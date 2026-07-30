# 命令参考与检查单

本章是操作台快速参考，不替代详细规程。首次部署使用[Windows](04-deploy-windows.md)或[Linux](05-deploy-linux.md)，日常判定使用[第 06 章](06-daily-operations-and-monitoring.md)，数据操作使用[第 07 章](07-backup-restore-and-dr.md)，升级使用[第 08 章](08-upgrade-and-rollback.md)，故障和安全分别使用[第 09 章](09-incident-runbooks.md)与[第 10 章](10-security-hardening.md)。

## 风险分类与使用规则

| 分类 | 典型操作 | 执行要求 |
|---|---|---|
| 安全例行 | config、状态、health、协议只读、日志读取、镜像身份 | 目标/context明确，检查退出状态，输出脱敏 |
| 影响可用性 | build资源峰值、start/up协调、restart、stop、down保留卷 | 影响/窗口、当前状态、备份策略、确认值、恢复人、操作后验证 |
| 破坏性 | `down --volumes`、覆盖式正式恢复、永久退役数据/密钥/备份 | 影响、外部可恢复备份、双人审批、精确输入确认、验证、不可恢复边界 |

所有命令从仓库根目录执行并显式指定 env/Compose文件。不要把 `.env` 当 shell脚本 source；不要输出密钥值、完整环境、认证头或 `docker inspect` 的环境/挂载。PowerShell原生命令后立即保存 `$LASTEXITCODE`；Bash使用 `set -euo pipefail`，预期允许失败的分支必须显式捕获状态。

所有受管生命周期和状态变更使用证据根下固定的项目全局锁 `innorder-occ-lifecycle.lock`，范围包括部署、start/restart/stop/down、systemd `ExecStart`/`ExecStop`、备份静默与恢复、隔离恢复、升级/回滚、凭据轮换和事件中的写操作。Windows以不共享的 `FileStream`、Linux以 `flock -n` 文件描述符在整个多步骤操作期间持锁；锁已占用时立即停止。该锁只协调遵循本文流程的操作，不能阻止忽略锁的带外 root/主机管理员或其他工具，因此仍必须建立并人工确认独占变更窗口；不得按变更号、章节或操作类型创建彼此独立的锁。

## Windows PowerShell 5.1 会话与有效配置

每个新会话先运行以下块。它只输出非敏感有效端口和数据库/桶名，不输出八个密钥路径。

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
function Invoke-CheckedNative {
  param([string]$FilePath,[string[]]$ArgumentList,[string]$FailureMessage)
  & $FilePath @ArgumentList
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$FailureMessage，退出码 $code" }
}
$LifecycleLockPath = Join-Path $EvidenceRoot 'innorder-occ-lifecycle.lock'
function Enter-LifecycleLock {
  try {
    return [IO.File]::Open($LifecycleLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  } catch [IO.IOException] {
    throw '另一个受管 OCC 生命周期操作持有项目全局锁；禁止并发变更'
  }
}
$AllowedKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
$RequiredPathKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE')
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
$SecretPathNames = [ordered]@{ POSTGRES_ADMIN_PASSWORD_FILE='postgres-admin-password'; POSTGRES_FLYWAY_PASSWORD_FILE='postgres-flyway-password'; POSTGRES_RUNTIME_PASSWORD_FILE='postgres-runtime-password'; REDIS_PASSWORD_FILE='redis-password'; MINIO_ROOT_USER_FILE='minio-root-user'; MINIO_ROOT_PASSWORD_FILE='minio-root-password'; MINIO_APP_USER_FILE='minio-app-user'; MINIO_APP_PASSWORD_FILE='minio-app-password' }
foreach ($entry in $SecretPathNames.GetEnumerator()) {
  if ($Config[$entry.Key] -ne (Join-Path $SecretRoot $entry.Value)) { throw "$($entry.Key) 未指向 OCC_SECRET_ROOT 下的预期文件" }
  $source = Get-Item -LiteralPath $Config[$entry.Key] -Force
  if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $source.Length -le 0) { throw "$($entry.Key) 未指向非空普通文件" }
}
function Get-Effective([string]$Name,[string]$Default) {
  if (-not $Config.ContainsKey($Name) -or [string]::IsNullOrEmpty($Config[$Name])) { return $Default }
  return $Config[$Name]
}
$PortDefaults = [ordered]@{ Postgres=@('POSTGRES_PORT',5432); Kafka=@('KAFKA_PORT',9092); Redis=@('REDIS_PORT',6379); MinioApi=@('MINIO_API_PORT',9000); MinioConsole=@('MINIO_CONSOLE_PORT',9001); Opa=@('OPA_PORT',8181); Ai=@('AI_PORT',3100); Core=@('CORE_PORT',8080) }
$Ports = [ordered]@{}; $SeenPorts = New-Object System.Collections.Generic.List[int]
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
$Ports.GetEnumerator() | ForEach-Object { [pscustomobject]@{Service=$_.Key;Address='127.0.0.1';EffectivePort=$_.Value} } | Format-Table -AutoSize
```

## Linux Bash 会话与有效配置

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
lifecycle_lock_path="$evidence_root/innorder-occ-lifecycle.lock"
lifecycle_lock_fd=
acquire_lifecycle_lock() {
  command -v flock >/dev/null
  exec {lifecycle_lock_fd}>"$lifecycle_lock_path"
  if ! flock -n "$lifecycle_lock_fd"; then exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; printf '另一个受管 OCC 生命周期操作持有项目全局锁；禁止并发变更\n' >&2; return 1; fi
}
release_lifecycle_lock() {
  if [ -n "$lifecycle_lock_fd" ]; then flock -u "$lifecycle_lock_fd"; exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; fi
}
declare -A config=() allowed=() seen=()
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
required_paths=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
while IFS='=' read -r key value || [ -n "$key" ]; do
  value=${value%$'\r'}
  [ -z "$key" ] && continue
  case "$key" in \#*) continue;; esac
  [[ $key =~ (PASSWORD|SECRET|ACCESS_KEY|TOKEN)$ ]] && exit 1
  [[ $key =~ ^MINIO_(ROOT|APP)_USER$ ]] && exit 1
  [ -n "${allowed[$key]:-}" ] && [ -z "${config[$key]+present}" ] || exit 1
  config[$key]=$value
done <infra/compose/.env
for key in "${required_paths[@]}"; do [ -n "${config[$key]:-}" ] || exit 1; done
path_names=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
file_names=(postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password)
for index in "${!path_names[@]}"; do name=${path_names[$index]}; [ "${config[$name]}" = "$secret_root/${file_names[$index]}" ] && [ -f "${config[$name]}" ] && [ ! -L "${config[$name]}" ] && [ -s "${config[$name]}" ] || exit 1; done
names=(POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT); defaults=(5432 9092 6379 9000 9001 8181 3100 8080)
for index in "${!names[@]}"; do name=${names[$index]}; port=${config[$name]:-${defaults[$index]}}; [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] && [ -z "${seen[$port]:-}" ] || exit 1; seen[$port]=1; done
POSTGRES_PORT=${config[POSTGRES_PORT]:-5432}; KAFKA_PORT=${config[KAFKA_PORT]:-9092}
REDIS_PORT=${config[REDIS_PORT]:-6379}; MINIO_API_PORT=${config[MINIO_API_PORT]:-9000}
MINIO_CONSOLE_PORT=${config[MINIO_CONSOLE_PORT]:-9001}; OPA_PORT=${config[OPA_PORT]:-8181}
AI_PORT=${config[AI_PORT]:-3100}; CORE_PORT=${config[CORE_PORT]:-8080}
POSTGRES_DB=${config[POSTGRES_DB]:-innorder_occ}; OBJECT_STORAGE_BUCKET=${config[OBJECT_STORAGE_BUCKET]:-innorder-occ}
[[ $POSTGRES_DB =~ ^[a-z][a-z0-9_]{0,62}$ ]] || exit 1
[ "${#OBJECT_STORAGE_BUCKET}" -ge 3 ] && [ "${#OBJECT_STORAGE_BUCKET}" -le 63 ] && [[ $OBJECT_STORAGE_BUCKET =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] && [[ $OBJECT_STORAGE_BUCKET != *..* ]] && [[ ! $OBJECT_STORAGE_BUCKET =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || exit 1
AI_LOG_LEVEL=${config[AI_LOG_LEVEL]:-info}; case "$AI_LOG_LEVEL" in fatal|error|warn|info|debug|trace) ;; *) exit 1;; esac
APP_VERSION=${config[APP_VERSION]:-0.1.0}; trimmed=$(printf '%s' "$APP_VERSION" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'); [ -n "$APP_VERSION" ] && [ "$APP_VERSION" = "$trimmed" ] || exit 1
ports=("$POSTGRES_PORT" "$KAFKA_PORT" "$REDIS_PORT" "$MINIO_API_PORT" "$MINIO_CONSOLE_PORT" "$OPA_PORT" "$AI_PORT" "$CORE_PORT")
printf '%-16s 127.0.0.1:%s\n' PostgreSQL "$POSTGRES_PORT" Kafka "$KAFKA_PORT" Redis "$REDIS_PORT" MinIO-API "$MINIO_API_PORT" MinIO-Console "$MINIO_CONSOLE_PORT" OPA "$OPA_PORT" AI "$AI_PORT" Core "$CORE_PORT"
```

