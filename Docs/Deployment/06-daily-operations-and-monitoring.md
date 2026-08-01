# 日常运维与监控

本章面向当前单客户、单主机 Compose 栈的值班人员。它把[架构与健康语义](01-architecture-and-boundaries.md)、[Windows 部署验收](04-deploy-windows.md)和[Linux 部署验收](05-deploy-linux.md)转化为轮班检查、趋势记录、告警和交接要求。当前仓库没有监控采集器、告警管理器或自动修复控制器；本章命令默认只读，不把重启、清理、删除卷或扩容作为自动动作。

## 运行原则与职责

- **安全：** 每次检查都显式指定 `infra/compose/.env` 与 `infra/compose/compose.yml`，并核对 Docker context、源码 revision 和 Compose project，避免检查错误环境。
- **注意：** `host-gateway` healthy 只证明八个监听器已建立；Core readiness 只含 `ping` 和 `db`。总体结论还需要一次性任务、各服务健康、HTTP、TCP 和协议结果。
- **注意：** 当前是单节点，不具备 HA、自动故障转移或多副本一致性。监控不能把单点变成高可用。
- **危险：** 告警响应不得自动运行 `restart`、`down`、`down --volumes`、`docker system prune`、`docker volume prune`、删除日志或修改数据库。先保留证据、确认影响和根因，再按审批流程人工处置。
- 值班人员负责检查、记录、初步分级和升级；组件所有者负责代码/配置根因；数据库与恢复负责人负责数据一致性和恢复决策；安全负责人处理疑似凭据或数据泄露。

## 会话初始化与有效配置

所有后续命令从仓库根目录执行。Windows PowerShell 5.1 会话使用以下块；它不输出 `.env` 内容或密钥路径。

```powershell
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw '必须使用 Windows PowerShell 5.1' }
foreach ($name in 'OCC_REPOSITORY_ROOT','OCC_EVIDENCE_ROOT','OCC_BACKUP_ROOT') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathRooted($value)) { throw "$name 必须是已设置的绝对路径" }
}
$RepositoryRoot = (Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT).Path
$EvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT).Path
$BackupRoot = (Resolve-Path -LiteralPath $env:OCC_BACKUP_ROOT).Path
Set-Location -LiteralPath $RepositoryRoot
$ComposeEnv = Join-Path $RepositoryRoot 'infra\compose\.env'
$ComposeFile = Join-Path $RepositoryRoot 'infra\compose\compose.yml'
$ComposeArgs = @('compose','--env-file',$ComposeEnv,'-f',$ComposeFile)
function Invoke-CheckedNative {
  param([string]$FilePath,[string[]]$ArgumentList,[string]$FailureMessage)
  & $FilePath @ArgumentList
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "$FailureMessage，退出码 $exitCode" }
}
$Config = @{}
$Allowed = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','OCC_JWT_PRIVATE_KEY_FILE','OCC_JWT_PUBLIC_KEY_FILE','OCC_JWT_ISSUER','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
Get-Content -LiteralPath $ComposeEnv | ForEach-Object {
  if ($_ -and -not $_.StartsWith('#')) {
    $parts = $_ -split '=',2
    if ($parts.Count -ne 2 -or $Allowed -notcontains $parts[0] -or $Config.ContainsKey($parts[0])) { throw '.env 含无效、未知或重复 key' }
    $Config[$parts[0]] = $parts[1]
  }
}
function Get-Effective([string]$Name,[string]$Default) {
  if (-not $Config.ContainsKey($Name) -or [string]::IsNullOrEmpty($Config[$Name])) { return $Default }
  return $Config[$Name]
}
$Ports = [ordered]@{ Postgres=[int](Get-Effective 'POSTGRES_PORT' '5432'); Kafka=[int](Get-Effective 'KAFKA_PORT' '9092'); Redis=[int](Get-Effective 'REDIS_PORT' '6379'); MinioApi=[int](Get-Effective 'MINIO_API_PORT' '9000'); MinioConsole=[int](Get-Effective 'MINIO_CONSOLE_PORT' '9001'); Opa=[int](Get-Effective 'OPA_PORT' '8181'); Ai=[int](Get-Effective 'AI_PORT' '3100'); Core=[int](Get-Effective 'CORE_PORT' '8080') }
$DatabaseName = Get-Effective 'POSTGRES_DB' 'innorder_occ'
Invoke-CheckedNative 'docker' @('context','show') 'Docker context 查询失败'
Invoke-CheckedNative 'docker' ($ComposeArgs + @('config','--quiet')) 'Compose 配置验证失败'
```

