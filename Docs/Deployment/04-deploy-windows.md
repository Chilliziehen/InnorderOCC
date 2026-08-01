# Windows 部署操作规程

本章是在 Windows 主机上部署当前单客户、单节点 Compose 栈的完整操作票。目标平台是 Windows PowerShell 5.1、Docker Desktop 和 Linux containers；全部命令从仓库根目录执行。先阅读[架构、所有权与故障边界](01-architecture-and-boundaries.md)，并把[部署前检查与容量规划](02-preflight-and-capacity.md)和[密钥与配置管理](03-secrets-and-configuration.md)作为强制门禁。

## 前置条件、权限边界与会话初始化

### 管理员与日常操作员边界

- Windows 管理员负责安装/升级 Docker Desktop、启用 WSL2、配置开机或登录启动、主机防火墙、磁盘、时间同步、受保护目录 ACL 和批准 Docker Desktop 文件共享。管理员权限也等价于能控制 Docker Engine、读取挂载文件和替换容器，必须按高权限账号管理。
- 部署操作员负责经过审批的源码 revision、`npm run install:verified`、OPA 来源、严格验证、Compose 构建/启动和验收。账号必须能访问 Docker Desktop Engine、仓库、证据目录及十个密钥文件，但不应因此获得其他业务目录权限。
- 日常值班人员只执行状态、HTTP/TCP 探测和经批准的日志收集。停止、重启、镜像重建和数据删除会影响可用性，不能仅因拥有 Docker 权限就自行执行。
- 需要提升权限时，关闭普通窗口后显式启动批准的管理员 PowerShell；不要在同一窗口临时混用身份。记录执行身份和变更单，不记录环境转储或密钥路径清单。

**验证：** PowerShell 主版本必须为 5，Docker Client/Server 均可响应，`docker info` 的 `OSType` 必须为 `linux`，Compose 必须为 v2。若 Docker Desktop 正处于 Windows containers 模式，立即停止部署。

每个新 PowerShell 窗口先由批准的会话配置设置三个稳定绝对路径，再运行以下初始化块。脚本不含需要手工替换的路径占位符；变量缺失、路径不存在或当前位置错误都会失败。

```powershell
$ErrorActionPreference = 'Stop'
$requiredVariables = 'OCC_REPOSITORY_ROOT','OCC_SECRET_ROOT','OCC_EVIDENCE_ROOT'
foreach ($name in $requiredVariables) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "缺少环境变量 $name" }
  if (-not [IO.Path]::IsPathRooted($value)) { throw "$name 必须是绝对路径" }
}
$RepositoryRoot = (Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT).Path
$SecretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
$EvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT).Path
Set-Location -LiteralPath $RepositoryRoot
$ComposeFile = Join-Path $RepositoryRoot 'infra\compose\compose.yml'
$ComposeEnv = Join-Path $RepositoryRoot 'infra\compose\.env'
$ComposeArgs = @('compose','--env-file',$ComposeEnv,'-f',$ComposeFile)
if (-not (Test-Path -LiteralPath 'package.json' -PathType Leaf)) { throw '当前目录不是 OCC 仓库根目录' }
$DockerOsType = & docker info --format '{{.OSType}}'
$DockerInfoExit = $LASTEXITCODE
if ($DockerInfoExit -ne 0) { throw "Docker Engine 查询失败，退出码 $DockerInfoExit" }
if ($DockerOsType -ne 'linux') { throw 'Docker Desktop 未使用 Linux containers' }
& docker @ComposeArgs version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 不可用' }
$LifecycleLockPath = Join-Path $EvidenceRoot 'innorder-occ-lifecycle.lock'
try {
  $LifecycleLock = [IO.File]::Open($LifecycleLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
} catch [IO.IOException] {
  throw '另一个受管 OCC 生命周期、备份、恢复、升级或轮换操作持有项目全局锁'
}
```

从本章首次部署到最终验收必须在同一 PowerShell 进程持有 `$LifecycleLock`；任何失败都先保持现场，退出该进程会由操作系统释放锁。只读检查无需锁，但不得在另一个窗口执行会改变容器、数据或凭据的命令。

### 执行第 02 章部署前检查

逐项执行[第 02 章 Windows 预检](02-preflight-and-capacity.md)中的操作系统/AMD64、Docker Desktop/WSL2、CPU、内存、磁盘、时间、DNS/TLS、最终八端口、Git revision、Node 22、host `psql`、JDK 21 toolchain 和 OPA 检查。预检必须使用最终 `.env` 端口覆盖复测；初始容量数字只是规划基线，生产候选还需要代表性负载和恢复验证。

