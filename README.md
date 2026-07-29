# 创序 OCC 软件基础

本仓库目前提供可构建、可测试的软件基础：Electron 运营桌面壳、Kotlin/Spring Boot Core、Node.js/Fastify AI 服务、共享 TypeScript/OpenAPI 契约、PostgreSQL/Flyway 既有数据库、OPA 基线策略和私有部署 Compose 定义。当前没有实现业务域流程、真实干预队列或 AI 自动执行；桌面中的流程摘要和队列是基础界面状态。

已工作的运行能力限于 Core/AI 状态接口、AI 静态能力注册表、桌面对 Core/AI 的受限状态轮询、OPA 基线授权决策以及基础设施定义。AI 当前不会调用真实模型或执行工具。

## 所有权边界

- Desktop 只能通过受限 preload IPC 访问 Core/AI HTTP 状态接口；不得直连 PostgreSQL、OPA 或 Flowable，也不得直接改变业务状态。
- Core 是事实和状态转换的唯一应用所有者，并封装 Flowable。只有 Core 可以发起工作流操作、持久化事实和协调授权决策。
- AI 只生成能力描述、建议或待 Core 验证的结果；不得直接写事实、调用 Flowable 或绕过 Core 执行变更。
- PostgreSQL 保存事实、版本、审计和投影。`database/` 是本项目开始前已存在的数据库交付物，当前迁移为 `V001` 至 `V009`。
- OPA 只根据 Core 提供的事实做无状态允许/拒绝决策，不保存或修改业务事实。

## 目录

```text
apps/desktop/          Electron + React 运营客户端、单元测试和打包烟测
services/core/         Kotlin + Spring Boot + Flowable Core
services/ai/           Fastify AI 边界和能力注册表
packages/contracts/    Zod/TypeScript 共享契约和 Core OpenAPI
database/              既有 PostgreSQL 迁移、完整入口和数据库测试
policies/opa/          Rego 平台授权策略和行为测试
infra/compose/         私有部署 Compose、镜像、初始化和静态契约
gradle/                 Gradle 8.14.3 wrapper、校验和及 Windows JDK 选择器
scripts/                根级集成验证编排
Docs/Project/           用户提供的项目和架构材料
Docs/Specification/     用户提供的规格交付物
Docs/superpowers/       本基础阶段的设计与实施计划
```

根目录的 `package.json`/`package-lock.json` 管理 npm workspaces；`settings.gradle.kts`/`build.gradle.kts` 管理 Core。`node_modules/`、`dist/`、`build/`、`.vite/` 和 `out/` 均为生成物，不是源码所有权边界。

## 前置条件

- Windows PowerShell 5.1 或兼容终端。
- Node.js 22 或更高版本及 lockfile 兼容的 npm。
- JDK 21。wrapper 固定 Gradle `8.14.3`，Core 编译目标固定 Java 21。
- Electron 本地开发/烟测需要图形桌面；当前阶段只打包和烟测 Windows x64。
- Electron `43.2.0` Windows x64 二进制与校验和只使用 Electron 项目的官方 GitHub Releases 固定版本源；仓库不配置第三方镜像或下载覆盖变量。
- Core 当前启动时的阻塞依赖是 PostgreSQL 16 + pgvector、`btree_gist`，以及已配置登录凭据和所需数据库权限的 `innorder_flyway`/`innorder_runtime` 角色。启用 Flyway 时，Core 在启动过程中应用 V001-V009。Kafka、Redis、MinIO、OPA 与 AI 是已配置的基础集成，其中并非全部已有活动客户端，因此目前不都阻塞 Core 启动。
- Compose 启动需要 Docker Engine 和 Compose v2 的 Linux 容器支持。
- 执行真实 Rego 行为测试需要 `opa` 可执行文件；没有时根测试仍执行静态 Rego 契约。

Windows 上若当前 `java` 是 Gradle 8 不支持的 Java 25+，`gradlew.bat` 会查找本机或 Gradle 缓存中的 Java 17-24 作为 wrapper 启动 JDK；Gradle toolchain 再解析/下载 JDK 21 来编译 Core。无法自动找到时，显式把 `JAVA_HOME` 指向 JDK 21。