## 安全例行命令

### 配置与来源门禁

Windows：

```powershell
Invoke-CheckedNative 'docker' @('context','show') 'Docker context 查询失败'
Invoke-CheckedNative 'docker' ($ComposeArgs + @('config','--quiet')) 'Compose 配置验证失败'
Invoke-CheckedNative 'docker' ($ComposeArgs + @('config','--services')) 'Compose 服务清单失败'
Invoke-CheckedNative 'git' @('-c',"safe.directory=$RepositoryRoot",'rev-parse','HEAD') 'Git revision 查询失败'
Invoke-CheckedNative 'git' @('-c',"safe.directory=$RepositoryRoot",'status','--short') 'Git 状态查询失败'
```

Linux：

```bash
set -euo pipefail
docker context show
"${compose[@]}" config --quiet
[ "$("${compose[@]}" config --services | wc -l)" -eq 10 ]
git rev-parse HEAD
git status --short
```

完整依赖安装和发布验证不是日常健康检查，但每次发布候选必须运行：

```powershell
npm run install:verified; if ($LASTEXITCODE -ne 0) { throw '来源验证安装失败' }
$previousOpaPath = $env:OPA_PATH
try {
  $env:OPA_PATH = (Get-Command opa -CommandType Application -ErrorAction Stop).Source
  npm run verify:full
  if ($LASTEXITCODE -ne 0) { throw '严格发布验证失败' }
} finally {
  if ($null -eq $previousOpaPath) { Remove-Item Env:OPA_PATH -ErrorAction SilentlyContinue } else { $env:OPA_PATH=$previousOpaPath }
}
```

```bash
set -euo pipefail
npm run install:verified
export OPA_PATH="$(command -v opa)"
trap 'unset OPA_PATH' EXIT
npm run verify:full
unset OPA_PATH
trap - EXIT
```

### 镜像构建与身份

构建不替换运行容器，但会消耗 CPU、内存、磁盘和网络；在单节点高负载时安排窗口。

```powershell
& docker @ComposeArgs build --pull
if ($LASTEXITCODE -ne 0) { throw 'Compose 构建失败；运行容器未因此自动改变' }
& docker @ComposeArgs images
if ($LASTEXITCODE -ne 0) { throw '构建后镜像清单失败' }
```

```bash
set -euo pipefail
"${compose[@]}" build --pull
"${compose[@]}" images
```

### 精确状态

Windows要求八个长运行服务 `running healthy`、两个 one-shot `exited 0`：

```powershell
& docker @ComposeArgs ps -a
if ($LASTEXITCODE -ne 0) { throw 'Compose 状态失败' }
foreach ($service in 'minio-volume-init','minio-init') {
  $ids = @(& docker @ComposeArgs ps -a -q $service | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0 -or $ids.Count -ne 1) { throw "$service 容器查询失败" }
  $state = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' $ids[0]
  if ($LASTEXITCODE -ne 0 -or $state -ne 'exited 0') { throw "$service 状态为 $state" }
}
foreach ($service in 'postgres','kafka','redis','minio','opa','ai','core','host-gateway') {
  $ids = @(& docker @ComposeArgs ps -q $service | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0 -or $ids.Count -ne 1) { throw "$service 运行容器查询失败" }
  $state = & docker inspect --format '{{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}' $ids[0]
  if ($LASTEXITCODE -ne 0 -or $state -notmatch '^running healthy restarts=') { throw "$service 状态为 $state" }
  Write-Output "$service $state"
}
```

Linux：

```bash
set -euo pipefail
"${compose[@]}" ps -a
for service in minio-volume-init minio-init; do
  id=$("${compose[@]}" ps -a -q "$service")
  [ -n "$id" ] && [ "$(printf '%s\n' "$id" | wc -l)" -eq 1 ]
  [ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id")" = 'exited 0' ]
done
for service in postgres kafka redis minio opa ai core host-gateway; do
  id=$("${compose[@]}" ps -q "$service")
  [ -n "$id" ] && [ "$(printf '%s\n' "$id" | wc -l)" -eq 1 ]
  state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}' "$id")
  case "$state" in 'running healthy restarts='*) ;; *) printf '%s %s\n' "$service" "$state" >&2; exit 1;; esac
  printf '%s %s\n' "$service" "$state"
done
```

### HTTP health 与状态

Windows使用前述 `$Ports`：

```powershell
$checks = @(
  @('core-readiness',"http://127.0.0.1:$($Ports.Core)/actuator/health/readiness"),
  @('ai-health',"http://127.0.0.1:$($Ports.Ai)/health"),
  @('ai-status',"http://127.0.0.1:$($Ports.Ai)/api/v1/system/status"),
  @('ai-capabilities',"http://127.0.0.1:$($Ports.Ai)/api/v1/providers/capabilities"),
  @('opa-health',"http://127.0.0.1:$($Ports.Opa)/health"),
  @('minio-readiness',"http://127.0.0.1:$($Ports.MinioApi)/minio/health/ready")
)
foreach ($check in $checks) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $check[1] -TimeoutSec 15
  if ([int]$response.StatusCode -ne 200) { throw "$($check[0]) HTTP $($response.StatusCode)" }
  Write-Output "$($check[0]) PASS"
}
$coreStatusResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Ports.Core)/api/v1/system/status" -TimeoutSec 15
if ([int]$coreStatusResponse.StatusCode -ne 200) { throw 'Core system status HTTP 失败' }
$coreStatusEvidence = Join-Path $EvidenceRoot ("core-system-status-{0}-review-required.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $coreStatusEvidence) { throw 'Core status 证据文件已存在' }
[IO.File]::WriteAllText($coreStatusEvidence,$coreStatusResponse.Content,(New-Object Text.UTF8Encoding($false)))
$coreStatus = $coreStatusResponse.Content | ConvertFrom-Json
$expectedComponentIds = @('core-runtime','postgresql','flowable','opa','kafka','redis','minio')
$actualComponentIds = @($coreStatus.components | ForEach-Object { $_.id } | Sort-Object)
if ($coreStatus.service -ne 'occ-core' -or $coreStatus.state -ne 'READY' -or @($coreStatus.components).Count -ne 7 -or (Compare-Object @($expectedComponentIds | Sort-Object) $actualComponentIds) -or @($coreStatus.components | Where-Object state -ne 'READY').Count -ne 0) { throw 'Core 聚合状态不是规范的全 READY 状态' }
```