```powershell
$ErrorActionPreference = 'Stop'
function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory=$true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory=$true)][string]$FailureMessage
  )
  & $FilePath @ArgumentList
  $nativeExit = $LASTEXITCODE
  if ($nativeExit -ne 0) { throw "$FailureMessage，退出码 $nativeExit" }
}
if ($PSVersionTable.PSVersion.Major -ne 5) { throw '必须使用 Windows PowerShell 5.1' }
Invoke-CheckedNative -FilePath 'docker' -ArgumentList @('version') -FailureMessage 'Docker Client/Server 版本检查失败'
Invoke-CheckedNative -FilePath 'docker' -ArgumentList @('compose','version') -FailureMessage 'Docker Compose v2 版本检查失败'
Invoke-CheckedNative -FilePath 'docker' -ArgumentList @('info','--format','OSType={{.OSType}} Architecture={{.Architecture}} CPUs={{.NCPU}} Memory={{.MemTotal}}') -FailureMessage 'Docker Engine 信息检查失败'
Invoke-CheckedNative -FilePath 'wsl.exe' -ArgumentList @('--status') -FailureMessage 'WSL2 状态检查失败'
Invoke-CheckedNative -FilePath 'git' -ArgumentList @('-c',"safe.directory=$RepositoryRoot",'rev-parse','HEAD') -FailureMessage 'Git revision 检查失败'
Invoke-CheckedNative -FilePath 'git' -ArgumentList @('-c',"safe.directory=$RepositoryRoot",'status','--short') -FailureMessage 'Git 工作区状态检查失败'
Invoke-CheckedNative -FilePath 'node' -ArgumentList @('--version') -FailureMessage 'Node.js 版本检查失败'
Invoke-CheckedNative -FilePath 'npm' -ArgumentList @('--version') -FailureMessage 'npm 版本检查失败'
Invoke-CheckedNative -FilePath 'java' -ArgumentList @('-version') -FailureMessage 'Java 版本检查失败'
Invoke-CheckedNative -FilePath './gradlew.bat' -ArgumentList @('--version') -FailureMessage 'Gradle wrapper 版本检查失败'
```

`Invoke-CheckedNative` 在每条必需命令后立即保存 `$LASTEXITCODE`；后续 PowerShell 命令不会覆盖判定。`java -version` 通常把合法版本写到 stderr，脚本不把 stderr 本身视为失败，只以原生退出码判断。

**验证：** 第 02 章检查单必须全部通过并进入变更证据。未知工作区修改、端口占用、Engine 不可连接、密钥目录位于仓库/临时目录、DNS/TLS 失败或容量未批准时不得继续；不得终止未知进程或关闭证书校验来绕过失败。

## 密钥准备与第 03 章门禁

严格执行[第 03 章 Windows 密钥和配置步骤](03-secrets-and-configuration.md)：在仓库外持久目录创建八个互异标量文件和一对 JWT PEM 文件，关闭 ACL 继承，仅授权部署身份、`SYSTEM`、本机 Administrators 以及经批准的 Docker 服务身份；然后创建只保存十个绝对文件路径、必填 issuer 和十二个可选非敏感覆盖项的 `infra/compose/.env`。

**安全：** 不在命令、工单、截图、PowerShell history、进程参数、`.env`、Compose YAML 或日志中放置密钥值。三个 PostgreSQL 密码必须互异，MinIO root 与应用用户名/密码必须不同。密钥生成与内容/ACL 检验直接使用第 03 章脚本，不另造较弱版本。

```powershell
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $SecretRoot -PathType Container)) { throw '密钥目录不存在' }
if ($SecretRoot.StartsWith($RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '密钥目录不能位于仓库内' }
$ignored = git check-ignore infra/compose/.env
if ($LASTEXITCODE -ne 0 -or $ignored -notcontains 'infra/compose/.env') { throw '.env 未被 Git 忽略' }
$expected = 'postgres-admin-password','postgres-flyway-password','postgres-runtime-password','redis-password','minio-root-user','minio-root-password','minio-app-user','minio-app-password','occ-jwt-private-key.pem','occ-jwt-public-key.pem'
$actual = @(Get-ChildItem -LiteralPath $SecretRoot -Force)
if ($actual.Count -ne 10 -or (Compare-Object $expected @($actual.Name))) { throw '密钥目录内容不符合第 03 章要求' }
if (-not (Test-Path -LiteralPath $ComposeEnv -PathType Leaf)) { throw 'infra/compose/.env 不存在' }
Write-Output '密钥目录文件名、外部位置和 .env 忽略规则门禁通过；继续运行第 03 章完整内容与 ACL 验证'
```

**验证：** 第 03 章完整验证器必须只输出通过结论，不输出值或散列；十个 `.env` 路径必须分别指向预期普通文件。Compose 插值成功不能替代文件内容、唯一性、JWT 配对和 ACL 检查。

## 配置解析、依赖安装与严格验证

### 安全派生有效配置

后续探测必须使用 `.env` 的实际覆盖值。以下解析器只接受第 03 章允许的 key，不执行文件内容，不把密钥路径或值输出到屏幕；空端口采用 Compose 默认值。

```powershell
$ErrorActionPreference = 'Stop'
$Config = @{}
$AllowedKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','OCC_JWT_PRIVATE_KEY_FILE','OCC_JWT_PUBLIC_KEY_FILE','OCC_JWT_ISSUER','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
Get-Content -LiteralPath $ComposeEnv | ForEach-Object {
  if ($_ -and -not $_.StartsWith('#')) {
    $parts = $_ -split '=', 2
    if ($parts.Count -ne 2 -or $AllowedKeys -notcontains $parts[0] -or $Config.ContainsKey($parts[0])) { throw '无效、未知或重复的 .env key' }
    $Config[$parts[0]] = $parts[1]
  }
}
function Get-EffectiveValue([string]$Name, [string]$Default) {
  if (-not $Config.ContainsKey($Name) -or [string]::IsNullOrEmpty($Config[$Name])) { return $Default }
  return $Config[$Name]
}
$Ports = [ordered]@{
  Postgres = [int](Get-EffectiveValue 'POSTGRES_PORT' '5432')
  Kafka = [int](Get-EffectiveValue 'KAFKA_PORT' '9092')
  Redis = [int](Get-EffectiveValue 'REDIS_PORT' '6379')
  MinioApi = [int](Get-EffectiveValue 'MINIO_API_PORT' '9000')
  MinioConsole = [int](Get-EffectiveValue 'MINIO_CONSOLE_PORT' '9001')
  Opa = [int](Get-EffectiveValue 'OPA_PORT' '8181')
  Ai = [int](Get-EffectiveValue 'AI_PORT' '3100')
  Core = [int](Get-EffectiveValue 'CORE_PORT' '8080')
}
$DatabaseName = Get-EffectiveValue 'POSTGRES_DB' 'innorder_occ'
$BucketName = Get-EffectiveValue 'OBJECT_STORAGE_BUCKET' 'innorder-occ'
$Ports.GetEnumerator() | ForEach-Object { [pscustomobject]@{ Service=$_.Key; EffectivePort=$_.Value } } | Format-Table -AutoSize
```