## 安装与验证

从仓库根目录执行干净安装：

```powershell
npm run install:verified
```

`install:verified` 不依赖 `node_modules`：它先拒绝继承环境和仓库配置中的 Electron 镜像、自定义下载源及校验覆盖，再使用官方 npm registry、仓库内可写缓存执行 `npm ci`。在守卫、锁文件和项目源码未被恶意篡改的前提下，该流程为本次干净安装建立来源边界；已有 npm/Electron 缓存中工件的历史来源无法被追溯证明，需要删除旧缓存后再运行此命令才能建立新的安装边界。

Electron 来源检查递归覆盖已提交的可执行和配置源码，包括 `vendor/` 下的此类文件；只跳过文档、依赖目录和明确生成的 `.git/`、`node_modules/`、`out/`、`dist/`、`build/`、`.gradle/`、`.vite/`、`coverage/`、`playwright-report/`、`test-results/` 与 `.cache/`。该检查用于阻止意外引入或配置形成的来源绕过，不声称抵抗能够修改守卫、测试或其他同仓库源码的恶意代码。

常用验证命令：

```powershell
npm test                  # Node/infra/database tests + Core Kotlin tests（Docker 测试可跳过）
npm run typecheck         # 先构建 contracts，再检查全部 TypeScript workspace
npm run build             # contracts -> AI -> Electron package
npm run verify            # 离线友好的 quick：测试、Core 构建、TypeScript 构建和类型检查
npm run verify:local      # local verification：扩展本机检查，允许 Docker/OPA 测试跳过
npm run verify:full       # 严格 full：要求 Docker Engine 和 OPA，禁止集成测试 skipped
```

分项命令：

```powershell
npm run test:workspaces
npm run test:infra
npm run test:database
npm run test:electron-provenance
npm run test:database:pglite
./gradlew.bat :services:core:test
./gradlew.bat :services:core:build
./gradlew.bat :services:core:test --tests com.innorder.occ.PostgreSqlFlowableIntegrationTest --dependency-verification strict
```

上面的 Gradle 命令在 PowerShell 中应写作 `./gradlew.bat ...`；POSIX 环境使用 `./gradlew ...`。直接运行 `npm run test:infra` 不搜索 `PATH`，必须显式提供 `OPA_PATH` 才会执行真实 OPA 测试：

```powershell
$env:OPA_PATH = (Get-Command opa -ErrorAction Stop).Source
npm run test:infra
Remove-Item Env:OPA_PATH
```

`npm run verify` 保持离线友好，运行静态 Rego 契约，并在 OPA 可用时附加真实检查。`npm run verify:local` 增加 PGlite、官方 npm registry high 阈值漏洞审计、registry 签名审计和已打包 Electron 烟测；Docker 或 OPA 不可用时允许对应测试 skipped，成功消息只能是 `local verification passed`。

`npm run verify:full` 是 CI/发布用严格模式。它在任何构建前要求 `docker info` 成功连接 Docker Engine，并要求 `OPA_PATH` 或 `PATH` 中的真实 `opa version` 成功；随后执行真实 OPA 测试、强制重跑 digest-pinned PostgreSQL Testcontainers 测试，并解析 `PostgreSqlFlowableIntegrationTest` JUnit XML。结果文件缺失、测试为零、任何 failures/errors 或任何 skipped 都会失败，绝不输出 full success。Full 同样包含 local 扩展检查。Gradle 始终以 strict dependency verification 校验已签入的 artifact checksum/签名元数据；这是 JVM artifact provenance 控制，不是 JVM 漏洞扫描，可靠且固定版本的 JVM CVE scanner 仍是后续 CI 控制。

## 本地运行

AI 服务不依赖外部基础设施即可启动：

```powershell
npm run build --workspace @innorder/contracts
npm run build --workspace @innorder/ai-service
$env:PORT = "3100"
npm start --workspace @innorder/ai-service
```

