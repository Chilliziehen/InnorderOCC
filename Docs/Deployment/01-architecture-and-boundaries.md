# 架构、所有权与故障边界

本章描述 `infra/compose/compose.yml` 当前定义的单主机私有部署。它用于判断服务能否启动、健康检查究竟证明什么、数据由谁拥有，以及故障应当被隔离在哪里。

## 部署拓扑

Compose 项目名为 `innorder-occ`，包含十一个服务、四个命名卷和两个网络。除 `host-gateway` 外，所有服务只连接内部网络 `backend`，且不直接发布主机端口。`host-gateway` 同时连接 `backend` 与普通 bridge 网络 `host-access`，是唯一端口发布者。

**安全：** `backend` 设置为 `internal: true`，用于容器间通信。`host-access` 只给网关提供主机端口发布能力，不应被其他服务加入。

### 十一个 Compose 服务

| 服务 | 类型 | 当前职责 | 持久状态 | 启动门禁 |
|---|---|---|---|---|
| `postgres` | 长运行 | PostgreSQL 16、pgvector、业务与 Flowable 数据 | `postgres-data` | 自身 `pg_isready` |
| `kafka` | 长运行 | 单节点 KRaft broker/controller | `kafka-data` | 自身 topic-list 探测 |
| `redis` | 长运行 | 带密码的 AOF Redis | `redis-data` | 认证后 `PING` |
| `postgres-init` | 一次性 | 验证 PostgreSQL 可用并把对象卷所有者改为 UID/GID `10001` | PostgreSQL、`minio-data` | 等待 PostgreSQL 健康，成功退出 |
| `minio` | 长运行 | S3 兼容对象存储与控制台 | `minio-data` | 等待卷初始化成功 |
| `minio-init` | 一次性 | 建桶、创建桶级应用账号并附加策略 | MinIO 内部状态 | 等待 MinIO 健康 |
| `opa` | 长运行 | 加载只读策略并提供无状态决策 | 无命名卷 | 自身 `/health` |
| `ai` | 长运行 | AI 边界、状态和静态能力注册表 | 当前无持久挂载 | 自身 `/health` |
| `flowable-init` | 一次性 | 在显式初始化 profile 中维护 Flowable 私有表 | PostgreSQL | 等待 PostgreSQL 健康，成功退出 |
| `core` | 长运行 | 应用事实、迁移、Flowable 和状态聚合边界 | PostgreSQL | 等待 PostgreSQL 健康和 `flowable-init` 成功 |
| `host-gateway` | 长运行 | 八路 TCP 回环转发 | 无卷、无密钥 | 只验证自身监听器 |

三个一次性服务的正常终态是 `Exited (0)`。将它们强行设为持续重启会改变初始化语义。

## 启动依赖图

Compose 中只有四条显式条件依赖：

```text
postgres --健康--> postgres-init --成功完成--> minio --健康--> minio-init
postgres-init --成功完成--> flowable-init --成功完成--> core
host-gateway --无 depends_on，独立启动并建立本地监听器
kafka、redis、opa、ai --无显式依赖，彼此并行启动
```

Core 启动时通过 Flyway 应用迁移，因此没有第二个并发迁移容器。Kafka、Redis、MinIO、OPA 和 AI 已配置为集成地址，但当前不是 Core 的 Compose 启动门禁。MinIO 初始化也不阻塞 Core。

**注意：** `docker compose up --wait` 的成功不能被解释为所有业务依赖均可用；一次性任务、Core 外部状态探测和网关上游必须分别检查。

## 网关独立启动与上游隔离

`host-gateway` 以非 root 的 `node` 用户运行，根文件系统只读，移除全部 Linux capabilities，启用 `no-new-privileges`，不挂载卷也不消费密钥。它启动时在容器内打开八个 TCP 监听器和 `18000` 健康端口，不预先连接上游。