默认端口依次是 PostgreSQL `5432`、Kafka `9092`、Redis `6379`、MinIO API `9000`、MinIO Console `9001`、OPA `8181`、AI `3100`、Core `8080`。表中 `EffectivePort` 是后续命令实际使用值；它可能与默认值不同。

### 经过来源验证的安装和官方 OPA 路径

`install:verified` 必须在严格验证和 Compose 构建前执行。它使用 lockfile、官方 npm registry 和仓库来源守卫；普通 `npm install` 不能替代。

```powershell
$ErrorActionPreference = 'Stop'
npm run install:verified
if ($LASTEXITCODE -ne 0) { throw 'npm 经过来源验证的干净安装失败' }
$OpaCommand = Get-Command opa -CommandType Application -ErrorAction Stop
$OpaPath = $OpaCommand.Source
if (-not [IO.Path]::IsPathRooted($OpaPath)) { throw 'OPA_PATH 必须解析为绝对路径' }
& $OpaPath version
if ($LASTEXITCODE -ne 0) { throw 'OPA 可执行文件不能运行' }
```

OPA 应来自 Open Policy Agent 官方发布渠道，并按组织批准的 checksum/签名与版本清单核验；记录版本和文件摘要，不把临时下载位置写入运行手册或发布配置。Compose 镜像中的 OPA 已由 Dockerfile 固定为 `1.5.1` 及 digest；host OPA 也应使用经批准的兼容版本。`Get-Command` 后保存绝对 `$OpaPath`，避免后续 PATH 改变选择另一个程序。

### 严格发布验证和 Compose 配置验证

```powershell
$ErrorActionPreference = 'Stop'
$PreviousOpaPath = $env:OPA_PATH
try {
  $env:OPA_PATH = $OpaPath
  npm run verify:full
  if ($LASTEXITCODE -ne 0) { throw 'verify:full 失败' }
} finally {
  if ($null -eq $PreviousOpaPath) { Remove-Item Env:OPA_PATH -ErrorAction SilentlyContinue } else { $env:OPA_PATH = $PreviousOpaPath }
}
& docker @ComposeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose 配置或插值验证失败' }
& docker @ComposeArgs config --services
if ($LASTEXITCODE -ne 0) { throw '无法列出 Compose 服务' }
```

**验证：** `verify:full` 必须以零退出，Docker/PostgreSQL 集成和真实 OPA 测试不得 skipped；`config --quiet` 必须以零退出。失败时保留脱敏日志、修复根因并从失败门禁重跑，不得以 `verify`、`verify:local` 或删除测试结果替代。

## 镜像构建

标准构建与启动分开执行，便于把构建失败和运行失败分离。构建会拉取固定 digest 的外部镜像并生成 `opa`、`ai`、`core`、`host-gateway` 本地镜像；不使用 `--no-verify`、自定义 Electron 镜像或未审批代理绕过来源控制。

```powershell
$ErrorActionPreference = 'Stop'
& docker @ComposeArgs build --pull
if ($LASTEXITCODE -ne 0) { throw 'Compose 标准镜像构建失败' }
& docker @ComposeArgs images
if ($LASTEXITCODE -ne 0) { throw '无法读取构建后镜像清单' }
```

**验证：** 四个本地构建服务都有镜像，外部镜像仍保留可读 tag 和 `sha256` digest。构建失败不会改变正在运行容器；收集构建日志时先检查代理 URL、用户名和文件路径，不归档认证头或环境转储。

## 分离模式启动

`up -d` 创建或重建与配置不一致的容器，在后台返回；它不等于所有健康检查和一次性初始化已通过。首次部署、配置变更或镜像变化后均运行同一显式命令。

```powershell
$ErrorActionPreference = 'Stop'
& docker @ComposeArgs up -d
if ($LASTEXITCODE -ne 0) { throw 'Compose up -d 创建或启动失败；立即检查状态和日志' }
& docker @ComposeArgs ps -a
```

**注意：** Compose v5 的 `up -d --wait` 可能因为成功完成的 `postgres-init`、`flowable-init` 或 `minio-init` 已退出而返回非零，即使八个长运行服务全部健康。这是一次性容器与 wait 判定的交互，不能把非零直接改写为部署失败，也不能忽略。标准流程使用 `up -d`，随后按下一节分别验证三个精确退出码和八个健康状态；即使使用了 `--wait`，最终结论也只能来自这两组检查。

## 状态与一次性任务验收

### 三个一次性服务的精确退出码