Linux Bash 会话使用以下块；不要 `source` `.env`。

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
: "${OCC_BACKUP_ROOT:?必须设置 OCC_BACKUP_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
backup_root=$(realpath "$OCC_BACKUP_ROOT")
cd -- "$repository_root"
compose=(docker compose --env-file "$repository_root/infra/compose/.env" -f "$repository_root/infra/compose/compose.yml")
declare -A config=()
declare -A allowed=()
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE OCC_JWT_PRIVATE_KEY_FILE OCC_JWT_PUBLIC_KEY_FILE OCC_JWT_ISSUER POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
while IFS='=' read -r key value || [ -n "$key" ]; do
  value=${value%$'\r'}
  [ -z "$key" ] && continue
  case "$key" in \#*) continue;; esac
  [ -n "${allowed[$key]:-}" ] && [ -z "${config[$key]+present}" ] || exit 1
  config[$key]=$value
done <infra/compose/.env
POSTGRES_PORT=${config[POSTGRES_PORT]:-5432}
KAFKA_PORT=${config[KAFKA_PORT]:-9092}
REDIS_PORT=${config[REDIS_PORT]:-6379}
MINIO_API_PORT=${config[MINIO_API_PORT]:-9000}
MINIO_CONSOLE_PORT=${config[MINIO_CONSOLE_PORT]:-9001}
OPA_PORT=${config[OPA_PORT]:-8181}
AI_PORT=${config[AI_PORT]:-3100}
CORE_PORT=${config[CORE_PORT]:-8080}
POSTGRES_DB=${config[POSTGRES_DB]:-innorder_occ}
docker context show
"${compose[@]}" config --quiet
```

**验证：** 三个根目录存在且受组织访问控制保护；Docker context、Compose project 和仓库是当班目标。初始化失败时停止检查并升级环境访问问题，不改用隐式当前目录或另一个 Engine。

## 轮班、每日、每周、每月和每季度计划

| 周期 | 必做检查 | 记录与通过条件 |
|---|---|---|
| 接班后与交班前 | 未关闭事件、变更窗口、十一服务状态、HTTP/TCP、备份新鲜度、磁盘、时间 | 八个长运行服务 healthy、三个 one-shot 为 `exited 0`；失败有负责人和事件号 |
| 每日 | 日志错误趋势、容器资源、主机 CPU/内存、磁盘/inode、卷使用量、备份结果、DNS/TLS | 与基线比较；任何初始阈值越界均记录，不以单个瞬时峰值自动重启 |
| 每周 | Docker build/cache、镜像身份、源码 revision、日志增长、证据/备份保留、告警投递抽查 | revision 和镜像与发布记录一致；保留任务有可验证结果 |
| 每月 | 容量增长率、阈值调优、权限抽查、时间源/DNS/证书到期、恢复点抽样校验 | 依据至少四周趋势更新阈值和容量预测并获得审批 |
| 每季度 | 按[备份、恢复与灾难恢复](07-backup-restore-and-dr.md)做隔离恢复演练，审查升级/回滚与值班通讯录 | 演练有 RPO/RTO 实测、差距、责任人和完成日期 |

轮班检查单：

- [ ] 阅读上班交接、未关闭事件、风险接受和计划变更。
- [ ] 运行 Compose 状态与 one-shot 精确退出码检查。
- [ ] 运行 HTTP、TCP 和至少 PostgreSQL/Redis/Kafka 原生协议检查。
- [ ] 检查过去一班日志、重启次数、资源和磁盘趋势。
- [ ] 验证最后一个完整备份集合的时间、校验清单和异地复制状态。
- [ ] 记录异常的首次/最近发生时间、影响、证据位置、负责人和下一检查时间。

## Compose 状态、一次性任务与健康

Windows 精确状态检查会在原生命令后立即读取 `$LASTEXITCODE`，不会把缺失容器当作空结果通过。

```powershell
$ErrorActionPreference = 'Stop'
& docker @ComposeArgs ps -a
if ($LASTEXITCODE -ne 0) { throw 'Compose ps -a 失败' }
foreach ($service in 'postgres-init','flowable-init','minio-init') {
  $idOutput = & docker @ComposeArgs ps -a -q $service
  $idExit = $LASTEXITCODE
  $ids = @($idOutput | Where-Object { $_ })
  if ($idExit -ne 0 -or $ids.Count -ne 1) { throw "$service 容器查询失败或数量不是 1" }
  $state = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' $ids[0]
  if ($LASTEXITCODE -ne 0 -or $state -ne 'exited 0') { throw "$service 预期 exited 0，实际 $state" }
}
foreach ($service in 'postgres','kafka','redis','minio','opa','ai','core','host-gateway') {
  $idOutput = & docker @ComposeArgs ps -q $service
  $idExit = $LASTEXITCODE
  $ids = @($idOutput | Where-Object { $_ })
  if ($idExit -ne 0 -or $ids.Count -ne 1) { throw "$service 运行容器查询失败或数量不是 1" }
  $state = & docker inspect --format '{{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}' $ids[0]
  if ($LASTEXITCODE -ne 0 -or $state -notmatch '^running healthy restarts=') { throw "$service 未达到 running healthy：$state" }
  Write-Output "$service $state"
}
```

Linux 等价检查：

```bash
set -euo pipefail
"${compose[@]}" ps -a
for service in postgres-init flowable-init minio-init; do
  id=$("${compose[@]}" ps -a -q "$service")
  [ -n "$id" ] && [ "$(printf '%s\n' "$id" | wc -l)" -eq 1 ]
  state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id")
  [ "$state" = 'exited 0' ]
  printf '%s %s\n' "$service" "$state"
