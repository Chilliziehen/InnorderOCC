# 事件处置手册

本章面向当前单客户、单主机 Compose 栈的一线处置。先按[架构与故障边界](01-architecture-and-boundaries.md)判断健康信号能证明什么，再按[日常运维与监控](06-daily-operations-and-monitoring.md)保存基线。涉及数据、迁移或版本时必须同时使用[备份与恢复](07-backup-restore-and-dr.md)和[升级与回滚](08-upgrade-and-rollback.md)。

## 通用安全边界与会话

- 先建立事件号、UTC 时间线、影响客户、当前写入状态、最后正常时间、最近变更和指挥人；没有证据时不猜测根因。
- 先读后写，先单服务后全栈，先恢复受支持配置后考虑恢复数据。不要循环重启、删除容器/卷、修剪镜像或 cache、编辑迁移历史。
- 不得关闭 TLS/证书验证、认证、健康检查、OPA、Flyway、Gradle dependency verification、Electron 来源守卫或文件型密钥控制。授权依赖异常时失败关闭。
- 日志、状态响应和支持包可能含客户数据、用户名、对象键或绝对密钥路径。只放入受限证据目录，人工不可逆脱敏并二次复核后再移交；不收集 `.env` 内容、密钥、认证头、完整环境、主机/容器进程命令行或 `docker inspect` 的环境/挂载详情。当前 Redis 密码存在于长运行进程 argv，进程命令行尤其不得进入支持包。
- `host-gateway` healthy 只证明八个监听器存在；Core readiness 只证明 `ping` 和数据库。三个 one-shot 的正常终态是 `exited 0`。
- `Stop-CoreForIncident`/`stop_core_for_incident` 首次写操作取得全局锁后会持续持有，直到事件指挥明确解除冻结并执行本章释放命令。后续调查、恢复决定和交接都在该所有权下进行；不能只锁住单条 stop。

Windows PowerShell 5.1 初始化、有效配置和检查函数。该块验证 `.env` 的精确允许集合、九个预期密钥路径、端口、数据库名、桶名、日志级别和版本；运行态不要求端口空闲：
Windows PowerShell 5.1 初始化、有效配置和检查函数。该块验证 `.env` 的精确允许集合、十个预期密钥路径、JWT issuer、端口、数据库名、桶名、日志级别和版本；运行态不要求端口空闲：

```powershell
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw '必须使用 Windows PowerShell 5.1' }
foreach ($name in 'OCC_REPOSITORY_ROOT','OCC_EVIDENCE_ROOT','OCC_SECRET_ROOT') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathRooted($value)) { throw "$name 必须是已设置的绝对路径" }
}
$RepositoryRoot = (Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT).Path
$EvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT).Path
$SecretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
Set-Location -LiteralPath $RepositoryRoot
$ComposeEnv = Join-Path $RepositoryRoot 'infra\compose\.env'
$ComposeFile = Join-Path $RepositoryRoot 'infra\compose\compose.yml'
$ComposeArgs = @('compose','--env-file',$ComposeEnv,'-f',$ComposeFile)
function Invoke-CheckedNative([string]$FilePath,[string[]]$ArgumentList,[string]$FailureMessage) {
  & $FilePath @ArgumentList
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$FailureMessage，退出码 $code" }
}
$LifecycleLockPath = Join-Path $EvidenceRoot 'innorder-occ-lifecycle.lock'
function Stop-CoreForIncident {
  if ($null -eq $script:IncidentLifecycleLock) {
    try { $script:IncidentLifecycleLock=[IO.File]::Open($LifecycleLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch [IO.IOException] { throw '另一个受管 OCC 操作持有项目全局锁；禁止并发事件写操作' }
  }
  try {
    Invoke-CheckedNative 'docker' ($ComposeArgs + @('stop','core')) '停止 Core 失败'
  } catch { $script:IncidentLifecycleLock.Dispose(); $script:IncidentLifecycleLock=$null; throw }
}
$AllowedKeys = @('CURSOR_HMAC_KEY_FILE','POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
$RequiredPathKeys = @('CURSOR_HMAC_KEY_FILE','POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE')
$AllowedKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','OCC_JWT_PRIVATE_KEY_FILE','OCC_JWT_PUBLIC_KEY_FILE','OCC_BOOTSTRAP_ADMIN_PASSWORD_FILE','OCC_JWT_ISSUER','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
$RequiredPathKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','OCC_JWT_PRIVATE_KEY_FILE','OCC_JWT_PUBLIC_KEY_FILE')
$Config = @{}
Get-Content -LiteralPath $ComposeEnv | ForEach-Object {
  if ($_ -and -not $_.StartsWith('#')) {
    $parts = $_ -split '=',2
    if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) { throw '无效的 .env 行' }
    $key = $parts[0]
    if ($key -match '(?:PASSWORD|SECRET|ACCESS_KEY|TOKEN)$' -or $key -match '^MINIO_(?:ROOT|APP)_USER$') { throw "禁止 literal credential key: $key" }
    if ($AllowedKeys -notcontains $key -or $Config.ContainsKey($key)) { throw "未知或重复 .env key: $key" }
    $Config[$key] = $parts[1]
  }
}
foreach ($key in $RequiredPathKeys) { if (-not $Config.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($Config[$key])) { throw "缺少必填路径 key: $key" } }
$SecretPathNames = [ordered]@{ CURSOR_HMAC_KEY_FILE='cursor-hmac-key'; POSTGRES_ADMIN_PASSWORD_FILE='postgres-admin-password'; POSTGRES_FLYWAY_PASSWORD_FILE='postgres-flyway-password'; POSTGRES_RUNTIME_PASSWORD_FILE='postgres-runtime-password'; REDIS_PASSWORD_FILE='redis-password'; MINIO_ROOT_USER_FILE='minio-root-user'; MINIO_ROOT_PASSWORD_FILE='minio-root-password'; MINIO_APP_USER_FILE='minio-app-user'; MINIO_APP_PASSWORD_FILE='minio-app-password' }
if (-not $Config.ContainsKey('OCC_JWT_ISSUER') -or $Config.OCC_JWT_ISSUER -notmatch '^https://') { throw '缺少有效 OCC_JWT_ISSUER' }
$SecretPathNames = [ordered]@{ POSTGRES_ADMIN_PASSWORD_FILE='postgres-admin-password'; POSTGRES_FLYWAY_PASSWORD_FILE='postgres-flyway-password'; POSTGRES_RUNTIME_PASSWORD_FILE='postgres-runtime-password'; REDIS_PASSWORD_FILE='redis-password'; MINIO_ROOT_USER_FILE='minio-root-user'; MINIO_ROOT_PASSWORD_FILE='minio-root-password'; MINIO_APP_USER_FILE='minio-app-user'; MINIO_APP_PASSWORD_FILE='minio-app-password'; OCC_JWT_PRIVATE_KEY_FILE='occ-jwt-private-key.pem'; OCC_JWT_PUBLIC_KEY_FILE='occ-jwt-public-key.pem' }
foreach ($entry in $SecretPathNames.GetEnumerator()) {
  if ($Config[$entry.Key] -ne (Join-Path $SecretRoot $entry.Value)) { throw "$($entry.Key) 未指向 OCC_SECRET_ROOT 下的预期文件" }
  $source = Get-Item -LiteralPath $Config[$entry.Key] -Force
  if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$($entry.Key) 未指向普通文件" }
}
function Get-Effective([string]$Name,[string]$Default) { if (-not $Config.ContainsKey($Name) -or [string]::IsNullOrEmpty($Config[$Name])) { $Default } else { $Config[$Name] } }
$PortDefaults = [ordered]@{ Postgres=@('POSTGRES_PORT',5432); Kafka=@('KAFKA_PORT',9092); Redis=@('REDIS_PORT',6379); MinioApi=@('MINIO_API_PORT',9000); MinioConsole=@('MINIO_CONSOLE_PORT',9001); Opa=@('OPA_PORT',8181); Ai=@('AI_PORT',3100); Core=@('CORE_PORT',8080) }
$Ports = [ordered]@{}
$SeenPorts = New-Object System.Collections.Generic.List[int]
foreach ($entry in $PortDefaults.GetEnumerator()) {
  $parsed = 0; $raw = Get-Effective $entry.Value[0] ([string]$entry.Value[1])
  if ($raw -notmatch '^[0-9]+$' -or -not [int]::TryParse($raw,[ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535 -or $SeenPorts.Contains($parsed)) { throw "无效或重复端口: $($entry.Value[0])" }
  $SeenPorts.Add($parsed); $Ports[$entry.Key] = $parsed
}
$DatabaseName = Get-Effective 'POSTGRES_DB' 'innorder_occ'
if ($DatabaseName -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw 'POSTGRES_DB 不符合保守标识符规则' }
$BucketName = Get-Effective 'OBJECT_STORAGE_BUCKET' 'innorder-occ'
if ($BucketName.Length -lt 3 -or $BucketName.Length -gt 63 -or $BucketName -notmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' -or $BucketName.Contains('..') -or $BucketName -match '^\d{1,3}(?:\.\d{1,3}){3}$') { throw 'OBJECT_STORAGE_BUCKET 无效' }
$LogLevel = Get-Effective 'AI_LOG_LEVEL' 'info'; if (@('fatal','error','warn','info','debug','trace') -notcontains $LogLevel) { throw 'AI_LOG_LEVEL 无效' }
$AppVersion = Get-Effective 'APP_VERSION' '0.1.0'; if ([string]::IsNullOrWhiteSpace($AppVersion) -or $AppVersion -ne $AppVersion.Trim()) { throw 'APP_VERSION 无效' }
```