Linux：

```bash
set -euo pipefail
checks=(
  "core-readiness|http://127.0.0.1:$CORE_PORT/actuator/health/readiness"
  "ai-health|http://127.0.0.1:$AI_PORT/health"
  "ai-status|http://127.0.0.1:$AI_PORT/api/v1/system/status"
  "ai-capabilities|http://127.0.0.1:$AI_PORT/api/v1/providers/capabilities"
  "opa-health|http://127.0.0.1:$OPA_PORT/health"
  "minio-readiness|http://127.0.0.1:$MINIO_API_PORT/minio/health/ready"
)
for check in "${checks[@]}"; do
  IFS='|' read -r name url <<<"$check"
  curl --fail --silent --show-error --max-time 15 "$url" >/dev/null
  printf '%s PASS\n' "$name"
done
core_status_evidence="$evidence_root/core-system-status-$(date -u +%Y%m%dT%H%M%SZ)-review-required.json"
test ! -e "$core_status_evidence"
curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$CORE_PORT/api/v1/system/status" >"$core_status_evidence"
node - "$core_status_evidence" <<'NODE'
const fs = require('fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = ['core-runtime','flowable','kafka','minio','opa','postgresql','redis'];
const actual = Array.isArray(status.components) ? status.components.map(component => component.id).sort() : [];
if (status.service !== 'occ-core' || status.state !== 'READY' || actual.length !== 7 || JSON.stringify(actual) !== JSON.stringify(expected) || status.components.some(component => component.state !== 'READY')) process.exit(1);
NODE
```

Core readiness路由只证明 `ping` 与数据库 readiness；HTTP 200不代表聚合依赖健康。上面的 Core status检查保留由源码脱敏的响应体到受限证据目录，并要求顶层 `READY`、七个规范组件 ID且全部 `READY`；移交前仍需审查。依赖总体结论还要结合以下原生协议检查。

### TCP 与协议

Windows：

```powershell
foreach ($entry in $Ports.GetEnumerator()) {
  if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $entry.Value -InformationLevel Quiet)) { throw "$($entry.Key) TCP 失败" }
}
psql --host 127.0.0.1 --port $Ports.Postgres --dbname $DatabaseName --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 协议失败' }
redis-cli -h 127.0.0.1 -p $Ports.Redis --askpass PING
if ($LASTEXITCODE -ne 0) { throw 'Redis 协议失败' }
& docker @ComposeArgs exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
if ($LASTEXITCODE -ne 0) { throw 'Kafka 容器内主协议检查失败' }
```

Linux：

```bash
set -euo pipefail
for port in "$POSTGRES_PORT" "$KAFKA_PORT" "$REDIS_PORT" "$MINIO_API_PORT" "$MINIO_CONSOLE_PORT" "$OPA_PORT" "$AI_PORT" "$CORE_PORT"; do
  timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1; exec 3>&-; exec 3<&-' bash "$port"
done
psql --host 127.0.0.1 --port "$POSTGRES_PORT" --dbname "$POSTGRES_DB" --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
redis-cli -h 127.0.0.1 -p "$REDIS_PORT" --askpass PING
"${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
```

PostgreSQL和 Redis值只在客户端隐藏提示输入。Kafka 的保证可用主检查使用镜像内固定客户端和容器内固定 `localhost:29092`；前面的有效主机端口 TCP检查另行覆盖网关入口。若主机安装了经批准 Kafka CLI，可额外对 `127.0.0.1` 有效端口执行 topic-list，但它是可选的主机路径增强，不是本参考的前提。Kafka external listener仍为本机 `PLAINTEXT`、无认证；TCP成功不能替代协议认证/查询。

### 日志、资源与容量

Windows：

```powershell
$savedNativeErrorPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $logs = & docker @ComposeArgs logs --no-color --timestamps --since 24h 2>&1
  $logExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $savedNativeErrorPreference }
if ($logExit -ne 0) { throw "日志读取失败，退出码 $logExit" }
@($logs | Select-String -Pattern 'error|exception|fatal|panic|out of memory|no space left|migration' -CaseSensitive:$false) | Select-Object -Last 200
Invoke-CheckedNative 'docker' @('stats','--no-stream') '容器资源查询失败'
Invoke-CheckedNative 'docker' @('system','df','-v') 'Docker 容量查询失败'
Get-Volume | Select-Object DriveLetter,FileSystem,HealthStatus,Size,SizeRemaining
```

Linux：

```bash
set -euo pipefail
log_file=$(mktemp)
trap 'rm -f -- "$log_file"' EXIT
"${compose[@]}" logs --no-color --timestamps --since 24h >"$log_file" 2>&1
grep -Ei 'error|exception|fatal|panic|out of memory|no space left|migration' "$log_file" || true
docker stats --no-stream
docker system df -v
df -hT
df -ih
free -h
rm -f -- "$log_file"
trap - EXIT
```

不将完整日志直接附到外部工单。按第 06 章创建受限支持包、检查原生命令退出码、人工脱敏和二次复核。

## 影响可用性的命令

### 启动或协调栈

**影响：** `up -d` 可能创建、启动或重建配置漂移的容器；Core启动可能执行 Flyway。前提：config/密钥验证、批准 revision/image、备份/迁移评审、维护窗口和恢复人明确。确认机制要求当前会话精确值 `OCC_CONFIRM_START=APPROVED_CONFIG_AND_MIGRATIONS`。

```powershell
$LifecycleLock = $null
try {
  $LifecycleLock = Enter-LifecycleLock
  if ($env:OCC_CONFIRM_START -ne 'APPROVED_CONFIG_AND_MIGRATIONS') { throw '未确认启动配置与迁移影响' }
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('config','--quiet')) '启动前 config 失败'
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('up','-d')) 'Compose 启动/协调失败'
  Remove-Item Env:OCC_CONFIRM_START
} finally {
  if ($LifecycleLock) { $LifecycleLock.Dispose() }
}
```

```bash
set -euo pipefail
acquire_lifecycle_lock
trap release_lifecycle_lock EXIT
: "${OCC_CONFIRM_START:?必须设置确认值}"
[ "$OCC_CONFIRM_START" = APPROVED_CONFIG_AND_MIGRATIONS ]
"${compose[@]}" config --quiet
"${compose[@]}" up -d
unset OCC_CONFIRM_START
release_lifecycle_lock
trap - EXIT
```

验证：执行精确状态、HTTP、TCP和协议全套。恢复限制：如果迁移已开始，旧镜像只有在 schema兼容性明确时才能恢复；否则按第 08 章前向修复/完整恢复。

### 单服务受控重启

**影响：** 中断目标现有连接，不采用新镜像/config/secret。前提：证据已保存、根因支持重启、依赖/备份策略和恢复人明确。仅允许八个长运行服务。

```powershell
$LifecycleLock = $null
try {
  $LifecycleLock = Enter-LifecycleLock
  $allowed = 'postgres','kafka','redis','minio','opa','ai','core','host-gateway'
  if ($allowed -notcontains $env:OCC_RESTART_SERVICE) { throw '无效重启服务' }
  if ($env:OCC_CONFIRM_RESTART -ne 'APPROVED_SERVICE_INTERRUPTION') { throw '未确认服务中断' }
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('restart',$env:OCC_RESTART_SERVICE)) '服务重启失败'
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('ps',$env:OCC_RESTART_SERVICE)) '重启后状态查询失败'
  Remove-Item Env:OCC_RESTART_SERVICE,Env:OCC_CONFIRM_RESTART
} finally {
  if ($LifecycleLock) { $LifecycleLock.Dispose() }
}
```