done
for service in postgres kafka redis minio opa ai core host-gateway; do
  id=$("${compose[@]}" ps -q "$service")
  [ -n "$id" ] && [ "$(printf '%s\n' "$id" | wc -l)" -eq 1 ]
  state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}' "$id")
  case "$state" in 'running healthy restarts='*) ;; *) printf '%s %s\n' "$service" "$state" >&2; exit 1;; esac
  printf '%s %s\n' "$service" "$state"
done
```

任何重启次数增加都应与 daemon/主机重启或已批准变更对应。无对应记录时按非计划重启升级；不得通过重新创建容器清零计数来隐藏事件。

## HTTP、TCP 与协议检查

Windows HTTP/TCP 检查采用有效端口并汇总失败：

```powershell
$ErrorActionPreference = 'Stop'
$HttpChecks = @(
  @('core-readiness',"http://127.0.0.1:$($Ports.Core)/actuator/health/readiness"),
  @('core-status',"http://127.0.0.1:$($Ports.Core)/api/v1/system/status"),
  @('ai-health',"http://127.0.0.1:$($Ports.Ai)/health"),
  @('ai-status',"http://127.0.0.1:$($Ports.Ai)/api/v1/system/status"),
  @('opa-health',"http://127.0.0.1:$($Ports.Opa)/health"),
  @('minio-readiness',"http://127.0.0.1:$($Ports.MinioApi)/minio/health/ready")
)
$Failures = New-Object System.Collections.Generic.List[string]
foreach ($check in $HttpChecks) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $check[1] -TimeoutSec 15
    if ([int]$response.StatusCode -ne 200) { $Failures.Add("$($check[0]) HTTP $($response.StatusCode)") }
  } catch { $Failures.Add("$($check[0]) $($_.Exception.Message)") }
}
foreach ($entry in $Ports.GetEnumerator()) {
  if (-not (Test-NetConnection 127.0.0.1 -Port $entry.Value -InformationLevel Quiet)) { $Failures.Add("$($entry.Key) TCP $($entry.Value)") }
}
if ($Failures.Count -gt 0) { $Failures | ForEach-Object { [Console]::Error.WriteLine($_) }; throw 'HTTP/TCP 检查失败' }
Write-Output 'HTTP 与八个回环 TCP 检查通过'
```

Linux 等价检查：

```bash
set -euo pipefail
checks=(
  "core-readiness|http://127.0.0.1:$CORE_PORT/actuator/health/readiness"
  "core-status|http://127.0.0.1:$CORE_PORT/api/v1/system/status"
  "ai-health|http://127.0.0.1:$AI_PORT/health"
  "ai-status|http://127.0.0.1:$AI_PORT/api/v1/system/status"
  "opa-health|http://127.0.0.1:$OPA_PORT/health"
  "minio-readiness|http://127.0.0.1:$MINIO_API_PORT/minio/health/ready"
)
for check in "${checks[@]}"; do
  IFS='|' read -r name url <<<"$check"
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 "$url")
  [ "$status" = 200 ] || { printf '%s HTTP %s\n' "$name" "$status" >&2; exit 1; }