Linux Bash 初始化和等价有效配置验证：

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
secret_root=$(realpath "$OCC_SECRET_ROOT")
cd -- "$repository_root"
compose=(docker compose --env-file "$repository_root/infra/compose/.env" -f "$repository_root/infra/compose/compose.yml")
lifecycle_lock_fd=
stop_core_for_incident() {
  if [ -z "$lifecycle_lock_fd" ]; then exec {lifecycle_lock_fd}>"$evidence_root/innorder-occ-lifecycle.lock"; flock -n "$lifecycle_lock_fd" || { exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; printf '另一个受管 OCC 操作持有项目全局锁；禁止并发事件写操作\n' >&2; return 1; }; fi
  "${compose[@]}" stop core || { local status=$?; flock -u "$lifecycle_lock_fd"; exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; return "$status"; }
}
declare -A config=() allowed=() seen=()
for key in CURSOR_HMAC_KEY_FILE POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
required_paths=(CURSOR_HMAC_KEY_FILE POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE OCC_JWT_PRIVATE_KEY_FILE OCC_JWT_PUBLIC_KEY_FILE OCC_BOOTSTRAP_ADMIN_PASSWORD_FILE OCC_JWT_ISSUER POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
required_paths=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE OCC_JWT_PRIVATE_KEY_FILE OCC_JWT_PUBLIC_KEY_FILE)
while IFS='=' read -r key value || [ -n "$key" ]; do
  value=${value%$'\r'}; [ -z "$key" ] && continue; case "$key" in \#*) continue;; esac
  [[ $key =~ (PASSWORD|SECRET|ACCESS_KEY|TOKEN)$ ]] && exit 1
  [[ $key =~ ^MINIO_(ROOT|APP)_USER$ ]] && exit 1
  [ -n "${allowed[$key]:-}" ] && [ -z "${config[$key]+present}" ] || exit 1
  config[$key]=$value