网关健康路由 `http://localhost:18000/health` 只报告本地监听器已建立以及路由数量。客户端发起连接后，网关才解析服务名并连接上游；单个上游连接错误只销毁对应的客户端/上游 socket，不停止其他监听器。

**验证：** 网关健康但 `http://127.0.0.1:8080/actuator/health/readiness` 失败时，应检查 Core/PostgreSQL，而不是把网关健康当作 Core 健康。反之，单个上游故障不应使其他七路转发失效。

## 网络和八个回环映射

| 主机回环地址 | 网关容器端口 | 上游容器地址 | 用途 |
|---|---:|---|---|
| `127.0.0.1:${POSTGRES_PORT:-5432}` | `5432` | `postgres:5432` | PostgreSQL |
| `127.0.0.1:${KAFKA_PORT:-9092}` | `9092` | `kafka:9092` | Kafka 外部 listener |
| `127.0.0.1:${REDIS_PORT:-6379}` | `6379` | `redis:6379` | Redis |
| `127.0.0.1:${MINIO_API_PORT:-9000}` | `9000` | `minio:9000` | MinIO API |
| `127.0.0.1:${MINIO_CONSOLE_PORT:-9001}` | `9001` | `minio:9001` | MinIO Console |
| `127.0.0.1:${OPA_PORT:-8181}` | `8181` | `opa:8181` | OPA |
| `127.0.0.1:${AI_PORT:-3100}` | `3100` | `ai:3100` | AI |
| `127.0.0.1:${CORE_PORT:-8080}` | `8080` | `core:8080` | Core |

Compose 不提供受支持的 LAN 或公网入口。Core 等后端服务在 `backend` 内部可达，并通过网关供同一主机访问；`host-access` 不应被误解为应用后端网络。

### Kafka 监听器

Kafka 使用单节点 KRaft：

- `CONTROLLER://:29093`：控制器 quorum，投票地址为 `kafka:29093`。
- `INTERNAL://:29092`：容器间 broker 地址，广告为 `kafka:29092`；Core 使用此地址。
- `EXTERNAL://:9092`：供网关转发，广告为 `localhost:${KAFKA_PORT:-9092}`。

三个 listener 均为 `PLAINTEXT`。回环绑定降低了网络暴露面，但不提供传输加密或协议认证。外部客户端必须使用与 `KAFKA_PORT` 一致的 `localhost` 端口；不能用容器名连接主机 listener。

## 持久化边界

精确的四个命名卷为：

| 卷 | 挂载服务 | 内容与恢复含义 |
|---|---|---|
| `postgres-data` | `postgres` | 数据库、迁移历史、角色和 Flowable 表，是核心事实存储 |
| `kafka-data` | `kafka` | broker 日志和 KRaft 元数据，不是权威业务主存储 |
| `redis-data` | `redis` | AOF 缓存状态；设计上应可丢失和重建，但当前降级仍需验证 |
| `minio-data` | `postgres-init`、`minio` | 对象、桶和 MinIO 内部配置 |

**危险：** `docker compose --env-file infra/compose/.env -f infra/compose/compose.yml down --volumes` 会删除以上四个卷。仅有容器镜像、数据库 SQL 或 `.env` 都不能替代完整恢复点。

## 密钥消费矩阵

| Compose secret | 消费服务 | 容器目标 |
|---|---|---|
| `postgres_admin_password` | `postgres` | `/run/secrets/postgres_admin_password` |
| `postgres_flyway_password` | `postgres`、`core` | PostgreSQL 初始化文件；Core 的 `/run/secrets/spring.flyway.password` |
| `postgres_runtime_password` | `postgres`、`core` | PostgreSQL 初始化文件；Core 的 `/run/secrets/spring.datasource.password` |
| `redis_password` | `redis`、`core` | Redis 文件；Core 的 `/run/secrets/spring.data.redis.password` |
| `minio_root_user` | `minio`、`minio-init` | `/run/secrets/minio_root_user` |
| `minio_root_password` | `minio`、`minio-init` | `/run/secrets/minio_root_password` |
| `minio_app_user` | `minio-init`、`core` | 初始化文件；Core 的 `/run/secrets/occ.object-storage.access-key` |
| `minio_app_password` | `minio-init`、`core` | 初始化文件；Core 的 `/run/secrets/occ.object-storage.secret-key` |