done
for item in "PostgreSQL:$POSTGRES_PORT" "Kafka:$KAFKA_PORT" "Redis:$REDIS_PORT" "MinIO-API:$MINIO_API_PORT" "MinIO-Console:$MINIO_CONSOLE_PORT" "OPA:$OPA_PORT" "AI:$AI_PORT" "Core:$CORE_PORT"; do
  name=${item%%:*}; port=${item##*:}
  timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1; exec 3>&-; exec 3<&-' bash "$port"
  printf '%s PASS TCP %s\n' "$name" "$port"
done
```

协议检查不得把密码放入 argv。PostgreSQL 和 Redis 使用隐藏交互提示；Kafka 当前无认证，仅列 topic 元数据，不代表生产消费链。

```powershell
$ErrorActionPreference = 'Stop'
psql --host 127.0.0.1 --port $Ports.Postgres --dbname $DatabaseName --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 协议检查失败' }
redis-cli -h 127.0.0.1 -p $Ports.Redis --askpass PING
if ($LASTEXITCODE -ne 0) { throw 'Redis 协议检查失败' }
kafka-topics --bootstrap-server "127.0.0.1:$($Ports.Kafka)" --list
if ($LASTEXITCODE -ne 0) { throw 'Kafka 协议检查失败' }
```

```bash
set -euo pipefail
psql --host 127.0.0.1 --port "$POSTGRES_PORT" --dbname "$POSTGRES_DB" --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
redis-cli -h 127.0.0.1 -p "$REDIS_PORT" --askpass PING
if command -v kafka-topics >/dev/null; then
  kafka-topics --bootstrap-server "127.0.0.1:$KAFKA_PORT" --list
else
  kafka-topics.sh --bootstrap-server "127.0.0.1:$KAFKA_PORT" --list
fi
```

## 日志、资源和存储检查

日志检查必须保留 Compose 原生退出码。搜索无匹配通常是正常结果，不能因管道语义误报；日志读取失败则必须失败。

```powershell
$ErrorActionPreference = 'Stop'
$savedNativeErrorPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $logOutput = & docker @ComposeArgs logs --no-color --timestamps --since 24h 2>&1
  $logExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $savedNativeErrorPreference }
if ($logExit -ne 0) { throw "Compose 日志读取失败，退出码 $logExit" }
$matches = @($logOutput | Select-String -Pattern 'error|exception|fatal|panic|out of memory|no space left|migration' -CaseSensitive:$false)
$matches | Select-Object -Last 200
Write-Output "过去 24 小时高关注日志行数：$($matches.Count)；原始输出需脱敏后归档"
& docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}'
if ($LASTEXITCODE -ne 0) { throw 'docker stats 失败' }
& docker system df -v
if ($LASTEXITCODE -ne 0) { throw 'Docker build/cache 使用量查询失败' }
Get-Volume | Select-Object DriveLetter,FileSystem,HealthStatus,Size,SizeRemaining
Get-CimInstance Win32_Processor | Select-Object Name,LoadPercentage,NumberOfLogicalProcessors
Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime
```

```bash
set -euo pipefail
log_file=$(mktemp)
trap 'rm -f -- "$log_file"' EXIT
if ! "${compose[@]}" logs --no-color --timestamps --since 24h >"$log_file" 2>&1; then
  printf 'Compose 日志读取失败\n' >&2
  exit 1