```powershell
$ErrorActionPreference = 'Stop'
$OneShots = 'postgres-init','flowable-init','minio-init'
foreach ($service in $OneShots) {
  $containerId = (& docker @ComposeArgs ps -a -q $service | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) { throw "$service 容器不存在" }
  $state = docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' $containerId
  if ($LASTEXITCODE -ne 0) { throw "无法检查 $service" }
  $parts = $state -split ' '
  if ($parts[0] -ne 'exited' -or [int]$parts[1] -ne 0) { throw "$service 必须是 exited 且退出码精确为 0，实际为 $state" }
  Write-Output "$service PASS exited 0"
}
```

`postgres-init` 的零退出证明 PostgreSQL 可连接且 `minio-data` 所有权准备完成；`flowable-init` 的零退出证明 Flowable 私有表初始化完成；`minio-init` 的零退出证明建桶、应用用户和策略命令完成。非零时不得反复重跑掩盖原因：先保存对应日志并修复根因，再用 `up -d` 协调。

### 八个长运行服务的健康状态

```powershell
$ErrorActionPreference = 'Stop'
$LongRunning = 'postgres','kafka','redis','minio','opa','ai','core','host-gateway'
$Deadline = (Get-Date).AddMinutes(10)
do {
  $notReady = New-Object System.Collections.Generic.List[string]
  foreach ($service in $LongRunning) {
    $containerId = (& docker @ComposeArgs ps -q $service | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($containerId)) { $notReady.Add("$service=missing"); continue }
    $state = docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' $containerId
    if ($state -ne 'running healthy') { $notReady.Add("$service=$state") }
  }
  if ($notReady.Count -eq 0) { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $Deadline)
if ($notReady.Count -gt 0) { $notReady | ForEach-Object { [Console]::Error.WriteLine($_) }; throw '八个长运行服务未在时限内全部达到 running healthy' }
& docker @ComposeArgs ps -a
Write-Output '八个长运行服务均为 running healthy；三个一次性服务仍需保持 exited 0'
```

**验证：** 总体期望是八个 `running healthy` 加三个 `exited 0`。网关 healthy 只证明八个监听器存在，不证明上游；Core readiness 只证明 `ping` 和数据库，不证明 Kafka、Redis、MinIO、OPA、AI 全部可用。

## HTTP 探测与有效端口

重新运行“安全派生有效配置”块建立 `$Ports`。以下检查直接使用 `.env` 覆盖后的端口；默认地址分别是 `http://127.0.0.1:8080/actuator/health/readiness`、`http://127.0.0.1:3100/health`、`http://127.0.0.1:8181/health`、`http://127.0.0.1:9000/minio/health/ready`。MinIO Console 只检查 HTTP 可达性，不把控制台页面当作 MinIO readiness。

```powershell
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$HttpChecks = @(
  [pscustomobject]@{ Name='core-readiness'; Uri="http://127.0.0.1:$($Ports.Core)/actuator/health/readiness"; Allowed=@(200) }
  [pscustomobject]@{ Name='core-status'; Uri="http://127.0.0.1:$($Ports.Core)/api/v1/system/status"; Allowed=@(200) }
  [pscustomobject]@{ Name='ai-health'; Uri="http://127.0.0.1:$($Ports.Ai)/health"; Allowed=@(200) }
  [pscustomobject]@{ Name='ai-status'; Uri="http://127.0.0.1:$($Ports.Ai)/api/v1/system/status"; Allowed=@(200) }
  [pscustomobject]@{ Name='opa-health'; Uri="http://127.0.0.1:$($Ports.Opa)/health"; Allowed=@(200) }
  [pscustomobject]@{ Name='minio-readiness'; Uri="http://127.0.0.1:$($Ports.MinioApi)/minio/health/ready"; Allowed=@(200) }
  [pscustomobject]@{ Name='minio-console-reachability'; Uri="http://127.0.0.1:$($Ports.MinioConsole)/"; Allowed=@(200,301,302,303,307,308) }
)
foreach ($check in $HttpChecks) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $check.Uri -Method Get -MaximumRedirection 0 -TimeoutSec 15
    $status = [int]$response.StatusCode
  } catch [Net.WebException] {
    if ($null -eq $_.Exception.Response) { throw }
    $status = [int]$_.Exception.Response.StatusCode
  }
  if ($check.Allowed -notcontains $status) { throw "$($check.Name) 返回 HTTP $status" }
  Write-Output "$($check.Name) PASS HTTP $status $($check.Uri)"
}
```

检查 Core readiness JSON 时确认总体 `UP` 且组件只有 `ping` 和 `db`；依赖状态看 Core system status 和各服务原生检查。不要向健康路由增加认证数据，也不要把响应正文未经审查直接附入外部工单。

## TCP 与协议探测

### 八个回环 TCP 入口

TCP 成功只证明网关接受并完成了当前连接，不等于协议认证或业务语义成功。

```powershell
$ErrorActionPreference = 'Stop'
foreach ($entry in $Ports.GetEnumerator()) {
  $result = Test-NetConnection -ComputerName 127.0.0.1 -Port $entry.Value -InformationLevel Detailed
  if (-not $result.TcpTestSucceeded) { throw "$($entry.Key) TCP 端口 $($entry.Value) 不可达" }
  [pscustomobject]@{ Service=$entry.Key; Address='127.0.0.1'; Port=$entry.Value; Tcp='PASS' }
}
```

### host 客户端协议验证