Core 启动所需的数据库/Flyway 配置是 `DATABASE_JDBC_URL`、`DATABASE_USERNAME`、`DATABASE_PASSWORD`、`FLYWAY_USERNAME` 和 `FLYWAY_PASSWORD`。数据库与 Flowable 的可选控制项是 `FLYWAY_ENABLED`、`FLYWAY_LOCATIONS`、`FLOWABLE_DATABASE_SCHEMA` 和 `FLOWABLE_DATABASE_SCHEMA_UPDATE`。

当前非阻塞的基础集成配置包括 `REDIS_HOST`、`REDIS_PORT`、`KAFKA_BOOTSTRAP_SERVERS`、`OPA_BASE_URL`、`AI_BASE_URL`、`OBJECT_STORAGE_ENDPOINT` 和 `OBJECT_STORAGE_BUCKET`；对应的可选敏感配置名是 `REDIS_PASSWORD`、`OBJECT_STORAGE_ACCESS_KEY` 和 `OBJECT_STORAGE_SECRET_KEY`。运行参数还包括 `APP_VERSION` 与 `SERVER_PORT`；使用挂载的 Spring config tree 时设置 `SPRING_CONFIG_IMPORT`。实际值应由环境或 Compose secret files 提供，不得写入仓库。随后运行：

```powershell
./gradlew.bat :services:core:bootRun
```

Electron 开发、打包和烟测：

```powershell
npm run dev --workspace @innorder/desktop
npm run package --workspace @innorder/desktop
npm run smoke --workspace @innorder/desktop
```

桌面默认读取 `CORE_BASE_URL=http://127.0.0.1:8080` 和 `AI_BASE_URL=http://127.0.0.1:3100`；可在启动桌面前覆盖这两个环境变量。

OPA 独立测试：

```powershell
opa check --strict policies/opa
opa test policies/opa
```

真实 PostgreSQL/pgvector 的迁移和 SQL 测试见 `database/README.md`；PGlite 只提供无外部数据库的兼容烟测，不能验证 pgvector HNSW 运算符类。

## 端口与状态

| 服务 | 默认主机端口 | 状态或主要路由 |
|---|---:|---|
| Core | `8080` | `/actuator/health/readiness`、`/api/v1/system/status` |
| AI | `3100` | `/health`、`/api/v1/system/status`、`/api/v1/providers/capabilities` |
| OPA | `8181` | `/health`、`/v1/data/innorder/platform/authz/decision` |
| PostgreSQL | `5432` | PostgreSQL 协议，无 HTTP 状态路由 |
| Kafka | `9092` | Kafka 协议 |
| Redis | `6379` | Redis 协议 |
| MinIO API | `9000` | `/minio/health/ready` |
| MinIO Console | `9001` | 管理控制台 |

Compose 发布端口都绑定 `127.0.0.1`；容器间使用内部 `backend` 网络。Electron 开发服务器端口由 Forge/Vite 动态管理，不是公共服务契约。

## Compose 与密钥

不要把凭据写进 `.env` 或 Compose。实际步骤是：

1. 在仓库外创建八个只含一个非空值的独立文件，PostgreSQL 三个密码互不相同，MinIO 应用账号与 root 凭据不同。
2. 复制 `infra/compose/.env.example` 为忽略跟踪的 `infra/compose/.env`，只填写这八个文件的绝对路径；可选端口留空即使用默认值。
3. 先验证插值，再构建启动：

```powershell
Copy-Item infra/compose/.env.example infra/compose/.env
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up --build
```

完整变量名、角色权限、停止和清理命令见 `infra/compose/README.md` 与 `infra/compose/.env.example`。外部镜像和 Dockerfile 基础镜像均固定可读 tag 与 `sha256` digest；`V009` 只向运行角色授予所需 DML、序列及 Flowable schema 的 `USAGE, CREATE`。`flowable` schema 仍由 `innorder_flyway` 所有，运行角色只拥有自己创建的 `ACT_*` 表。

Core 的 PostgreSQL 集成测试使用 Compose 中相同 digest 的 pgvector PostgreSQL 镜像并自动执行 V001-V009、Flyway/运行账号隔离、Flowable schema/操作和扩展检查。普通 `npm test` 与 `verify:local` 在 Docker 不可用时允许明确 skip；严格 `verify:full` 要求 Docker 和 OPA 均可用，并拒绝任何 skipped 集成测试。