fi
grep -Ei 'error|exception|fatal|panic|out of memory|no space left|migration' "$log_file" || true
printf '高关注日志行数：'
grep -Eic 'error|exception|fatal|panic|out of memory|no space left|migration' "$log_file" || true
rm -f -- "$log_file"; trap - EXIT
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}'
docker system df -v
df -hT
df -ih
free -h
uptime
vmstat 1 5
```

命名卷使用量由固定 digest 的只读辅助容器统计，不复制卷内容：

```powershell
$ErrorActionPreference = 'Stop'
$volumes = & docker volume ls --quiet --filter 'label=com.docker.compose.project=innorder-occ'
if ($LASTEXITCODE -ne 0) { throw '项目卷查询失败' }
$volumes = @($volumes | Where-Object { $_ })
if ($volumes.Count -ne 4) { throw "预期四个项目卷，实际 $($volumes.Count)" }
foreach ($volume in $volumes) {
  & docker run --rm --mount "type=volume,src=$volume,dst=/data,readonly" alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c du -sx -B 1 /data
  if ($LASTEXITCODE -ne 0) { throw "$volume 使用量统计失败" }
}
```

```bash
set -euo pipefail
set +e
volume_identity_output=$(docker volume ls --quiet --filter label=com.docker.compose.project=innorder-occ 2>&1); volume_identity_exit=$?
set -e
[ "$volume_identity_exit" -eq 0 ] || { printf '%s\n' "$volume_identity_output" >&2; exit "$volume_identity_exit"; }
[ -n "$volume_identity_output" ]
mapfile -t volumes <<<"$volume_identity_output"
[ "${#volumes[@]}" -eq 4 ]
for volume in "${volumes[@]}"; do
  printf '%s ' "$volume"
  docker run --rm --mount "type=volume,src=$volume,dst=/data,readonly" alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c du -sx -B 1 /data
done
```

**注意：** `du` 会对活跃卷产生读取 I/O，数据量大时安排在低峰并设置外部执行超时。不得从在线卷打包作为 PostgreSQL/MinIO 主备份。

## 时间、DNS 与 TLS

```powershell
$ErrorActionPreference = 'Stop'
Get-Date -Format o
w32tm /query /status
if ($LASTEXITCODE -ne 0) { throw 'Windows 时间同步状态查询失败' }
w32tm /query /source
if ($LASTEXITCODE -ne 0) { throw 'Windows 时间源查询失败' }
foreach ($uri in 'https://registry-1.docker.io/v2/','https://registry.npmjs.org/-/ping','https://repo.maven.apache.org/maven2/') {
  $hostName = ([Uri]$uri).DnsSafeHost
  Resolve-DnsName $hostName -ErrorAction Stop | Out-Null
  try { $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 30 } catch [Net.WebException] {
    if ($uri -like '*docker.io/v2/*' -and [int]$_.Exception.Response.StatusCode -eq 401) { continue }
    throw
  }
  if ([int]$response.StatusCode -ne 200) { throw "$uri TLS/HTTP 检查失败" }
}
```

```bash
set -euo pipefail
date --iso-8601=seconds
timedatectl status
timedatectl timesync-status
for url in 'https://registry-1.docker.io/v2/' 'https://registry.npmjs.org/-/ping' 'https://repo.maven.apache.org/maven2/'; do
  host=${url#https://}; host=${host%%/*}
  getent ahosts "$host" >/dev/null
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 30 "$url")
  case "$url:$status" in *docker.io/v2/:401|*:200) ;; *) printf '%s HTTP %s\n' "$url" "$status" >&2; exit 1;; esac