```bash
set -euo pipefail
acquire_lifecycle_lock
trap release_lifecycle_lock EXIT
: "${OCC_RESTART_SERVICE:?必须设置服务名}"
: "${OCC_CONFIRM_RESTART:?必须设置确认值}"
[ "$OCC_CONFIRM_RESTART" = APPROVED_SERVICE_INTERRUPTION ]
case "$OCC_RESTART_SERVICE" in postgres|kafka|redis|minio|opa|ai|core|host-gateway) ;; *) exit 1;; esac
"${compose[@]}" restart "$OCC_RESTART_SERVICE"
"${compose[@]}" ps "$OCC_RESTART_SERVICE"
unset OCC_RESTART_SERVICE OCC_CONFIRM_RESTART
release_lifecycle_lock
trap - EXIT
```

验证目标原生 health/协议和总体状态。失败后停止重复重启；无数据/config变化时可启动原容器，存储/迁移失败走第 09 章。

### 临时停止并保留容器/卷

**影响：** 全栈不可用；容器、网络、四卷保留。前提：调用方静默、写入完成、备份状态和恢复人明确。

```powershell
$LifecycleLock = $null
try {
  $LifecycleLock = Enter-LifecycleLock
  if ($env:OCC_CONFIRM_STOP -ne 'APPROVED_KEEP_CONTAINERS_AND_DATA') { throw '未确认全栈停止' }
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('stop')) 'Compose stop 失败'
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('ps','-a')) '停止后状态查询失败'
  Remove-Item Env:OCC_CONFIRM_STOP
} finally {
  if ($LifecycleLock) { $LifecycleLock.Dispose() }
}
```

```bash
set -euo pipefail
acquire_lifecycle_lock
trap release_lifecycle_lock EXIT
: "${OCC_CONFIRM_STOP:?必须设置确认值}"
[ "$OCC_CONFIRM_STOP" = APPROVED_KEEP_CONTAINERS_AND_DATA ]
"${compose[@]}" stop
"${compose[@]}" ps -a
unset OCC_CONFIRM_STOP
release_lifecycle_lock
trap - EXIT
```

验证八个长运行容器停止且带项目 label的四卷仍存在。恢复运行上面的启动块并完整验收。

### down 并保留数据

**影响：** 删除项目容器和网络，服务不可用，默认保留四卷。Linux systemd部署必须按第 05 章先确认生命周期所有者，不能与 unit竞态。

```powershell
$LifecycleLock = $null
try {
  $LifecycleLock = Enter-LifecycleLock
  if ($env:OCC_CONFIRM_DOWN -ne 'APPROVED_REMOVE_CONTAINERS_KEEP_DATA') { throw '未确认 down 影响' }
  Invoke-CheckedNative 'docker' ($ComposeArgs + @('down','--remove-orphans')) 'Compose down 失败'
  $ids = @(& docker @ComposeArgs ps -a -q | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0 -or $ids.Count -ne 0) { throw 'down 后仍有容器或查询失败' }
  $volumes = @(& docker volume ls --quiet --filter 'label=com.docker.compose.project=innorder-occ' | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0 -or $volumes.Count -ne 4) { throw 'down 后四卷保留验证失败' }
  Remove-Item Env:OCC_CONFIRM_DOWN
} finally {
  if ($LifecycleLock) { $LifecycleLock.Dispose() }
}
```

```bash
set -euo pipefail
acquire_lifecycle_lock
trap release_lifecycle_lock EXIT
: "${OCC_CONFIRM_DOWN:?必须设置确认值}"
[ "$OCC_CONFIRM_DOWN" = APPROVED_REMOVE_CONTAINERS_KEEP_DATA ]
unit_state=$(systemctl is-active innorder-occ.service 2>/dev/null) || true
case "$unit_state" in
  active) printf '由 systemd 拥有生命周期；使用第 05 章 systemctl stop 流程\n' >&2; exit 1;;
  inactive|failed) ;;
  *) printf '未知或转换中 unit 状态：%s\n' "$unit_state" >&2; exit 1;;
esac
"${compose[@]}" down --remove-orphans
[ -z "$("${compose[@]}" ps -a -q)" ]
[ "$(docker volume ls --quiet --filter label=com.docker.compose.project=innorder-occ | wc -l)" -eq 4 ]
unset OCC_CONFIRM_DOWN
release_lifecycle_lock
trap - EXIT
```

验证项目容器为零、四卷精确存在。卷缺失时禁止启动空栈，保护现有卷并转入第 07/09 章；恢复使用原生命周期所有者和完整验收。

## 破坏性命令

下列命令不属于日常停止、故障诊断、升级回滚或普通重新部署。不得从工单复制后立即执行。

### 永久删除四个 Compose 数据卷

**危险影响：** `down --volumes` 停止全栈并删除 `postgres-data`、`kafka-data`、`redis-data`、`minio-data`，包括数据库事实、Flyway/Flowable、Kafka KRaft/日志、Redis AOF、MinIO对象/桶/IAM。命令没有撤销。

**前提与备份：** 仅限批准永久退役或隔离恢复演练；客户/项目/主机范围双人复核；写入静默；[第 07 章](07-backup-restore-and-dr.md)完整集合、checksum、独立恢复演练和所需 off-host immutable/WORM验证通过；备份不位于待删卷；恢复/退役负责人在场。

**授权绑定：** 本机环境变量、文件摘要和本地 nonce marker 只能做误操作门禁，不能对具有 Docker/root 等价权限的执行人强制双人授权。真正授权必须是组织外部审批服务签发的 artifact，密码学绑定主机、精确 Compose project、备份/manifest digest、变更号、两个互异实名审批身份、UTC 到期、一次性 nonce 和操作模式。批准的验证适配器必须使用内置或主机受保护的固定信任根验证签名，并在外部不可变服务中原子消费 nonce 后返回签名消费收据；不能只读取本机文本、信任调用方提供的公钥/摘要或写本地 marker。没有该适配器、外部服务不可达或收据验证失败时，本手册不支持执行永久卷删除。

**当前不提供删除实现：** 以下双平台块只用于组织设计审查，不能作为生产操作票；本手册不再包含可执行 `down --volumes`、`docker volume rm/prune` 或等价数据卷删除命令。组织操作票必须把可信验证器和删除执行器固定在受保护发布物中，而不是接受调用方提供的工具路径。只读预检通过不授权删除，也不消费 nonce。

Windows PowerShell 5.1：

