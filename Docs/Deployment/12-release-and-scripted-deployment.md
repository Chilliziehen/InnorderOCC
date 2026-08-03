# 发布制品与脚本化部署

本章说明本仓库产出的 release 制品、校验方式，以及 `scripts/deploy/` 下四个脚本的用途、参数和退出语义。它补充而不替代第 03 至 11 章：脚本封装的每一步在那些章节都有对应的手工命令和判定标准，出现分歧时以源码和 Compose 定义为准。

## 适用与非适用

- **适用**：单客户、单主机 Compose 部署的构建、预检、启动、备份和升级回滚准备。
- **不适用**：多节点编排、公网暴露、外部身份平台接入。脚本不会为你建立网络隔离或 TLS 终止。

**注意：** 所有脚本都从仓库根目录执行，且都不接受、不打印、不复制任何密钥值。

---

## 1. 发布制品

### 1.1 构建

```bash
npm run release
```

该命令依次执行：

1. `:services:core:bootJar`，使用 strict dependency verification。
2. `@innorder/contracts` 构建（AI 与桌面均依赖其产物）。
3. `@innorder/ai-service` TypeScript 构建。
4. `@innorder/desktop` Electron 打包（Windows x64）。

产物写入 `dist/release/`（可用 `--out` 覆盖）：

| 制品 | 内容 |
|---|---|
| `core-<版本>.jar` | Core 可执行 Spring Boot jar，内含 V001–V017 迁移资源 |
| `ai-service/dist/` + `package.json` | 编译后的 AI 服务 |
| `desktop/` | 打包后的桌面客户端目录 |
| `SHA256SUMS` | 全部文件的 SHA-256 清单 |
| `manifest.json` | 构建时间、git revision、工作区是否干净、平台、逐文件摘要 |

跳过桌面打包（例如在无图形环境的 CI 上只出后端制品）：

```bash
npm run release -- --skip-desktop
```

**验证：** `manifest.json` 的 `workingTreeDirty` 必须为 `false`，`gitRevision` 必须与发布工单记录的 revision 一致。为 `true` 时该制品只能用于调试，不得进入发布基线。

### 1.2 校验

在目标主机上核对：

```bash
sha256sum --check SHA256SUMS
```

Windows PowerShell：

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $parts = $_ -split '\s+', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $parts[1].Trim()).Hash.ToLower()
  if ($actual -ne $parts[0]) { throw "摘要不匹配：$($parts[1])" }
}
Write-Output '全部制品摘要匹配'
```

**危险：** 摘要不匹配的制品一律不得安装。不要"重新下载一次试试"，先按第 09 章记录事件并确认来源。

---

## 2. 部署前预检

```bash
npm run deploy:preflight
```

指定非默认环境文件：

```bash
npm run deploy:preflight -- --compose-env /path/to/.env
```

> 该标志刻意不叫 `--env-file`：那是 Node 自身的 CLI 标志，会在脚本读取参数前被 Node 截获。

预检项：

1. Docker Engine 可连接、Docker Compose v2 可用。
2. 从 `compose.yml` 中提取全部 `${VAR:?}` 必填变量（当前 14 个），逐一确认在环境文件中已设置且非空。
3. 每个 `*_FILE` 变量：必须是绝对路径、指向常规文件。
4. 标量密钥文件：恰好一个非空行、无首尾空白、无引号包裹；MinIO 用户名 ≥ 16 字符，其余密码 ≥ 32 字符；`CURSOR_HMAC_KEY_FILE` 必须是 64 位小写十六进制。
5. JWT 文件按 PEM 校验，不参与单行与唯一性检查。
6. 全部标量值两两互异（按 SHA-256 比对，不打印值）。
7. `OCC_JWT_ISSUER` 必须是 `https://` URI。
8. 上述全部通过后才渲染 Compose，并确认每个外部镜像都固定了 `@sha256` digest。

预检**一次报告全部问题**而不是遇到第一个就退出。退出码 `0` 表示通过，`1` 表示存在问题。

**安全：** 预检只读，不创建容器、不写卷、不修改任何文件。

---

## 3. 启动部署

```bash
npm run deploy:up
```

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--compose-env PATH` | `infra/compose/.env` | 环境文件路径 |
| `--timeout SECONDS` | `900` | 全部就绪门禁的总预算 |
| `--no-build` | 关闭 | 不重新构建镜像，直接启动既有镜像 |
| `--skip-preflight` | 关闭 | 跳过预检（仅在刚刚单独跑过预检时使用） |

执行顺序：

1. 运行预检；不通过则**不启动任何容器**。
2. `docker compose up --detach`（默认带 `--build`）。
3. 等待四个一次性任务 `exited 0`：`postgres-init`、`flowable-init`、`minio-init`、`parser-volume-init`。任一非零退出立即失败，不重试。
4. 等待八个长运行服务健康：`postgres`、`kafka`、`redis`、`minio`、`opa`、`ai`、`core`、`host-gateway`。
5. 探测已发布端点：Core readiness、Core 状态、AI 健康、OPA 健康、MinIO readiness。

**注意：** 一次性任务 `exited 0` 是**成功**，不是故障。第 06 章对此有同样说明；把它误判为异常会导致不必要的回滚。

超时或任一门禁失败时脚本以非零退出，容器保持运行以便按第 09 章取证。

---

## 4. 备份

```bash
npm run deploy:backup -- --out /path/to/backup/root
```

产出 `innorder-occ-<UTC 时间戳>/` 目录，包含：

| 文件 | 内容 |
|---|---|
| `postgres-cluster.sql` | `pg_dumpall --clean --if-exists`，含角色定义 |
| `minio-objects.tar` | MinIO `/data` 全量 tar |
| `compose-rendered.yml` | 插值后的 Compose 配置（不含密钥内容） |
| `manifest.json` | 起止时间、git revision、逐文件字节数与 SHA-256 |

**危险：** 备份**不包含**十三个密钥文件。恢复时必须由密钥保管方提供同一组文件，否则数据库和对象存储无法解锁使用。这是有意的边界，不要为了"方便恢复"把密钥塞进备份目录。

恢复步骤、恢复点目标和演练要求见[第 07 章](07-backup-restore-and-dr.md)。

---

## 5. 与手工流程的对应关系

| 脚本 | 对应章节 | 脚本不替代的部分 |
|---|---|---|
| `preflight.mjs` | 第 02、03 章 | 容量规划、磁盘与时间同步、密钥生成与 ACL 设置 |
| `deploy.mjs` | 第 04、05 章 | 平台特定的服务注册、开机自启、生命周期锁 |
| `backup.mjs` | 第 07 章 | 异地保存、保留策略、恢复演练与验收 |
| `release.mjs` | 第 08、11 章 | 签名、分发、升级窗口审批与回滚决策 |

**验证：** 首次在某台主机上使用脚本时，仍应按第 11 章检查单人工复核一次结果；脚本通过不等于验收通过。

---

## 6. 退出码约定

| 退出码 | 含义 |
|---|---|
| `0` | 全部检查或步骤通过 |
| `1` | 存在明确失败项，输出已列出全部问题 |
| `2` | 参数用法错误（例如 `backup.mjs` 缺少 `--out`） |

脚本的标准输出可直接进入工单，但进入证据目录前仍应按第 06 章约定检查是否包含主机名、绝对路径等环境信息。