Spring 通过 `SPRING_CONFIG_IMPORT=configtree:/run/secrets/` 把目标文件名映射成属性。网关、AI、OPA、Kafka 和两个不相关的基础服务不应获得额外密钥。

## PostgreSQL 所有权与初始化

### 角色边界

- `innorder_admin`：由 PostgreSQL 官方入口创建的 bootstrap superuser；密码来自管理员文件。
- `innorder_flyway`：非 superuser、不可建库/建角色/复制的登录角色；拥有应用 schema 并执行 V001-V011。
- `innorder_runtime`：非 superuser 的 Core 数据源登录角色；获得限定 DML、序列、函数和 Flowable 建表权限。

三个 PostgreSQL 密码必须互不相同。初始化脚本撤销数据库 `PUBLIC` 权限，给 Flyway `CONNECT, TEMPORARY, CREATE`，给 runtime `CONNECT`，并允许 Flyway 成为 runtime 的成员以正确授予对象权限。

### Schema 和 Flowable 所有权

V001 创建 `platform`、`catalog`、`iam`、`authz`、`occ`、`audit`、`ai` 和 `flowable` 八个 schema。它们由执行迁移的 `innorder_flyway` 所有。V009 给 runtime 在前七个应用 schema 上的使用、表 DML 和序列权限，但撤销 `CREATE`；仅对 `flowable` 授予 `USAGE, CREATE`。

Flowable schema 归 Flyway 所有；受控 `flowable-init` one-shot 使用 runtime 连接创建或升级固定版本 Flowable 的 `ACT_*` 表，随后 Core 以 `FLOWABLE_DATABASE_SCHEMA_UPDATE=false` 运行。应用迁移不复制供应商私有 DDL，其他模块不得直接依赖 Flowable 私有表。

### 空卷初始化顺序

1. PostgreSQL 入口用 `innorder_admin` 和 `POSTGRES_DB` 创建空数据库。
2. `010-create-roles.sh` 读取三个密钥，拒绝空值或重复值。
3. 脚本创建/更新 `innorder_flyway` 与 `innorder_runtime`，收紧权限，并安装 `vector`、`btree_gist`。
4. PostgreSQL 健康后 Core 启动。
5. Core 以 Flyway 角色执行 V001-V011；以 runtime 角色运行普通 JDBC 和 Flowable。
6. `flowable-init` 在 Flyway 创建的 `flowable` schema 中维护版本相关表并成功退出；Core 只在该完成门禁后启动。

**注意：** PostgreSQL `/docker-entrypoint-initdb.d` 脚本只在空数据目录初始化时执行。修改密钥文件或重建容器不会在已有数据库中重新设置角色密码。

## 数据库初始化失败语义与恢复

### PostgreSQL 健康与 Core readiness

PostgreSQL 的 `pg_isready` 成功只表示数据库接受连接探测。Core 在 PostgreSQL 达到 Compose 健康后才开始启动；在 Core 完成 Flyway、Spring 容器和 Flowable 引擎初始化并启动 HTTP 服务前，`/actuator/health/readiness` 不存在或不会成功。PostgreSQL 后续失去健康时，Compose 不会自动停止 Core，但 Core readiness 的 `db` 组件应转为失败。

**验证：** 同时运行 `docker compose --env-file infra/compose/.env -f infra/compose/compose.yml ps postgres core`，并检查 PostgreSQL 日志、Core 日志和 Core readiness。不得因 PostgreSQL 容器显示 healthy 就宣称 Core 可用，也不得在 Core readiness 尚未成功时继续业务验收。