```powershell
$AuthorizationNames = @('OCC_DESTRUCTIVE_HOST','OCC_DESTRUCTIVE_PROJECT','OCC_DESTRUCTIVE_BACKUP_RECORD_FILE','OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256','OCC_DESTRUCTIVE_MANIFEST_FILE','OCC_DESTRUCTIVE_MANIFEST_SHA256','OCC_DESTRUCTIVE_CHANGE_ID','OCC_DESTRUCTIVE_APPROVER_ONE','OCC_DESTRUCTIVE_APPROVER_TWO','OCC_DESTRUCTIVE_EXPIRES_UTC','OCC_DESTRUCTIVE_NONCE','OCC_DESTRUCTIVE_MODE','OCC_DESTRUCTIVE_AUTH_ARTIFACT','OCC_DESTRUCTIVE_AUTH_TOOL')
$LifecycleLock = $null
try {
  $LifecycleLock = Enter-LifecycleLock
  foreach ($name in $AuthorizationNames) { if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "缺少破坏性授权字段 $name" } }
  $AuthTool = (Resolve-Path -LiteralPath $env:OCC_DESTRUCTIVE_AUTH_TOOL).Path
  $AuthArtifact = (Resolve-Path -LiteralPath $env:OCC_DESTRUCTIVE_AUTH_ARTIFACT).Path
  foreach ($path in $AuthTool,$AuthArtifact) { $item=Get-Item -LiteralPath $path -Force; if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0) { throw '外部授权工具/artifact 必须是非空普通非重解析文件' } }
  function Assert-DestructiveAuthorization {
    if ($env:OCC_DESTRUCTIVE_HOST -ne [Environment]::MachineName -or $env:OCC_DESTRUCTIVE_PROJECT -ne 'innorder-occ') { throw '授权主机或项目不匹配' }
    if ($env:OCC_DESTRUCTIVE_CHANGE_ID -notmatch '^[a-z0-9][a-z0-9.-]{0,63}$' -or $env:OCC_DESTRUCTIVE_MODE -notin @('decommission','isolated-restore-drill')) { throw '变更号或操作模式无效' }
    if ($env:OCC_DESTRUCTIVE_APPROVER_ONE -notmatch '^\S{3,128}$' -or $env:OCC_DESTRUCTIVE_APPROVER_TWO -notmatch '^\S{3,128}$' -or $env:OCC_DESTRUCTIVE_APPROVER_ONE -eq $env:OCC_DESTRUCTIVE_APPROVER_TWO) { throw '两个实名审批身份无效或相同' }
    if ($env:OCC_DESTRUCTIVE_NONCE -notmatch '^[0-9a-fA-F]{32,128}$') { throw '一次性 nonce 格式或熵长度无效' }
    $expires = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($env:OCC_DESTRUCTIVE_EXPIRES_UTC,[ref]$expires) -or $expires.Offset -ne [TimeSpan]::Zero) { throw '授权到期时间不是 UTC' }
    $now = [DateTimeOffset]::UtcNow
    if ($expires -le $now -or $expires -gt $now.AddMinutes(30)) { throw '授权已过期或有效期超过 30 分钟' }
    $recordItem = Get-Item -LiteralPath $env:OCC_DESTRUCTIVE_BACKUP_RECORD_FILE -Force
    $manifestItem = Get-Item -LiteralPath $env:OCC_DESTRUCTIVE_MANIFEST_FILE -Force
    if ($recordItem.PSIsContainer -or $manifestItem.PSIsContainer -or ($recordItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $recordItem.Length -le 0 -or $manifestItem.Length -le 0) { throw '备份记录或 manifest 必须是非空普通非重解析文件' }
    $record = [IO.Path]::GetFullPath($recordItem.FullName)
    $manifest = [IO.Path]::GetFullPath($manifestItem.FullName)
    if ($env:OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256 -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $record).Hash -ne $env:OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256) { throw '备份记录摘要不匹配' }
    if ($env:OCC_DESTRUCTIVE_MANIFEST_SHA256 -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash -ne $env:OCC_DESTRUCTIVE_MANIFEST_SHA256) { throw 'manifest 摘要不匹配' }
    $manifestRoot = [IO.Path]::GetFullPath((Split-Path $manifest -Parent))
    $manifestRootItem = Get-Item -LiteralPath $manifestRoot -Force
    if (-not $manifestRootItem.PSIsContainer -or ($manifestRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'manifest root 必须是普通目录' }
    $manifestRootWithSeparator = $manifestRoot.TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    Get-Content -LiteralPath $manifest | ForEach-Object {
      if ($_ -notmatch '^([0-9a-f]{64})  (.+)$') { throw 'manifest 行无效' }
      $expectedHash = $Matches[1]
      $relativePath = $Matches[2]
      $normalizedPath = $relativePath.Replace('/',[IO.Path]::DirectorySeparatorChar).Replace('\',[IO.Path]::DirectorySeparatorChar)
      if ([IO.Path]::IsPathRooted($normalizedPath) -or $relativePath -match '%[0-9a-fA-F]{2}' -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') { throw 'manifest artifact 路径包含 rooted、encoded 或 traversal 形式' }
      $artifactCandidate = [IO.Path]::GetFullPath((Join-Path $manifestRoot $normalizedPath))
      if (-not $artifactCandidate.StartsWith($manifestRootWithSeparator,[StringComparison]::OrdinalIgnoreCase)) { throw 'manifest artifact 不是 root 的严格后代' }
      $currentPath = $manifestRoot
      foreach ($segment in $normalizedPath.Split(@([IO.Path]::DirectorySeparatorChar),[StringSplitOptions]::RemoveEmptyEntries)) {
        $currentPath = Join-Path $currentPath $segment
        $currentItem = Get-Item -LiteralPath $currentPath -Force
        if ($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'manifest artifact 路径包含 symlink/reparse point' }
      }
      if ($currentItem.PSIsContainer) { throw 'manifest artifact 不是普通文件' }
      $artifact = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $currentPath).Path)
      if (-not $artifact.StartsWith($manifestRootWithSeparator,[StringComparison]::OrdinalIgnoreCase)) { throw '解析后的 manifest artifact 逃逸 root' }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'manifest artifact 校验失败' }
    }
    $configJson = & docker @ComposeArgs config --format json
    if ($LASTEXITCODE -ne 0 -or ($configJson | ConvertFrom-Json).name -ne $env:OCC_DESTRUCTIVE_PROJECT) { throw '实际 Compose project 不匹配' }
  }
  function Get-ProjectVolumeNames {
    $output = & docker volume ls --quiet --filter 'label=com.docker.compose.project=innorder-occ'
    if ($LASTEXITCODE -ne 0) { throw '项目卷查询失败' }
    return @($output | Where-Object { $_ } | Sort-Object)
  }
  function Assert-ExactProjectVolumes {
    $expected = @('innorder-occ_kafka-data','innorder-occ_minio-data','innorder-occ_postgres-data','innorder-occ_redis-data')
    $actual = @(Get-ProjectVolumeNames)
    if (Compare-Object $expected $actual) { throw '项目卷名称集合存在缺失或意外项' }
    $labels = @{ 'innorder-occ_postgres-data'='postgres-data'; 'innorder-occ_kafka-data'='kafka-data'; 'innorder-occ_redis-data'='redis-data'; 'innorder-occ_minio-data'='minio-data' }
    foreach ($name in $expected) { $label = & docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' $name; if ($LASTEXITCODE -ne 0 -or $label -ne $labels[$name]) { throw "$name 的 Compose volume label 不匹配" } }
  }
  Assert-DestructiveAuthorization
  & docker @ComposeArgs config --quiet
  if ($LASTEXITCODE -ne 0) { throw '只读破坏性预检的 Compose 配置失败' }
  $containers = @(& docker ps -a --quiet --filter 'label=com.docker.compose.project=innorder-occ' | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0 -or $containers.Count -ne 0) { throw '破坏性命令前仍有项目容器或查询失败' }
  Assert-ExactProjectVolumes
  Assert-DestructiveAuthorization
  $savedNativeErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $authReceipt = & $AuthTool verify-only --artifact $AuthArtifact --host $env:OCC_DESTRUCTIVE_HOST --project $env:OCC_DESTRUCTIVE_PROJECT --mode $env:OCC_DESTRUCTIVE_MODE --change-id $env:OCC_DESTRUCTIVE_CHANGE_ID --manifest-sha256 $env:OCC_DESTRUCTIVE_MANIFEST_SHA256 --backup-record-sha256 $env:OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256 --require-two-distinct-approvers --do-not-consume-nonce 2>&1
    $authReceiptExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedNativeErrorPreference }
  if ($authReceiptExit -ne 0 -or @($authReceipt).Count -eq 0) { throw '外部审批服务未通过只读签名绑定预检' }
  Write-Output '只读预检完成；未停止服务、未消费 nonce、未删除容器或卷。永久删除仍不受本手册支持。'
} finally {
  if ($LifecycleLock) { $LifecycleLock.Dispose() }
  foreach ($name in $AuthorizationNames) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
```