done
```

证书失败不得通过 `--insecure`、关闭校验或临时替换源绕过。时间偏差超过组织阈值时停止变更；当前命令展示同步状态，不自行校时。

## 源码、镜像身份与备份新鲜度

源码 revision、工作区状态、容器实际镜像 ID、仓库 digest 和 Compose 声明要共同记录。`RepoDigests` 可能为空的本地构建镜像以 image ID 加 revision 识别；外部镜像应有与 Compose 固定值一致的 digest。

```powershell
$ErrorActionPreference = 'Stop'
& git -c "safe.directory=$RepositoryRoot" rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Git revision 查询失败' }
& git -c "safe.directory=$RepositoryRoot" status --short
if ($LASTEXITCODE -ne 0) { throw 'Git 工作区查询失败' }
& docker @ComposeArgs images
if ($LASTEXITCODE -ne 0) { throw 'Compose 镜像清单失败' }
$ids = & docker @ComposeArgs ps -a -q
if ($LASTEXITCODE -ne 0) { throw '容器 ID 查询失败' }
foreach ($id in @($ids | Where-Object { $_ })) {
  & docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }} container={{.Id}} image={{.Image}}' $id
  if ($LASTEXITCODE -ne 0) { throw "容器 $id 身份查询失败" }
}
$imageIds = @(& docker @ComposeArgs images --quiet | Where-Object { $_ } | Sort-Object -Unique)
foreach ($imageId in $imageIds) {
  & docker image inspect --format '{{.Id}} {{json .RepoTags}} {{json .RepoDigests}}' $imageId
  if ($LASTEXITCODE -ne 0) { throw "镜像 $imageId inspect 失败" }
}
$latestManifest = Get-ChildItem -LiteralPath $BackupRoot -Filter 'backup-manifest.sha256' -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($null -eq $latestManifest) { throw '未找到备份校验清单' }
$age = (Get-Date).ToUniversalTime() - $latestManifest.LastWriteTimeUtc
[pscustomobject]@{ BackupManifest=$latestManifest.Name; LastWriteUtc=$latestManifest.LastWriteTimeUtc; AgeHours=[math]::Round($age.TotalHours,1) }
if ($age.TotalHours -gt 26) { throw '备份校验清单超过 26 小时；该值是待调优初始阈值' }
```

```bash
set -euo pipefail
git rev-parse HEAD
git status --short
"${compose[@]}" images
set +e
identity_ids_output=$("${compose[@]}" ps -a -q 2>&1); identity_ids_exit=$?
identity_images_output=$("${compose[@]}" images --quiet 2>&1); identity_images_exit=$?
set -e
[ "$identity_ids_exit" -eq 0 ] || { printf '%s\n' "$identity_ids_output" >&2; exit "$identity_ids_exit"; }
[ "$identity_images_exit" -eq 0 ] || { printf '%s\n' "$identity_images_output" >&2; exit "$identity_images_exit"; }
[ -n "$identity_ids_output" ] && [ -n "$identity_images_output" ]
mapfile -t ids <<<"$identity_ids_output"
[ "${#ids[@]}" -eq 11 ]
for id in "${ids[@]}"; do docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }} container={{.Id}} image={{.Image}}' "$id"; done
mapfile -t raw_image_ids <<<"$identity_images_output"
declare -A seen_image_ids=()
image_ids=()
for image_id in "${raw_image_ids[@]}"; do
  [ -n "$image_id" ]
  if [ -z "${seen_image_ids[$image_id]:-}" ]; then seen_image_ids[$image_id]=1; image_ids+=("$image_id"); fi