优先使用经过批准的 host 客户端，因为它同时验证回环发布、网关转发和上游协议。PostgreSQL 使用 `psql --password` 的隐藏交互提示，Redis 使用 `redis-cli --askpass`；密码不能出现在命令参数、PowerShell 命令历史或日志。Kafka 当前为回环 `PLAINTEXT` 且无认证，只执行只读 metadata/topic-list 检查。

```powershell
$ErrorActionPreference = 'Stop'
Get-Command psql -CommandType Application -ErrorAction Stop | Out-Null
psql --host 127.0.0.1 --port $Ports.Postgres --dbname $DatabaseName --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
if ($LASTEXITCODE -ne 0) { throw 'host PostgreSQL 协议验证失败' }

$RedisCli = Get-Command redis-cli -CommandType Application -ErrorAction SilentlyContinue
if ($null -ne $RedisCli) {
  & $RedisCli.Source -h 127.0.0.1 -p $Ports.Redis --askpass PING
  if ($LASTEXITCODE -ne 0) { throw 'host Redis 协议验证失败' }
} else {
  Write-Warning 'host redis-cli 不可用；必须执行下方受限容器替代检查，并把 host 客户端缺口记录为运维就绪风险'
}

$KafkaTopics = Get-Command kafka-topics -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $KafkaTopics) { $KafkaTopics = Get-Command kafka-topics.bat -CommandType Application -ErrorAction SilentlyContinue }
if ($null -ne $KafkaTopics) {
  & $KafkaTopics.Source --bootstrap-server "127.0.0.1:$($Ports.Kafka)" --list
  if ($LASTEXITCODE -ne 0) { throw 'host Kafka 协议验证失败' }
} else {
  Write-Warning 'host Kafka client 不可用；执行下方容器内替代检查，且不能据此宣称主机 Kafka 协议路径已完整验证'
}
```

操作员通过批准的密码管理器读取 PostgreSQL runtime/Redis 值，并只在客户端隐藏提示中输入。结束后关闭会话；不要设置 `PGPASSWORD`、`REDISCLI_AUTH` 为长期用户环境变量。命令输出只包含角色/数据库、`PONG` 或 topic 名，不应包含凭据。

### 安全替代检查

仅当对应 host 客户端不可用时使用。替代检查在内部容器网络执行，**不能验证 host-gateway 的主机协议路径**；必须与八端口 TCP 检查组合，并记录验收限制。密码由容器内 secret 文件进入短生命周期环境，不出现在 host argv 或输出，命令结束立即清除。

```powershell
$ErrorActionPreference = 'Stop'
& docker @ComposeArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"; psql --host 127.0.0.1 --username innorder_runtime --dbname "$POSTGRES_DB" --no-password --command "SELECT current_user, current_database();"; status=$?; unset PGPASSWORD; exit $status'
if ($LASTEXITCODE -ne 0) { throw '容器内 PostgreSQL 替代检查失败' }
& docker @ComposeArgs exec -T redis sh -ec 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; redis-cli --no-auth-warning PING; status=$?; unset REDISCLI_AUTH; exit $status'
if ($LASTEXITCODE -ne 0) { throw '容器内 Redis 替代检查失败' }
& docker @ComposeArgs exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
if ($LASTEXITCODE -ne 0) { throw '容器内 Kafka 替代检查失败' }
```

## 可选的网关上游隔离验证

此步骤只允许在非生产、无业务流量的受控验收环境执行。它会停止 AI，造成 AI HTTP/TCP 路径短时不可用，但不改变持久数据；前提是八个长运行服务/三个一次性服务检查已通过、日志已留存、维护窗口和恢复责任人已确认。生产环境跳过并依赖仓库网关契约测试。