Linux Bash：

```bash
set -euo pipefail
authorization_names=(OCC_DESTRUCTIVE_HOST OCC_DESTRUCTIVE_PROJECT OCC_DESTRUCTIVE_BACKUP_RECORD_FILE OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256 OCC_DESTRUCTIVE_MANIFEST_FILE OCC_DESTRUCTIVE_MANIFEST_SHA256 OCC_DESTRUCTIVE_CHANGE_ID OCC_DESTRUCTIVE_APPROVER_ONE OCC_DESTRUCTIVE_APPROVER_TWO OCC_DESTRUCTIVE_EXPIRES_UTC OCC_DESTRUCTIVE_NONCE OCC_DESTRUCTIVE_MODE OCC_DESTRUCTIVE_AUTH_ARTIFACT OCC_DESTRUCTIVE_AUTH_TOOL)
cleanup_destructive_window() {
  release_lifecycle_lock
  unset "${authorization_names[@]}"
}
trap cleanup_destructive_window EXIT
for name in "${authorization_names[@]}"; do [ -n "${!name:-}" ] || { printf '缺少破坏性授权字段 %s\n' "$name" >&2; exit 1; }; done
auth_tool=$(realpath -e -- "$OCC_DESTRUCTIVE_AUTH_TOOL")
auth_artifact=$(realpath -e -- "$OCC_DESTRUCTIVE_AUTH_ARTIFACT")
[ -f "$auth_tool" ] && [ ! -L "$auth_tool" ] && [ -x "$auth_tool" ] && [ -f "$auth_artifact" ] && [ ! -L "$auth_artifact" ] && [ -s "$auth_artifact" ]
assert_destructive_authorization() {
  [ "$OCC_DESTRUCTIVE_HOST" = "$(hostname)" ] && [ "$OCC_DESTRUCTIVE_PROJECT" = innorder-occ ] || { printf '授权主机或项目不匹配\n' >&2; return 1; }
  [[ $OCC_DESTRUCTIVE_CHANGE_ID =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || return 1
  case "$OCC_DESTRUCTIVE_MODE" in decommission|isolated-restore-drill) ;; *) return 1;; esac
  [[ $OCC_DESTRUCTIVE_APPROVER_ONE =~ ^[^[:space:]]{3,128}$ ]] && [[ $OCC_DESTRUCTIVE_APPROVER_TWO =~ ^[^[:space:]]{3,128}$ ]] && [ "$OCC_DESTRUCTIVE_APPROVER_ONE" != "$OCC_DESTRUCTIVE_APPROVER_TWO" ] || return 1
  [[ $OCC_DESTRUCTIVE_NONCE =~ ^[0-9a-fA-F]{32,128}$ ]] || return 1
  node -e 'const value=process.env.OCC_DESTRUCTIVE_EXPIRES_UTC; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) process.exit(1); const expires=Date.parse(value), now=Date.now(); if (!Number.isFinite(expires) || expires <= now || expires > now + 30*60*1000) process.exit(1)'
  record=$(realpath -e -- "$OCC_DESTRUCTIVE_BACKUP_RECORD_FILE")
  manifest=$(realpath -e -- "$OCC_DESTRUCTIVE_MANIFEST_FILE")
  [ -f "$record" ] && [ ! -L "$record" ] && [ -s "$record" ] && [ -f "$manifest" ] && [ ! -L "$manifest" ] && [ -s "$manifest" ] || return 1
  [[ $OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256 =~ ^[0-9a-fA-F]{64}$ ]] && [[ $OCC_DESTRUCTIVE_MANIFEST_SHA256 =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  [ "$(sha256sum -- "$record" | awk '{print $1}')" = "${OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256,,}" ] || return 1
  [ "$(sha256sum -- "$manifest" | awk '{print $1}')" = "${OCC_DESTRUCTIVE_MANIFEST_SHA256,,}" ] || return 1
  manifest_root=$(realpath -e -- "$(dirname -- "$manifest")")
  [ -d "$manifest_root" ] || return 1
  local -a manifest_paths=()
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || return 1
    artifact=${BASH_REMATCH[2]}
    for seen_path in "${manifest_paths[@]}"; do [ "$seen_path" != "$artifact" ] || return 1; done
    manifest_paths+=("$artifact")
    case "$artifact" in /*|*\\*|*//*|*/|.) return 1;; esac
    case "/$artifact/" in */../*|*/./*) return 1;; esac
    current=$manifest_root
    IFS='/' read -r -a artifact_components <<<"$artifact"
    [ "${#artifact_components[@]}" -gt 0 ] || return 1
    for component in "${artifact_components[@]}"; do
      [ -n "$component" ] && [ "$component" != . ] && [ "$component" != .. ] || return 1
      current="$current/$component"
      [ -e "$current" ] && [ ! -L "$current" ] || return 1
    done
    [ -f "$current" ] || return 1
    resolved_artifact=$(realpath -e -- "$current")
    case "$resolved_artifact" in "$manifest_root"/*) ;; *) printf 'manifest artifact is not a strict descendant of canonical manifest root: %s\n' "$artifact" >&2; return 1;; esac
  done <"$manifest"
  [ "${#manifest_paths[@]}" -gt 0 ] || return 1
  (cd -- "$manifest_root" && sha256sum --check --strict -- "$manifest") >/dev/null
  project_name=$("${compose[@]}" config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')
  [ "$project_name" = "$OCC_DESTRUCTIVE_PROJECT" ]
}
assert_no_occ_lifecycle_jobs() {
  local jobs
  jobs=$(systemctl list-jobs --no-legend --no-pager)
  if printf '%s\n' "$jobs" | grep -Eq '[[:space:]](innorder-occ|docker)\.service[[:space:]]'; then
    printf '%s\nDocker 或 OCC 存在待处理 systemd job；禁止竞态删除\n' "$jobs" >&2
    return 1
  fi
}
get_project_volumes() {
  local output status
  set +e
  output=$(docker volume ls --quiet --filter label=com.docker.compose.project=innorder-occ 2>&1); status=$?
  set -e
  [ "$status" -eq 0 ] || { printf '%s\n' "$output" >&2; return "$status"; }
  if [ -n "$output" ]; then printf '%s\n' "$output" | sort; fi
}
assert_exact_project_volumes() {
  local actual_output label name
  local actual=()
  local expected=(innorder-occ_kafka-data innorder-occ_minio-data innorder-occ_postgres-data innorder-occ_redis-data)
  actual_output=$(get_project_volumes) || return
  if [ -n "$actual_output" ]; then mapfile -t actual <<<"$actual_output"; fi
  [ "${#actual[@]}" -eq 4 ] && [ "$(printf '%s\n' "${actual[@]}")" = "$(printf '%s\n' "${expected[@]}")" ] || { printf '项目卷名称集合存在缺失或意外项\n' >&2; return 1; }
  for name in "${expected[@]}"; do
    label=$(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "$name")
    case "$name:$label" in innorder-occ_kafka-data:kafka-data|innorder-occ_minio-data:minio-data|innorder-occ_postgres-data:postgres-data|innorder-occ_redis-data:redis-data) ;; *) return 1;; esac
  done
}
assert_destructive_authorization
assert_no_occ_lifecycle_jobs
unit_state=$(systemctl show innorder-occ.service --property ActiveState --value)
case "$unit_state" in active|inactive|failed) ;; activating|deactivating|reloading) printf 'OCC unit 正在转换状态：%s\n' "$unit_state" >&2; exit 1;; *) printf '未知 OCC unit 状态：%s\n' "$unit_state" >&2; exit 1;; esac
acquire_lifecycle_lock
"${compose[@]}" config --quiet
assert_exact_project_volumes
assert_destructive_authorization
assert_no_occ_lifecycle_jobs
set +e
auth_receipt=$("$auth_tool" verify-only --artifact "$auth_artifact" --host "$OCC_DESTRUCTIVE_HOST" --project "$OCC_DESTRUCTIVE_PROJECT" --mode "$OCC_DESTRUCTIVE_MODE" --change-id "$OCC_DESTRUCTIVE_CHANGE_ID" --manifest-sha256 "$OCC_DESTRUCTIVE_MANIFEST_SHA256" --backup-record-sha256 "$OCC_DESTRUCTIVE_BACKUP_RECORD_SHA256" --require-two-distinct-approvers --do-not-consume-nonce 2>&1); auth_receipt_exit=$?
set -e
[ "$auth_receipt_exit" -eq 0 ] && [ -n "$auth_receipt" ] || { printf '外部审批服务未通过只读签名绑定预检\n' >&2; exit 1; }
printf '只读预检完成；未停止服务、未消费 nonce、未删除容器或卷。永久删除仍不受本手册支持。\n'
release_lifecycle_lock
unset "${authorization_names[@]}"
trap - EXIT
```

