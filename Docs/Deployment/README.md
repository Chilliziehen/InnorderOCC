# 创序 OCC 私有部署与运维手册

本手册面向负责单客户、单节点 Docker Compose 环境的部署工程师、系统管理员、安全管理员、数据库管理员和一线值班人员。它说明当前仓库实际可运行的软件基础，不把目标架构或尚未实现的能力写成现有功能。

## 阅读对象与推荐路径

- 首次部署人员：依次阅读第 01、02、03、04 或 05 章，再按第 11 章执行验收。
- 日常值班人员：先读第 06 章，再使用第 09 章和第 11 章定位告警。
- 数据库与灾备人员：先理解第 01 章的数据所有权，再读第 07、08 章。
- 安全管理员：重点阅读第 03、08、10 章，并复核密钥保管、镜像来源和本机暴露面。
- 变更审批人员：以第 02 章证据、第 08 章回滚条件和第 11 章检查单作为审批输入。

## 手册范围

当前部署单元是 `infra/compose/compose.yml` 定义的每客户独立、单主机 Compose 栈。手册覆盖主机预检、容量初始基线、八个文件型密钥、配置、Windows/Linux 生命周期、状态检查、备份恢复、升级回滚、事件处置和安全加固。

**安全：** 所有发布端口只绑定主机回环地址。该设计适合同机客户端和受控运维，不等于已建立网络隔离、身份认证、TLS 终止、远程访问或互联网发布能力。

## 当前基础限制

当前仓库是可构建、可测试的软件基础，能力限于 Core/AI 状态接口、AI 静态契约元数据、桌面状态轮询、OPA 基线决策以及基础设施定义。AI 状态中的 `agent-runtime READY` 和 capabilities 中的 `supportsTools` 是固定注册表输出，不是模型连接、工具执行或实际 provider 可用性的探测结果。

- 没有业务域工作流，也没有可投入运营的业务流程。
- 没有真实干预队列；桌面中的流程摘要和队列只是基础界面状态。
- AI 不调用真实模型，不执行工具，也不自动改变事实。
- 没有高可用、自动故障转移、多副本一致性或跨节点编排保证。
- 不支持 Kubernetes 或服务网格部署。
- 不提供受支持的公网或远程访问方案；不得把回环绑定改成通配地址后直接暴露。
- Compose 栈没有完整可观测性收集器、生产备份调度器或外部身份提供方集成。

**注意：** 规格中的目标能力不代表当前代码已经实现。上线业务试点前必须另行完成业务流程、授权集成、真实依赖降级、备份恢复和负载验收。

## 风险标签

本手册统一使用以下标签：

- **安全：** 正常只读、可重复或不改变持久状态的操作。
- **注意：** 会改变运行状态、配置或可用性，执行前需确认环境和影响范围。
- **危险：** 可能删除数据、泄露密钥、导致不可逆迁移或扩大网络暴露面，必须有审批、备份和回退条件。
- **验证：** 操作后的客观检查及其通过标准；未通过不得继续下一阶段。

## 事实来源与优先级

发生不一致时，按以下顺序判断当前实现：

1. 可执行源码、数据库迁移、初始化脚本和应用配置。
2. `infra/compose/compose.yml`、Dockerfile、镜像固定值和自动化契约测试。
3. 根目录及组件 README 中与当前源码一致的操作说明。
4. 本部署手册。
5. `Docs/Specification/` 中的目标规格和图示。

同一层级冲突时停止变更，记录文件、版本和差异，交由组件所有者确认。不得用规格中的未来拓扑覆盖当前 Compose 行为。本手册中的容量数值是初始规划基线，不是性能承诺。

## 命令约定

- 除非章节另有说明，命令从仓库根目录执行。
- Windows 示例要求 Windows PowerShell 5.1；Linux 示例要求 Bash。
- 需要主机路径的章节使用操作员预先设置的环境变量：`OCC_REPOSITORY_ROOT`、`OCC_SECRET_ROOT` 和 `OCC_EVIDENCE_ROOT`。命令会在变量缺失时失败，不包含需要手工改写的假路径。
- Compose 命令始终显式指定环境文件和 Compose 文件，避免从错误目录加载隐式配置。
- 命令输出进入工单或证据目录前先检查是否包含用户名、绝对密钥路径、环境转储或其他敏感信息。