恢复时先修复 PostgreSQL 的磁盘、权限、凭据、扩展或数据一致性根因，使其健康；再重启 Core 并等待 readiness 成功。不要删除 `postgres-data`、跳过数据库检查或反复重启来掩盖根因。

### Flyway 迁移失败

Flyway 在 Core 启动期以 `innorder_flyway` 执行 V001-V011。迁移校验、SQL、权限、扩展或连接失败会使 Spring 启动失败，因此 Core 不会提供成功 readiness。Compose 的 `unless-stopped` 可能反复重启 Core；每次尝试仍会在同一根因处失败。

Flyway 事务能力取决于具体迁移语句；不能假设一次失败会把已执行的全部迁移自动回滚，也不能手工删除 `flyway_schema_history` 记录。恢复步骤是：停止 Core 重启循环；保全数据库备份；收集 Core/PostgreSQL 日志和 Flyway 历史；确认最后成功版本、失败语句及数据库实际状态；按迁移所有者批准的方法修复根因或执行经评审的修复迁移；再启动 Core 并验证 V001-V011 均成功及 readiness 成功。

**危险：** 不得通过关闭 Flyway、修改已发布迁移校验和、手工标记成功或删除数据卷使启动表面通过。迁移已经改变 schema 时，应用镜像回退也不等于数据库回滚。

### Flowable schema、权限或引擎初始化失败

Flowable 引擎被 `FlowableDatabaseInitializationDependencyDetector` 声明为数据库初始化的依赖者。Compose 先运行 `flowable-init`，其在 Flyway 完成后创建或升级供应商表；Core 的启动校验再确认同一 DataSource、Spring transaction manager 和禁用 schema update。任一步失败都不会提供成功 readiness。schema 所有者不是 `innorder_flyway` 属于必须修复的权限漂移。

恢复时停止 Core；收集 Core 异常链、PostgreSQL 日志、schema 所有者、runtime grants、Flyway 历史和已有 `ACT_*` 表状态；对照 V001/V009 与固定 Flowable `7.1.0` 找到根因；从已验证备份恢复或执行经数据库与应用所有者批准的权限/迁移修复；然后重启 Core，确认 Flowable 初始化成功、system status 中 Flowable 探测正常且 readiness 成功。

**危险：** 只允许 `flowable-init`（以及 development/test profile）启用 `FLOWABLE_DATABASE_SCHEMA_UPDATE`。不得在长运行 Core 上启用，不得关闭 `flowable.depends-on-database-initialization-detection`，也不得让 runtime 获得 superuser 或整个应用 schema 的所有权。

## 健康语义和路由

| 服务 | Compose 健康检查 | 能证明 | 不能证明 |
|---|---|---|---|
| PostgreSQL | `pg_isready` 到本容器数据库 | 接受连接探测 | 迁移完整、应用查询正确 |
| Kafka | 内部 `localhost:29092` 列 topic | broker 响应 | 生产消费链或外部 listener 完整 |
| Redis | 使用文件密码执行 `PING` | 当前密码认证和服务响应 | Core 已采用同一密码 |
| MinIO | `/minio/health/ready` | 服务 readiness | 桶、应用用户和策略已完成 |
| OPA | `/health` | OPA 进程响应且入口已通过策略严格检查 | 具体业务输入会允许 |
| AI | `/health` | HTTP 进程响应 | 模型、provider 或工具可用；当前本就未实现执行 |
| Core | `/actuator/health/readiness` | `ping` 与数据库健康 | Kafka、Redis、OPA、AI、MinIO 全部健康 |
| 网关 | 内部 `:18000/health` | 八个本地监听器已绑定 | 任一上游可连接 |

主机侧关键 HTTP 路由：

- Core readiness：`http://127.0.0.1:8080/actuator/health/readiness`
- Core 状态：`http://127.0.0.1:8080/api/v1/system/status`
- AI 健康：`http://127.0.0.1:3100/health`
- AI 状态：`http://127.0.0.1:3100/api/v1/system/status`
- AI 静态能力：`http://127.0.0.1:3100/api/v1/providers/capabilities`
- OPA 健康：`http://127.0.0.1:8181/health`
- MinIO readiness：`http://127.0.0.1:9000/minio/health/ready`