**验证：** 只读预检后项目状态和四卷必须保持不变；外部备份、escrow、manifest 和审计仍可读取且保持受限。任何差异都按事件处理。不得把预检输出当作删除授权或完成证明。

**恢复与限制：** 删除前 Linux unit 已停止、禁用并保持 runtime mask，避免开机或依赖传播重新创建空栈。恢复时必须先还原并验证数据，再经审批运行 `sudo systemctl unmask --runtime innorder-occ.service`，随后重新启用 unit并完整验收；不得为了启动空栈提前 unmask。只能从已验证外部集合按“密钥/配置、PostgreSQL、MinIO、声明的 Redis/Kafka、应用”顺序恢复。没有成功恢复演练或备份缺项时，数据可能永久不可恢复；源码、镜像、`.env`、回收站和重新运行 init不是恢复来源。

### 正式覆盖恢复和永久介质销毁

覆盖数据库/对象、删除备份或销毁密钥同样具有破坏性，但其精确命令取决于被批准的备份集合、加密/KMS、保留和介质系统。本章不提供可误执行的通用删除命令。必须使用[第 07 章恢复/切换程序](07-backup-restore-and-dr.md)或组织介质销毁操作票，并具备相同五项：明确影响、可恢复前提、双人逐字确认、操作后验证、恢复/不可恢复限制。任何缺项均停止。

## 首次部署检查单

- [ ] 已确认单客户、单主机、仅本机访问符合用途；远程、HA、Kubernetes需求不在当前支持范围。
- [ ] 按第 02 章完成 OS/AMD64、Engine/Compose、Node 22、host `psql`、JDK 21 toolchain、真实 OPA、CPU/内存/磁盘/inode、时间、DNS/TLS和最终八端口预检。
- [ ] 仓库 revision、工作区差异、审批、角色、维护/恢复窗口已记录。
- [ ] 八个外部密钥互异、权限合格；`.env` 只有八路径和十二非敏感项，已忽略且 config通过。
- [ ] `install:verified`、Electron来源守卫、Gradle strict、真实 OPA和 `verify:full` 无失败/跳过。
- [ ] 六外部镜像 tag+digest和四本地 image ID/revision已记录；构建成功。
- [ ] `up -d` 后两个 one-shot `exited 0`、八服务 `running healthy`；这些容器状态不是 Core聚合依赖结论。
- [ ] 有效端口 HTTP、八 TCP和 PostgreSQL/Redis/Kafka协议通过；Core readiness仅证明 `ping`/数据库，Core system status顶层及七个规范组件全部为 `READY`。
- [ ] 回环、防火墙、账号、ACL/mode、日志/证据和备份基线完成安全评审。
- [ ] 初始完整备份与隔离恢复演练已记录；容量数值未被当作性能/SLA承诺。

## 每次启动检查单

- [ ] Docker context/Engine、仓库、Compose项目和生命周期所有者正确；无并发 systemd/Docker job。
- [ ] `.env`/八密钥路径、权限和 `config --quiet` 通过；未输出路径或值。
- [ ] 当前/目标 image ID、revision、配置和迁移变更已知；需要时已有备份/审批。
- [ ] 使用精确启动确认值；命令零退出不单独作为成功结论。
- [ ] 两 one-shot、八 health、HTTP/TCP/协议和 restart count通过；另行确认 Core system status顶层及七个规范组件全部为 `READY`，不以 readiness替代。
- [ ] 监听仍为八个 `127.0.0.1`，无直接后端暴露。

## 班次、每日、每周与每月检查单

### 每班

- [ ] 阅读开放事件/变更/风险接受；记录交接时间、人员和下一责任人。
- [ ] 十服务精确状态、HTTP/TCP/协议、Core聚合顶层/七组件全 `READY`、非计划 restart count和最后正常时间已检查。
- [ ] 备份新鲜度、checksum/外部复制状态、磁盘/inode和时间同步已检查。
- [ ] 异常已创建事件，不以自动重启处置。

### 每日

- [ ] 过去 24小时高关注日志已分类并脱敏；fatal、OOM、磁盘、迁移、泄露立即升级。
- [ ] 容器/主机 CPU、内存、Docker容量、四卷增长与调优阈值比较。
- [ ] DNS/TLS、备份任务退出状态、manifest和异地接收结果通过。

### 每周

- [ ] source revision、运行 image ID/digest、Compose声明和发布记录一致。
- [ ] build cache/日志/证据/备份保留受控；未运行自动 prune或删事件证据。
- [ ] 告警投递和采集失败告警抽查通过；一次性任务没有被误报。
- [ ] 漏洞/补丁公告已分诊，紧急项有变更或期限性风险接受。

### 每月

- [ ] 至少四周容量趋势、阈值和30/7日耗尽预测已评审。
- [ ] 管理员/Docker/发布/DBA/备份/审计成员和Windows ACL/Linux mode差异已复核。
- [ ] 防火墙、回环、出站、DNS、时间源、证书到期和远程访问禁止已复核。
- [ ] 凭据轮换/escrow、镜像/Gradle keyring/OPA策略、备份加密/WORM和恢复权限已审计。

## 备份检查单

- [ ] 使用[第 07 章](07-backup-restore-and-dr.md)；备份 ID、政策、保留、故障域、信任模式、部署 revision和变更号已固定。
- [ ] staging不在仓库/Docker数据根；权限/加密合格，secret escrow独立。
- [ ] 调用方和未知写入已静默，Core停止状态有证据；集合一致性窗口明确。
- [ ] PostgreSQL custom dump和 `pg_restore --list`、MinIO精确桶镜像/对象清单/checksum完成。
- [ ] Redis disposition精确为 snapshot或 rebuildable；Kafka精确为 metadata-only或 cold-archive并承认限制。
- [ ] inventory、manifest、工具/image/revision元数据精确，只有全部成功才写 `COMPLETE`。
- [ ] off-host immutable/WORM或签名系统已实际接收并实时验证；本机 checksum未冒充抗篡改。
- [ ] Core恢复，readiness通过且聚合 status顶层/七组件全 `READY`，完整协议通过；失败集合标记不完整且不计入RPO。

## 恢复演练检查单