标准 Compose 前缀为：

```text
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml
```

执行平台章节命令前，操作员应通过受批准的会话配置设置上述路径变量，然后验证并进入仓库根目录：

```powershell
$required = 'OCC_REPOSITORY_ROOT','OCC_SECRET_ROOT','OCC_EVIDENCE_ROOT'
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "缺少环境变量 $name" }
}
Set-Location -LiteralPath $env:OCC_REPOSITORY_ROOT
```

```bash
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
cd -- "$OCC_REPOSITORY_ROOT"
```

Windows 调用仓库脚本时使用 `./gradlew.bat`，Linux 使用 `./gradlew`。严格发布验证使用：

```powershell
npm run verify:full
```

`verify:full` 要求可响应的 Docker Engine 和真实 OPA 可执行文件，并拒绝被跳过的 Docker 集成测试。

## 章节地图

1. [架构、所有权与故障边界](01-architecture-and-boundaries.md)
2. [部署前检查与容量规划](02-preflight-and-capacity.md)
3. [密钥与配置管理](03-secrets-and-configuration.md)
4. [Windows 部署](04-deploy-windows.md)
5. [Linux 部署](05-deploy-linux.md)
6. [日常运维与监控](06-daily-operations-and-monitoring.md)
7. [备份、恢复与灾难恢复](07-backup-restore-and-dr.md)
8. [升级与回滚](08-upgrade-and-rollback.md)
9. [事件处置手册](09-incident-runbooks.md)
10. [安全加固](10-security-hardening.md)
11. [命令参考与检查单](11-command-reference-and-checklists.md)

## 快速生命周期地图

### 规划

1. 确认单客户、单主机和仅本机访问符合用途。
2. 按第 02 章确认架构、资源、磁盘、端口、时间和外部依赖。
3. 确定持久卷、密钥目录、备份目标和证据目录的所有者与保留策略。

### 准备

1. 按第 03 章生成八个互异、非空的文件型密钥。
2. 创建只保存密钥文件路径和非敏感覆盖值的 `infra/compose/.env`。
3. 运行 Compose 插值验证；检查镜像 tag 与 digest 均保留。

### 构建与启动

1. 记录 Git revision 和工作区状态。
2. 执行严格验证或记录经审批的例外。
3. 构建并启动 Compose 栈，等待 PostgreSQL、Core 和各独立服务达到预期状态。
4. 确认两个一次性任务成功完成，不把已退出且退出码为零误判为故障。

### 验收

1. 检查十个服务的状态、健康语义和八个回环监听。
2. 执行 HTTP 与协议探测，确认 Core readiness 只代表 `ping` 和数据库。
3. 保存已脱敏的配置摘要、镜像 ID、状态、测试结果和审批记录。

### 运行与变更

1. 监控容量、日志、服务健康、一次性初始化结果和备份。
2. 配置或密钥变更必须执行受影响服务的协调更新，不能只改文件后宣称生效。
3. 升级前验证恢复点；迁移开始后按迁移兼容性决定是否允许应用回退。

### 停止与销毁

不删除数据的停止命令为：

```powershell
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml down
```

**危险：** `down --volumes` 会删除 `postgres-data`、`kafka-data`、`redis-data` 和 `minio-data`。除非已审批永久删除并验证可恢复备份，否则不得执行。

## 文档维护规则

- 每次修改 Compose 服务、网络、卷、端口、密钥目标、健康检查或默认值时，同一变更必须更新对应章节。
- 操作命令先在与支持平台一致的隔离环境验证；记录命令版本和预期结果，不记录密钥值。
- 新章节只能使用一个 H1，并保持描述性的 H2/H3 层级。
- 所有代码围栏必须标注真实语言；Markdown 链接使用仓库内相对路径。
- 不在文档中放置可用凭据、私有主机地址、临时主机路径或可被误执行的示例密码。
- 发布前运行 `npm run test:deployment-docs`，并人工对照 Compose、`.env.example`、Dockerfile、应用配置和数据库初始化脚本。
- 文档评审记录应包含源码 revision、评审人、事实核对日期和未解决风险。

**验证：** 文档变更只有在结构测试通过、所有当前章节事实与源码一致、未来章节链接在完整手册中可解析后才可进入发布基线。