done <infra/compose/.env
for key in "${required_paths[@]}"; do [ -n "${config[$key]:-}" ] || exit 1; done
path_names=(CURSOR_HMAC_KEY_FILE POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
file_names=(cursor-hmac-key postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password)
[[ ${config[OCC_JWT_ISSUER]:-} == https://* ]] || exit 1
path_names=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE OCC_JWT_PRIVATE_KEY_FILE OCC_JWT_PUBLIC_KEY_FILE)
file_names=(postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password occ-jwt-private-key.pem occ-jwt-public-key.pem)
for index in "${!path_names[@]}"; do name=${path_names[$index]}; [ "${config[$name]}" = "$secret_root/${file_names[$index]}" ] && [ -f "${config[$name]}" ] && [ ! -L "${config[$name]}" ] || exit 1; done
names=(POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT); defaults=(5432 9092 6379 9000 9001 8181 3100 8080)
for index in "${!names[@]}"; do name=${names[$index]}; port=${config[$name]:-${defaults[$index]}}; [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] && [ -z "${seen[$port]:-}" ] || exit 1; seen[$port]=1; done
POSTGRES_PORT=${config[POSTGRES_PORT]:-5432}; KAFKA_PORT=${config[KAFKA_PORT]:-9092}; REDIS_PORT=${config[REDIS_PORT]:-6379}; MINIO_API_PORT=${config[MINIO_API_PORT]:-9000}; MINIO_CONSOLE_PORT=${config[MINIO_CONSOLE_PORT]:-9001}; OPA_PORT=${config[OPA_PORT]:-8181}; AI_PORT=${config[AI_PORT]:-3100}; CORE_PORT=${config[CORE_PORT]:-8080}
POSTGRES_DB=${config[POSTGRES_DB]:-innorder_occ}; [[ $POSTGRES_DB =~ ^[a-z][a-z0-9_]{0,62}$ ]] || exit 1
OBJECT_STORAGE_BUCKET=${config[OBJECT_STORAGE_BUCKET]:-innorder-occ}; [ "${#OBJECT_STORAGE_BUCKET}" -ge 3 ] && [ "${#OBJECT_STORAGE_BUCKET}" -le 63 ] && [[ $OBJECT_STORAGE_BUCKET =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] && [[ $OBJECT_STORAGE_BUCKET != *..* ]] && [[ ! $OBJECT_STORAGE_BUCKET =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || exit 1
AI_LOG_LEVEL=${config[AI_LOG_LEVEL]:-info}; case "$AI_LOG_LEVEL" in fatal|error|warn|info|debug|trace) ;; *) exit 1;; esac
APP_VERSION=${config[APP_VERSION]:-0.1.0}; trimmed=$(printf '%s' "$APP_VERSION" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'); [ -n "$APP_VERSION" ] && [ "$APP_VERSION" = "$trimmed" ] || exit 1
```

通用证据快照必须检查命令退出状态。Windows：

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$IncidentEvidence = Join-Path $EvidenceRoot "incident-$stamp"
New-Item -ItemType Directory -Path $IncidentEvidence -ErrorAction Stop | Out-Null
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$SystemSid = 'S-1-5-18'
$AdministratorsSid = 'S-1-5-32-544'
$CurrentGrant = '*{0}:(OI)(CI)F' -f $CurrentSid
& icacls.exe $IncidentEvidence /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw '关闭事件目录 ACL 继承失败' }
& icacls.exe $IncidentEvidence /grant:r $CurrentGrant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '设置事件目录 ACL 失败' }
$IncidentAcl = Get-Acl -LiteralPath $IncidentEvidence
if (-not $IncidentAcl.AreAccessRulesProtected) { throw '事件目录 ACL 继承仍未关闭' }
$AllowedIncidentSids = @($CurrentSid,$SystemSid,$AdministratorsSid)
$IncidentOwnerSid = $IncidentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($IncidentOwnerSid -notin @($CurrentSid,$AdministratorsSid)) { throw '事件目录所有者不是当前身份或 Administrators' }
$IncidentAllowSids = @($IncidentAcl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
if (Compare-Object @($AllowedIncidentSids | Sort-Object) $IncidentAllowSids) { throw '事件目录 Allow ACL 不是当前 SID、SYSTEM 与 Administrators 的精确集合' }
$commands = @(
  @('docker-version.txt',@('version')),
  @('compose-ps.txt',($ComposeArgs + @('ps','-a'))),
  @('compose-images.txt',($ComposeArgs + @('images'))),
  @('compose-logs-review-required.txt',($ComposeArgs + @('logs','--no-color','--timestamps','--tail','2000')))
)
foreach ($entry in $commands) {
  $savedNativeErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & docker @($entry[1]) 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedNativeErrorPreference }
  $output | Out-File (Join-Path $IncidentEvidence $entry[0]) -Encoding utf8
  if ($code -ne 0) { throw "事件证据命令失败：$($entry[0])，退出码 $code" }
}
```

Linux：

```bash
incident_evidence="$evidence_root/incident-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$incident_evidence"
docker version >"$incident_evidence/docker-version.txt"
"${compose[@]}" ps -a >"$incident_evidence/compose-ps.txt"
"${compose[@]}" images >"$incident_evidence/compose-images.txt"
"${compose[@]}" logs --no-color --timestamps --tail 2000 >"$incident_evidence/compose-logs-review-required.txt" 2>&1
```

Engine 不可用时上述快照无法完成是证据，不是允许跳过。改为收集主机服务、磁盘和时间状态；Engine 恢复后补收 Compose 状态。以下各手册中的“证据命令”均要求先执行适用的通用快照，且在归档前脱敏。

## Docker Engine 不可用

### 1. 症状与影响范围

`docker version` 只有 Client、连接 daemon 失败，Windows Docker Desktop/WSL2 未运行，或 Linux `docker.service` 非 active。全部容器控制面不可观察，八个主机入口通常不可用；不得因此推断四个卷已丢失。

### 2. 立即安全动作

冻结 Compose、备份、升级和清理操作，通知全栈不可用。记录最后一次 daemon/主机重启、存储告警和 Docker context；不切换未知 context，不重装 Docker，不删除 Docker 数据根。

### 3. 证据命令

```powershell
wsl.exe --status; if ($LASTEXITCODE -ne 0) { throw 'WSL 状态查询失败' }
wsl.exe --list --verbose; if ($LASTEXITCODE -ne 0) { throw 'WSL 发行版查询失败' }
Get-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue | Format-List Status,StartType,Name
docker context show; if ($LASTEXITCODE -ne 0) { throw 'Docker context 查询失败' }
Get-Volume | Select-Object DriveLetter,HealthStatus,Size,SizeRemaining
```

```bash
set -euo pipefail
systemctl status --no-pager docker.service || true
journalctl --unit docker.service --since '-2 hours' --no-pager
docker context show
df -hT
df -ih
```

### 4. 主机到容器到依赖决策树

主机磁盘/时间/虚拟化异常，先修主机；主机正常但 daemon inactive，检查服务日志；daemon active 但客户端失败，核对批准 context、socket 权限和服务身份；Engine 响应后才检查十一个容器，再检查 PostgreSQL、Core 和其他依赖。不要在 Engine 不可观察时操作卷文件。

### 5. 从最小到最大修正

恢复批准的 Docker Desktop 启动或 `docker.service`；修复磁盘、WSL2/虚拟化或 socket 权限根因；确认同一 Engine/context 后运行 `config --quiet` 和 `up -d` 协调。重装 Engine、移动 Docker 数据根或主机恢复属于平台变更，需独立审批和可恢复备份。

### 6. 验证与恢复服务

要求 Client/Server 均响应、Linux containers/AMD64 正确、原 context 不变、四卷仍精确存在；再验证八个 `running healthy`、三个 `exited 0`、HTTP/TCP/协议和备份新鲜度。仅 daemon 恢复不代表 OCC 恢复。

### 7. 升级与预防

Engine 数据根不可读、卷缺失、重复崩溃或恢复时间超过窗口时升级平台与恢复负责人。保留 daemon journal/Desktop diagnostics 的脱敏副本；复盘补充磁盘阈值、开机监督、context 固定和 daemon 补丁策略。

## 镜像、构建或来源验证失败

### 1. 症状与影响范围

`install:verified`、Electron 来源守卫、`verify:full`、Gradle strict verification、镜像 pull/build 或 digest 检查失败。构建与运行分离时现有容器通常仍服务；若失败发生在已开始发布后，受替换服务可能不可用。

### 2. 立即安全动作

停止发布，不执行 `up`，保留旧容器和旧 image ID。不得改用普通 `npm install`、第三方 Electron 源、`--dependency-verification off`、浮动镜像 tag、伪造 OPA 或跳过测试。

### 3. 证据命令

```powershell
git -c "safe.directory=$RepositoryRoot" rev-parse HEAD; if ($LASTEXITCODE -ne 0) { throw 'revision 查询失败' }
git -c "safe.directory=$RepositoryRoot" status --short; if ($LASTEXITCODE -ne 0) { throw '工作区查询失败' }
npm run test:provenance; if ($LASTEXITCODE -ne 0) { throw 'npm provenance 测试失败' }
npm run test:electron-provenance; if ($LASTEXITCODE -ne 0) { throw 'Electron provenance 测试失败' }
& docker @ComposeArgs images; if ($LASTEXITCODE -ne 0) { throw '镜像清单失败' }
```

```bash
set -euo pipefail
git rev-parse HEAD
git status --short
npm run test:provenance
npm run test:electron-provenance
"${compose[@]}" images
```

### 4. 主机到容器到依赖决策树

先查主机 DNS/TLS、磁盘、时钟和批准代理；再查 lockfile/revision、Node/JDK/OPA 工具链；再区分 registry pull、Dockerfile build、npm、Electron 或 Gradle verification；最后核对失败是否已影响容器 image ID。官方依赖不可达与内容验证失败是不同安全事件。

### 5. 从最小到最大修正

修复 DNS、时间、受信 CA、磁盘或批准代理；恢复批准 revision/lockfile；由依赖所有者评审合法的新 checksum/签名/keyring/digest 后再更新源码。按[升级门禁](08-upgrade-and-rollback.md)从头重跑。供应链身份不明时隔离构建机并按安全事件处置。

### 6. 验证与恢复服务

`npm run install:verified`、真实 OPA 的 `verify:full`、Gradle strict、Compose config、固定 digest 和四个本地构建 image ID 全部成功；若运行态曾改变，再做完整发布后验收。

### 7. 升级与预防

签名/checksum 不符、未知下载源、构建机疑似失陷或发布物身份漂移立即升级安全负责人。预防项包括受保护 release commit、依赖变更评审、批准 keyring、registry 保留和可重现证据。

## host-gateway、回环端口或单路转发失败

### 1. 症状与影响范围

网关不 healthy、八个端口之一未监听、`address already in use`，或容器内服务健康但主机路径失败。网关整体失败影响全部主机入口；单上游失败应只影响对应路由。

### 2. 立即安全动作

不把绑定改为 `0.0.0.0`，不终止未知进程。记录有效 `.env` 端口、监听进程和网关日志；保留其他可用路由。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps host-gateway; if ($LASTEXITCODE -ne 0) { throw '网关状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 500 host-gateway; if ($LASTEXITCODE -ne 0) { throw '网关日志失败' }
$EffectivePorts = @($Ports.Values)
Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $EffectivePorts -contains $_.LocalPort } | Select-Object LocalAddress,LocalPort,OwningProcess
```

```bash
set -euo pipefail
"${compose[@]}" ps host-gateway
"${compose[@]}" logs --no-color --timestamps --tail 500 host-gateway
for port in "$POSTGRES_PORT" "$KAFKA_PORT" "$REDIS_PORT" "$MINIO_API_PORT" "$MINIO_CONSOLE_PORT" "$OPA_PORT" "$AI_PORT" "$CORE_PORT"; do ss -H -ltnp "sport = :$port"; done
```

### 4. 主机到容器到依赖决策树

先确认主机端口和回环地址是否被批准进程占用；再确认网关容器 `running healthy`、八条发布映射和 `backend`/`host-access`；再从网关对应 socket 到上游服务名/端口；最后检查上游服务。网关内部 `:18000/health` 成功而单路失败，优先查该上游。

### 5. 从最小到最大修正

协调占用者或使用已审批且八端口互异的 `.env` 覆盖；修复 Compose 配置漂移；仅在网关镜像/配置确有问题且其余服务正常时重建 `host-gateway`。网络整体重建会中断全部入口，须维护窗口。

### 6. 验证与恢复服务

确认只有网关发布且均绑定 `127.0.0.1`，网关 healthy，八个有效端口 TCP 通过，并逐项执行 HTTP/协议探测。不能用 TCP 成功替代认证或查询。

### 7. 升级与预防

未知监听进程、安全软件拦截或端口反复漂移时升级主机/安全负责人。预防项是启动前有效端口检查、防火墙审计和网关契约测试。

## 部分上游隔离或 Core 总体状态降级

### 1. 症状与影响范围

Core readiness 为 UP，但 `/api/v1/system/status` 中 Kafka、Redis、MinIO 或 OPA 异常；或一个网关路由失败而其他路由正常。Core status 不含 AI，AI 必须直接检查。影响限于对应依赖边界，但当前基础尚未证明完整生产降级。

### 2. 立即安全动作

识别依赖所有者和受影响操作。OPA 不可用或决策不可信时授权敏感操作失败关闭；MinIO 异常时阻止对象写入；不要因 Core readiness 成功宣布系统正常。

### 3. 证据命令

```powershell
$statusValidationError = $null
try {
  $status = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Core)/api/v1/system/status" -TimeoutSec 15
  if ([int]$status.StatusCode -ne 200) { throw 'Core system status HTTP 失败' }
  $statusPath = Join-Path $IncidentEvidence 'core-system-status-review-required.json'
  [IO.File]::WriteAllText($statusPath,$status.Content,(New-Object Text.UTF8Encoding($false)))
  $statusJson = $status.Content | ConvertFrom-Json
  $allowedStates = @('READY','DEGRADED','UNREACHABLE','CHECKING')
  $expectedTopProperties = @('checkedAt','components','service','state','version')
  if (Compare-Object $expectedTopProperties @($statusJson.PSObject.Properties.Name | Sort-Object)) { throw 'Core status 顶层 schema 无效' }
  $checkedAt = [DateTimeOffset]::MinValue
  if ($statusJson.service -ne 'occ-core' -or $statusJson.version -isnot [string] -or [string]::IsNullOrWhiteSpace($statusJson.version) -or $allowedStates -notcontains $statusJson.state -or -not [DateTimeOffset]::TryParse([string]$statusJson.checkedAt,[ref]$checkedAt)) { throw 'Core status 顶层字段无效' }
  $expectedComponentIds = @('core-runtime','postgresql','flowable','opa','kafka','redis','minio')
  $components = @($statusJson.components)
  if ($components.Count -ne 7) { throw 'Core status 组件数量无效' }
  foreach ($component in $components) {
    $properties = @($component.PSObject.Properties.Name | Sort-Object)
    $requiredProperties = @('checkedAt','id','label','state')
    $allowedProperties = @('checkedAt','detail','id','label','state')
    if (@(Compare-Object $requiredProperties $properties | Where-Object SideIndicator -eq '<=').Count -ne 0 -or @(Compare-Object $allowedProperties $properties | Where-Object SideIndicator -eq '=>').Count -ne 0) { throw 'Core component schema 无效' }
    $componentCheckedAt = [DateTimeOffset]::MinValue
    if ($component.id -isnot [string] -or $component.label -isnot [string] -or [string]::IsNullOrWhiteSpace($component.label) -or $allowedStates -notcontains $component.state -or -not [DateTimeOffset]::TryParse([string]$component.checkedAt,[ref]$componentCheckedAt) -or ($component.PSObject.Properties.Name -contains 'detail' -and $component.detail -isnot [string])) { throw 'Core component 字段无效' }
  }
  $actualComponentIds = @($components | ForEach-Object { $_.id } | Sort-Object)
  if (Compare-Object @($expectedComponentIds | Sort-Object) $actualComponentIds) { throw 'Core status 组件 ID 集合不符合契约' }
  Write-Output "Core aggregate actual state: $($statusJson.state)"
  $components | Select-Object id,state,checkedAt | Format-Table -AutoSize
} catch {
  $statusValidationError = $_.Exception.Message
  Write-Warning "Core status 证据无效或不可用：$statusValidationError"
}
$serviceEvidenceFailures = New-Object System.Collections.Generic.List[string]
foreach ($service in 'kafka','redis','minio','opa','ai','core','host-gateway') {
  & docker @ComposeArgs ps $service
  if ($LASTEXITCODE -ne 0) { $serviceEvidenceFailures.Add($service) }
}
if ($statusValidationError -or $serviceEvidenceFailures.Count -ne 0) { throw "证据收集存在失败；Core status=$statusValidationError；服务=$($serviceEvidenceFailures -join ',')" }
```

```bash
set -euo pipefail
status_file="$incident_evidence/core-system-status-review-required.json"
status_validation_exit=0
if curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$CORE_PORT/api/v1/system/status" >"$status_file"; then
node - "$status_file" <<'NODE' || status_validation_exit=$?
const fs = require('fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const states = new Set(['READY','DEGRADED','UNREACHABLE','CHECKING']);
const expected = ['core-runtime','flowable','kafka','minio','opa','postgresql','redis'];
const exactKeys = (value, allowed, required = allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
if (!exactKeys(status, ['service','version','state','checkedAt','components']) || status.service !== 'occ-core' || typeof status.version !== 'string' || !status.version.trim() || !states.has(status.state) || !timestamp(status.checkedAt) || !Array.isArray(status.components)) process.exit(1);
const validComponent = component => exactKeys(component, ['id','label','state','detail','checkedAt'], ['id','label','state','checkedAt']) && typeof component.id === 'string' && typeof component.label === 'string' && component.label.trim() && states.has(component.state) && timestamp(component.checkedAt) && (!Object.hasOwn(component, 'detail') || typeof component.detail === 'string');
const actual = status.components.map(component => component.id).sort();
if (status.components.length !== 7 || status.components.some(component => !validComponent(component)) || JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
console.log(`Core aggregate actual state: ${status.state}`);
for (const component of status.components) console.log(`${component.id}\t${component.state}\t${component.checkedAt}`);
NODE
else
  status_validation_exit=$?
fi
service_evidence_exit=0
for service in kafka redis minio opa ai core host-gateway; do "${compose[@]}" ps "$service" || service_evidence_exit=1; done
[ "$status_validation_exit" -eq 0 ] && [ "$service_evidence_exit" -eq 0 ]
```

证据阶段接受并明确输出 `READY`、`DEGRADED`、`UNREACHABLE` 或 `CHECKING` 的实际顶层/组件状态；合法的降级状态本身不使采集提前退出。JSON、严格 schema或规范组件 ID无效时记录失败，但仍完成其余容器证据后再返回非零。只有下面的恢复服务门禁要求顶层与七组件全部 `READY`。

### 4. 主机到容器到依赖决策树

先确认主机网关对应路由；再确认 Core 与目标依赖容器是否同在 `backend`；再执行目标原生 health/protocol；最后检查目标的存储、认证和初始化。只修失败支路，不先重启 Core 或网关。

### 5. 从最小到最大修正

修复目标依赖的 DNS、存储、凭据或进程；确认其原生健康后让状态探测自然恢复。仅当目标进程卡死且证据已保存时受控重启目标；不使用全栈 down。

### 6. 验证与恢复服务

目标服务 `running healthy`、原生协议成功、Core system status 顶层和七个规范组件均为 `READY`、对应主机路由成功，且未受影响的其他路由保持成功。`/actuator/health/readiness` 只验证 `ping`/数据库，不是聚合依赖状态。

### 7. 升级与预防

无法确定哪些业务操作依赖故障组件时升级应用所有者并保持受影响操作关闭。补充依赖级告警、合成只读探测和经批准的降级矩阵。

## Core 启动或 readiness 失败

### 1. 症状与影响范围

Core 重启循环、有效 Core 主机端口不可达、readiness DOWN，或 db 组件失败。桌面状态和未来业务入口不可用；其他基础服务可独立健康。

### 2. 立即安全动作

保存首次异常链和 restart count。若日志指向迁移/Flowable，停止 Core 重启循环并转入对应手册；不关闭 health、Flyway 或初始化依赖检测。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps postgres core; if ($LASTEXITCODE -ne 0) { throw 'Core/PostgreSQL 状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 core postgres; if ($LASTEXITCODE -ne 0) { throw 'Core/PostgreSQL 日志失败' }
try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Core)/actuator/health/readiness" -TimeoutSec 10 | Select-Object StatusCode,Content } catch { $_.Exception.Message }
```

```bash
set -euo pipefail
"${compose[@]}" ps postgres core
"${compose[@]}" logs --no-color --timestamps --tail 1000 core postgres
curl --silent --show-error --max-time 10 "http://127.0.0.1:$CORE_PORT/actuator/health/readiness" || true
```

### 4. 主机到容器到依赖决策树

主机端口失败先检查网关；网关正常再看 Core 容器进程/health；Core 未启动从异常链区分 configtree、JVM、Flyway、Flowable；Core 启动但 db DOWN 再查 PostgreSQL网络、runtime 认证和查询。Kafka/Redis/MinIO/OPA/AI 不属于 readiness 门禁。

### 5. 从最小到最大修正

修复配置路径、磁盘或 PostgreSQL；恢复正确的已验证镜像/config；仅在根因消除后启动 Core。涉及 schema 时由 DBA 选择前向修复或完整恢复，不靠旧镜像猜测兼容性。

### 6. 验证与恢复服务

Core `running healthy`，readiness 总体 UP 且组件仅 `ping`、`db`；system status、八个 TCP 和各依赖原生探测通过；restart count 不再增加。

### 7. 升级与预防

异常链不明、重复失败或数据一致性存疑立即升级 Core/DBA。保留 image ID、revision、配置变更和完整异常链；增加启动时长与连接池趋势基线。

## PostgreSQL 健康、连接或认证失败

### 1. 症状与影响范围

`postgres` unhealthy、`pg_isready` 失败、runtime/admin/Flyway 登录失败或 Core db DOWN。数据库是核心事实存储，Core 不可用或不可信；其他服务不代表应用可用。

### 2. 立即安全动作

阻止新写入，保护 `postgres-data`，确认最后备份和磁盘。不要删除卷、重跑空卷初始化、把 runtime 提升为 superuser，或把密码放入 argv/环境转储。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps postgres core; if ($LASTEXITCODE -ne 0) { throw '数据库状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 postgres; if ($LASTEXITCODE -ne 0) { throw '数据库日志失败' }
& docker @ComposeArgs exec -T postgres pg_isready -h 127.0.0.1 -U innorder_admin; if ($LASTEXITCODE -ne 0) { throw 'pg_isready 失败' }
psql --host 127.0.0.1 --port $Ports.Postgres --dbname $DatabaseName --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
if ($LASTEXITCODE -ne 0) { throw 'runtime 隐藏提示登录失败' }
```

```bash
set -euo pipefail
"${compose[@]}" ps postgres core
"${compose[@]}" logs --no-color --timestamps --tail 1000 postgres
"${compose[@]}" exec -T postgres pg_isready -h 127.0.0.1 -U innorder_admin
psql --host 127.0.0.1 --port "$POSTGRES_PORT" --dbname "$POSTGRES_DB" --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
```

### 4. 主机到容器到依赖决策树

先查主机磁盘/inode和 Engine；再查 postgres 容器状态、日志、卷挂载和 `pg_isready`；再区分网络、数据库名、角色、密码和 grants；最后查 Core runtime/Flyway 消费的文件是否与服务端状态协调。`pg_isready` 不证明迁移或应用查询正确。

### 5. 从最小到最大修正

释放非数据文件系统压力或扩容；恢复批准配置/密钥路径；按[协调轮换](03-secrets-and-configuration.md)修复凭据状态；由 DBA 修正已证实的 grants/扩展。数据库损坏走[恢复流程](07-backup-restore-and-dr.md)，不做现场试验性修复。

### 6. 验证与恢复服务

PostgreSQL healthy，三个角色按最小权限分别可执行其必要动作，Core readiness UP，Flyway 历史完整且 success，Flowable 与 system status 正常。确认旧凭据失效仅在批准轮换场景执行。

### 7. 升级与预防

损坏、WAL/存储错误、角色漂移或备份超过 RPO 立即升级 DBA/恢复负责人。预防包括容量趋势、季度恢复演练、三角色权限审计和协调轮换演练。

## Flyway 迁移失败

### 1. 症状与影响范围

Core 启动异常包含 Flyway validation/SQL/checksum/权限失败，`flyway_schema_history` 有失败或版本缺口。schema 可能处于中间态；应用镜像回退不等于数据库回退。

### 2. 立即安全动作

停止 Core 重启循环，冻结升级和写入，验证升级前备份。不得编辑已发布迁移、checksum 或历史，不得 repair/mark success、关闭 Flyway或删卷。

### 3. 证据命令

```powershell
Stop-CoreForIncident
& docker @ComposeArgs logs --no-color --timestamps --tail 2000 core postgres; if ($LASTEXITCODE -ne 0) { throw '迁移日志收集失败' }
& docker @ComposeArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql -U innorder_admin -d "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT installed_rank,version,description,checksum,installed_by,success FROM flyway_schema_history ORDER BY installed_rank"; rc=$?; unset PGPASSWORD; exit $rc'
if ($LASTEXITCODE -ne 0) { throw 'Flyway 历史查询失败' }
```

```bash
set -euo pipefail
stop_core_for_incident
"${compose[@]}" logs --no-color --timestamps --tail 2000 core postgres
"${compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql -U innorder_admin -d "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT installed_rank,version,description,checksum,installed_by,success FROM flyway_schema_history ORDER BY installed_rank"; rc=$?; unset PGPASSWORD; exit $rc'
```

### 4. 主机到容器到依赖决策树

先确认磁盘和 PostgreSQL 可写；再从 Core 首个 Flyway 异常确定连接/验证/SQL；再比较已部署 revision 的不可变迁移 blob、历史和数据库实际对象；最后评估失败语句是否事务化及中间态。没有 DBA 结论不进入修正。

### 5. 从最小到最大修正

先修容量、连接或缺失扩展/grant；若迁移缺陷，发布经评审的新前向修复迁移；若不可安全前向修复，从经隔离验证的完整备份恢复整个集合。严格按[升级失败路径](08-upgrade-and-rollback.md)执行。

### 6. 验证与恢复服务

历史版本和 checksum 与批准源码一致、全部 success、`installed_by=innorder_flyway`，数据库对象/权限验收通过；启动 Core 后 readiness、Flowable 和完整协议检查通过。

### 7. 升级与预防

任何中间态、数据变换或恢复决定必须升级 DBA、迁移所有者和数据所有者。复盘补充事务性、锁、空间、兼容矩阵、前向修复及实测恢复时间。

事件指挥明确解除写入冻结、受影响服务已按批准流程恢复且验收完成后才释放事件锁：Windows 执行 `$script:IncidentLifecycleLock.Dispose(); $script:IncidentLifecycleLock=$null`；Linux 执行 `flock -u "$lifecycle_lock_fd"; exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=`。若保持停机或调查未关闭，不释放锁；值班交接必须转移同一受控会话，不能删除锁文件。

## Flowable schema、权限或引擎初始化失败

### 1. 症状与影响范围

Core 异常指向 `flowable` schema、`ACT_*` 表、版本升级或引擎 bean。Core 启动失败；Flowable 私有表状态可能与固定版本 `7.1.0` 不兼容。

### 2. 立即安全动作

停止 Core，保留数据库。不得关闭 `flowable.depends-on-database-initialization-detection`、强制改变 schema-update 来绕过、复制供应商 DDL，或授予 runtime superuser/schema 所有权。

### 3. 证据命令

```powershell
Stop-CoreForIncident
& docker @ComposeArgs logs --no-color --timestamps --tail 2000 core; if ($LASTEXITCODE -ne 0) { throw 'Core 日志失败' }
& docker @ComposeArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql -U innorder_admin -d "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT nspname,pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = ''flowable''; SELECT grantee,privilege_type FROM information_schema.schema_privileges WHERE schema_name = ''flowable'' ORDER BY grantee,privilege_type;"; rc=$?; unset PGPASSWORD; exit $rc'
if ($LASTEXITCODE -ne 0) { throw 'Flowable 权限证据失败' }
```

```bash
set -euo pipefail
stop_core_for_incident
"${compose[@]}" logs --no-color --timestamps --tail 2000 core
"${compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql -U innorder_admin -d "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT nspname,pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '\''flowable'\''; SELECT grantee,privilege_type FROM information_schema.schema_privileges WHERE schema_name = '\''flowable'\'' ORDER BY grantee,privilege_type;"; rc=$?; unset PGPASSWORD; exit $rc'
```

### 4. 主机到容器到依赖决策树

先确认 PostgreSQL 健康；再确认 Flyway 已完成 V001-V011；再检查 `flowable` owner 应为 `innorder_flyway`、runtime 的 `USAGE,CREATE` 及已有对象权限；最后对照异常链和 `ACT_*` 版本状态。owner 漂移不一定单独导致当前启动失败，但必须修复。

### 5. 从最小到最大修正

由 DBA 恢复源码定义的最小 grants/owner；若供应商表升级失败，按固定 Flowable 版本的经评审前向修复或完整备份恢复。不得手工挑选删除 `ACT_*` 表。

### 6. 验证与恢复服务

Flyway 先完成，Flowable 引擎随后初始化；owner/grants 符合 V001/V009，Core healthy，system status 中 Flowable 探测正常，readiness 和数据库协议通过。

### 7. 升级与预防

表版本不明、对象 owner 混乱或修复需 DDL 时升级 DBA/Core 所有者。预防使用 PostgreSQL+Flowable 集成测试、升级前权限快照和隔离恢复演练。

## Kafka 不健康或外部 listener 失败

### 1. 症状与影响范围

Kafka unhealthy、topic-list 失败、KRaft/cluster ID 错误，或 host client 收到错误 advertised listener。Core readiness 仍可能 UP；当前不承诺消息链降级或消息级恢复。

### 2. 立即安全动作

停止依赖 Kafka 的操作并保存 broker 日志/元数据。保护 `kafka-data`；不删除 KRaft 元数据、不重建 cluster ID、不把 Kafka 当权威业务恢复源。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps kafka host-gateway; if ($LASTEXITCODE -ne 0) { throw 'Kafka 状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 kafka; if ($LASTEXITCODE -ne 0) { throw 'Kafka 日志失败' }
if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $Ports.Kafka -InformationLevel Quiet)) { throw 'Kafka 有效主机 TCP 端口失败' }
& docker @ComposeArgs exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --describe; if ($LASTEXITCODE -ne 0) { throw 'Kafka 内部 metadata 失败' }
```

```bash
set -euo pipefail
"${compose[@]}" ps kafka host-gateway
"${compose[@]}" logs --no-color --timestamps --tail 1000 kafka
timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1; exec 3>&-; exec 3<&-' bash "$KAFKA_PORT"
"${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --describe
```

### 4. 主机到容器到依赖决策树

主机 client 失败先核对有效 `KAFKA_PORT` 与广告的 `localhost`；再查网关的有效主机端口；再查容器内固定 EXTERNAL `9092`、INTERNAL `29092` 和 CONTROLLER `29093`；最后查卷、KRaft 日志和磁盘。内部成功但 host 失败是网关/advertised listener 路径。

### 5. 从最小到最大修正

修复批准端口覆盖/网关；释放磁盘或恢复原配置；证据保存后受控重启 Kafka。卷损坏仅按第 07 章已声明的 `metadata-only`/`cold-archive` 限制处理，不能承诺消息恢复。

### 6. 验证与恢复服务

Kafka `running healthy`，内部 topic-list 和 host `localhost:有效端口` topic-list 均成功，Core system status 恢复；记录 consumer groups 与重平衡影响。

### 7. 升级与预防

KRaft 元数据损坏、消息丢失疑问或 cluster ID 漂移升级 Kafka/数据所有者。预防做磁盘趋势、topic/group 清单和单节点风险接受；真正消息恢复需另行设计复制/导出。

## Redis 健康或认证失败

### 1. 症状与影响范围

Redis unhealthy、认证 `PING` 失败、AOF 错误或 Core status 降级。Redis 架构上应可重建，但当前丢失降级未完整验证，不能直接删除 `redis-data`。

### 2. 立即安全动作

停止依赖 Redis 的操作，保护 AOF/卷和当前密钥文件。当前 Compose 由 shell 读取 secret 后展开 `redis-server --requirepass`，因此长运行 `redis-server` 的 argv 含密码；主机管理员和 Docker/root 等价身份可检查到该值。不得把进程命令行放入证据/支持包，不得关闭 `requirepass`。限制主机管理员与 Docker socket、按第 03 章协调轮换并记录风险接受；不能把现状描述为零 argv 暴露。生产接受必须由安全负责人明确批准该残余风险和整改计划；改为不在长运行 argv 暴露的启动/认证机制属于需单独设计、实现和测试的源码/部署变更。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps redis; if ($LASTEXITCODE -ne 0) { throw 'Redis 状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 redis; if ($LASTEXITCODE -ne 0) { throw 'Redis 日志失败' }
redis-cli -h 127.0.0.1 -p $Ports.Redis --askpass PING; if ($LASTEXITCODE -ne 0) { throw 'Redis 隐藏提示认证失败' }
```

```bash
set -euo pipefail
"${compose[@]}" ps redis
"${compose[@]}" logs --no-color --timestamps --tail 1000 redis
redis-cli -h 127.0.0.1 -p "$REDIS_PORT" --askpass PING
```

### 4. 主机到容器到依赖决策树

先查主机端口/网关；再查 Redis 容器、磁盘、AOF 与 health；再区分 server 当前密码和 Core 挂载密码；最后确认应用是否可安全重建缓存。容器 health 使用文件密码成功而 host 失败，优先查网关或输入凭据。

### 5. 从最小到最大修正

修复磁盘/权限；按[Redis 协调轮换](03-secrets-and-configuration.md)让服务端和 Core 同步；有证据后重启 Redis。只有数据所有者已证明可重建并批准时，才按恢复程序重建空 Redis。

### 6. 验证与恢复服务

Redis healthy，认证 PONG，AOF 无持续错误，Core system status 恢复且旧密码按轮换计划失效。readiness 不包含 Redis，不能替代该验证。

### 7. 升级与预防

AOF 损坏、部分轮换或缓存可丢失性不明时升级组件/数据所有者。预防执行快照 disposition、轮换演练和磁盘延迟/增长监控。

## MinIO server、卷初始化、桶初始化或 IAM 失败

### 1. 症状与影响范围

`postgres-init` 非 `exited 0`、MinIO 不 ready、`minio-init` 非 `exited 0`，或桶级应用账号不能列桶。Core readiness 仍可能 UP；对象能力、桶或 IAM 不可用。

### 2. 立即安全动作

停止对象读写，保护 `minio-data` 和对象备份。区分三个阶段，不反复运行 one-shot，不把应用账号提升为 root，不放宽卷为世界可写。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps -a postgres-init minio minio-init; if ($LASTEXITCODE -ne 0) { throw 'MinIO 状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 postgres-init minio minio-init; if ($LASTEXITCODE -ne 0) { throw 'MinIO 日志失败' }
Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.MinioApi)/minio/health/ready" -TimeoutSec 15 | Out-Null
```

```bash
set -euo pipefail
"${compose[@]}" ps -a postgres-init minio minio-init
"${compose[@]}" logs --no-color --timestamps --tail 1000 postgres-init minio minio-init
curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$MINIO_API_PORT/minio/health/ready" >/dev/null
```

### 4. 主机到容器到依赖决策树

先查主机磁盘/inode与网关；再按 `postgres-init` 的 PostgreSQL 检查与 UID/GID `10001` 所有权、MinIO server readiness、`minio-init` 桶名/四个密钥顺序检查；最后用桶级应用身份验证目标桶。server ready 不证明 IAM 完成，one-shot 旧 `exited 0` 不证明本次发布已初始化。

### 5. 从最小到最大修正

修复卷容量/所有权或安全标签；恢复正确 root/app 文件且保持互异；修正合法桶名；MinIO ready 后只按[升级流程](08-upgrade-and-rollback.md)强制重建一次 `minio-init` 并接受新 container ID。对象损坏按第 07 章恢复，不使用 `mc mirror --remove` 试修。

### 6. 验证与恢复服务

volume-init 为 `exited 0`、MinIO `running healthy`、本次 init 为 `exited 0`；目标桶存在，应用账号只具该桶列取写删权限，不具 admin/root；Core status 和主机 API 路径成功。

### 7. 升级与预防

对象缺失、IAM 漂移、卷损坏或 root 凭据疑似泄露立即升级存储/安全负责人。预防做精确桶镜像、对象清单/checksum、IAM 审计和隔离恢复演练。

## OPA strict 检查、策略加载或决策异常

### 1. 症状与影响范围

OPA 容器重启、`opa check --strict` 失败、health 不通，或决策返回意外 allow/deny/reason。Core readiness 可保持 UP；授权敏感操作必须失败关闭。

### 2. 立即安全动作

阻止授权敏感操作，保留当前策略 revision 和决策输入的最小脱敏复现。不得关闭 OPA、strict check、默认拒绝或临时硬编码 allow。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps opa; if ($LASTEXITCODE -ne 0) { throw 'OPA 状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 opa; if ($LASTEXITCODE -ne 0) { throw 'OPA 日志失败' }
$opaHealth = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Opa)/health" -TimeoutSec 15
if ([int]$opaHealth.StatusCode -ne 200) { throw 'OPA 有效主机端口 health 失败' }
opa check --strict policies/opa; if ($LASTEXITCODE -ne 0) { throw 'OPA strict 检查失败' }
opa test policies/opa; if ($LASTEXITCODE -ne 0) { throw 'OPA 策略测试失败' }
```

```bash
set -euo pipefail
"${compose[@]}" ps opa
"${compose[@]}" logs --no-color --timestamps --tail 1000 opa
curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$OPA_PORT/health" >/dev/null
opa check --strict policies/opa
opa test policies/opa
```

### 4. 主机到容器到依赖决策树

先查 OPA 有效主机端口/网关；再查 OPA health、入口 strict check 和只读 `/policies` 挂载；再对照 `innorder.platform.authz`、输入 schema、显式 DENY/ALLOW 和默认拒绝；最后判断是调用方事实错误还是策略错误。health 只证明进程响应，不证明某决策正确。

### 5. 从最小到最大修正

恢复批准策略 revision/只读挂载；修复输入生产者或经评审的 Rego；本地 strict/test 全过后重建 OPA。策略不确定时维持拒绝，不绕过授权恢复可用性。

### 6. 验证与恢复服务

真实 OPA strict/test 零退出，容器 healthy；无效输入拒绝，显式 deny 优先，只有匹配 allow 且无基线/deny 时允许；Core status 恢复并完成审计样本复核。

### 7. 升级与预防

错误允许、策略来源漂移或输入含敏感数据泄露立即升级安全负责人。预防使用受保护策略评审、回归测试、决策 reason 审计和发布 digest/revision 关联。

## AI 服务异常

### 1. 症状与影响范围

AI unhealthy、有效 AI 主机端口不可达、status/capabilities 不符合严格契约或日志级别异常。受影响的是 AI HTTP 状态和静态契约元数据；当前服务没有 model factory 或真实模型/工具执行，不存在可据此宣称中断的“AI 建议能力”。

### 2. 立即安全动作

冻结任何尚未正式实现却假定依赖 AI 的外部试验操作，保持 Core/事实路径独立。不要伪造 provider、关闭响应验证，或把静态 capabilities 当成工具可执行证明。

### 3. 证据命令

```powershell
& docker @ComposeArgs ps ai; if ($LASTEXITCODE -ne 0) { throw 'AI 状态失败' }
& docker @ComposeArgs logs --no-color --timestamps --tail 1000 ai; if ($LASTEXITCODE -ne 0) { throw 'AI 日志失败' }
foreach ($path in '/health','/api/v1/system/status','/api/v1/providers/capabilities') { $r=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Ai)$path" -TimeoutSec 15; if ([int]$r.StatusCode -ne 200) { throw "AI $path 失败" } }
```

```bash
set -euo pipefail
"${compose[@]}" ps ai
"${compose[@]}" logs --no-color --timestamps --tail 1000 ai
for path in /health /api/v1/system/status /api/v1/providers/capabilities; do curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$AI_PORT$path" >/dev/null; done
```

### 4. 主机到容器到依赖决策树

先查主机端口/网关；再查 AI Node 进程、health、日志和 `APP_VERSION`；再查 system-status/capabilities 是否仍符合源码定义的静态契约。Core 当前没有 AI status probe 或真实 AI 客户端调用，不能用 Core status 诊断 AI。`agent-runtime READY` 和 `supportsTools` 不是运行探测；不存在真实模型依赖时不向外延伸诊断。

### 5. 从最小到最大修正

修复日志级别/版本配置或恢复批准镜像；证据保存后单独重启/重建 AI。不要为 AI 故障重启数据库或 Core。

### 6. 验证与恢复服务

AI `running healthy`，三个直接路由 HTTP 200 且静态契约测试通过；另行确认 Core readiness、Core 聚合的六个依赖和其他七路网关未受影响。不得等待不存在的 Core AI component“恢复”。

### 7. 升级与预防

响应契约漂移、未知网络调用或敏感数据进入日志立即升级 AI/安全负责人。预防固定依赖、契约测试、日志审查和隔离降级演练。

## DNS 或 TLS 失败

### 1. 症状与影响范围

官方 registry/npm/Maven/Gradle/GitHub/Electron 端点解析或证书失败，pull/build/install/patch 受阻；已运行的内部 Compose 网络可能不受影响。

### 2. 立即安全动作

停止下载和发布，记录目标、DNS 答案、证书链、代理与 UTC。不得使用 `--insecure`、关闭证书校验、替换第三方源或导入未知 CA。

### 3. 证据命令

```powershell
Resolve-DnsName registry.npmjs.org -ErrorAction Stop | Select-Object Name,Type,IPAddress
$r=Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmjs.org/-/ping' -TimeoutSec 30
if ([int]$r.StatusCode -ne 200) { throw 'npm TLS/HTTP 失败' }
w32tm /query /status; if ($LASTEXITCODE -ne 0) { throw '时间状态失败' }
```

```bash
set -euo pipefail
getent ahosts registry.npmjs.org >/dev/null
[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 30 https://registry.npmjs.org/-/ping)" = 200 ]
timedatectl timesync-status
```

### 4. 主机到容器到依赖决策树

先查主机时间、DNS 配置和批准代理/CA；再比较多个官方端点以区分单域与全局故障；再查 Docker daemon 与构建容器代理信任；最后回到具体依赖来源。只通 TCP 443 不证明 TLS 正确。

### 5. 从最小到最大修正

恢复组织 DNS、时间同步、代理和批准 CA 链；等待官方端点恢复；由安全团队更新受信根。不要把代理凭据写入 Dockerfile、日志或命令。

### 6. 验证与恢复服务

第 02 章全部官方 DNS/TLS 检查按预期状态码通过，再运行来源验证、strict build 和 digest 检查。确认无临时源/CA 配置遗留。

### 7. 升级与预防

证书主体异常、DNS 污染或未知代理立即升级安全事件。预防监控证书到期、DNS/时间源和批准代理容量，并维护离线但同样签名验证的灾备流程。

## 磁盘或 inode 耗尽

### 1. 症状与影响范围

`no space left`、只读文件系统、数据库/Kafka/Redis/MinIO 写失败、build 失败，或 bytes 尚有余量但 inode 用尽。可能影响全部持久组件并造成数据一致性风险。

### 2. 立即安全动作

停止新写入、构建和日志放大，保护证据与备份。不得运行 `docker system prune`、volume prune、删除数据库/WAL/AOF/Kafka/MinIO 文件或清除事件日志。

### 3. 证据命令

```powershell
Get-Volume | Select-Object DriveLetter,FileSystem,HealthStatus,Size,SizeRemaining
docker system df -v; if ($LASTEXITCODE -ne 0) { throw 'Docker 容量查询失败' }
& docker @ComposeArgs ps -a; if ($LASTEXITCODE -ne 0) { throw '服务状态失败' }
```

```bash
set -euo pipefail
df -hT
df -ih
docker system df -v
"${compose[@]}" ps -a
```

### 4. 主机到容器到依赖决策树

先定位主机文件系统或 Docker 数据根的 bytes/inode；再区分镜像/cache、容器日志和四个命名卷；再查受影响容器日志与存储原生一致性；最后评估 Core 写入。不要仅看 Docker 总量。

### 5. 从最小到最大修正

暂停非必要构建/备份；按批准保留政策迁移已脱敏证据和过期外部备份；扩容文件系统/Docker Desktop 磁盘；只在镜像身份和回退需求审查后删除明确未引用的 build cache。任何数据卷内容处置走第 07 章恢复设计。

### 6. 验证与恢复服务

bytes 与 inode 回到批准余量，文件系统健康可写；逐个验证 PostgreSQL、Kafka、Redis、MinIO 原生状态，再启动 Core并做完整验收。检查数据一致性而非只看 healthy。

### 7. 升级与预防

存储报错、部分写入或备份也受影响时升级 DBA/存储/恢复负责人。预防按卷分别趋势、日志轮转审批、30% 空间基线和增长预测扩容。

## 内存或 CPU 压力

### 1. 症状与影响范围

主机持续高 CPU/内存、OOM、容器被杀、探测超时或构建挤压运行服务。单节点全部服务共享资源，可能连锁失败。

### 2. 立即安全动作

停止非必要构建和批量任务，记录 OOM/调度证据。不要自动重启、关闭 health、提高超时掩盖问题或终止未知进程。

### 3. 证据命令

```powershell
Get-CimInstance Win32_Processor | Select-Object Name,LoadPercentage,NumberOfLogicalProcessors
Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime
docker stats --no-stream; if ($LASTEXITCODE -ne 0) { throw '容器资源查询失败' }
```

```bash
set -euo pipefail
free -h
uptime
vmstat 1 5
docker stats --no-stream
journalctl -k --since '-2 hours' --no-pager | grep -Ei 'oom|out of memory|killed process' || true
```

### 4. 主机到容器到依赖决策树

先区分主机总体与 Docker Desktop 配额；再按容器 CPU/RSS/PID、restart count 定位；再查该服务依赖等待、GC、查询或 I/O；最后区分运行负载与构建峰值。高 CPU 本身不等于应重启。

### 5. 从最小到最大修正

停止已批准的非运行构建/批任务；减少外部流量；按容量计划增加 Docker/主机资源；修复查询、泄漏或负载根因。仅对已证实卡死的单服务在窗口内重启。

### 6. 验证与恢复服务

资源持续回到调优阈值以内，OOM 不再出现，restart count 稳定；全部 health、HTTP、协议延迟和数据一致性检查通过，再恢复流量/构建。

### 7. 升级与预防

OOM 影响 PostgreSQL/持久组件、容量无法恢复或重复泄漏时升级组件/容量负责人。预防分离构建窗口、代表性负载测试和四周趋势调优。

## 主机时钟漂移

### 1. 症状与影响范围

审计顺序异常、证书尚未生效/已过期、Kafka 时间相关异常或主机与事件证据时间不一致。影响证据可信度、TLS 和跨组件关联。

### 2. 立即安全动作

停止升级、轮换和恢复切换，记录当前时间、时区、同步源与偏差。不要手工跳时或关闭证书验证。

### 3. 证据命令

```powershell
Get-Date -Format o
Get-TimeZone
w32tm /query /status; if ($LASTEXITCODE -ne 0) { throw 'Windows 时间状态失败' }
w32tm /query /source; if ($LASTEXITCODE -ne 0) { throw 'Windows 时间源失败' }
```

```bash
set -euo pipefail
date --iso-8601=seconds
timedatectl status
timedatectl timesync-status
```

### 4. 主机到容器到依赖决策树

先查主机同步服务/虚拟化时钟；再比较容器 UTC 与主机；再查 TLS、Kafka和审计时间线；最后判断哪些记录落在漂移窗口。容器通常继承主机时钟，逐容器改时不是修复。

### 5. 从最小到最大修正

由平台管理员恢复批准 NTP/W32Time/虚拟化时间源，让同步服务按策略收敛；大幅跳变必须维护窗口和数据库/Kafka所有者批准。不得自行执行未评审强制校时。

### 6. 验证与恢复服务

同步状态正常、偏差低于组织阈值、时区记录正确；重跑 TLS、全部 health/protocol，并标注受影响证据的时间不确定区间。

### 7. 升级与预防

审计不可排序、证书异常或漂移重复发生时升级平台/安全负责人。预防监控偏差、冗余批准时间源和主机重启后的同步门禁。

## 损坏、失败升级、回滚或恢复

### 1. 症状与影响范围

升级后镜像/配置/迁移不一致，回滚后旧应用不兼容当前 schema，恢复 checksum/清单失败，或恢复目标出现空库、对象缺失、owner/IAM 漂移。影响可能覆盖全部事实、对象和恢复可信度。

### 2. 立即安全动作

停止 Core和所有新写入，冻结现场、备份集合、旧/新镜像和发布证据；指定 DBA、数据所有者与事件指挥。不得在原数据上反复 restore、启动空栈、编辑 Flyway/Flowable、覆盖唯一备份或删除卷。

### 3. 证据命令

```powershell
Stop-CoreForIncident
& docker @ComposeArgs ps -a; if ($LASTEXITCODE -ne 0) { throw '状态收集失败' }
& docker @ComposeArgs images; if ($LASTEXITCODE -ne 0) { throw '镜像收集失败' }
git -c "safe.directory=$RepositoryRoot" rev-parse HEAD; if ($LASTEXITCODE -ne 0) { throw 'revision 收集失败' }
```

```bash
set -euo pipefail
stop_core_for_incident
"${compose[@]}" ps -a
"${compose[@]}" images
git rev-parse HEAD
```

### 4. 主机到容器到依赖决策树

先确认主机/Engine/卷和证据目录没有继续变化；再锁定每个容器 image ID、release revision、配置版本和备份 record；再检查 PostgreSQL manifest/Flyway/owner/Flowable 与 MinIO 清单/IAM；最后区分：仅应用镜像失败、配置部分变更、schema 已改变、恢复 artifact 损坏或数据已被新写入。不同类别不能共用“重启旧版”处理。

### 5. 从最小到最大修正

仅镜像且 schema 未变时按第 08 章使用已保留旧 image ID；配置变更按协调回退恢复；schema 已改变时仅在兼容矩阵明确时回退应用，否则前向修复；数据损坏时在隔离目标重新验证第 07 章完整集合后整体恢复。**危险：** 任何删除卷、覆盖数据库、对象镜像回灌或正式切换都必须使用第 07/08 章的影响、备份、双人审批、精确确认、验证和恢复限制，不在本章直接给出捷径。

本手册任一事件 runbook 关闭时都使用同一释放规则：Windows 执行 `$script:IncidentLifecycleLock.Dispose(); $script:IncidentLifecycleLock=$null`；Linux 执行 `flock -u "$lifecycle_lock_fd"; exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=`。只有事件指挥确认写入冻结解除、恢复和验收完成才执行；保持停机或调查未关闭时继续持锁并进行受控会话交接。

### 6. 验证与恢复服务

从隔离验收开始：manifest/checksum、角色/owner、Flyway、Flowable、对象计数/IAM、可选 Redis/Kafka disposition、八健康/三 one-shot、HTTP/TCP/协议全部通过；数据所有者签字后才切换。记录实际 RPO/RTO 和不可恢复数据。

### 7. 升级与预防

此类事件始终升级发布负责人、DBA、恢复和安全负责人。复盘必须修订迁移兼容矩阵、不可变备份、外部 WORM验证、恢复演练、窗口停止条件和双人切换程序。

## 事件关闭门禁

- [ ] 根因与触发变更有证据，不以“重启后正常”作为根因。
- [ ] 八个长运行服务、三个 one-shot、有效端口 HTTP/TCP/协议和有限健康语义均已复核。
- [ ] 数据一致性、迁移历史、Flowable、对象/IAM和备份状态由相应所有者签字。
- [ ] 未降低 TLS、认证、OPA、health、secret或供应链控制；临时批准变更已撤销并验证。
- [ ] 原始证据受限，移交副本已脱敏；时间线、命令退出码、image ID、revision和恢复决定完整。
- [ ] 预防项有负责人、截止时间和验证方法；未解决风险有批准人和到期时间。