- [ ] 使用隔离主机/项目/网络/密钥，不覆盖生产；演练范围、允许数据损失和切换禁止明确。
- [ ] 外部 record/version、manifest、inventory、checksum、加密解锁和 escrow取回双人验证。
- [ ] 先恢复密钥/配置和三 PostgreSQL角色/扩展，再 PostgreSQL、MinIO、声明的 Redis/Kafka，最后应用。
- [ ] Flyway历史/checksum/owner、八 schema、Flowable `ACT_*`、runtime最小 grants通过。
- [ ] MinIO对象键/大小/抽样内容、桶级 IAM和root/app分离通过。
- [ ] 八 health、两 one-shot、有效端口 HTTP/TCP/协议通过；Core聚合 status顶层及七个规范组件全部 `READY`。
- [ ] 实测 RPO/RTO、缺失/偏差、工具版本、人员、退出状态和改进项已记录；隔离数据按审批销毁。

## 升级检查单

- [ ] 按[第 08 章](08-upgrade-and-rollback.md)固定当前/目标完整 commit、变更号、窗口、角色和停止条件。
- [ ] 工作区、provenance、依赖、Electron、Gradle strict、OPA、`verify:full`和镜像 digest全通过。
- [ ] 已部署迁移路径/blob不可变；新增迁移事务性、锁、空间、中间态、双向兼容和前向修复已由DBA评审。
- [ ] 新鲜完整备份、checksum、隔离恢复和所需 off-host trust实时重验通过。
- [ ] 旧运行 image ID已保留，四本地服务构建完成且未改变运行容器。
- [ ] Core静默；基础服务先发布，当前 release的 `minio-init` 使用新 container ID并 `exited 0`，再启动 Core。
- [ ] 发布后 image ID、APP_VERSION、Flyway历史、八/两状态、HTTP/TCP/协议、Core聚合顶层/七组件全 `READY`和数据验收通过。
- [ ] 观察期、沟通、回滚/前向修复决策和证据目录完整。

## 回滚检查单

- [ ] 明确失败仅在应用/镜像、配置、凭据还是 schema/数据；停止新写入并保存首次证据。
- [ ] 旧应用对当前 schema兼容性由DBA书面确认；未知即不允许旧镜像回滚。
- [ ] schema未变时使用记录的旧 image ID/revision；配置/凭据按协调回退，不恢复单边状态。
- [ ] schema已变且不兼容时选择批准前向修复或完整备份恢复，不编辑迁移历史/checksum。
- [ ] 恢复/回滚后 Flyway/Flowable、数据、对象/IAM、八/两状态和协议全通过。
- [ ] 未解决的数据损失、RPO/RTO和风险由数据所有者签字并进入事件交接。

## 凭据轮换检查单

当前只有 PostgreSQL Flyway/runtime 和 MinIO 应用账号具有本手册可执行流程。PostgreSQL admin、Redis 和 MinIO root 仅有设计要求，明确不支持直接生产执行；检查单不能把它们转化为授权。

- [ ] 使用[第 03 章协调轮换](03-secrets-and-configuration.md)，明确 PostgreSQL admin/Flyway/runtime、Redis或MinIO app/root范围和消费者。
- [ ] 维护窗口、可恢复备份、staged/old受限文件、双人审批和部分失败顺序准备完成。
- [ ] PostgreSQL/MinIO和临时客户端值未进入 argv、env、日志、工单或输出；当前 Redis服务长运行 argv例外已按第 10 章接受风险并禁止进程命令行进入支持包，文件内容/唯一性/ACL/mode只输出结论。
- [ ] 服务端状态先协调，正式文件原子替换，消费者 force-recreate；不能只改文件。
- [ ] 新凭据独立认证、最小权限、应用健康通过；旧凭据按计划撤销。
- [ ] 任一步失败按组件精确逆序恢复；恢复失败保持受影响服务停止并升级安全/DBA。
- [ ] escrow版本、轮换时间、操作者、消费者 image ID和旧材料销毁有审计。

## 事件接入、证据与交接检查单

- [ ] 事件号、严重性、UTC首次/最近时间、客户/功能影响、写入状态、指挥人和通讯频道已建立。
- [ ] 最近发布/配置/凭据/主机变更、revision、image ID、restart count和最后正常时间已固定。
- [ ] 按第 09 章从主机到容器到依赖检查；命令退出失败与空输出没有混淆。
- [ ] 原始日志/证据目录受限且标记敏感；不收集 `.env`、secret、完整环境、认证头或无必要客户数据。
- [ ] 修正从最小到最大；每个可用性动作有影响、确认、验证和恢复；没有循环重启/清理。
- [ ] TLS、认证、OPA、health、Flyway、dependency verification和secret控制未被削弱。
- [ ] 交接包含当前状态、已排除原因、待验证假设、证据位置/访问、下一动作/停止条件、负责人/截止时间。
- [ ] 关闭前根因、数据一致性、完整验收、预防项和风险接受均签字。

## 安全评审检查单

- [ ] 完成[第 10 章安全检查单](10-security-hardening.md)，威胁模型和例外仍与当前用途一致。
- [ ] 回环/internal网络、防火墙、无远程转发和无后端直曝有主机与Compose双重证据。
- [ ] Docker=root等价风险、账号分离、最小权限、ACL/mode/MAC和离职撤销通过。
- [ ] 八密钥互异、最小消费者和协调轮换通过；除第 10 章已记录并接受的 Redis长运行 argv残余风险外，无 env/argv/log/support泄密，且支持包不收集进程命令行。
- [ ] npm/Electron/Gradle/image/OPA供应链、漏洞/补丁和实际运行身份通过。
- [ ] 审计、加密备份、off-host WORM、恢复访问和季度演练通过。
- [ ] 远程访问、HA或Kubernetes没有被未评审地扩展为“支持”。

## 永久退役检查单

- [ ] 资产/客户/项目精确范围、法务冻结/保留、审批人、执行人、复核人和完成标准已固定。
- [ ] 客户端/写入静默，最终备份集合、外部不可变接收、checksum和独立恢复已验证；数据所有者确认保留/销毁选择。
- [ ] 停止/移除 systemd或Desktop生命周期时先保留四卷；确认无其他实例/备份共享密钥、目录或volume label。
- [ ] 若批准删除四卷，使用本章唯一的危险块及绑定主机/project/备份摘要/变更/双审批/UTC到期/一次性 nonce的授权；部分失败冻结现场。
- [ ] 外部密钥、KMS/escrow、证书、服务账号、Docker/主机组、监控、DNS、防火墙和远程集成按各自独立操作票撤销。
- [ ] 备份/WORM在保留期到达前不删除；到期销毁需介质系统的影响、双人确认、验证和不可恢复记录。
- [ ] 仓库/镜像/cache/证据按数据分类和审计保留处理，不用通用 prune代替可证明销毁。
- [ ] 最终验证：入口不可达、容器/网络/批准数据已移除、保留材料仍可审计、CMDB/值班/恢复目录已更新。

## 操作票关闭字段

```text
变更/事件号：
UTC 开始与结束：
主机资产与 Compose project：
操作者、复核人、审批人：
执行前 revision / APP_VERSION / image ID：
有效八端口与回环检查：
备份集合、trust 分类与最近恢复演练：
执行命令分类及每条退出状态：
八个长运行服务、两个 one-shot：
HTTP / TCP / PostgreSQL / Redis / Kafka：
Flyway / Flowable / MinIO IAM / OPA 结论：
CPU / 内存 / 磁盘 / inode / 时间：
证据目录、敏感级别、脱敏复核与保留期：
偏差、风险接受、到期日：
恢复/回滚是否执行及数据损失：
后续负责人、截止时间和验证方法：
```