**验证：** Core readiness 响应中的组件只能包含 `ping` 和 `db`。依赖总体状态应读取 Core system status，并结合各服务原生探测，而不是扩大 readiness 语义。

## 数据流与控制流

### 当前实际流

1. 同机桌面通过受限 preload IPC 轮询 Core/AI HTTP 状态，不直连数据库、OPA 或 Flowable。
2. Core 以 PostgreSQL 作为事实与状态转换的唯一应用所有者，并封装 Flowable。
3. Core 聚合状态探测 PostgreSQL、Flowable、OPA、Kafka、Redis 和 MinIO；Compose 虽配置 `AI_BASE_URL`，当前 Core 没有 AI status probe 或真实模型调用。配置地址不等于已实现客户端能力。
4. OPA 根据 Core 提供的事实做无状态允许/拒绝决策，不保存业务事实。
5. AI 只返回状态和静态能力描述；`agent-runtime READY`、模型通配符和 `supportsTools`/`supportsStructuredOutput` 都是固定注册表元数据，不是运行探测。当前没有 model factory，不访问真实模型、不执行工具、不写业务事实。
6. MinIO 初始化器建立目标桶和桶级应用账号；Core 只获得应用账号，不获得 root 凭据。

### 目标控制边界

后续业务实现仍必须保持：命令进入 Core；Core 在一个事务边界内协调事实、Flowable、审计与 Outbox；OPA 只决策；Kafka 不是主存储；Redis 可重建；AI 输出必须经 Core 验证和授权。目标边界不表示这些业务链路当前已完成。

## 预期故障隔离

- PostgreSQL 不健康：Core 被启动门禁阻止或 readiness 失败；AI、OPA、Kafka、Redis、MinIO 和网关仍可独立运行。
- Core 不健康：桌面不能进行受支持的状态/未来业务访问；其他服务健康不代表系统可用。
- Kafka 或 Redis 不健康：不会被 Compose 阻止 Core 启动；当前基础不应据此宣称生产级降级已验证。
- MinIO 或 `minio-init` 失败：Core 仍可能健康，因为 readiness 不包含对象存储；对象能力和初始化状态必须单独判定。
- OPA 不健康：Core readiness 仍可能为健康；未来授权敏感操作必须失败关闭，当前业务操作尚未实现。
- AI 不健康：不应影响 PostgreSQL/Core 启动；AI 的 HTTP 状态和静态元数据不可读。当前没有真实建议/模型执行能力，不能把此故障描述成业务推理中断。
- 网关不健康：容器内服务可能正常，但主机八个入口不可用。
- 单个网关上游不健康：对应连接失败，其他路由继续监听。

## 不支持的扩展边界

**危险：** 下列变更不是当前手册支持范围，不能作为现场临时修改：

- 把 `127.0.0.1` 改成 `0.0.0.0`、LAN 地址或公网地址。
- 在网关前声称已有 TLS、OIDC、WAF、反向代理或零信任访问支持。
- 将单节点 Kafka/PostgreSQL/MinIO 改成集群并宣称高可用。
- 将 Compose 直接转换为 Kubernetes 清单或加入服务网格。
- 横向扩展 Core/AI 而不解决会话、迁移、调度、幂等和状态一致性。
- 让 Desktop、AI 或其他服务直写 PostgreSQL、操作 Flowable 或绕过 Core。
- 让 runtime 获得 superuser、schema 所有权或在非 Flowable schema 的 `CREATE`。
- 用外部对象存储、Kafka、Redis 或 OPA 替换内置服务而不重新完成安全、兼容、故障和负载验收。

**验证：** 任何扩展提案必须明确新的所有者、认证与 TLS、迁移路径、备份恢复、容量模型、故障域和回退方法，并在受支持范围更新前保持为未支持状态。