done
[ "${#image_ids[@]}" -gt 0 ]
for image_id in "${image_ids[@]}"; do docker image inspect --format '{{.Id}} {{json .RepoTags}} {{json .RepoDigests}}' "$image_id"; done
latest_manifest=$(find "$backup_root" -type f -name backup-manifest.sha256 -printf '%T@ %p\n' | sort -nr | sed -n '1{s/^[^ ]* //;p;}')
[ -n "$latest_manifest" ]
now=$(date +%s); modified=$(stat -c %Y "$latest_manifest"); age_seconds=$((now - modified))
printf '最新备份清单年龄：%s 秒；文件名：%s\n' "$age_seconds" "$(basename "$latest_manifest")"
[ "$age_seconds" -le 93600 ]
```

文件修改时间只能证明校验清单最近写入，不证明备份可恢复。每日还应验证当次命令零退出、清单中的 PostgreSQL/MinIO 文件均存在且 checksum 通过、复制到批准异地目标成功；季度隔离恢复才是可恢复性的证据。

## 基线、趋势与初始操作阈值

以下全部是**需要按真实工作负载调优的初始操作员阈值**，不是 SLA、容量承诺或自动处置触发器。上线后至少收集四周同一时段数据，使用正常峰值、增长率、恢复测试和业务窗口重新批准阈值。

| 指标 | 初始关注 | 初始紧急 | 解释与调优 |
|---|---:|---:|---|
| 任一长运行服务非 healthy | 连续 2 次/5 分钟 | 连续 3 次或 Core 不可用 10 分钟 | 同时检查原生协议和依赖，避免单一 health 误判 |
| 容器非计划重启 | 1 次 | 15 分钟内 3 次 | 排除批准 daemon/主机重启；不自动重启 |
| 主机或 Docker 内存 | 持续 15 分钟超过 75% | 持续 15 分钟超过 90% 或 OOM | 结合 swap、容器 RSS 和构建窗口 |
| CPU | 持续 15 分钟超过 80% | 持续 15 分钟超过 95% 且探测变慢 | 按同一时段基线和构建峰值调优 |
| 数据/Docker 文件系统 | 已用 70% 或预计 30 天到 80% | 已用 85% 或预计 7 天耗尽 | 同时看 bytes 与 inode；人工扩容/保留处置 |
| inode | 已用 70% | 已用 85% | 小文件工作负载需单独趋势 |
| 单卷日增长 | 超过近 14 日中位数 2 倍 | 按当前速率 7 天内耗尽 | PostgreSQL、MinIO、Kafka 分开建模 |
| 备份校验清单年龄 | 超过 26 小时 | 超过批准 RPO 或 checksum 失败 | 26 小时仅适用于每日任务的初始延迟窗口 |
| 时间偏差 | 超过组织标准一半 | 超过组织标准 | 组织未定义标准时先建立，不虚构毫秒保证 |
| 高关注日志 | 超过近 14 日同班次均值 2 倍 | fatal、OOM、磁盘满、迁移失败或疑似泄露一次 | 计数前按已知无害模式分类，不静默丢弃 |

趋势记录至少包含 UTC 时间、版本/revision、容器 image ID、主机重启/变更标记、每服务 CPU/内存、四卷字节、文件系统/inode、探测延迟/结果、日志分类数和备份年龄。阈值每月审查；调高阈值必须有容量或误报证据，不能只为停止告警。

## 当前可用告警与外部集成边界

当前 Compose 可直接观察：容器运行/健康/退出码、restart count、HTTP 状态、TCP/原生协议结果、Compose 日志、`docker stats` 瞬时资源、主机磁盘/inode/CPU/内存、镜像身份和备份文件时间。操作员可由组织批准的计划任务执行只读脚本，并仅把退出码、指标和脱敏摘要送到外部监控。

当前仓库**不提供**长期指标存储、日志集中化、分布式追踪、告警去重/抑制/路由、值班排班、合成业务事务、证书到期发现、备份调度或自动工单。外部集成必须自行定义：

- 使用最小权限采集身份；Docker socket 权限等价高权限，不能作为普通远程 exporter 权限。
- 只发送必要指标和脱敏标签，不发送 `.env`、密钥路径/值、认证头、对象键、客户数据或完整 inspect。
- 区分一次性任务正常 `exited 0` 与故障退出；区分网关/Core health 的有限语义。
- 对采集失败本身告警，记录最后成功采集时间；没有数据不能显示为健康。
- 自动动作仅可创建/更新事件和通知，不可停止、重启、重建、清理、迁移或恢复数据。

## 日志保留、脱敏与支持证据包

Docker 默认日志驱动和保留量取决于主机 Engine 配置；Compose 当前未声明日志轮转。每月核对 `docker info --format '{{.LoggingDriver}}'` 与组织 daemon 配置。修改 daemon 日志策略会影响主机其他容器，必须经独立变更和重启影响评估。保留期应按安全、审计、隐私和磁盘预算批准；不得以磁盘压力为由未审查删除事件日志。

日志进入证据前遮盖：密码/token/认证头、MinIO 用户名、对象键、客户标识/内容、绝对密钥路径、主机用户名和不必要的内部地址。遮盖必须不可逆，保留原件时按更高敏感级别限制访问；记录遮盖人和复核人。

Windows 支持包在受控目录创建，全部原生命令成功后才写 `COMPLETE`：

```powershell
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bundle = Join-Path $EvidenceRoot "occ-support-$stamp"
if (Test-Path -LiteralPath $bundle) { throw '支持包目录已存在' }
New-Item -ItemType Directory -Path $bundle -ErrorAction Stop | Out-Null
& icacls.exe $bundle /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw '关闭支持包 ACL 继承失败' }
& icacls.exe $bundle /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '设置支持包 ACL 失败' }
$commands = @(
  @('compose-ps.txt',@('compose','--env-file',$ComposeEnv,'-f',$ComposeFile,'ps','-a')),
  @('compose-images.txt',@('compose','--env-file',$ComposeEnv,'-f',$ComposeFile,'images')),
  @('docker-system-df.txt',@('system','df','-v')),
  @('compose-logs-review-required.txt',@('compose','--env-file',$ComposeEnv,'-f',$ComposeFile,'logs','--no-color','--timestamps','--tail','2000'))
)
foreach ($entry in $commands) {
  $savedNativeErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & docker @($entry[1]) 2>&1
    $nativeExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedNativeErrorPreference }
  if ($nativeExit -ne 0) { [IO.File]::WriteAllText((Join-Path $bundle 'INCOMPLETE'),"collection failed`r`n"); throw "$($entry[0]) 收集失败" }
  $output | Out-File (Join-Path $bundle $entry[0]) -Encoding utf8
}
[IO.File]::WriteAllText((Join-Path $bundle 'COMPLETE'),"review required`r`n")
```

Linux 等价收集：

```bash
set -euo pipefail
set +x
umask 077
bundle="$evidence_root/occ-support-$(date -u +%Y%m%d-%H%M%SZ)"
install -d -m 0700 "$bundle"
mark_incomplete() { printf 'collection failed\n' >"$bundle/INCOMPLETE"; }
trap mark_incomplete ERR
"${compose[@]}" ps -a >"$bundle/compose-ps.txt"
"${compose[@]}" images >"$bundle/compose-images.txt"
docker system df -v >"$bundle/docker-system-df.txt"
"${compose[@]}" logs --no-color --timestamps --tail 2000 >"$bundle/compose-logs-review-required.txt" 2>&1
printf 'review required\n' >"$bundle/COMPLETE"
trap - ERR
```

支持包还应由人工加入事件时间线、探测结果、revision、实际 image ID、主机资源和备份新鲜度结论。不得收集 `.env` 内容、密钥、完整环境、shell history、认证请求或未经必要性审查的数据库数据。`COMPLETE` 仅表示收集命令成功，不表示已脱敏；二次审查通过后才能移交。

## 交接模板与升级条件

每次交班使用以下字段，不留含义不明的“正常”结论：

```text
班次 UTC 起止：
值班人与接班人：
主机资产标识与 Compose project：
Git revision / APP_VERSION / 实际 image ID：
八个长运行服务与三个 one-shot 状态：
HTTP / TCP / 协议检查时间与结论：
CPU / 内存 / 磁盘 / inode / 四卷趋势：
最后完整备份 UTC、年龄、checksum 与异地复制结论：
开放事件、影响、首次发生、最近发生和事件号：
进行中变更、停止条件和回退责任人：
临时风险接受、批准人和到期时间：
证据包位置、敏感级别与访问人：
下一步、负责人和截止时间：
```

以下任一条件立即升级，不等待下个班次：Core readiness/数据库协议失败；PostgreSQL/MinIO 数据一致性疑问；迁移失败；磁盘或 inode 紧急阈值；备份 checksum 失败或超过批准 RPO；一次性任务非零；非计划反复重启；疑似凭据/客户数据泄露；镜像/revision 与发布记录不一致；时间显著漂移；Docker Engine 或主机不可用；任何操作可能需要删除数据、恢复、回滚 schema 或扩大网络暴露。

升级时提供影响范围、首次/最近时间、已执行的只读检查、精确失败、revision/image ID、脱敏证据和当前写入状态。不要在没有根因、备份、影响确认和审批时重启；不要删除容器/卷、修剪 cache、编辑已应用迁移或运行恢复来“试一下”。

## 当班关闭检查

- [ ] 所有检查均记录命令退出状态；空输出和命令失败没有混淆。
- [ ] 健康结论同时覆盖八个 `running healthy`、三个 `exited 0`、HTTP/TCP/协议和有限健康语义。
- [ ] 初始阈值越界均有事件、负责人或经批准的期限性风险接受。
- [ ] 备份新鲜度同时核对时间、checksum、异地复制；未把文件时间当作可恢复证明。
- [ ] 日志和支持包已脱敏、限制访问并设置保留期。
- [ ] 未执行破坏性自动修复；任何人工状态变更都有影响、审批、回退与验证。
- [ ] 交接字段完整，接班人能够从证据重现当前结论。