**注意：** 执行前由审批流程在当前会话设置 `OCC_CONFIRM_GATEWAY_ISOLATION=NON_PRODUCTION_APPROVED`。以下命令不会接受其他值。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_GATEWAY_ISOLATION -ne 'NON_PRODUCTION_APPROVED') { throw '未确认非生产网关隔离测试' }
& docker @ComposeArgs stop ai
if ($LASTEXITCODE -ne 0) { throw '停止 AI 失败' }
try {
  Start-Sleep -Seconds 3
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Ai)/health" -TimeoutSec 5 | Out-Null
    throw 'AI 停止后仍返回健康，隔离前提不成立'
  } catch [Net.WebException] {
    Write-Output 'AI 上游按预期不可用'
  }
  Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Core)/actuator/health/readiness" -TimeoutSec 15 | Out-Null
  $gatewayId = (& docker @ComposeArgs ps -q host-gateway | Select-Object -First 1)
  $gatewayHealth = docker inspect --format '{{.State.Health.Status}}' $gatewayId
  if ($gatewayHealth -ne 'healthy') { throw '单个上游停止影响了网关健康' }
  Write-Output 'PASS：AI 上游失败时 Core 路由与 host-gateway 健康保持隔离'
} finally {
  & docker @ComposeArgs start ai
  if ($LASTEXITCODE -ne 0) { throw '恢复 AI 启动失败，立即升级事件' }
  Remove-Item Env:OCC_CONFIRM_GATEWAY_ISOLATION -ErrorAction SilentlyContinue
}
```

恢复后重新运行八服务健康、AI HTTP 和 TCP 探测。AI 未恢复 healthy 时保持变更窗口，不继续发布；查看 AI/网关日志，必要时用已验证的原镜像执行下一节重建。该测试不证明所有上游组合或长期降级行为。

## 重启、主机重启与镜像重建

### 单服务受控重启

重启会中断目标服务现有连接。先确认变更窗口、调用方重试能力、当前健康和持久数据备份策略；由审批流程设置服务变量，只允许八个长运行服务。重启不会重新构建镜像，也不保证重新读取已变更的 Compose 配置或 secret 挂载。

```powershell
$ErrorActionPreference = 'Stop'
$AllowedRestartServices = 'postgres','kafka','redis','minio','opa','ai','core','host-gateway'
if ($AllowedRestartServices -notcontains $env:OCC_RESTART_SERVICE) { throw 'OCC_RESTART_SERVICE 不是允许的长运行服务' }
if ($env:OCC_CONFIRM_RESTART -ne 'APPROVED') { throw '未确认服务重启影响' }
& docker @ComposeArgs restart $env:OCC_RESTART_SERVICE
if ($LASTEXITCODE -ne 0) { throw '服务重启命令失败' }
& docker @ComposeArgs ps $env:OCC_RESTART_SERVICE
Remove-Item Env:OCC_CONFIRM_RESTART -ErrorAction SilentlyContinue
Remove-Item Env:OCC_RESTART_SERVICE -ErrorAction SilentlyContinue
```

验证目标恢复 `running healthy`，再执行其 HTTP/协议检查。失败时停止重复重启，收集日志并修复根因；若重启前正常且没有数据/配置变更，可 `start` 原容器恢复，否则按备份和组件恢复程序处理。

### 应用新镜像或配置的重建

`restart` 不采用新镜像。重建目标服务会中断该服务并替换容器；先保留旧镜像 ID、确认数据库迁移兼容性、有效备份、维护窗口和回退镜像可用，再执行。以 AI 为例，服务名来自受限变量而不是手工改命令。

```powershell
$ErrorActionPreference = 'Stop'
$RecreateAllowed = 'opa','ai','core','host-gateway'
if ($RecreateAllowed -notcontains $env:OCC_RECREATE_SERVICE) { throw '只允许重建仓库本地构建服务' }
if ($env:OCC_CONFIRM_RECREATE -ne 'APPROVED') { throw '未确认镜像重建影响与回退条件' }
& docker @ComposeArgs build --pull $env:OCC_RECREATE_SERVICE
if ($LASTEXITCODE -ne 0) { throw '目标镜像构建失败；运行容器未改变' }
& docker @ComposeArgs up -d --no-deps --force-recreate $env:OCC_RECREATE_SERVICE
if ($LASTEXITCODE -ne 0) { throw '目标容器重建失败；使用记录的旧镜像/源码 revision 重建并恢复' }
Remove-Item Env:OCC_CONFIRM_RECREATE -ErrorAction SilentlyContinue
Remove-Item Env:OCC_RECREATE_SERVICE -ErrorAction SilentlyContinue
```

Core 重建可能运行 Flyway；镜像回退不等于数据库迁移回退。验证目标健康、HTTP/协议和总体状态；失败时保留新旧镜像 ID及日志，只有迁移兼容性明确时才切回原 revision 构建的镜像。

### Windows 或 Docker Desktop 重启

八个长运行服务配置 `restart: unless-stopped`。Docker Desktop Engine 正常重启后，未被显式停止的容器通常自动恢复；`docker compose down` 删除的容器不会恢复，曾被手工 stop 的容器也不能假定自动启动。三个一次性服务为 `restart: "no"`，正常保持 `exited 0`。

主机重启影响全部本机 OCC 连接。前提是维护窗口、应用静默、数据库/对象备份状态、Docker Desktop 登录启动策略和恢复值班人已确认；在操作系统界面确认重启，不在文档提供可误执行的强制重启命令。系统回来后登录批准的部署账号，等待 Docker Desktop Engine 可响应，重新初始化会话，然后执行：

```powershell
$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddMinutes(10)
do {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $deadline)
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop 未在时限内恢复' }
& docker @ComposeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw '重启后 Compose 配置验证失败' }
& docker @ComposeArgs up -d
if ($LASTEXITCODE -ne 0) { throw '重启后 Compose 协调失败' }
& docker @ComposeArgs ps -a
```

重新执行三个 `exited 0`、八个 `running healthy`、HTTP、TCP 和协议验收。恢复失败时不要删除卷；保留 Docker Desktop/WSL2 状态和容器日志，修复 Engine、磁盘、挂载或服务根因后再次 `up -d`。

## 日志与无密钥支持包

日志可能含业务标识、绝对路径或意外敏感值。收集前确认受控证据目录 ACL、工单范围和保留期；不收集 `.env` 内容、密钥文件、`docker inspect` 环境、认证头、shell history 或完整进程环境。

```powershell
$ErrorActionPreference = 'Stop'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BundleRoot = Join-Path $EvidenceRoot "occ-support-$Timestamp"
if (Test-Path -LiteralPath $BundleRoot) { throw '证据目录已存在；禁止覆盖或清理既有证据' }
function Remove-OrSecureEmptyBundle([string]$Path, [string]$CurrentSid) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    return
  } catch {
    $secureAcl = New-Object Security.AccessControl.DirectorySecurity
    $secureAcl.SetAccessRuleProtection($true, $false)
    $identity = New-Object Security.Principal.SecurityIdentifier($CurrentSid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $secureAcl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $secureAcl -ErrorAction Stop
  }
}
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ExpectedSids = @($CurrentSid, 'S-1-5-18', 'S-1-5-32-544')
try {
  New-Item -ItemType Directory -Path $BundleRoot -ErrorAction Stop | Out-Null
  & icacls.exe $BundleRoot /inheritance:r | Out-Null
  $AclInheritanceExit = $LASTEXITCODE
  if ($AclInheritanceExit -ne 0) { throw "关闭证据目录 ACL 继承失败，退出码 $AclInheritanceExit" }
  & icacls.exe $BundleRoot /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  $AclGrantExit = $LASTEXITCODE
  if ($AclGrantExit -ne 0) { throw "设置证据目录 ACL 失败，退出码 $AclGrantExit" }
  $BundleAcl = Get-Acl -LiteralPath $BundleRoot
  if (-not $BundleAcl.AreAccessRulesProtected) { throw '证据目录 ACL 继承仍未关闭' }
  $AllowSids = @($BundleAcl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if ($AllowSids | Where-Object { $ExpectedSids -notcontains $_ }) { throw '证据目录存在未批准的 Allow ACL' }
  foreach ($sid in $ExpectedSids) { if ($AllowSids -notcontains $sid) { throw '证据目录缺少批准 ACL' } }
} catch {
  $AclFailure = $_
  Remove-OrSecureEmptyBundle -Path $BundleRoot -CurrentSid $CurrentSid
  throw $AclFailure
}
try {
  $SavedNativeErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $SupportGitOutput = & git -c "safe.directory=$RepositoryRoot" rev-parse HEAD 2>&1
  $SupportGitExit = $LASTEXITCODE
  if ($SupportGitExit -ne 0) { throw "支持包 Git revision 收集失败，退出码 $SupportGitExit" }
  $SupportDockerVersionOutput = & docker version 2>&1
  $SupportDockerVersionExit = $LASTEXITCODE
  if ($SupportDockerVersionExit -ne 0) { throw "支持包 Docker version 收集失败，退出码 $SupportDockerVersionExit" }
  $SupportComposeVersionOutput = & docker compose version 2>&1
  $SupportComposeVersionExit = $LASTEXITCODE
  if ($SupportComposeVersionExit -ne 0) { throw "支持包 Compose version 收集失败，退出码 $SupportComposeVersionExit" }
  $SupportComposePsOutput = & docker @ComposeArgs ps -a 2>&1
  $SupportComposePsExit = $LASTEXITCODE
  if ($SupportComposePsExit -ne 0) { throw "支持包 Compose 状态收集失败，退出码 $SupportComposePsExit" }
  $SupportImagesOutput = & docker @ComposeArgs images 2>&1
  $SupportImagesExit = $LASTEXITCODE
  if ($SupportImagesExit -ne 0) { throw "支持包镜像清单收集失败，退出码 $SupportImagesExit" }
  $SupportLogsOutput = & docker @ComposeArgs logs --no-color --timestamps --tail 2000 2>&1
  $SupportLogsExit = $LASTEXITCODE
  if ($SupportLogsExit -ne 0) { throw "支持包日志收集失败，退出码 $SupportLogsExit" }
} catch {
  $CollectionFailure = $_
  Remove-OrSecureEmptyBundle -Path $BundleRoot -CurrentSid $CurrentSid
  throw $CollectionFailure
} finally {
  $ErrorActionPreference = $SavedNativeErrorPreference
}
try {
  $SupportGitOutput | Out-File (Join-Path $BundleRoot 'git-revision.txt') -Encoding ascii
  $SupportDockerVersionOutput | Out-File (Join-Path $BundleRoot 'docker-version.txt') -Encoding utf8
  $SupportComposeVersionOutput | Out-File (Join-Path $BundleRoot 'compose-version.txt') -Encoding utf8
  $SupportComposePsOutput | Out-File (Join-Path $BundleRoot 'compose-ps.txt') -Encoding utf8
  $SupportImagesOutput | Out-File (Join-Path $BundleRoot 'compose-images.txt') -Encoding utf8
  $SupportLogsOutput | Out-File (Join-Path $BundleRoot 'compose-logs-review-required.txt') -Encoding utf8
  [IO.File]::WriteAllText((Join-Path $BundleRoot 'bundle-status.txt'), "COMPLETE`r`n", (New-Object Text.UTF8Encoding($false)))
} catch {
  $WriteFailure = $_
  try {
    [IO.File]::WriteAllText((Join-Path $BundleRoot 'bundle-status.txt'), "INCOMPLETE`r`n", (New-Object Text.UTF8Encoding($false)))
  } catch {
    [Console]::Error.WriteLine('支持包写入失败且无法写入 INCOMPLETE 标记；目录保持受限，不得移交。')
  }
  throw $WriteFailure
}
Get-ChildItem -LiteralPath $BundleRoot | Select-Object Name,Length,LastWriteTime
```

先在受控主机人工审查 `compose-logs-review-required.txt`，删除或不可逆遮盖密码、token、用户名、对象键、客户数据、绝对密钥路径和认证信息；二次审查通过后才能压缩和移交。原始文件仍按敏感证据处理。不得使用 `docker compose config` 或 `docker inspect` 作为普通支持包内容，因为前者包含密钥路径，后者包含运行环境和挂载细节。

只有 `bundle-status.txt` 内容为 `COMPLETE` 才表示所有 Git/Docker 原生命令均以零退出且全部文件写入成功；`INCOMPLETE` 或缺少该文件的目录不得压缩、移交或称为完整支持包。当前流程不运行 Compose `config` 或 Docker `inspect`，因为它们会扩大密钥路径、环境和挂载信息暴露面；如果经单独审批加入，必须采用相同的“捕获输出、立即检查 `$LASTEXITCODE`、全部成功后写文件”顺序。验证包只含批准文件、ACL 继承关闭且接收方有授权。收集失败不影响运行服务；修复证据目录权限后重收，不要把材料转移到用户临时目录或同步盘。

## 日常停止与无数据删除的 down

### 临时停止并保留容器

`stop` 会使八个长运行服务不可用，但保留容器、网络和四个命名卷。前提是维护窗口、调用方已静默、数据库/对象操作完成、恢复操作员在场；由审批会话设置确认值。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_STOP -ne 'APPROVED') { throw '未确认全栈停止影响' }
& docker @ComposeArgs stop
if ($LASTEXITCODE -ne 0) { throw 'Compose stop 未完整成功，检查 ps -a' }
& docker @ComposeArgs ps -a
Remove-Item Env:OCC_CONFIRM_STOP -ErrorAction SilentlyContinue
```

验证八个长运行容器不再运行且命名卷仍存在。恢复使用 `up -d`，随后执行完整状态和探测；若停止部分失败，先确认实际状态，不要直接删除容器。

### 常规 down 并保留数据

`down` 停止并删除本项目容器和网络，造成全栈不可用，但默认保留 `postgres-data`、`kafka-data`、`redis-data`、`minio-data`。执行前同样需要维护窗口、静默、当前备份状态记录和恢复责任人。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_DOWN -ne 'APPROVED_KEEP_DATA') { throw '未确认保留数据的 Compose down' }
& docker @ComposeArgs down --remove-orphans
if ($LASTEXITCODE -ne 0) { throw 'Compose down 未完整成功，检查残留容器和网络' }
$RoutinePsOutput = & docker @ComposeArgs ps -a -q
$RoutinePsExit = $LASTEXITCODE
if ($RoutinePsExit -ne 0) { throw "down 后 Compose 容器查询失败，退出码 $RoutinePsExit；保持确认变量，不得推断停机完成" }
$RoutineContainerIds = @($RoutinePsOutput | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($RoutineContainerIds.Count -ne 0) { throw 'down 后仍有项目容器；保持确认变量，检查容器状态和 down 日志后再决定恢复' }
$RoutineVolumeListOutput = & docker volume ls --quiet --filter 'label=com.docker.compose.project=innorder-occ'
$RoutineVolumeListExit = $LASTEXITCODE
if ($RoutineVolumeListExit -ne 0) { throw "down 后数据卷查询失败，退出码 $RoutineVolumeListExit；保持确认变量，不得宣称数据已保留" }
$RoutineVolumes = @($RoutineVolumeListOutput | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($RoutineVolumes.Count -ne 4) { throw "预期保留四个项目卷，实际为 $($RoutineVolumes.Count)；禁止启动空栈，立即核对卷和备份" }
Write-Output '项目容器已全部删除；保留的项目卷如下：'
$RoutineVolumes | Write-Output
Remove-Item Env:OCC_CONFIRM_DOWN -ErrorAction SilentlyContinue
```

**验证：** 只有 Compose 容器查询和 Docker 卷查询均以零退出、项目容器 ID 为空且项目卷精确为四个时，脚本才清除确认变量。任一只读查询失败时保持栈停止，先恢复 Docker Engine 后重跑只读 `ps -a -q` 和卷查询；不要再次执行 `down` 或删除卷。容器残留时根据实际状态完成停机或用原配置恢复。卷少于四个时禁止 `up`，保护现有卷并按备份/恢复程序处置；四卷确认完整后，恢复运行 `config --quiet`、`up -d` 和完整验收。

## 危险的数据删除与恢复限制

**危险：** `docker compose --env-file infra/compose/.env -f infra/compose/compose.yml down --volumes` 会停止全栈并永久删除 Compose 管理的 `postgres-data`、`kafka-data`、`redis-data`、`minio-data`。影响包括数据库事实、Flyway/Flowable 状态、Kafka 日志与 KRaft 元数据、Redis AOF、MinIO 对象/桶/IAM 状态；镜像、源码、`.env` 和密钥文件都不能恢复这些数据。

本章不提供可执行销毁命令。唯一受支持入口是[第 11 章“永久数据销毁”](11-command-reference-and-checklists.md)；必须在同一会话使用其项目全局锁、双人审批、nonce、精确项目/卷清单校验和失败冻结逻辑，禁止从该流程摘抄单条命令或自行简化。在线复制命名卷不是应用一致备份。

**验证：** 只按第 11 章的关闭条件判定销毁是否完成。删除失败或只删部分卷时停止所有创建/启动操作，保存实际卷清单并由恢复负责人决定处置，不能反复执行清理。

恢复只能重新创建空卷并按顺序恢复密钥/配置、PostgreSQL、MinIO、必要的 Kafka/Redis 状态，再启动应用并执行本章全部验收。没有通过恢复演练的外部备份时，已删除的数据可能不可恢复；Docker Desktop 磁盘、回收站、镜像层和重新运行初始化脚本都不是恢复来源。永久退役时按组织政策继续销毁仓库外密钥和备份；灾难误删时保留现场、停止空栈写入并升级为数据丢失事件。

本章部署、维护或停机操作完成且全部验收关闭后执行 `$LifecycleLock.Dispose()` 并清除变量；不得在后台仍有 Compose 操作时提前释放。
