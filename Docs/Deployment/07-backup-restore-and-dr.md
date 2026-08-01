# 备份、恢复与灾难恢复

本章定义当前单节点 Compose 部署的可恢复集合、创建与校验命令、隔离恢复、切换和灾难处置。它不承诺未实测的 RPO/RTO，不把在线命名卷复制作为 PostgreSQL、MinIO 或 Kafka 的应用一致主备份，也不把单主机快照误写成高可用。

## 一致性模型与权威数据

一个备份集合使用唯一 UTC 标识，记录备份开始/结束时间。当前组件之间没有可用的全局快照协议：

- PostgreSQL 自定义格式逻辑备份是关系事实、Flyway 历史和 Flowable 表的**权威数据库备份**。`pg_dump` 在单个数据库事务快照内一致，但不包含集群级角色密码和 tablespace 定义。
- MinIO 对精确 `OBJECT_STORAGE_BUCKET` 执行对象镜像。`mc mirror` 在一个时间区间逐对象读取，不是与 PostgreSQL 同时发生的原子快照；对象在镜像期间改变会破坏集合级一致性。
- 为获得可解释的集合，应先阻止新客户端写入并停止 Core，再创建 PostgreSQL dump 和 MinIO mirror。当前基础没有业务事务可供演示；不得发明“测试订单”等工作流。未来出现写入能力后必须由应用所有者提供静默/排空证据。
- Redis 当前配置为带认证 AOF，架构角色是可重建缓存/辅助状态；实际丢失降级尚未完整验证。RDB 快照只是次要恢复材料，不提升为权威事实。
- Kafka 当前是单节点 KRaft，架构角色不是业务主存储。仓库没有跨 topic、producer、consumer group 的一致备份协议，也没有复制集。运行中复制 `kafka-data` 可能混合日志段、索引和 KRaft 元数据时点，不能称为应用一致备份。

**注意：** 即使 Core 已停止，其他被授权的数据库/对象客户端也必须确认停止。无法排除写入时，把 PostgreSQL 和 MinIO 分别标为组件一致，明确时间窗口和潜在跨存储偏差，不得宣称全局一致。

## 完整备份集合

每个集合必须包含或引用：

| 项目 | 内容 | 是否包含敏感值 |
|---|---|---|
| 发布来源 | `source-revision.txt`、`source-status.txt` | 否；不复制仓库工作区作为备份 |
| 配置恢复 | `configuration-paths-only.txt`、`compose-env-paths-only.txt`、`compose-env-nonsecret.txt` | 保存 Compose/env 位置、十个 secret 源路径、JWT issuer 和十二个可选非秘密配置；路径按敏感元数据保护，不保存 secret 值 |
| 密钥托管 | `secret-escrow-receipt.txt` | 只保存外部托管版本/取回收据，不含 secret 值或值散列 |
| 镜像 | `compose-images.txt`、`image-identifiers.txt` | Compose 镜像清单、实际 image ID、RepoTag/RepoDigest 和本地构建 revision 关联 |
| PostgreSQL | 精确一个 `occ-*.dump` 与非空 `postgresql-restore-list.txt` | 自定义格式逻辑备份与独立 `pg_restore --list` 结果 |
| MinIO | `minio/objects/`、`source-objects.json`、`source-object-count.txt`、`source-object-manifest.jsonl`、`minio-files.sha256` | 精确桶镜像、源对象清单、canonical key/size 对照和落地文件清单；空桶必须由清单显式证明 |
| Redis | `redis-disposition.txt`，选择快照时另有 `redis.rdb` 与 `redis-bgsave-proof.txt` | 必须明确 `snapshot` 或 `rebuildable-no-snapshot`；证明文件记录新 BGSAVE 前后时间/状态 |
| Kafka | `kafka-topics.txt`、`kafka-consumer-groups.txt`、`kafka-disposition.txt`，选择冷归档时另有 `kafka-data-cold.tar.gz` | 必须明确 `metadata-only` 或 `cold-archive`，不保证消息级恢复 |
| 策略与工具 | `backup-policy-metadata.txt`、`backup-trust-status.txt`、`tool-versions.txt`、开始/结束 UTC | 记录 source/deployed revision、change ID、政策、保留类别、故障域、信任模式和工具版本 |
| 完整性 | `backup-artifacts.inventory`、`backup-manifest.sha256`、`COMPLETE` | inventory 与 checksum 只能检测意外损坏；外部模式另由批准验证工具输出 `external-trust-evidence.txt` 控制证据 |

`.env` 不整文件归档：十个 secret **路径**写入 `compose-env-paths-only.txt`，JWT issuer 和十二个可选非敏感覆盖写入 `compose-env-nonsecret.txt`。两者合并后必须精确覆盖 `.env.example` 的允许 key；不得把 secret escrow 内容放入同一目录。恢复负责人必须能从独立托管取回与备份时点匹配的凭据，且取回操作有双人审批和审计。

## 备份会话与安全目标

备份 staging 必须位于仓库和 Docker 数据根之外。相同主机或相同文件系统上的 staging 仍可能与主机、磁盘、勒索软件或管理员误操作共同丢失，只能称为本地内部完整性副本。只有批准的 off-host immutable/WORM/object-lock 或 detached-signature 系统已接收 manifest/数据并由其验证工具重新验证，才可标记 `external-verified`；不得从本机路径或本机可写文本推导 host-loss-ready。

先由批准会话设置路径、`OCC_DEPLOYED_REVISION`、`OCC_BACKUP_CHANGE_ID`、`OCC_BACKUP_FAULT_DOMAIN` 和 `OCC_EXTERNAL_TRUST_MODE`。Windows Docker Desktop 还必须设置批准的主机侧 `OCC_DOCKER_DATA_ROOT_HOST`；Engine 报告的 Linux VM `DockerRootDir` 仍要查询和记录，但不能与 Windows 路径直接比较。

```powershell
$ErrorActionPreference = 'Stop'
foreach ($name in 'OCC_REPOSITORY_ROOT','OCC_BACKUP_ROOT','OCC_SECRET_ESCROW_RECEIPT','OCC_DOCKER_DATA_ROOT_HOST','OCC_EVIDENCE_ROOT') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value) -or -not [IO.Path]::IsPathRooted($value)) { throw "$name 必须是绝对路径" }
}
foreach ($name in 'OCC_BACKUP_POLICY_ID','OCC_BACKUP_RETENTION_CLASS','OCC_BACKUP_CONSISTENCY','OCC_DEPLOYED_REVISION','OCC_BACKUP_CHANGE_ID','OCC_BACKUP_FAULT_DOMAIN','OCC_EXTERNAL_TRUST_MODE') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]') { throw "$name 必须是无换行的非空元数据" }
}
$RepositoryRoot = (Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT).Path
$BackupRoot = (Resolve-Path -LiteralPath $env:OCC_BACKUP_ROOT).Path
$DockerDataRootHost = (Resolve-Path -LiteralPath $env:OCC_DOCKER_DATA_ROOT_HOST).Path
$EvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT).Path
function Assert-NoReparsePath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $current = [IO.Path]::GetPathRoot($full)
  foreach ($segment in $full.Substring($current.Length).Split(@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar),[StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $segment
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "备份路径包含 junction/symlink/reparse point：$current" }
  }
}
Assert-NoReparsePath $BackupRoot
Assert-NoReparsePath $RepositoryRoot
Assert-NoReparsePath $DockerDataRootHost
$LifecycleLockPath = Join-Path $EvidenceRoot 'innorder-occ-lifecycle.lock'
$DockerRootDirReported = (& docker info --format '{{.DockerRootDir}}').Trim()
$dockerInfoExit = $LASTEXITCODE
if ($dockerInfoExit -ne 0 -or [string]::IsNullOrWhiteSpace($DockerRootDirReported)) { throw 'DockerRootDir 查询失败' }
function Test-PathWithin([string]$Candidate,[string]$Parent) {
  $prefix = $Parent.TrimEnd('\') + '\'
  return $Candidate.Equals($Parent,[StringComparison]::OrdinalIgnoreCase) -or $Candidate.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
}
if (Test-PathWithin $BackupRoot $RepositoryRoot) { throw 'OCC_BACKUP_ROOT 不能位于仓库内' }
if (Test-PathWithin $BackupRoot $DockerDataRootHost) { throw 'OCC_BACKUP_ROOT 不能位于 Docker 主机数据根内' }
if ($DockerRootDirReported -match '^(?:[A-Za-z]:\\|\\\\)') {
  $reportedHostRoot = (Resolve-Path -LiteralPath $DockerRootDirReported).Path
  if (-not $reportedHostRoot.Equals($DockerDataRootHost,[StringComparison]::OrdinalIgnoreCase)) { throw 'Engine 报告的 Windows DockerRootDir 与批准主机路径不同' }
}
if ($env:OCC_DEPLOYED_REVISION -notmatch '^[0-9a-fA-F]{40}$') { throw 'OCC_DEPLOYED_REVISION 必须是完整 commit ID' }
if ($env:OCC_EXTERNAL_TRUST_MODE -notin @('internal-only','external-verified')) { throw 'OCC_EXTERNAL_TRUST_MODE 无效' }
if ($env:OCC_BACKUP_FAULT_DOMAIN -notin @('same-host-staging','off-host-immutable-copy')) { throw 'OCC_BACKUP_FAULT_DOMAIN 无效' }
if ($env:OCC_BACKUP_CONSISTENCY -notin @('quiesced-component-consistent','non-quiesced-component-snapshots')) { throw 'OCC_BACKUP_CONSISTENCY 必须使用受支持枚举' }
if ($env:OCC_EXTERNAL_TRUST_MODE -eq 'external-verified') {
  foreach ($name in 'OCC_EXTERNAL_VERIFY_TOOL','OCC_EXTERNAL_RECORD_ID','OCC_EXTERNAL_RECORD_VERSION') { $value=[Environment]::GetEnvironmentVariable($name); if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]') { throw "外部验证模式缺少有效 $name" } }
  if (-not [IO.Path]::IsPathRooted($env:OCC_EXTERNAL_VERIFY_TOOL)) { throw '外部验证工具必须是绝对路径' }
}
Set-Location -LiteralPath $RepositoryRoot
$ComposeEnv = Join-Path $RepositoryRoot 'infra\compose\.env'
$ComposeFile = Join-Path $RepositoryRoot 'infra\compose\compose.yml'
$ComposeArgs = @('compose','--env-file',$ComposeEnv,'-f',$ComposeFile)
$BackupId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$BackupSet = Join-Path $BackupRoot $BackupId
if (Test-Path -LiteralPath $BackupSet) { throw '备份集合目录已存在' }
New-Item -ItemType Directory -Path $BackupSet -ErrorAction Stop | Out-Null
& icacls.exe $BackupSet /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw '关闭备份目录 ACL 继承失败' }
& icacls.exe $BackupSet /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '设置备份目录 ACL 失败' }
[IO.File]::WriteAllText((Join-Path $BackupSet 'backup-start-utc.txt'),((Get-Date).ToUniversalTime().ToString('o') + "`r`n"))
```

Linux Bash 初始化：

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_BACKUP_ROOT:?必须设置 OCC_BACKUP_ROOT}"
: "${OCC_SECRET_ESCROW_RECEIPT:?必须设置 OCC_SECRET_ESCROW_RECEIPT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
: "${OCC_BACKUP_POLICY_ID:?必须设置 OCC_BACKUP_POLICY_ID}"
: "${OCC_BACKUP_RETENTION_CLASS:?必须设置 OCC_BACKUP_RETENTION_CLASS}"
: "${OCC_BACKUP_CONSISTENCY:?必须设置 OCC_BACKUP_CONSISTENCY}"
: "${OCC_DEPLOYED_REVISION:?必须设置 OCC_DEPLOYED_REVISION}"
: "${OCC_BACKUP_CHANGE_ID:?必须设置 OCC_BACKUP_CHANGE_ID}"
: "${OCC_BACKUP_FAULT_DOMAIN:?必须设置 OCC_BACKUP_FAULT_DOMAIN}"
: "${OCC_EXTERNAL_TRUST_MODE:?必须设置 OCC_EXTERNAL_TRUST_MODE}"
case "$OCC_SECRET_ESCROW_RECEIPT" in /*) ;; *) printf 'secret escrow 收据路径必须是绝对路径\n' >&2; exit 1;; esac
case "$OCC_BACKUP_POLICY_ID$OCC_BACKUP_RETENTION_CLASS$OCC_BACKUP_CONSISTENCY$OCC_BACKUP_CHANGE_ID" in *$'\n'*|*$'\r'*) printf '备份元数据不能含换行\n' >&2; exit 1;; esac
[[ $OCC_DEPLOYED_REVISION =~ ^[0-9a-fA-F]{40}$ ]]
case "$OCC_EXTERNAL_TRUST_MODE" in internal-only) ;; external-verified) : "${OCC_EXTERNAL_VERIFY_TOOL:?必须设置外部验证工具}"; : "${OCC_EXTERNAL_RECORD_ID:?必须设置外部记录 ID}"; : "${OCC_EXTERNAL_RECORD_VERSION:?必须设置外部记录版本}"; case "$OCC_EXTERNAL_VERIFY_TOOL" in /*) ;; *) exit 1;; esac;; *) exit 1;; esac
case "$OCC_BACKUP_FAULT_DOMAIN" in same-host-staging|off-host-immutable-copy) ;; *) exit 1;; esac
case "$OCC_BACKUP_CONSISTENCY" in quiesced-component-consistent|non-quiesced-component-snapshots) ;; *) exit 1;; esac
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
backup_root=$(realpath "$OCC_BACKUP_ROOT")
evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
lifecycle_lock_fd=
set +e
docker_root_output=$(docker info --format '{{.DockerRootDir}}' 2>&1); docker_root_exit=$?
set -e
[ "$docker_root_exit" -eq 0 ] || { printf '%s\n' "$docker_root_output" >&2; exit "$docker_root_exit"; }
[ -n "$docker_root_output" ]
docker_root=$(realpath "$docker_root_output")
case "$backup_root/" in "$repository_root/"*) printf '备份 staging 不能位于仓库内\n' >&2; exit 1;; esac
case "$backup_root/" in "$docker_root/"*) printf '备份 staging 不能位于 DockerRootDir 内\n' >&2; exit 1;; esac
cd -- "$repository_root"
compose=(docker compose --env-file "$repository_root/infra/compose/.env" -f "$repository_root/infra/compose/compose.yml")
backup_id=$(date -u +%Y%m%dT%H%M%SZ)
backup_set="$backup_root/$backup_id"
test ! -e "$backup_set"
install -d -m 0700 "$backup_set"
date -u --iso-8601=seconds >"$backup_set/backup-start-utc.txt"
```

**验证：** Windows ACL 只允许批准的部署/备份身份、`SYSTEM` 和 Administrators；Linux 目录为 `0700` 且由备份身份拥有。脚本强制 staging 不在仓库或 Docker 数据根内，但这不证明跨文件系统或跨主机。`same-host-staging` 永远不是 DR；`off-host-immutable-copy` 还必须由外部系统工具验证后才可用于 host-loss-ready 策略。权限、DockerRootDir 或边界检查失败时不创建备份集合。

## 静默与备份前门禁

停止 Core 会中断状态 API 和未来业务访问，但不停止 PostgreSQL、MinIO、Redis 或 Kafka。执行前确认维护窗口、调用方静默、备份责任人和恢复责任人；设置精确确认值。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_BACKUP_QUIESCE -ne 'APPROVED') { throw '未批准备份静默窗口' }
try { $LifecycleLock=[IO.File]::Open($LifecycleLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch [IO.IOException] { throw '另一个受管 OCC 操作持有项目全局锁' }
$BackupCoreStopped = $false
function Restore-CoreAfterBackup {
  if (-not $BackupCoreStopped) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $BackupSet 'COMPLETE') -PathType Leaf)) { [IO.File]::WriteAllText((Join-Path $BackupSet 'INCOMPLETE'),"backup did not complete`r`n",(New-Object Text.UTF8Encoding($false))) }
  & docker @ComposeArgs start core
  $restoreExit = $LASTEXITCODE
  $BackupCoreStopped = $false
  if ($restoreExit -ne 0) { throw '备份清理未能恢复 Core；立即升级可用性事件' }
}
trap {
  $backupFailure = $_
  try { Restore-CoreAfterBackup } catch { [Console]::Error.WriteLine($_.Exception.Message) }
  if ($LifecycleLock) { $LifecycleLock.Dispose(); $LifecycleLock=$null }
  [Console]::Error.WriteLine("备份失败：$($backupFailure.Exception.Message)")
  break
}
& docker @ComposeArgs ps -a
if ($LASTEXITCODE -ne 0) { throw '备份前状态查询失败' }
$BackupCoreStopped = $true
& docker @ComposeArgs stop core
if ($LASTEXITCODE -ne 0) { throw '停止 Core 失败；核对实际状态后停止备份' }
$coreId = & docker @ComposeArgs ps -a -q core
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($coreId)) { throw 'Core 容器状态不可确认' }
$coreState = & docker inspect --format '{{.State.Status}}' $coreId
if ($LASTEXITCODE -ne 0 -or $coreState -ne 'exited') { throw "Core 未静默：$coreState" }
$externalWriters = [Environment]::GetEnvironmentVariable('OCC_CONFIRM_EXTERNAL_WRITERS_QUIESCED')
if ($env:OCC_BACKUP_CONSISTENCY -eq 'quiesced-component-consistent' -and $externalWriters -ne 'APPROVED') { throw '声明静默组件一致时必须确认所有外部数据库和对象写入方已停止' }
$consistencyEvidence = @(
  "declared-consistency=$($env:OCC_BACKUP_CONSISTENCY)",
  'core-state=exited',
  ("external-writers-quiesced={0}" -f $(if ($externalWriters -eq 'APPROVED') { 'approved' } else { 'not-proven' })),
  'global-snapshot=not-available'
)
[IO.File]::WriteAllLines((Join-Path $BackupSet 'backup-consistency-evidence.txt'),$consistencyEvidence,(New-Object Text.UTF8Encoding($false)))
```

```bash
set -euo pipefail
: "${OCC_CONFIRM_BACKUP_QUIESCE:?必须设置确认值}"
[ "$OCC_CONFIRM_BACKUP_QUIESCE" = APPROVED ]
exec {lifecycle_lock_fd}>"$evidence_root/innorder-occ-lifecycle.lock"
flock -n "$lifecycle_lock_fd" || { exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; printf '另一个受管 OCC 操作持有项目全局锁\n' >&2; exit 1; }
backup_core_stopped=0
backup_cleanup() {
  local original_status=$?
  if [ "$backup_core_stopped" -eq 1 ]; then
    [ -f "$backup_set/COMPLETE" ] || printf 'backup did not complete\n' >"$backup_set/INCOMPLETE"
    if "${compose[@]}" start core; then backup_core_stopped=0; else printf '备份清理未能恢复 Core；立即升级可用性事件\n' >&2; original_status=1; fi
  fi
  if [ -n "${lifecycle_lock_fd:-}" ]; then flock -u "$lifecycle_lock_fd" || true; exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; fi
  return "$original_status"
}
trap backup_cleanup EXIT
"${compose[@]}" ps -a
backup_core_stopped=1
"${compose[@]}" stop core
core_id=$("${compose[@]}" ps -a -q core)
[ -n "$core_id" ]
[ "$(docker inspect --format '{{.State.Status}}' "$core_id")" = exited ]
case "$OCC_BACKUP_CONSISTENCY" in
  quiesced-component-consistent) [ "${OCC_CONFIRM_EXTERNAL_WRITERS_QUIESCED:-}" = APPROVED ]; external_writers=approved;;
  non-quiesced-component-snapshots) if [ "${OCC_CONFIRM_EXTERNAL_WRITERS_QUIESCED:-}" = APPROVED ]; then external_writers=approved; else external_writers=not-proven; fi;;
  *) exit 1;;
esac
printf 'declared-consistency=%s\ncore-state=exited\nexternal-writers-quiesced=%s\nglobal-snapshot=not-available\n' "$OCC_BACKUP_CONSISTENCY" "$external_writers" >"$backup_set/backup-consistency-evidence.txt"
```

如果停止失败或存在未知写入方，记录备份为非静默组件快照并由数据所有者决定是否继续；不能忽略。备份流程无论成功失败都要按“恢复应用”步骤启动 Core 并验证，除非现场事件要求保持停机。

## PostgreSQL 权威逻辑备份

### 自定义格式、角色和所有权

`pg_dump --format=custom` 支持压缩归档、`pg_restore --list`、选择性恢复和并行恢复。它包含对象定义、数据、ACL 和对象 owner 名称，但不创建集群级登录角色或恢复密码。隔离目标必须先由当前初始化脚本创建 `innorder_admin`、`innorder_flyway`、`innorder_runtime` 及扩展；角色密码来自目标环境的外部 secret escrow。

备份以 `innorder_admin` 执行以读取全部 schema。密码只由 PostgreSQL 容器内 secret 文件进入短生命周期进程环境，不出现在 host argv。dump 先写容器临时文件，验证后用 `docker cp` 二进制复制，避免 Windows PowerShell 5.1 重定向损坏二进制。

```powershell
$ErrorActionPreference = 'Stop'
$postgresId = & docker @ComposeArgs ps -q postgres
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($postgresId)) { throw 'PostgreSQL 容器不存在' }
$dumpName = "occ-$BackupId.dump"
& docker @ComposeArgs exec -T postgres sh -ec 'umask 077; export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; pg_dump --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --format=custom --compress=6 --file /tmp/occ-backup.dump; status=$?; unset PGPASSWORD; exit $status'
if ($LASTEXITCODE -ne 0) { throw 'pg_dump 失败' }
& docker @ComposeArgs exec -T postgres pg_restore --list /tmp/occ-backup.dump
if ($LASTEXITCODE -ne 0) { throw '容器内 pg_restore 清单验证失败' }
& docker cp "${postgresId}:/tmp/occ-backup.dump" (Join-Path $BackupSet $dumpName)
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL dump 二进制复制失败' }
$restoreList = & docker run --rm --mount "type=bind,src=$BackupSet,dst=/backup,readonly" pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9 pg_restore --list "/backup/$dumpName" 2>&1
$restoreListExit = $LASTEXITCODE
if ($restoreListExit -ne 0 -or @($restoreList).Count -eq 0) { throw '主机备份文件 pg_restore 清单验证失败或结果为空' }
$restoreList | Out-File (Join-Path $BackupSet 'postgresql-restore-list.txt') -Encoding utf8
& docker @ComposeArgs exec -T postgres rm -f /tmp/occ-backup.dump
if ($LASTEXITCODE -ne 0) { throw '容器临时 dump 清理失败；记录后人工处理' }
```

```bash
set -euo pipefail
postgres_id=$("${compose[@]}" ps -q postgres)
[ -n "$postgres_id" ]
dump_name="occ-$backup_id.dump"
"${compose[@]}" exec -T postgres sh -ec 'umask 077; export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; pg_dump --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --format=custom --compress=6 --file /tmp/occ-backup.dump; status=$?; unset PGPASSWORD; exit $status'
"${compose[@]}" exec -T postgres pg_restore --list /tmp/occ-backup.dump
docker cp "$postgres_id:/tmp/occ-backup.dump" "$backup_set/$dump_name"
docker run --rm --mount "type=bind,src=$backup_set,dst=/backup,readonly" pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9 pg_restore --list "/backup/$dump_name" >"$backup_set/postgresql-restore-list.txt"
"${compose[@]}" exec -T postgres rm -f /tmp/occ-backup.dump
```

`pg_restore --list` 只验证归档目录可读，不验证每个数据块或逻辑约束能恢复。季度必须恢复到隔离数据库，查询完整 Flyway 历史、schema/owner、Flowable 表和应用 readiness。不要使用 `--no-owner` 掩盖角色缺失；若组织决定重映射所有权，必须由 DBA 审批并验证所有已部署迁移与 Flowable 后续迁移仍由正确角色拥有。

## MinIO 精确桶镜像

当前固定 `minio/mc` 镜像与 Compose `minio-init` 一致。命令使用 MinIO root secret 在内部网络建立短生命周期 alias，只镜像配置的 `MINIO_BUCKET`；凭据不进入 host argv、输出或备份目录，但 `mc alias set` 会让值在短生命周期容器内的 `mc` 进程 argv 中短暂可见。Docker/主机管理员本就能读取挂载 secret，执行窗口仍必须禁止进程快照、调试 trace 和支持包采集。目标是新建的空 `minio` 子目录，不使用 `--remove`。

```powershell
$ErrorActionPreference = 'Stop'
$minioBackup = Join-Path $BackupSet 'minio'
New-Item -ItemType Directory -Path $minioBackup -ErrorAction Stop | Out-Null
& docker @ComposeArgs exec -T minio curl -fsS http://localhost:9000/minio/health/ready
if ($LASTEXITCODE -ne 0) { throw 'MinIO 未 ready' }
& docker @ComposeArgs run --rm --no-deps --volume "${minioBackup}:/backup" --entrypoint /bin/sh minio-init -ec 'mkdir -p /backup/objects; root_user="$(cat /run/secrets/minio_root_user)"; root_password="$(cat /run/secrets/minio_root_password)"; mc alias set source http://minio:9000 "$root_user" "$root_password" >/dev/null; unset root_user root_password; mc mirror --preserve source/"$MINIO_BUCKET" /backup/objects; mc ls --recursive --json source/"$MINIO_BUCKET" > /backup/source-objects.json'
if ($LASTEXITCODE -ne 0) { throw 'MinIO 桶镜像或对象清单失败' }
$objectLines = @(Get-Content -LiteralPath (Join-Path $minioBackup 'source-objects.json'))
[IO.File]::WriteAllText((Join-Path $minioBackup 'source-object-count.txt'),("{0}`r`n" -f $objectLines.Count))
$minioObjectRoot = Join-Path $minioBackup 'objects'
& node -e 'const fs=require("node:fs"),path=require("node:path");const [source,root,out]=process.argv.slice(1);const text=fs.readFileSync(source,"utf8").trim();const records=text?text.split(/\r?\n/).map(JSON.parse).filter(x=>x.type==="file"):[];const expected=new Map();for(const x of records){if(typeof x.key!=="string"||!Number.isSafeInteger(x.size)||x.size<0||expected.has(x.key))process.exit(2);expected.set(x.key,x.size)}const actual=new Map();function walk(dir,prefix=""){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const key=prefix?prefix+"/"+e.name:e.name;const full=path.join(dir,e.name);if(e.isDirectory())walk(full,key);else if(e.isFile())actual.set(key,fs.statSync(full).size);else process.exit(3)}}walk(root);if(expected.size!==actual.size||[...expected].some(([k,v])=>actual.get(k)!==v))process.exit(4);fs.writeFileSync(out,[...expected].sort(([a],[b])=>a.localeCompare(b)).map(([key,size])=>JSON.stringify({key,size})).join("\n")+(expected.size?"\n":""))' (Join-Path $minioBackup 'source-objects.json') $minioObjectRoot (Join-Path $minioBackup 'source-object-manifest.jsonl')
if ($LASTEXITCODE -ne 0) { throw 'MinIO 源 key/size 与镜像目录不一致' }
$minioHashes = @(Get-ChildItem -LiteralPath $minioObjectRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($minioBackup.Length + 1).Replace('\','/')
  '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(),$relative
})
[IO.File]::WriteAllLines((Join-Path $minioBackup 'minio-files.sha256'),$minioHashes,(New-Object Text.UTF8Encoding($false)))
```

```bash
set -euo pipefail
minio_backup="$backup_set/minio"
install -d -m 0700 "$minio_backup"
"${compose[@]}" exec -T minio curl -fsS http://localhost:9000/minio/health/ready
"${compose[@]}" run --rm --no-deps --volume "$minio_backup:/backup" --entrypoint /bin/sh minio-init -ec 'mkdir -p /backup/objects; root_user="$(cat /run/secrets/minio_root_user)"; root_password="$(cat /run/secrets/minio_root_password)"; mc alias set source http://minio:9000 "$root_user" "$root_password" >/dev/null; unset root_user root_password; mc mirror --preserve source/"$MINIO_BUCKET" /backup/objects; mc ls --recursive --json source/"$MINIO_BUCKET" > /backup/source-objects.json'
wc -l <"$minio_backup/source-objects.json" >"$minio_backup/source-object-count.txt"
(node -e 'const fs=require("node:fs"),path=require("node:path");const [source,root,out]=process.argv.slice(1);const text=fs.readFileSync(source,"utf8").trim();const records=text?text.split(/\r?\n/).map(JSON.parse).filter(x=>x.type==="file"):[];const expected=new Map();for(const x of records){if(typeof x.key!=="string"||!Number.isSafeInteger(x.size)||x.size<0||expected.has(x.key))process.exit(2);expected.set(x.key,x.size)}const actual=new Map();function walk(dir,prefix=""){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const key=prefix?prefix+"/"+e.name:e.name;const full=path.join(dir,e.name);if(e.isDirectory())walk(full,key);else if(e.isFile())actual.set(key,fs.statSync(full).size);else process.exit(3)}}walk(root);if(expected.size!==actual.size||[...expected].some(([k,v])=>actual.get(k)!==v))process.exit(4);fs.writeFileSync(out,[...expected].sort(([a],[b])=>a.localeCompare(b)).map(([key,size])=>JSON.stringify({key,size})).join("\n")+(expected.size?"\n":""))' "$minio_backup/source-objects.json" "$minio_backup/objects" "$minio_backup/source-object-manifest.jsonl")
(cd -- "$minio_backup" && find objects -type f -print0 | sort -z | xargs -0 -r sha256sum >minio-files.sha256)
```

对象计数用于发现明显缺失，不证明字节级相等。S3 ETag 对 multipart、加密或实现差异不保证是对象内容 MD5；不能把 ETag 当通用 checksum。备份集合的 SHA-256 只能证明落地文件此后未改变。隔离恢复后应比较源清单与目标对象键、大小和版本/元数据需求，并对组织选定样本或全量对象下载计算内容 checksum；源在备份后继续变化时，比较必须使用备份时清单而不是当前源。

## Redis 次要快照

Core 已停止且没有其他 Redis 写入方时，先记录 `rdb_last_bgsave_time_sec` 与 `rdb_last_bgsave_status`，再执行 `BGSAVE`。必须同时满足：`redis-cli` 原生退出零、响应精确为 `Background saving started`、后台保存结束、最终 status 为 `ok`，且最终时间严格大于先前时间。任何一项失败或时间未变化都不复制。命令从容器 secret 认证，不输出密码；证明文件只含时间和状态。

```powershell
$ErrorActionPreference = 'Stop'
$redisId = & docker @ComposeArgs ps -q redis
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($redisId)) { throw 'Redis 容器不存在' }
$bgsaveProof = & docker @ComposeArgs exec -T redis sh -ec 'set -eu; set +x; export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; read_info() { output=$(redis-cli --no-auth-warning INFO persistence); rc=$?; [ "$rc" -eq 0 ]; printf "%s\n" "$output"; }; field() { printf "%s\n" "$1" | tr -d "\r" | awk -F: -v key="$2" "\$1 == key { print \$2 }"; }; before=$(read_info); pre_time=$(field "$before" rdb_last_bgsave_time_sec); pre_status=$(field "$before" rdb_last_bgsave_status); [ -n "$pre_status" ]; case "$pre_time" in -[0-9]*|[0-9]*) ;; *) exit 1;; esac; response=$(redis-cli --no-auth-warning BGSAVE); response_rc=$?; [ "$response_rc" -eq 0 ]; [ "$response" = "Background saving started" ]; deadline=$(( $(date +%s) + 300 )); while :; do current=$(read_info); progress=$(field "$current" rdb_bgsave_in_progress); case "$progress" in 0) break;; 1) [ "$(date +%s)" -lt "$deadline" ]; sleep 1;; *) exit 1;; esac; done; after=$(read_info); post_time=$(field "$after" rdb_last_bgsave_time_sec); post_status=$(field "$after" rdb_last_bgsave_status); case "$post_time" in [0-9]*) ;; *) exit 1;; esac; [ "$post_status" = ok ]; [ "$post_time" -gt "$pre_time" ]; unset REDISCLI_AUTH; printf "pre-rdb-last-bgsave-time-sec=%s\npre-rdb-last-bgsave-status=%s\npost-rdb-last-bgsave-time-sec=%s\npost-rdb-last-bgsave-status=%s\n" "$pre_time" "$pre_status" "$post_time" "$post_status"' 2>&1
$bgsaveExit = $LASTEXITCODE
if ($bgsaveExit -ne 0 -or @($bgsaveProof).Count -ne 4 -or $bgsaveProof[-1] -ne 'post-rdb-last-bgsave-status=ok') { throw 'Redis BGSAVE 原生执行、精确响应或新快照证明失败' }
$bgsaveProof | Out-File (Join-Path $BackupSet 'redis-bgsave-proof.txt') -Encoding ascii
& docker cp "${redisId}:/data/dump.rdb" (Join-Path $BackupSet 'redis.rdb')
if ($LASTEXITCODE -ne 0) { throw 'Redis RDB 复制失败' }
[IO.File]::WriteAllText((Join-Path $BackupSet 'redis-disposition.txt'),"snapshot`r`n",(New-Object Text.UTF8Encoding($false)))
```

```bash
set -euo pipefail
redis_id=$("${compose[@]}" ps -q redis)
[ -n "$redis_id" ]
set +e
bgsave_proof=$("${compose[@]}" exec -T redis sh -ec 'set -eu; set +x; export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; read_info() { output=$(redis-cli --no-auth-warning INFO persistence); rc=$?; [ "$rc" -eq 0 ]; printf "%s\n" "$output"; }; field() { printf "%s\n" "$1" | tr -d "\r" | awk -F: -v key="$2" "\$1 == key { print \$2 }"; }; before=$(read_info); pre_time=$(field "$before" rdb_last_bgsave_time_sec); pre_status=$(field "$before" rdb_last_bgsave_status); [ -n "$pre_status" ]; case "$pre_time" in -[0-9]*|[0-9]*) ;; *) exit 1;; esac; response=$(redis-cli --no-auth-warning BGSAVE); response_rc=$?; [ "$response_rc" -eq 0 ]; [ "$response" = "Background saving started" ]; deadline=$(( $(date +%s) + 300 )); while :; do current=$(read_info); progress=$(field "$current" rdb_bgsave_in_progress); case "$progress" in 0) break;; 1) [ "$(date +%s)" -lt "$deadline" ]; sleep 1;; *) exit 1;; esac; done; after=$(read_info); post_time=$(field "$after" rdb_last_bgsave_time_sec); post_status=$(field "$after" rdb_last_bgsave_status); case "$post_time" in [0-9]*) ;; *) exit 1;; esac; [ "$post_status" = ok ]; [ "$post_time" -gt "$pre_time" ]; unset REDISCLI_AUTH; printf "pre-rdb-last-bgsave-time-sec=%s\npre-rdb-last-bgsave-status=%s\npost-rdb-last-bgsave-time-sec=%s\npost-rdb-last-bgsave-status=%s\n" "$pre_time" "$pre_status" "$post_time" "$post_status"' 2>&1); bgsave_exit=$?
set -e
[ "$bgsave_exit" -eq 0 ] || { printf '%s\n' "$bgsave_proof" >&2; exit "$bgsave_exit"; }
[ "$(printf '%s\n' "$bgsave_proof" | wc -l)" -eq 4 ]
[ "$(printf '%s\n' "$bgsave_proof" | tail -n 1)" = post-rdb-last-bgsave-status=ok ]
printf '%s\n' "$bgsave_proof" >"$backup_set/redis-bgsave-proof.txt"
docker cp "$redis_id:/data/dump.rdb" "$backup_set/redis.rdb"
printf 'snapshot\n' >"$backup_set/redis-disposition.txt"
```

若经数据所有者批准不创建 Redis 快照，跳过 BGSAVE/copy，并精确写入 disposition：

```powershell
[IO.File]::WriteAllText((Join-Path $BackupSet 'redis-disposition.txt'),"rebuildable-no-snapshot`r`n",(New-Object Text.UTF8Encoding($false)))
```

```bash
printf 'rebuildable-no-snapshot\n' >"$backup_set/redis-disposition.txt"
```

当前 Redis 启用 AOF，RDB 不是 AOF 的在线等价副本，也不包含与 PostgreSQL 的事务边界。一个集合只能选择一个 disposition；`snapshot` 必须同时有 `redis.rdb` 和 `redis-bgsave-proof.txt`，`rebuildable-no-snapshot` 必须两者都没有。恢复时可以把 RDB 作为空 Redis 的可选种子，但优先根据应用设计重建缓存；若无法证明数据可丢失，停止切换并由组件所有者决定。不能在线复制 AOF 目录并宣称一致。

## Kafka 清单与停机卷归档限制

保存只读元数据用于重建分析：

```powershell
$ErrorActionPreference = 'Stop'
$kafkaTopics = & docker @ComposeArgs exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --describe 2>&1
$kafkaTopicsExit = $LASTEXITCODE
if ($kafkaTopicsExit -ne 0) { throw 'Kafka topic 清单失败' }
$kafkaTopics | Out-File (Join-Path $BackupSet 'kafka-topics.txt') -Encoding utf8
$kafkaGroups = & docker @ComposeArgs exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 --all-groups --describe 2>&1
$kafkaGroupsExit = $LASTEXITCODE
if ($kafkaGroupsExit -ne 0) { throw 'Kafka consumer group 清单失败' }
$kafkaGroups | Out-File (Join-Path $BackupSet 'kafka-consumer-groups.txt') -Encoding utf8
[IO.File]::WriteAllText((Join-Path $BackupSet 'kafka-disposition.txt'),"metadata-only`r`n",(New-Object Text.UTF8Encoding($false)))
```

```bash
set -euo pipefail
"${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --describe >"$backup_set/kafka-topics.txt"
"${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 --all-groups --describe >"$backup_set/kafka-consumer-groups.txt"
printf 'metadata-only\n' >"$backup_set/kafka-disposition.txt"
```

Kafka 没有主备份命令。可选的 `kafka-data` 停机归档仅用于同版本、同单节点拓扑的最后手段：必须停止所有 producer/consumer、Core 和 Kafka，确认 Kafka 容器 `exited` 后，以固定 digest 辅助容器只读打包该卷。它会增加停机时间，不保证未来版本或新 cluster ID 可导入，且不替代 topic 级复制/导出设计。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_KAFKA_COLD_ARCHIVE -ne 'APPROVED_SECONDARY') { throw '未批准 Kafka 次要停机归档' }
$kafkaStopped = $false
try {
  & docker @ComposeArgs stop kafka
  if ($LASTEXITCODE -ne 0) { throw '停止 Kafka 失败' }
  $kafkaStopped = $true
  $kafkaId = & docker @ComposeArgs ps -a -q kafka
  $kafkaState = & docker inspect --format '{{.State.Status}}' $kafkaId
  if ($LASTEXITCODE -ne 0 -or $kafkaState -ne 'exited') { throw 'Kafka 未完全停止' }
  $kafkaVolume = & docker volume ls --quiet --filter 'label=com.docker.compose.project=innorder-occ' --filter 'label=com.docker.compose.volume=kafka-data'
  if ($LASTEXITCODE -ne 0 -or @($kafkaVolume).Count -ne 1) { throw 'Kafka 卷定位失败' }
  & docker run --rm --mount "type=volume,src=$kafkaVolume,dst=/source,readonly" --mount "type=bind,src=$BackupSet,dst=/backup" alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c tar -C /source -czf /backup/kafka-data-cold.tar.gz .
  if ($LASTEXITCODE -ne 0) { throw 'Kafka 停机卷归档失败' }
} finally {
  if ($kafkaStopped) {
    & docker @ComposeArgs start kafka
    if ($LASTEXITCODE -ne 0) { throw 'Kafka 恢复启动失败，立即升级' }
  }
}
[IO.File]::WriteAllText((Join-Path $BackupSet 'kafka-disposition.txt'),"cold-archive`r`n",(New-Object Text.UTF8Encoding($false)))
Remove-Item Env:OCC_CONFIRM_KAFKA_COLD_ARCHIVE
```

```bash
set -euo pipefail
: "${OCC_CONFIRM_KAFKA_COLD_ARCHIVE:?必须设置确认值}"
[ "$OCC_CONFIRM_KAFKA_COLD_ARCHIVE" = APPROVED_SECONDARY ]
restore_kafka_after_archive() { if [ "${kafka_stopped:-0}" -eq 1 ]; then "${compose[@]}" start kafka || printf 'Kafka 自动恢复启动失败，立即升级\n' >&2; fi; }
trap 'restore_kafka_after_archive; backup_cleanup' EXIT
"${compose[@]}" stop kafka
kafka_stopped=1
kafka_id=$("${compose[@]}" ps -a -q kafka)
[ "$(docker inspect --format '{{.State.Status}}' "$kafka_id")" = exited ]
kafka_volume=$(docker volume ls --quiet --filter label=com.docker.compose.project=innorder-occ --filter label=com.docker.compose.volume=kafka-data)
[ -n "$kafka_volume" ] && [ "$(printf '%s\n' "$kafka_volume" | wc -l)" -eq 1 ]
docker run --rm --mount "type=volume,src=$kafka_volume,dst=/source,readonly" --mount "type=bind,src=$backup_set,dst=/backup" alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c tar -C /source -czf /backup/kafka-data-cold.tar.gz .
"${compose[@]}" start kafka
kafka_stopped=0
trap backup_cleanup EXIT
printf 'cold-archive\n' >"$backup_set/kafka-disposition.txt"
unset OCC_CONFIRM_KAFKA_COLD_ARCHIVE
```

Kafka 恢复后必须回到 `running healthy` 并通过 topic-list。失败时不删除卷、不重复归档，保留日志并升级。

## 元数据、checksum 与完成标记

`backup-manifest.sha256` 与 inventory 只能检测传输、介质或操作造成的意外变化；能修改备份目录的人也能重写两者，因此本机可写文本、调用方提供的 digest 或简单字符串相等都不提供恶意篡改抵抗。`internal-only` 集合可以创建 `COMPLETE`，但 `backup-trust-status.txt` 必须写 `local/internal-integrity-only`，且不得称为 host-loss-ready。`external-verified` 集合必须由组织提供的验证适配器向外部 immutable/WORM/object-lock 或 detached-signature 系统核验 record ID/version 和 manifest；只有适配器原生退出零后才能写 `external-trust-evidence.txt` 和 external `COMPLETE`。该 evidence 文件只是审计转录，本身仍可本地修改；每次 off-host 接受、恢复或升级都必须重新调用外部工具，不能信任转录内容。

当前文本 inventory 每行一个相对路径，因此拒绝含 CR、LF 或反斜杠的落地 artifact 路径；若对象键需要这些字符，应使用能够无损编码路径的经评审备份工具，不能静默改名。Windows 先收集元数据、工具和精确镜像身份，再建立 artifact contract：

```powershell
$ErrorActionPreference = 'Stop'
$revision = (& git -c "safe.directory=$RepositoryRoot" rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Git revision 失败' }
if ($revision -ne $env:OCC_DEPLOYED_REVISION.ToLowerInvariant()) { throw '备份 source revision 与声明的 deployed revision 不同' }
$status = & git -c "safe.directory=$RepositoryRoot" status --short
if ($LASTEXITCODE -ne 0) { throw 'Git status 失败' }
$images = & docker @ComposeArgs images
if ($LASTEXITCODE -ne 0) { throw 'Compose images 失败' }
$revision | Out-File (Join-Path $BackupSet 'source-revision.txt') -Encoding ascii
$status | Out-File (Join-Path $BackupSet 'source-status.txt') -Encoding utf8
$images | Out-File (Join-Path $BackupSet 'compose-images.txt') -Encoding utf8
@('compose=infra/compose/compose.yml','env=infra/compose/.env') | Out-File (Join-Path $BackupSet 'configuration-paths-only.txt') -Encoding ascii
$pathOnlyEnv = @(Get-Content -LiteralPath $ComposeEnv | Where-Object { $_ -match '^(POSTGRES_ADMIN_PASSWORD_FILE|POSTGRES_FLYWAY_PASSWORD_FILE|POSTGRES_RUNTIME_PASSWORD_FILE|REDIS_PASSWORD_FILE|MINIO_ROOT_USER_FILE|MINIO_ROOT_PASSWORD_FILE|MINIO_APP_USER_FILE|MINIO_APP_PASSWORD_FILE|OCC_JWT_PRIVATE_KEY_FILE|OCC_JWT_PUBLIC_KEY_FILE)=' })
if ($pathOnlyEnv.Count -ne 10) { throw 'Compose env 必须精确提供十个 secret 路径行' }
[IO.File]::WriteAllLines((Join-Path $BackupSet 'compose-env-paths-only.txt'),$pathOnlyEnv,(New-Object Text.UTF8Encoding($false)))
$nonSecretKeys = @('OCC_JWT_ISSUER','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
$nonSecretEnv = @(Get-Content -LiteralPath $ComposeEnv | Where-Object { ($_ -split '=',2)[0] -in $nonSecretKeys })
if ($nonSecretEnv.Count -ne 13 -or (Compare-Object $nonSecretKeys @($nonSecretEnv | ForEach-Object { ($_ -split '=',2)[0] }))) { throw 'Compose env 必须精确提供十三个非秘密配置行' }
[IO.File]::WriteAllLines((Join-Path $BackupSet 'compose-env-nonsecret.txt'),$nonSecretEnv,(New-Object Text.UTF8Encoding($false)))
$escrowReceipt = (Resolve-Path -LiteralPath $env:OCC_SECRET_ESCROW_RECEIPT).Path
if ((Get-Item -LiteralPath $escrowReceipt).Length -eq 0) { throw 'secret escrow 收据为空' }
Copy-Item -LiteralPath $escrowReceipt -Destination (Join-Path $BackupSet 'secret-escrow-receipt.txt') -ErrorAction Stop
$toolLines = New-Object System.Collections.Generic.List[string]
function Add-ToolVersion([string]$FilePath,[string[]]$ArgumentList) {
  $output = & $FilePath @ArgumentList 2>&1
  $toolExit = $LASTEXITCODE
  if ($toolExit -ne 0) { throw "工具版本收集失败：$FilePath" }
  $toolLines.Add(($output -join ' '))
}
Add-ToolVersion 'docker' @('version','--format','Client={{.Client.Version}} Server={{.Server.Version}}')
Add-ToolVersion 'docker' @('compose','version')
Add-ToolVersion 'git' @('--version')
Add-ToolVersion 'docker' ($ComposeArgs + @('exec','-T','postgres','pg_dump','--version'))
Add-ToolVersion 'docker' ($ComposeArgs + @('run','--rm','--no-deps','--entrypoint','/bin/sh','minio-init','-ec','mc --version'))
Add-ToolVersion 'docker' ($ComposeArgs + @('exec','-T','redis','redis-server','--version'))
Add-ToolVersion 'docker' ($ComposeArgs + @('exec','-T','kafka','/opt/kafka/bin/kafka-topics.sh','--version'))
[IO.File]::WriteAllLines((Join-Path $BackupSet 'tool-versions.txt'),$toolLines,(New-Object Text.UTF8Encoding($false)))
$containerIdOutput = & docker @ComposeArgs ps -a -q
$containerIdExit = $LASTEXITCODE
$containerIds = @($containerIdOutput | Where-Object { $_ })
if ($containerIdExit -ne 0 -or $containerIds.Count -ne 11) { throw '镜像身份收集要求精确十一个 Compose 容器' }
$imageLines = New-Object System.Collections.Generic.List[string]
foreach ($containerId in $containerIds) {
  $containerLine = & docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }} container={{.Id}} image={{.Image}}' $containerId
  if ($LASTEXITCODE -ne 0) { throw "容器镜像身份收集失败：$containerId" }
  $containerImageId = (& docker inspect --format '{{.Image}}' $containerId).Trim()
  if ($LASTEXITCODE -ne 0 -or $containerImageId -notmatch '^sha256:[0-9a-f]{64}$') { throw "容器 image ID 收集失败：$containerId" }
  $imageLine = & docker image inspect --format '{{.Id}} tags={{json .RepoTags}} digests={{json .RepoDigests}}' $containerImageId
  if ($LASTEXITCODE -ne 0) { throw "镜像 digest 收集失败：$containerId" }
  $imageLines.Add("$containerLine $imageLine")
}
[IO.File]::WriteAllLines((Join-Path $BackupSet 'image-identifiers.txt'),$imageLines,(New-Object Text.UTF8Encoding($false)))
$BackupEndUtc = (Get-Date).ToUniversalTime().ToString('o')
$externalRecordId = if ($env:OCC_EXTERNAL_TRUST_MODE -eq 'external-verified') { $env:OCC_EXTERNAL_RECORD_ID } else { 'none' }
$externalRecordVersion = if ($env:OCC_EXTERNAL_TRUST_MODE -eq 'external-verified') { $env:OCC_EXTERNAL_RECORD_VERSION } else { 'none' }
@(
  "policy-id=$($env:OCC_BACKUP_POLICY_ID)",
  "retention-class=$($env:OCC_BACKUP_RETENTION_CLASS)",
  "consistency=$($env:OCC_BACKUP_CONSISTENCY)",
  "backup-source-revision=$revision",
  "backup-deployed-revision=$($env:OCC_DEPLOYED_REVISION.ToLowerInvariant())",
  "backup-change-id=$($env:OCC_BACKUP_CHANGE_ID)",
  "backup-end-utc=$BackupEndUtc",
  "fault-domain-status=$($env:OCC_BACKUP_FAULT_DOMAIN)",
  "trust-mode=$($env:OCC_EXTERNAL_TRUST_MODE)",
  "external-record-id=$externalRecordId",
  "external-record-version=$externalRecordVersion",
  "docker-root-dir-reported=$DockerRootDirReported",
  'rpo-rto=not-asserted-use-approved-worksheet'
) | Out-File (Join-Path $BackupSet 'backup-policy-metadata.txt') -Encoding utf8
$trustStatus = if ($env:OCC_EXTERNAL_TRUST_MODE -eq 'external-verified') { 'external-verification-required' } else { 'local/internal-integrity-only' }
[IO.File]::WriteAllText((Join-Path $BackupSet 'backup-trust-status.txt'),("$trustStatus`r`n"),(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $BackupSet 'backup-end-utc.txt'),("$BackupEndUtc`r`n"),(New-Object Text.UTF8Encoding($false)))

$dumpFiles = @(Get-ChildItem -LiteralPath $BackupSet -Filter 'occ-*.dump' -File)
if ($dumpFiles.Count -ne 1 -or $dumpFiles[0].Length -eq 0) { throw '必须精确包含一个非空 PostgreSQL custom dump' }
if ((Get-Item -LiteralPath (Join-Path $BackupSet 'postgresql-restore-list.txt')).Length -eq 0) { throw 'PostgreSQL restore list 缺失或为空' }
$minioCountText = [IO.File]::ReadAllText((Join-Path $BackupSet 'minio\source-object-count.txt')).Trim()
$minioCount = 0
if (-not [int]::TryParse($minioCountText,[ref]$minioCount) -or $minioCount -lt 0) { throw 'MinIO 源对象计数无效' }
$sourceObjectLines = @(Get-Content -LiteralPath (Join-Path $BackupSet 'minio\source-objects.json'))
if ($sourceObjectLines.Count -ne $minioCount) { throw 'MinIO 源对象清单行数与记录计数不同' }
$minioObjectFiles = @(Get-ChildItem -LiteralPath (Join-Path $BackupSet 'minio\objects') -File -Recurse | Sort-Object FullName)
$minioHashLines = @(Get-Content -LiteralPath (Join-Path $BackupSet 'minio\minio-files.sha256'))
if ($minioHashLines.Count -ne $minioObjectFiles.Count) { throw 'MinIO 落地文件 inventory 数量不匹配' }
$minioHashedPaths = New-Object System.Collections.Generic.List[string]
foreach ($line in $minioHashLines) {
  if ($line -notmatch '^([0-9a-f]{64})  (objects/.+)$') { throw 'MinIO 文件 checksum 行无效' }
  $minioHashedPaths.Add($Matches[2])
  $path = Join-Path (Join-Path $BackupSet 'minio') ($Matches[2].Replace('/','\'))
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $Matches[1]) { throw "MinIO 文件 checksum 失败：$($Matches[2])" }
}
$minioActualPaths = @($minioObjectFiles | ForEach-Object { $_.FullName.Substring($minioBackup.Length + 1).Replace('\','/') } | Sort-Object -Unique)
if (Compare-Object $minioActualPaths @($minioHashedPaths | Sort-Object -Unique)) { throw 'MinIO 文件 checksum 路径集合与落地对象不同' }
$redisDisposition = [IO.File]::ReadAllText((Join-Path $BackupSet 'redis-disposition.txt')).Trim()
switch ($redisDisposition) {
  'snapshot' { foreach ($name in 'redis.rdb','redis-bgsave-proof.txt') { if (-not (Test-Path -LiteralPath (Join-Path $BackupSet $name) -PathType Leaf)) { throw "Redis snapshot disposition 缺少 $name" } } }
  'rebuildable-no-snapshot' { foreach ($name in 'redis.rdb','redis-bgsave-proof.txt') { if (Test-Path -LiteralPath (Join-Path $BackupSet $name)) { throw "Redis no-snapshot disposition 不得包含 $name" } } }
  default { throw 'Redis disposition 无效' }
}
$kafkaDisposition = [IO.File]::ReadAllText((Join-Path $BackupSet 'kafka-disposition.txt')).Trim()
switch ($kafkaDisposition) {
  'metadata-only' { if (Test-Path -LiteralPath (Join-Path $BackupSet 'kafka-data-cold.tar.gz')) { throw 'Kafka metadata-only disposition 不得包含冷归档' } }
  'cold-archive' { if (-not (Test-Path -LiteralPath (Join-Path $BackupSet 'kafka-data-cold.tar.gz') -PathType Leaf)) { throw 'Kafka cold-archive disposition 缺少归档' } }
  default { throw 'Kafka disposition 无效' }
}
$required = @(
  'backup-start-utc.txt','backup-end-utc.txt','source-revision.txt','source-status.txt',
  'configuration-paths-only.txt','compose-env-paths-only.txt','compose-env-nonsecret.txt','secret-escrow-receipt.txt','backup-consistency-evidence.txt',
  'compose-images.txt','image-identifiers.txt','tool-versions.txt','backup-policy-metadata.txt','backup-trust-status.txt',
  $dumpFiles[0].Name,'postgresql-restore-list.txt','minio/source-objects.json',
  'minio/source-object-count.txt','minio/source-object-manifest.jsonl','minio/minio-files.sha256','redis-disposition.txt',
  'kafka-topics.txt','kafka-consumer-groups.txt','kafka-disposition.txt'
)
$required += @($minioObjectFiles | ForEach-Object { $_.FullName.Substring($BackupSet.Length + 1).Replace('\','/') })
if ($redisDisposition -eq 'snapshot') { $required += @('redis.rdb','redis-bgsave-proof.txt') }
if ($kafkaDisposition -eq 'cold-archive') { $required += 'kafka-data-cold.tar.gz' }
$required = @($required | Sort-Object -Unique)
if ($required | Where-Object { $_ -match '[\r\n\\]' -or $_ -match '^(?:/|\.\.?/)' }) { throw 'artifact 路径不能安全写入文本 inventory' }
$actual = @(Get-ChildItem -LiteralPath $BackupSet -File -Recurse | ForEach-Object { $_.FullName.Substring($BackupSet.Length + 1).Replace('\','/') } | Where-Object { $_ -notin @('backup-manifest.sha256','external-trust-evidence.txt','COMPLETE') } | Sort-Object -Unique)
if (Compare-Object $required $actual) { Compare-Object $required $actual | Format-Table | Out-String | Write-Error; throw '备份 artifact 缺失或存在未声明文件' }
$inventory = @($required + 'backup-artifacts.inventory' | Sort-Object -Unique)
[IO.File]::WriteAllLines((Join-Path $BackupSet 'backup-artifacts.inventory'),$inventory,(New-Object Text.UTF8Encoding($false)))
$actualWithInventory = @(Get-ChildItem -LiteralPath $BackupSet -File -Recurse | ForEach-Object { $_.FullName.Substring($BackupSet.Length + 1).Replace('\','/') } | Where-Object { $_ -notin @('backup-manifest.sha256','external-trust-evidence.txt','COMPLETE') } | Sort-Object -Unique)
if (Compare-Object $inventory $actualWithInventory) { throw '写入 inventory 后 artifact 集合发生漂移' }
$manifestLines = foreach ($relative in $inventory) {
  $path = Join-Path $BackupSet ($relative.Replace('/','\'))
  '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant(),$relative
}
[IO.File]::WriteAllLines((Join-Path $BackupSet 'backup-manifest.sha256'),$manifestLines,(New-Object Text.UTF8Encoding($false)))
$manifestDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $BackupSet 'backup-manifest.sha256')).Hash.ToLowerInvariant()
Write-Output "manifest-sha256=$manifestDigest"
```

`internal-only` 直接记录本地完整性结论；不得把这一分支用于 host-loss-ready：

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_EXTERNAL_TRUST_MODE -ne 'internal-only') { throw '此分支只允许 internal-only' }
[IO.File]::WriteAllText((Join-Path $BackupSet 'COMPLETE'),"local/internal-integrity-only;not-host-loss-ready`r`n",(New-Object Text.UTF8Encoding($false)))
```

`external-verified` 模式先由外部系统完成 off-host immutable/object-lock 写入或 detached signature 登记，再调用组织适配器。适配器接口固定为 `verify-manifest` 加 manifest、record ID/version 和 `--require-off-host-immutable`；适配器必须自行访问外部系统并验证签名/不可变保留状态，不能只读取备份目录中的文本：

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_EXTERNAL_TRUST_MODE -ne 'external-verified' -or $env:OCC_BACKUP_FAULT_DOMAIN -ne 'off-host-immutable-copy') { throw '外部验证要求 off-host immutable fault domain' }
$verifyTool = (Resolve-Path -LiteralPath $env:OCC_EXTERNAL_VERIFY_TOOL).Path
$externalEvidence = & $verifyTool verify-manifest --manifest (Join-Path $BackupSet 'backup-manifest.sha256') --record-id $env:OCC_EXTERNAL_RECORD_ID --record-version $env:OCC_EXTERNAL_RECORD_VERSION --require-off-host-immutable 2>&1
$externalVerifyExit = $LASTEXITCODE
if ($externalVerifyExit -ne 0 -or @($externalEvidence).Count -eq 0) { throw '外部系统未验证 manifest、record/version 或 immutable 状态' }
$externalEvidence | Out-File (Join-Path $BackupSet 'external-trust-evidence.txt') -Encoding utf8
[IO.File]::WriteAllText((Join-Path $BackupSet 'COMPLETE'),"external-verified-off-host-immutable`r`n",(New-Object Text.UTF8Encoding($false)))
```

Linux：

```bash
set -euo pipefail
git rev-parse HEAD >"$backup_set/source-revision.txt"
git status --short >"$backup_set/source-status.txt"
revision=$(tr -d '\r\n' <"$backup_set/source-revision.txt")
[ "$revision" = "${OCC_DEPLOYED_REVISION,,}" ]
"${compose[@]}" images >"$backup_set/compose-images.txt"
printf '%s\n' 'compose=infra/compose/compose.yml' 'env=infra/compose/.env' >"$backup_set/configuration-paths-only.txt"
awk -F= '/^(POSTGRES_ADMIN_PASSWORD_FILE|POSTGRES_FLYWAY_PASSWORD_FILE|POSTGRES_RUNTIME_PASSWORD_FILE|REDIS_PASSWORD_FILE|MINIO_ROOT_USER_FILE|MINIO_ROOT_PASSWORD_FILE|MINIO_APP_USER_FILE|MINIO_APP_PASSWORD_FILE|OCC_JWT_PRIVATE_KEY_FILE|OCC_JWT_PUBLIC_KEY_FILE)=/ { print }' infra/compose/.env >"$backup_set/compose-env-paths-only.txt"
[ "$(wc -l <"$backup_set/compose-env-paths-only.txt")" -eq 10 ]
awk -F= '/^(OCC_JWT_ISSUER|POSTGRES_DB|POSTGRES_PORT|KAFKA_PORT|REDIS_PORT|MINIO_API_PORT|MINIO_CONSOLE_PORT|OPA_PORT|AI_PORT|CORE_PORT|AI_LOG_LEVEL|APP_VERSION|OBJECT_STORAGE_BUCKET)=/ { print }' infra/compose/.env >"$backup_set/compose-env-nonsecret.txt"
[ "$(wc -l <"$backup_set/compose-env-nonsecret.txt")" -eq 13 ]
expected_nonsecret_keys=$'AI_LOG_LEVEL\nAI_PORT\nAPP_VERSION\nCORE_PORT\nKAFKA_PORT\nMINIO_API_PORT\nMINIO_CONSOLE_PORT\nOBJECT_STORAGE_BUCKET\nOCC_JWT_ISSUER\nOPA_PORT\nPOSTGRES_DB\nPOSTGRES_PORT\nREDIS_PORT'
[ "$(cut -d= -f1 "$backup_set/compose-env-nonsecret.txt" | sort)" = "$expected_nonsecret_keys" ]
escrow_receipt=$(realpath "$OCC_SECRET_ESCROW_RECEIPT")
test -s "$escrow_receipt"
cp -- "$escrow_receipt" "$backup_set/secret-escrow-receipt.txt"
{
  docker version --format 'Client={{.Client.Version}} Server={{.Server.Version}}'
  docker compose version
  git --version
  "${compose[@]}" exec -T postgres pg_dump --version
  "${compose[@]}" run --rm --no-deps --entrypoint /bin/sh minio-init -ec 'mc --version'
  "${compose[@]}" exec -T redis redis-server --version
  "${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --version
} >"$backup_set/tool-versions.txt"
mapfile -t container_ids < <("${compose[@]}" ps -a -q)
[ "${#container_ids[@]}" -eq 11 ]
: >"$backup_set/image-identifiers.txt"
for container_id in "${container_ids[@]}"; do
  container_line=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }} container={{.Id}} image={{.Image}}' "$container_id")
  image_id=$(docker inspect --format '{{.Image}}' "$container_id")
  image_line=$(docker image inspect --format '{{.Id}} tags={{json .RepoTags}} digests={{json .RepoDigests}}' "$image_id")
  printf '%s %s\n' "$container_line" "$image_line" >>"$backup_set/image-identifiers.txt"
done
backup_end_utc=$(date -u --iso-8601=seconds)
if [ "$OCC_EXTERNAL_TRUST_MODE" = external-verified ]; then external_record_id=$OCC_EXTERNAL_RECORD_ID; external_record_version=$OCC_EXTERNAL_RECORD_VERSION; trust_status=external-verification-required; else external_record_id=none; external_record_version=none; trust_status=local/internal-integrity-only; fi
printf 'policy-id=%s\nretention-class=%s\nconsistency=%s\nbackup-source-revision=%s\nbackup-deployed-revision=%s\nbackup-change-id=%s\nbackup-end-utc=%s\nfault-domain-status=%s\ntrust-mode=%s\nexternal-record-id=%s\nexternal-record-version=%s\ndocker-root-dir-reported=%s\nrpo-rto=not-asserted-use-approved-worksheet\n' "$OCC_BACKUP_POLICY_ID" "$OCC_BACKUP_RETENTION_CLASS" "$OCC_BACKUP_CONSISTENCY" "$revision" "${OCC_DEPLOYED_REVISION,,}" "$OCC_BACKUP_CHANGE_ID" "$backup_end_utc" "$OCC_BACKUP_FAULT_DOMAIN" "$OCC_EXTERNAL_TRUST_MODE" "$external_record_id" "$external_record_version" "$docker_root_output" >"$backup_set/backup-policy-metadata.txt"
printf '%s\n' "$trust_status" >"$backup_set/backup-trust-status.txt"
printf '%s\n' "$backup_end_utc" >"$backup_set/backup-end-utc.txt"
mapfile -t dumps < <(find "$backup_set" -maxdepth 1 -type f -name 'occ-*.dump')
[ "${#dumps[@]}" -eq 1 ] && test -s "${dumps[0]}" && test -s "$backup_set/postgresql-restore-list.txt"
minio_count=$(tr -d '\r\n' <"$backup_set/minio/source-object-count.txt")
[[ $minio_count =~ ^[0-9]+$ ]]
[ "$(wc -l <"$backup_set/minio/source-objects.json")" -eq "$minio_count" ]
mapfile -d '' -t minio_object_files < <(find "$backup_set/minio/objects" -type f -print0 | sort -z)
mapfile -t minio_hash_lines <"$backup_set/minio/minio-files.sha256"
[ "${#minio_hash_lines[@]}" -eq "${#minio_object_files[@]}" ]
mapfile -t minio_hashed_paths < <(sed -n 's/^[0-9a-f]\{64\}  //p' "$backup_set/minio/minio-files.sha256" | sort -u)
mapfile -t minio_actual_paths < <(find "$backup_set/minio/objects" -type f -printf '%P\n' | sed 's#^#objects/#' | sort -u)
diff -u <(printf '%s\n' "${minio_actual_paths[@]}") <(printf '%s\n' "${minio_hashed_paths[@]}")
if [ "${#minio_object_files[@]}" -gt 0 ]; then (cd -- "$backup_set/minio" && sha256sum --check minio-files.sha256); fi
redis_disposition=$(tr -d '\r\n' <"$backup_set/redis-disposition.txt")
case "$redis_disposition" in snapshot) test -f "$backup_set/redis.rdb" && test -s "$backup_set/redis-bgsave-proof.txt";; rebuildable-no-snapshot) test ! -e "$backup_set/redis.rdb" && test ! -e "$backup_set/redis-bgsave-proof.txt";; *) exit 1;; esac
kafka_disposition=$(tr -d '\r\n' <"$backup_set/kafka-disposition.txt")
case "$kafka_disposition" in metadata-only) test ! -e "$backup_set/kafka-data-cold.tar.gz";; cold-archive) test -f "$backup_set/kafka-data-cold.tar.gz";; *) exit 1;; esac
required=(
  backup-start-utc.txt backup-end-utc.txt source-revision.txt source-status.txt
  configuration-paths-only.txt compose-env-paths-only.txt compose-env-nonsecret.txt
  secret-escrow-receipt.txt backup-consistency-evidence.txt
  compose-images.txt image-identifiers.txt tool-versions.txt backup-policy-metadata.txt backup-trust-status.txt
  "$(basename "${dumps[0]}")" postgresql-restore-list.txt minio/source-objects.json
  minio/source-object-count.txt minio/source-object-manifest.jsonl minio/minio-files.sha256 redis-disposition.txt
  kafka-topics.txt kafka-consumer-groups.txt kafka-disposition.txt
)
for path in "${minio_object_files[@]}"; do required+=("${path#"$backup_set/"}"); done
[ "$redis_disposition" = snapshot ] && required+=(redis.rdb redis-bgsave-proof.txt)
[ "$kafka_disposition" = cold-archive ] && required+=(kafka-data-cold.tar.gz)
for path in "${required[@]}"; do case "$path" in *$'\n'*|*$'\r'*|*\\*|/*|../*|./*) printf 'artifact 路径不能写入文本 inventory：%s\n' "$path" >&2; exit 1;; esac; done
mapfile -t required_sorted < <(printf '%s\n' "${required[@]}" | sort -u)
mapfile -t actual_sorted < <(find "$backup_set" -type f ! -name backup-manifest.sha256 ! -name external-trust-evidence.txt ! -name COMPLETE -printf '%P\n' | sort -u)
diff -u <(printf '%s\n' "${required_sorted[@]}") <(printf '%s\n' "${actual_sorted[@]}")
printf '%s\n' "${required_sorted[@]}" backup-artifacts.inventory | sort -u >"$backup_set/backup-artifacts.inventory"
mapfile -t inventory <"$backup_set/backup-artifacts.inventory"
mapfile -t actual_with_inventory < <(find "$backup_set" -type f ! -name backup-manifest.sha256 ! -name external-trust-evidence.txt ! -name COMPLETE -printf '%P\n' | sort -u)
diff -u <(printf '%s\n' "${inventory[@]}") <(printf '%s\n' "${actual_with_inventory[@]}")
: >"$backup_set/backup-manifest.sha256"
for relative in "${inventory[@]}"; do (cd -- "$backup_set" && sha256sum -- "$relative") >>"$backup_set/backup-manifest.sha256"; done
(cd -- "$backup_set" && sha256sum --check backup-manifest.sha256)
manifest_digest=$(sha256sum "$backup_set/backup-manifest.sha256" | awk '{print $1}')
printf 'manifest-sha256=%s\n' "$manifest_digest"
```

`internal-only` 分支：

```bash
set -euo pipefail
[ "$OCC_EXTERNAL_TRUST_MODE" = internal-only ]
printf 'local/internal-integrity-only;not-host-loss-ready\n' >"$backup_set/COMPLETE"
```

`external-verified` 分支必须让组织适配器实时访问外部系统：

```bash
set -euo pipefail
[ "$OCC_EXTERNAL_TRUST_MODE" = external-verified ]
[ "$OCC_BACKUP_FAULT_DOMAIN" = off-host-immutable-copy ]
verify_tool=$(realpath "$OCC_EXTERNAL_VERIFY_TOOL")
set +e
external_evidence=$("$verify_tool" verify-manifest --manifest "$backup_set/backup-manifest.sha256" --record-id "$OCC_EXTERNAL_RECORD_ID" --record-version "$OCC_EXTERNAL_RECORD_VERSION" --require-off-host-immutable 2>&1); external_verify_exit=$?
set -e
[ "$external_verify_exit" -eq 0 ] || { printf '%s\n' "$external_evidence" >&2; exit "$external_verify_exit"; }
[ -n "$external_evidence" ]
printf '%s\n' "$external_evidence" >"$backup_set/external-trust-evidence.txt"
printf 'external-verified-off-host-immutable\n' >"$backup_set/COMPLETE"
```

完成或中止后都必须显式恢复 Core。只有 `COMPLETE` 存在才允许把集合称为成功；否则先写 `INCOMPLETE`。Core 恢复失败优先于备份任务状态，立即升级可用性事件。

```powershell
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $BackupSet 'COMPLETE') -PathType Leaf)) {
  [IO.File]::WriteAllText((Join-Path $BackupSet 'INCOMPLETE'),"backup did not complete`r`n",(New-Object Text.UTF8Encoding($false)))
}
Restore-CoreAfterBackup
$deadline = (Get-Date).AddMinutes(10)
do {
  $coreId = & docker @ComposeArgs ps -q core
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($coreId)) { throw 'Core 状态查询失败' }
  $coreHealth = & docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' $coreId
  if ($LASTEXITCODE -ne 0) { throw 'Core health 查询失败' }
  if ($coreHealth -eq 'running healthy') { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $deadline)
if ($coreHealth -ne 'running healthy') { throw "Core 未恢复：$coreHealth" }
Remove-Item Env:OCC_CONFIRM_BACKUP_QUIESCE -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath (Join-Path $BackupSet 'COMPLETE') -PathType Leaf)) { throw 'Core 已恢复，但备份集合不完整，禁止保留轮换' }
if ($LifecycleLock) { $LifecycleLock.Dispose(); Remove-Variable LifecycleLock }
```

```bash
set -euo pipefail
if [ ! -f "$backup_set/COMPLETE" ]; then printf 'backup did not complete\n' >"$backup_set/INCOMPLETE"; fi
backup_cleanup
trap - EXIT
deadline=$((SECONDS + 600))
while :; do
  core_id=$("${compose[@]}" ps -q core)
  [ -n "$core_id" ]
  core_health=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$core_id")
  [ "$core_health" = 'running healthy' ] && break
  [ "$SECONDS" -lt "$deadline" ] || { printf 'Core 未恢复：%s\n' "$core_health" >&2; exit 1; }
  sleep 5
done
unset OCC_CONFIRM_BACKUP_QUIESCE
test -f "$backup_set/COMPLETE"
```

随后执行[日常运维检查](06-daily-operations-and-monitoring.md)中的八服务/三 one-shot、HTTP、TCP 和协议验收。`INCOMPLETE` 集合保留供故障分析但不得进入正常保留轮换或作为恢复点。

## 保留、加密、异地与访问

- 业务/法规所有者填写每日、每周、每月保留数量；未批准前不自动删除。删除到期备份是破坏性操作，必须先验证至少一个更新集合已异地复制并完成隔离恢复。
- 备份在源主机静态加密、传输加密和异地静态加密由组织平台提供；本仓库不提供密钥管理。加密密钥与备份分离托管，并定期验证灾难时可取回。
- 至少一份位于主机和站点共同故障域之外；同步盘或同一 Docker 磁盘不是异地备份。复制完成后在目标端重算 checksum。
- 备份读、写、删除、恢复权限分离；恢复需要双人批准。记录访问、导出、失败和销毁审计。
- PostgreSQL dump、MinIO 对象、Redis/Kafka 材料和 checksum 都按客户数据保护；支持工单只引用受控位置，不附文件。

## RPO/RTO 工作表

每个部署在上线和季度演练后填写实测值，不填写虚假保证：

| 字段 | 需记录内容 |
|---|---|
| 业务允许数据丢失 | 数据所有者批准的最大时间/事件范围 |
| 备份计划与最后成功 | 计划频率、最后完成 UTC、checksum、异地完成 UTC |
| 实际恢复点 | 被选集合开始/结束 UTC；PG 快照与 MinIO 镜像时间窗口 |
| 实测恢复用时 | 宣告、取回密钥/备份、建环境、PG、MinIO、辅助存储、验收、切换分别耗时 |
| 依赖与瓶颈 | 下载带宽、对象数、dump 大小、CPU、审批和人员到场 |
| 目标差距 | 实测与批准目标差异、风险接受、责任人、期限 |

没有代表性数据量、异地取回和完整验收的演练不能形成 RPO/RTO 保证。RPO 是备份时点与故障时点的差，不等于任务频率；RTO 从事件宣告到受支持服务恢复并通过验收，不等于 `docker compose up` 用时。

## 隔离恢复准备

恢复必须先到独立主机或同主机独立 Compose project、独立端口、独立四卷和独立密钥副本。不要让旧/新环境共享命名卷或写同一 MinIO bucket。由批准会话设置 `OCC_RESTORE_ROOT`、`OCC_RESTORE_SECRET_ROOT`、`OCC_RESTORE_ENV_FILE`、`OCC_RESTORE_BACKUP_SET` 和唯一 `OCC_RESTORE_PROJECT`；restore env 只含指向独立 secret escrow 副本的十个路径、JWT issuer 和不会冲突的端口，按[密钥与配置](03-secrets-and-configuration.md)完整验证。

Windows 初始化后先验证所选 `$RestoreSet`，再验证 secret、project 和端口隔离。以下块不启动容器：

```powershell
$ErrorActionPreference = 'Stop'
foreach ($name in 'OCC_REPOSITORY_ROOT','OCC_RESTORE_ROOT','OCC_RESTORE_SECRET_ROOT','OCC_RESTORE_ENV_FILE','OCC_RESTORE_BACKUP_SET','OCC_RESTORE_PROJECT','OCC_EVIDENCE_ROOT') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "缺少 $name" }
}
if ($env:OCC_RESTORE_PROJECT -eq 'innorder-occ' -or $env:OCC_RESTORE_PROJECT -notmatch '^innorder-occ-restore-[a-z0-9-]+$') { throw '恢复 project 必须是批准的隔离名称' }
$RestoreRoot = (Resolve-Path -LiteralPath $env:OCC_RESTORE_ROOT).Path
$RestoreSecretRoot = (Resolve-Path -LiteralPath $env:OCC_RESTORE_SECRET_ROOT).Path
$RestoreEnv = (Resolve-Path -LiteralPath $env:OCC_RESTORE_ENV_FILE).Path
$RestoreSet = (Resolve-Path -LiteralPath $env:OCC_RESTORE_BACKUP_SET).Path
function Assert-RestorePathNoReparse([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  $current=[IO.Path]::GetPathRoot($full)
  foreach ($segment in $full.Substring($current.Length).Split(@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar),[StringSplitOptions]::RemoveEmptyEntries)) {
    $current=Join-Path $current $segment
    $item=Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "恢复批准路径的祖先或叶节点含 reparse point：$current" }
  }
}
foreach ($path in $RestoreRoot,$RestoreSecretRoot,$RestoreEnv,$RestoreSet) { Assert-RestorePathNoReparse $path }
$restoreRootPrefix = $RestoreRoot.TrimEnd('\') + '\'
if ($RestoreSet.StartsWith($restoreRootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw '备份集合不能位于将被重建的恢复根目录' }
$RepositoryRoot = (Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT).Path
$EvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT).Path
try { $RestoreLifecycleLock = [IO.File]::Open((Join-Path $EvidenceRoot 'innorder-occ-lifecycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch [IO.IOException] { throw '另一个受管 OCC 操作持有项目全局锁' }
Set-Location -LiteralPath $RepositoryRoot
$ComposeFile = Join-Path $RepositoryRoot 'infra\compose\compose.yml'
$ProductionEnv = Join-Path $RepositoryRoot 'infra\compose\.env'
$ProductionArgs = @('compose','--env-file',$ProductionEnv,'-f',$ComposeFile)
$RestoreArgs = @('compose','-p',$env:OCC_RESTORE_PROJECT,'--env-file',$RestoreEnv,'-f',$ComposeFile)

$storedTrustStatus = [IO.File]::ReadAllText((Join-Path $RestoreSet 'backup-trust-status.txt')).Trim()
$controlFiles = @('backup-manifest.sha256','COMPLETE')
if ($storedTrustStatus -eq 'external-verification-required') { $controlFiles += 'external-trust-evidence.txt' }
foreach ($name in $controlFiles + @('backup-artifacts.inventory')) {
  if (-not (Test-Path -LiteralPath (Join-Path $RestoreSet $name) -PathType Leaf)) { throw "恢复集合缺少 $name" }
}
$inventory = @(Get-Content -LiteralPath (Join-Path $RestoreSet 'backup-artifacts.inventory'))
$sortedInventory = @($inventory | Sort-Object -Unique)
if ($inventory.Count -eq 0 -or (Compare-Object $inventory $sortedInventory) -or $inventory -notcontains 'backup-artifacts.inventory') { throw 'artifact inventory 必须非空、排序、唯一并包含自身' }
if ($inventory | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -match '[\r\n\\]' -or $_ -match '^(?:/|\.\.?/)' }) { throw 'artifact inventory 含不安全相对路径' }
$restoreSetItem = Get-Item -LiteralPath $RestoreSet -Force
if (-not $restoreSetItem.PSIsContainer -or ($restoreSetItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '恢复集合根必须是普通非重解析目录' }
$pendingDirectories = New-Object 'System.Collections.Generic.Stack[string]'
$pendingDirectories.Push($RestoreSet)
$safeRestoreFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
while ($pendingDirectories.Count -gt 0) {
  $directory = $pendingDirectories.Pop()
  foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "恢复集合包含 reparse point：$($item.FullName)" }
    if ($item.PSIsContainer) { $pendingDirectories.Push($item.FullName) } else { $safeRestoreFiles.Add($item) }
  }
}
$actual = @($safeRestoreFiles | ForEach-Object { $_.FullName.Substring($RestoreSet.Length + 1).Replace('\','/') } | Sort-Object -Unique)
$allowedActual = @($inventory + $controlFiles | Sort-Object -Unique)
if (Compare-Object $allowedActual $actual) { Compare-Object $allowedActual $actual | Format-Table | Out-String | Write-Error; throw '恢复集合有缺失或未声明 artifact' }
$manifest = @{}
Get-Content -LiteralPath (Join-Path $RestoreSet 'backup-manifest.sha256') | ForEach-Object {
  if ($_ -notmatch '^([0-9a-f]{64})  (.+)$' -or $manifest.ContainsKey($Matches[2])) { throw 'manifest 行无效或路径重复' }
  $manifest[$Matches[2]] = $Matches[1]
}
if (Compare-Object $inventory @($manifest.Keys | Sort-Object)) { throw 'manifest 路径集合与 artifact inventory 不同' }
foreach ($relative in $inventory) {
  $path = Join-Path $RestoreSet ($relative.Replace('/','\'))
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "manifest artifact 缺失：$relative" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $manifest[$relative]) { throw "manifest checksum 不匹配：$relative" }
}
$requiredArtifacts = @('backup-start-utc.txt','backup-end-utc.txt','source-revision.txt','source-status.txt','configuration-paths-only.txt','compose-env-paths-only.txt','compose-env-nonsecret.txt','secret-escrow-receipt.txt','backup-consistency-evidence.txt','compose-images.txt','image-identifiers.txt','tool-versions.txt','backup-policy-metadata.txt','backup-trust-status.txt','postgresql-restore-list.txt','minio/source-objects.json','minio/source-object-count.txt','minio/source-object-manifest.jsonl','minio/minio-files.sha256','redis-disposition.txt','kafka-topics.txt','kafka-consumer-groups.txt','kafka-disposition.txt','backup-artifacts.inventory')
foreach ($relative in $requiredArtifacts) { if ($inventory -notcontains $relative) { throw "artifact inventory 缺少必需项：$relative" } }
$policyMetadata = @{}
Get-Content -LiteralPath (Join-Path $RestoreSet 'backup-policy-metadata.txt') | ForEach-Object { $parts=$_ -split '=',2; if ($parts.Count -ne 2 -or $policyMetadata.ContainsKey($parts[0])) { throw '备份政策元数据格式无效' }; $policyMetadata[$parts[0]]=$parts[1] }
if ($storedTrustStatus -eq 'local/internal-integrity-only') {
  if ($policyMetadata['trust-mode'] -ne 'internal-only' -or [IO.File]::ReadAllText((Join-Path $RestoreSet 'COMPLETE')).Trim() -notmatch '^local/internal-integrity-only') { throw '本地完整性分类不一致' }
  Write-Warning '该集合只验证本地 checksum，不抵抗恶意篡改，也未证明主机损失后可用。'
} elseif ($storedTrustStatus -eq 'external-verification-required') {
  foreach ($name in 'OCC_EXTERNAL_VERIFY_TOOL','OCC_EXTERNAL_RECORD_ID','OCC_EXTERNAL_RECORD_VERSION') { if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "外部信任重验缺少 $name" } }
  if ($policyMetadata['trust-mode'] -ne 'external-verified' -or $policyMetadata['fault-domain-status'] -ne 'off-host-immutable-copy' -or $policyMetadata['external-record-id'] -ne $env:OCC_EXTERNAL_RECORD_ID -or $policyMetadata['external-record-version'] -ne $env:OCC_EXTERNAL_RECORD_VERSION) { throw '外部 record/version 或 fault-domain 元数据不匹配' }
  $verifyTool = (Resolve-Path -LiteralPath $env:OCC_EXTERNAL_VERIFY_TOOL).Path
  $externalCheck = & $verifyTool verify-manifest --manifest (Join-Path $RestoreSet 'backup-manifest.sha256') --record-id $env:OCC_EXTERNAL_RECORD_ID --record-version $env:OCC_EXTERNAL_RECORD_VERSION --require-off-host-immutable 2>&1
  $externalCheckExit = $LASTEXITCODE
  if ($externalCheckExit -ne 0 -or @($externalCheck).Count -eq 0) { throw '外部系统未重新验证 immutable record 或 detached signature' }
  if ([IO.File]::ReadAllText((Join-Path $RestoreSet 'COMPLETE')).Trim() -ne 'external-verified-off-host-immutable') { throw '外部信任 COMPLETE 分类不一致' }
} else { throw '未知 backup trust status' }
$restoreDumps = @($inventory | Where-Object { $_ -match '^occ-[^/]+\.dump$' })
if ($restoreDumps.Count -ne 1 -or (Get-Item -LiteralPath (Join-Path $RestoreSet $restoreDumps[0])).Length -eq 0 -or (Get-Item -LiteralPath (Join-Path $RestoreSet 'postgresql-restore-list.txt')).Length -eq 0) { throw 'PostgreSQL 恢复 artifact 不完整' }
$minioCount = 0
if (-not [int]::TryParse([IO.File]::ReadAllText((Join-Path $RestoreSet 'minio\source-object-count.txt')).Trim(),[ref]$minioCount) -or $minioCount -lt 0) { throw 'MinIO 对象计数无效' }
if (@(Get-Content -LiteralPath (Join-Path $RestoreSet 'minio\source-objects.json')).Count -ne $minioCount) { throw 'MinIO 源对象清单与计数不同' }
$minioObjectArtifacts = @($inventory | Where-Object { $_ -like 'minio/objects/*' } | Sort-Object)
$minioFileManifest = @(Get-Content -LiteralPath (Join-Path $RestoreSet 'minio\minio-files.sha256'))
if ($minioFileManifest.Count -ne $minioObjectArtifacts.Count) { throw 'MinIO 文件 manifest 与对象 artifact 数量不同' }
$minioManifestArtifacts = New-Object System.Collections.Generic.List[string]
foreach ($line in $minioFileManifest) {
  if ($line -notmatch '^([0-9a-f]{64})  (objects/.+)$' -or $inventory -notcontains "minio/$($Matches[2])") { throw 'MinIO 文件 manifest 路径无效' }
  $minioManifestArtifacts.Add("minio/$($Matches[2])")
}
if (Compare-Object $minioObjectArtifacts @($minioManifestArtifacts | Sort-Object -Unique)) { throw 'MinIO 文件 manifest 路径集合与 artifact inventory 不同' }
if ((Get-Item -LiteralPath (Join-Path $RestoreSet 'secret-escrow-receipt.txt')).Length -eq 0) { throw 'secret escrow 收据为空' }
$redisDisposition = [IO.File]::ReadAllText((Join-Path $RestoreSet 'redis-disposition.txt')).Trim()
if ($redisDisposition -eq 'snapshot') { foreach ($name in 'redis.rdb','redis-bgsave-proof.txt') { if ($inventory -notcontains $name) { throw "Redis snapshot disposition 缺少 $name" } } } elseif ($redisDisposition -eq 'rebuildable-no-snapshot') { foreach ($name in 'redis.rdb','redis-bgsave-proof.txt') { if ($inventory -contains $name) { throw "Redis no-snapshot disposition 含 $name" } } } else { throw 'Redis disposition 无效' }
$kafkaDisposition = [IO.File]::ReadAllText((Join-Path $RestoreSet 'kafka-disposition.txt')).Trim()
if ($kafkaDisposition -eq 'cold-archive') { if ($inventory -notcontains 'kafka-data-cold.tar.gz') { throw 'Kafka cold-archive disposition 缺少归档' } } elseif ($kafkaDisposition -eq 'metadata-only') { if ($inventory -contains 'kafka-data-cold.tar.gz') { throw 'Kafka metadata-only disposition 含归档' } } else { throw 'Kafka disposition 无效' }

function Read-OccEnv([string]$Path) {
  $allowed = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','OCC_JWT_PRIVATE_KEY_FILE','OCC_JWT_PUBLIC_KEY_FILE','OCC_JWT_ISSUER','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
  $result = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    if ($_ -and -not $_.StartsWith('#')) {
      $parts = $_ -split '=',2
      if ($parts.Count -ne 2 -or $allowed -notcontains $parts[0] -or $result.ContainsKey($parts[0])) { throw "无效、未知或重复 env key：$Path" }
      $result[$parts[0]] = $parts[1]
    }
  }
  return $result
}
$ProductionConfig = Read-OccEnv $ProductionEnv
$RestoreConfig = Read-OccEnv $RestoreEnv
$BackupNonSecretConfig = Read-OccEnv (Join-Path $RestoreSet 'compose-env-nonsecret.txt')
$nonSecretKeys = @('OCC_JWT_ISSUER','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
if (@($BackupNonSecretConfig.Keys).Count -ne 13) { throw '备份非秘密配置集不完整' }
foreach ($key in 'OCC_JWT_ISSUER','POSTGRES_DB','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET') {
  if (-not $BackupNonSecretConfig.ContainsKey($key) -or $RestoreConfig[$key] -ne $BackupNonSecretConfig[$key]) { throw "恢复配置与备份时点不一致：$key" }
}
$secretKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','OCC_JWT_PRIVATE_KEY_FILE','OCC_JWT_PUBLIC_KEY_FILE')
$rootItem = Get-Item -LiteralPath $RestoreSecretRoot -Force
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '恢复 secret root 不能是 reparse point' }
$rootPrefix = $RestoreSecretRoot.TrimEnd('\') + '\'
$seenSecretPaths = @{}
foreach ($key in $secretKeys) {
  $raw = $RestoreConfig[$key]
  if ([string]::IsNullOrWhiteSpace($raw) -or -not [IO.Path]::IsPathRooted($raw)) { throw "$key 必须是绝对路径" }
  if (($raw -split '[\\/]') -contains '..') { throw "$key 原始路径含 traversal 段" }
  $resolved = (Resolve-Path -LiteralPath $raw).Path
  if (-not $resolved.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw "$key 解析后不在 OCC_RESTORE_SECRET_ROOT 下" }
  $item = Get-Item -LiteralPath $resolved -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$key 不是普通非链接文件" }
  $cursor = $item.Directory
  while ($null -ne $cursor -and $cursor.FullName.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$key 的父路径含 reparse point" }
    $cursor = $cursor.Parent
  }
  if ($seenSecretPaths.ContainsKey($resolved.ToLowerInvariant())) { throw '八个恢复 secret 必须使用不同文件' }
  $seenSecretPaths[$resolved.ToLowerInvariant()] = $true
}
$portDefaults = [ordered]@{ POSTGRES_PORT=5432; KAFKA_PORT=9092; REDIS_PORT=6379; MINIO_API_PORT=9000; MINIO_CONSOLE_PORT=9001; OPA_PORT=8181; AI_PORT=3100; CORE_PORT=8080 }
function Effective-Port($Config,[string]$Name,[int]$Default) { if ([string]::IsNullOrEmpty($Config[$Name])) { return $Default }; $parsed=0; if (-not [int]::TryParse($Config[$Name],[ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) { throw "$Name 不是有效端口" }; return $parsed }
$productionPorts = @($portDefaults.GetEnumerator() | ForEach-Object { Effective-Port $ProductionConfig $_.Key $_.Value })
$restorePorts = New-Object System.Collections.Generic.List[int]
foreach ($entry in $portDefaults.GetEnumerator()) {
  $port = Effective-Port $RestoreConfig $entry.Key $entry.Value
  if ($productionPorts -contains $port) { throw "恢复端口 $port 与生产有效端口相同" }
  if ($restorePorts.Contains($port)) { throw "恢复端口 $port 重复" }
  if (Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port) { throw "恢复端口 $port 已被监听" }
  $restorePorts.Add($port)
}
$productionJson = & docker @ProductionArgs config --format json
if ($LASTEXITCODE -ne 0) { throw '生产 Compose project 查询失败' }
$restoreJson = & docker @RestoreArgs config --format json
if ($LASTEXITCODE -ne 0) { throw '恢复 Compose project 查询失败' }
$productionProject = ($productionJson | ConvertFrom-Json).name
$restoreProject = ($restoreJson | ConvertFrom-Json).name
if ($restoreProject -ne $env:OCC_RESTORE_PROJECT -or $restoreProject -eq $productionProject) { throw '恢复 Compose project 未与生产隔离' }
$preexistingVolumeOutput = & docker volume ls --quiet --filter "label=com.docker.compose.project=$restoreProject"
$preexistingVolumeExit = $LASTEXITCODE
if ($preexistingVolumeExit -ne 0) { throw '恢复 project 卷清单查询失败' }
if (@($preexistingVolumeOutput | Where-Object { $_ }).Count -ne 0) { throw '恢复 project 已有命名卷；本流程不支持未证明来源的 resume' }
$expectedVolumes = @('postgres-data','kafka-data','redis-data','minio-data') | ForEach-Object { "${restoreProject}_$_" }
foreach ($expectedVolume in $expectedVolumes) {
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $volumeInspectOutput = & docker volume inspect $expectedVolume 2>&1
    $volumeInspectExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  $volumeInspectText = (($volumeInspectOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
  if ($volumeInspectExit -eq 0) { throw "目标卷 $expectedVolume 已存在；禁止恢复" }
  $notFoundPattern = '(?im)^Error response from daemon: get ' + [regex]::Escape($expectedVolume) + ': no such volume\.?$'
  if ($volumeInspectExit -ne 1 -or $volumeInspectText -notmatch $notFoundPattern) {
    throw "目标卷 $expectedVolume inspect 失败（exit $volumeInspectExit）：$volumeInspectText"
  }
}
& docker @RestoreArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw '隔离恢复 Compose 配置失败' }
```

Linux：

```bash
set -euo pipefail
set +x
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_RESTORE_ROOT:?必须设置 OCC_RESTORE_ROOT}"
: "${OCC_RESTORE_SECRET_ROOT:?必须设置 OCC_RESTORE_SECRET_ROOT}"
: "${OCC_RESTORE_ENV_FILE:?必须设置 OCC_RESTORE_ENV_FILE}"
: "${OCC_RESTORE_BACKUP_SET:?必须设置 OCC_RESTORE_BACKUP_SET}"
: "${OCC_RESTORE_PROJECT:?必须设置 OCC_RESTORE_PROJECT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
case "$OCC_RESTORE_PROJECT" in innorder-occ-restore-[a-z0-9-]*) ;; *) exit 1;; esac
[ "$OCC_RESTORE_PROJECT" != innorder-occ ]
restore_root=$(realpath "$OCC_RESTORE_ROOT")
restore_secret_root=$(realpath "$OCC_RESTORE_SECRET_ROOT")
restore_env=$(realpath "$OCC_RESTORE_ENV_FILE")
restore_set=$(realpath "$OCC_RESTORE_BACKUP_SET")
case "$restore_set/" in "$restore_root/"*) printf '备份不能位于恢复根目录\n' >&2; exit 1;; esac
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
restore_lifecycle_lock_fd=
exec {restore_lifecycle_lock_fd}>"$evidence_root/innorder-occ-lifecycle.lock"
flock -n "$restore_lifecycle_lock_fd" || { exec {restore_lifecycle_lock_fd}>&-; printf '另一个受管 OCC 操作持有项目全局锁\n' >&2; exit 1; }
cd -- "$repository_root"
production_compose=(docker compose --env-file "$repository_root/infra/compose/.env" -f "$repository_root/infra/compose/compose.yml")
restore_compose=(docker compose -p "$OCC_RESTORE_PROJECT" --env-file "$restore_env" -f infra/compose/compose.yml)

for name in backup-artifacts.inventory backup-manifest.sha256 COMPLETE backup-trust-status.txt; do test -f "$restore_set/$name"; done
stored_trust_status=$(tr -d '\r\n' <"$restore_set/backup-trust-status.txt")
controls=(backup-manifest.sha256 COMPLETE)
[ "$stored_trust_status" = external-verification-required ] && controls+=(external-trust-evidence.txt)
mapfile -t inventory <"$restore_set/backup-artifacts.inventory"
[ "${#inventory[@]}" -gt 0 ]
mapfile -t sorted_inventory < <(printf '%s\n' "${inventory[@]}" | sort -u)
diff -u <(printf '%s\n' "${inventory[@]}") <(printf '%s\n' "${sorted_inventory[@]}")
printf '%s\n' "${inventory[@]}" | grep -qx backup-artifacts.inventory
for path in "${inventory[@]}"; do case "$path" in ''|*$'\n'*|*$'\r'*|*\\*|/*|../*|./*) printf '不安全 artifact 路径：%s\n' "$path" >&2; exit 1;; esac; done
mapfile -t actual < <(find "$restore_set" -type f -printf '%P\n' | sort -u)
mapfile -t allowed_actual < <(printf '%s\n' "${inventory[@]}" "${controls[@]}" | sort -u)
diff -u <(printf '%s\n' "${allowed_actual[@]}") <(printf '%s\n' "${actual[@]}")
mapfile -t manifest_paths < <(sed -n 's/^[0-9a-f]\{64\}  //p' "$restore_set/backup-manifest.sha256" | sort -u)
diff -u <(printf '%s\n' "${inventory[@]}") <(printf '%s\n' "${manifest_paths[@]}")
(cd -- "$restore_set" && sha256sum --check backup-manifest.sha256)
required_artifacts=(backup-start-utc.txt backup-end-utc.txt source-revision.txt source-status.txt configuration-paths-only.txt compose-env-paths-only.txt compose-env-nonsecret.txt secret-escrow-receipt.txt backup-consistency-evidence.txt compose-images.txt image-identifiers.txt tool-versions.txt backup-policy-metadata.txt backup-trust-status.txt postgresql-restore-list.txt minio/source-objects.json minio/source-object-count.txt minio/source-object-manifest.jsonl minio/minio-files.sha256 redis-disposition.txt kafka-topics.txt kafka-consumer-groups.txt kafka-disposition.txt backup-artifacts.inventory)
for path in "${required_artifacts[@]}"; do printf '%s\n' "${inventory[@]}" | grep -Fqx -- "$path"; done
declare -A policy_metadata=()
while IFS='=' read -r key value; do [ -n "$key" ] && [ -z "${policy_metadata[$key]+present}" ] || exit 1; policy_metadata[$key]=$value; done <"$restore_set/backup-policy-metadata.txt"
case "$stored_trust_status" in
  local/internal-integrity-only)
    [ "${policy_metadata[trust-mode]:-}" = internal-only ]
    case "$(cat "$restore_set/COMPLETE")" in local/internal-integrity-only*) ;; *) exit 1;; esac
    printf '警告：仅验证本地 checksum；不抵抗恶意篡改，未证明主机损失后可用。\n' >&2
    ;;
  external-verification-required)
    : "${OCC_EXTERNAL_VERIFY_TOOL:?必须设置外部验证工具}"; : "${OCC_EXTERNAL_RECORD_ID:?必须设置外部 record ID}"; : "${OCC_EXTERNAL_RECORD_VERSION:?必须设置外部 record version}"
    [ "${policy_metadata[trust-mode]:-}" = external-verified ] && [ "${policy_metadata[fault-domain-status]:-}" = off-host-immutable-copy ]
    [ "${policy_metadata[external-record-id]:-}" = "$OCC_EXTERNAL_RECORD_ID" ] && [ "${policy_metadata[external-record-version]:-}" = "$OCC_EXTERNAL_RECORD_VERSION" ]
    verify_tool=$(realpath "$OCC_EXTERNAL_VERIFY_TOOL")
    set +e
    external_check=$("$verify_tool" verify-manifest --manifest "$restore_set/backup-manifest.sha256" --record-id "$OCC_EXTERNAL_RECORD_ID" --record-version "$OCC_EXTERNAL_RECORD_VERSION" --require-off-host-immutable 2>&1); external_check_exit=$?
    set -e
    [ "$external_check_exit" -eq 0 ] && [ -n "$external_check" ]
    [ "$(tr -d '\r\n' <"$restore_set/COMPLETE")" = external-verified-off-host-immutable ]
    ;;
  *) exit 1;;
esac
mapfile -t restore_dumps < <(printf '%s\n' "${inventory[@]}" | grep -E '^occ-[^/]+\.dump$')
[ "${#restore_dumps[@]}" -eq 1 ] && test -s "$restore_set/${restore_dumps[0]}" && test -s "$restore_set/postgresql-restore-list.txt"
minio_count=$(tr -d '\r\n' <"$restore_set/minio/source-object-count.txt")
[[ $minio_count =~ ^[0-9]+$ ]]
[ "$(wc -l <"$restore_set/minio/source-objects.json")" -eq "$minio_count" ]
mapfile -t minio_object_artifacts < <(printf '%s\n' "${inventory[@]}" | grep '^minio/objects/' || true)
mapfile -t minio_file_manifest <"$restore_set/minio/minio-files.sha256"
[ "${#minio_object_artifacts[@]}" -eq "${#minio_file_manifest[@]}" ]
mapfile -t minio_manifest_artifacts < <(sed -n 's/^[0-9a-f]\{64\}  objects\//#minio/objects/#p' "$restore_set/minio/minio-files.sha256" | sort -u)
diff -u <(printf '%s\n' "${minio_object_artifacts[@]}") <(printf '%s\n' "${minio_manifest_artifacts[@]}")
if [ "${#minio_object_artifacts[@]}" -gt 0 ]; then (cd -- "$restore_set/minio" && sha256sum --check minio-files.sha256); fi
test -s "$restore_set/secret-escrow-receipt.txt"
redis_disposition=$(tr -d '\r\n' <"$restore_set/redis-disposition.txt")
case "$redis_disposition" in snapshot) for name in redis.rdb redis-bgsave-proof.txt; do printf '%s\n' "${inventory[@]}" | grep -Fqx "$name"; done;; rebuildable-no-snapshot) for name in redis.rdb redis-bgsave-proof.txt; do ! printf '%s\n' "${inventory[@]}" | grep -Fqx "$name"; done;; *) exit 1;; esac
kafka_disposition=$(tr -d '\r\n' <"$restore_set/kafka-disposition.txt")
case "$kafka_disposition" in cold-archive) printf '%s\n' "${inventory[@]}" | grep -Fqx kafka-data-cold.tar.gz;; metadata-only) ! printf '%s\n' "${inventory[@]}" | grep -Fqx kafka-data-cold.tar.gz;; *) exit 1;; esac

declare -A allowed=() production_config=() restore_config=() seen_secret_paths=()
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE OCC_JWT_PRIVATE_KEY_FILE OCC_JWT_PUBLIC_KEY_FILE OCC_JWT_ISSUER POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
read_occ_env() {
  local path=$1 target_name=$2 key value
  local -n target=$target_name
  while IFS='=' read -r key value || [ -n "$key" ]; do
    value=${value%$'\r'}; [ -z "$key" ] && continue; case "$key" in \#*) continue;; esac
    [ -n "${allowed[$key]:-}" ] && [ -z "${target[$key]+present}" ] || return 1
    target[$key]=$value
  done <"$path"
}
read_occ_env "$repository_root/infra/compose/.env" production_config
read_occ_env "$restore_env" restore_config
declare -A backup_nonsecret_config=()
read_occ_env "$restore_set/compose-env-nonsecret.txt" backup_nonsecret_config
nonsecret_keys=(OCC_JWT_ISSUER POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET)
[ "${#backup_nonsecret_config[@]}" -eq 13 ]
for key in "${nonsecret_keys[@]}"; do [ -n "${backup_nonsecret_config[$key]+present}" ] || { printf '备份非秘密配置缺少：%s\n' "$key" >&2; exit 1; }; done
for key in OCC_JWT_ISSUER POSTGRES_DB AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do [ "${restore_config[$key]:-}" = "${backup_nonsecret_config[$key]}" ] || { printf '恢复配置与备份时点不一致：%s\n' "$key" >&2; exit 1; }; done
test ! -L "$restore_secret_root"
set +e
secret_link_output=$(find "$restore_secret_root" -type l -print -quit 2>&1); secret_link_exit=$?
set -e
[ "$secret_link_exit" -eq 0 ]
[ -z "$secret_link_output" ] || { printf '恢复 secret root 下存在符号链接：%s\n' "$secret_link_output" >&2; exit 1; }
secret_keys=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE OCC_JWT_PRIVATE_KEY_FILE OCC_JWT_PUBLIC_KEY_FILE)
for key in "${secret_keys[@]}"; do
  raw=${restore_config[$key]:-}; case "$raw" in /*) ;; *) exit 1;; esac
  case "$raw" in */../*|*/..) printf '%s 原始路径含 traversal 段\n' "$key" >&2; exit 1;; esac
  test -f "$raw" && test ! -L "$raw"
  resolved=$(realpath -e "$raw")
  case "$resolved" in "$restore_secret_root"/*) ;; *) printf '%s 不在恢复 secret root 下\n' "$key" >&2; exit 1;; esac
  [ -z "${seen_secret_paths[$resolved]:-}" ] || exit 1
  seen_secret_paths[$resolved]=1
done
port_names=(POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT)
port_defaults=(5432 9092 6379 9000 9001 8181 3100 8080)
production_ports=(); restore_ports=()
for index in "${!port_names[@]}"; do name=${port_names[$index]}; production_ports+=("${production_config[$name]:-${port_defaults[$index]}}"); done
command -v ss >/dev/null
set +e
listening_output=$(ss -H -ltn 2>&1); listening_exit=$?
set -e
[ "$listening_exit" -eq 0 ] || { printf '%s\n' "$listening_output" >&2; exit "$listening_exit"; }
declare -A listening_ports=()
while read -r _ _ _ local_address _; do [ -z "$local_address" ] || listening_ports[${local_address##*:}]=1; done <<<"$listening_output"
for index in "${!port_names[@]}"; do
  name=${port_names[$index]}; port=${restore_config[$name]:-${port_defaults[$index]}}
  [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
  if printf '%s\n' "${production_ports[@]}" | grep -Fqx "$port"; then printf '恢复端口与生产相同：%s\n' "$port" >&2; exit 1; fi
  if printf '%s\n' "${restore_ports[@]:-}" | grep -Fqx "$port"; then printf '恢复端口重复：%s\n' "$port" >&2; exit 1; fi
  if [ -n "${listening_ports[$port]:-}" ]; then printf '恢复端口已监听：%s\n' "$port" >&2; exit 1; fi
  restore_ports+=("$port")
done
production_json=$("${production_compose[@]}" config --format json)
restore_json=$("${restore_compose[@]}" config --format json)
production_project=$(printf '%s' "$production_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')
restore_project=$(printf '%s' "$restore_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')
[ "$restore_project" = "$OCC_RESTORE_PROJECT" ] && [ "$restore_project" != "$production_project" ]
set +e
preexisting_volume_output=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$restore_project" 2>&1); preexisting_volume_exit=$?
set -e
[ "$preexisting_volume_exit" -eq 0 ] || { printf '%s\n' "$preexisting_volume_output" >&2; exit "$preexisting_volume_exit"; }
[ -z "$preexisting_volume_output" ] || { printf '恢复 project 已有卷；禁止未证明来源的 resume：%s\n' "$preexisting_volume_output" >&2; exit 1; }
expected_volumes=("${restore_project}_postgres-data" "${restore_project}_kafka-data" "${restore_project}_redis-data" "${restore_project}_minio-data")
for expected_volume in "${expected_volumes[@]}"; do
  set +e
  volume_inspect_output=$(docker volume inspect "$expected_volume" 2>&1); volume_inspect_exit=$?
  set -e
  [ "$volume_inspect_exit" -ne 0 ] || { printf '目标卷已存在；禁止恢复：%s\n' "$expected_volume" >&2; exit 1; }
  expected_not_found="Error response from daemon: get $expected_volume: no such volume"
  if [ "$volume_inspect_exit" -ne 1 ] || { [ "$volume_inspect_output" != "$expected_not_found" ] && [ "$volume_inspect_output" != "$expected_not_found." ]; }; then
    printf '目标卷 inspect 失败（exit %s）：%s\n' "$volume_inspect_exit" "$volume_inspect_output" >&2
    exit "$volume_inspect_exit"
  fi
done
"${restore_compose[@]}" config --quiet
```

**验证：** 此时尚未启动任何恢复状态服务。只有每个 artifact checksum、精确 inventory、信任分类（外部模式还必须由外部工具实时重验）、PostgreSQL/MinIO 必需恢复材料、Redis/Kafka disposition、八个 canonical secret 路径、实际 Compose project 名和八个空闲非生产端口全部通过，`config --quiet` 才作为附加结构检查。本流程不提供 resume：project label 清单是补充检查；按已验证规范名派生的四个精确卷名必须逐一由 `docker volume inspect` 返回明确的 `no such volume`。Windows PowerShell 5.1 会把重定向后的 native stderr 包装为 error record，因此每次 inspect 只在紧邻的 `try` 中临时使用 `Continue` 捕获输出和退出码，并在 `finally` 中恢复原始 `ErrorActionPreference`；随后以每个对象的 `ToString()` 值还原原始诊断文本，避免 `Out-String` 注入 PowerShell 显示元数据，再进行分类。任何卷存在、daemon/权限/上下文错误或其他非预期响应都立即停止，不用 `down --volumes` 清除未知环境。

## 隔离恢复顺序

精确顺序为：配置/密钥与 checksum -> PostgreSQL -> MinIO -> Redis/Kafka 辅助状态 -> Core/其他应用 -> 验收。先只启动 PostgreSQL 和 MinIO 基础服务，避免 Core 在恢复前运行 Flyway。

```powershell
$ErrorActionPreference = 'Stop'
& docker @RestoreArgs up -d postgres minio
if ($LASTEXITCODE -ne 0) { throw '隔离 PostgreSQL/MinIO 启动失败' }
```

```bash
set -euo pipefail
"${restore_compose[@]}" up -d postgres minio
```

### PostgreSQL 破坏性恢复保护

**影响：** `pg_restore --clean --if-exists` 会删除隔离目标数据库中同名对象并替换为备份内容；命令只允许新建恢复 project。**备份：** 若目标不是确认的新空实例，先按本章另建集合备份目标；无法备份则停止。**确认：** 设置 `OCC_CONFIRM_ISOLATED_PG_RESTORE=RESTORE_APPROVED_BACKUP`。**验证：** 恢复清单、完整 Flyway 历史、schema owner、数据库连接和 Core readiness。**恢复失败回退：** 保持 Core 未启动，保留日志；删除本次隔离 project 的卷只能另行双人批准，或恢复其操作前备份，绝不触碰生产卷。

Windows：

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_ISOLATED_PG_RESTORE -ne 'RESTORE_APPROVED_BACKUP') { throw '未确认隔离 PostgreSQL 恢复' }
$dump = Get-ChildItem -LiteralPath $RestoreSet -Filter '*.dump' -File
if (@($dump).Count -ne 1) { throw '备份集合必须精确包含一个 PostgreSQL dump' }
& docker @RestoreArgs run --rm --no-deps --volume "${RestoreSet}:/restore:ro" --entrypoint /bin/sh postgres -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; dump=$(find /restore -maxdepth 1 -type f -name "*.dump"); test -n "$dump"; pg_restore --host postgres --username innorder_admin --dbname "$POSTGRES_DB" --no-password --exit-on-error --clean --if-exists "$dump"; status=$?; unset PGPASSWORD; exit $status'
if ($LASTEXITCODE -ne 0) { throw '隔离 PostgreSQL 恢复失败；保持应用停止' }
& docker @RestoreArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT version, success FROM flyway_schema_history ORDER BY installed_rank;"; status=$?; unset PGPASSWORD; exit $status'
if ($LASTEXITCODE -ne 0) { throw 'Flyway 历史验证失败' }
Remove-Item Env:OCC_CONFIRM_ISOLATED_PG_RESTORE
```

Linux：

```bash
set -euo pipefail
: "${OCC_CONFIRM_ISOLATED_PG_RESTORE:?必须设置确认值}"
[ "$OCC_CONFIRM_ISOLATED_PG_RESTORE" = RESTORE_APPROVED_BACKUP ]
[ "$(find "$restore_set" -maxdepth 1 -type f -name '*.dump' | wc -l)" -eq 1 ]
"${restore_compose[@]}" run --rm --no-deps --volume "$restore_set:/restore:ro" --entrypoint /bin/sh postgres -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; dump=$(find /restore -maxdepth 1 -type f -name "*.dump"); test -n "$dump"; pg_restore --host postgres --username innorder_admin --dbname "$POSTGRES_DB" --no-password --exit-on-error --clean --if-exists "$dump"; status=$?; unset PGPASSWORD; exit $status'
"${restore_compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT version, success FROM flyway_schema_history ORDER BY installed_rank;"; status=$?; unset PGPASSWORD; exit $status'
unset OCC_CONFIRM_ISOLATED_PG_RESTORE
```

Flyway 查询必须与备份中的完整历史一致且全部成功；还需查询八个 schema owner 均为 `innorder_flyway`，Flowable `ACT_*` 表存在性与备份一致。不要手工插入/删除 `flyway_schema_history`，不要编辑已应用迁移。

### MinIO 破坏性恢复保护

**影响：** 向非空桶 mirror 可能覆盖同名对象；本流程只允许新隔离 project 的新桶。**备份：** 若目标桶非空，先 mirror 到另一个受限集合并校验，否则停止。**确认：** `OCC_CONFIRM_ISOLATED_MINIO_RESTORE=RESTORE_APPROVED_BACKUP`。**验证：** 初始化器成功、对象键/大小计数与备份清单比较、抽样或全量内容 checksum。**失败恢复：** 保持 Core 停止，保留目标和日志；用操作前目标 mirror 回退或重新创建本次隔离环境，不删除生产数据。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_ISOLATED_MINIO_RESTORE -ne 'RESTORE_APPROVED_BACKUP') { throw '未确认隔离 MinIO 恢复' }
& docker @RestoreArgs run --rm --no-deps minio-init
if ($LASTEXITCODE -ne 0) { throw '隔离 MinIO 初始化失败' }
$restoredJson = & docker @RestoreArgs run --rm --no-deps --volume "${RestoreSet}:/restore:ro" --entrypoint /bin/sh minio-init -ec 'root_user="$(cat /run/secrets/minio_root_user)"; root_password="$(cat /run/secrets/minio_root_password)"; mc alias set target http://minio:9000 "$root_user" "$root_password" >/dev/null; unset root_user root_password; test "$(mc ls --recursive --json target/"$MINIO_BUCKET" | wc -l)" -eq 0; mc mirror --preserve /restore/minio/objects target/"$MINIO_BUCKET" >/dev/null; mc ls --recursive --json target/"$MINIO_BUCKET"'
if ($LASTEXITCODE -ne 0) { throw '隔离 MinIO 恢复或目标清单读取失败' }
$restoredJson | & node -e 'const fs=require("node:fs");const expected=fs.readFileSync(process.argv[1],"utf8").trim();const input=fs.readFileSync(0,"utf8").trim();const records=input?input.split(/\r?\n/).map(JSON.parse).filter(x=>x.type==="file"):[];const actual=records.sort((a,b)=>a.key.localeCompare(b.key)).map(x=>JSON.stringify({key:x.key,size:x.size})).join("\n");if(actual!==expected)process.exit(1)' (Join-Path $RestoreSet 'minio\source-object-manifest.jsonl')
if ($LASTEXITCODE -ne 0) { throw '隔离 MinIO 目标 key/size 清单与备份不一致' }
Remove-Item Env:OCC_CONFIRM_ISOLATED_MINIO_RESTORE
```

```bash
set -euo pipefail
: "${OCC_CONFIRM_ISOLATED_MINIO_RESTORE:?必须设置确认值}"
[ "$OCC_CONFIRM_ISOLATED_MINIO_RESTORE" = RESTORE_APPROVED_BACKUP ]
"${restore_compose[@]}" run --rm --no-deps minio-init
restored_json=$("${restore_compose[@]}" run --rm --no-deps --volume "$restore_set:/restore:ro" --entrypoint /bin/sh minio-init -ec 'root_user="$(cat /run/secrets/minio_root_user)"; root_password="$(cat /run/secrets/minio_root_password)"; mc alias set target http://minio:9000 "$root_user" "$root_password" >/dev/null; unset root_user root_password; test "$(mc ls --recursive --json target/"$MINIO_BUCKET" | wc -l)" -eq 0; mc mirror --preserve /restore/minio/objects target/"$MINIO_BUCKET" >/dev/null; mc ls --recursive --json target/"$MINIO_BUCKET"')
printf '%s\n' "$restored_json" | node -e 'const fs=require("node:fs");const expected=fs.readFileSync(process.argv[1],"utf8").trim();const input=fs.readFileSync(0,"utf8").trim();const records=input?input.split(/\r?\n/).map(JSON.parse).filter(x=>x.type==="file"):[];const actual=records.sort((a,b)=>a.key.localeCompare(b.key)).map(x=>JSON.stringify({key:x.key,size:x.size})).join("\n");if(actual!==expected)process.exit(1)' "$restore_set/minio/source-object-manifest.jsonl"
unset OCC_CONFIRM_ISOLATED_MINIO_RESTORE
```

### 辅助存储恢复

Redis RDB 恢复会替换隔离 `redis-data` 的启动状态。**影响、备份、确认、验证、恢复：** 只对尚未启动的隔离 Redis 空卷执行；非空目标先 BGSAVE 并复制；要求 `OCC_CONFIRM_ISOLATED_REDIS_RESTORE=RESTORE_APPROVED_SECONDARY`；启动后认证 `PING` 并由 Core 状态验证；失败时停止 Redis并恢复操作前 RDB或重建该隔离卷，经批准后才删除。

使用只读 bind 和目标 volume 的固定辅助容器写入是次要恢复路径，不是主备份。命令先 `create` 隔离 Redis 以创建目标卷但不启动进程，再要求卷为空；发现任何文件都会停止，不覆盖。Windows：

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_ISOLATED_REDIS_RESTORE -ne 'RESTORE_APPROVED_SECONDARY') { throw '未确认隔离 Redis 次要恢复' }
if (-not (Test-Path -LiteralPath (Join-Path $RestoreSet 'redis.rdb') -PathType Leaf)) { throw '备份集合没有 Redis RDB' }
& docker @RestoreArgs create redis
if ($LASTEXITCODE -ne 0) { throw '隔离 Redis 容器/卷创建失败' }
$redisVolumeOutput = & docker volume ls --quiet --filter "label=com.docker.compose.project=$($env:OCC_RESTORE_PROJECT)" --filter 'label=com.docker.compose.volume=redis-data'
$redisVolumeExit = $LASTEXITCODE
$redisVolumes = @($redisVolumeOutput | Where-Object { $_ })
if ($redisVolumeExit -ne 0 -or $redisVolumes.Count -ne 1) { throw '隔离 Redis 卷定位失败' }
& docker run --rm --mount "type=volume,src=$($redisVolumes[0]),dst=/target" --mount "type=bind,src=$RestoreSet,dst=/restore,readonly" alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c sh -ec 'test -z "$(find /target -mindepth 1 -maxdepth 1 -print -quit)"; test -f /restore/redis.rdb; cp /restore/redis.rdb /target/dump.rdb; chmod 0600 /target/dump.rdb'
if ($LASTEXITCODE -ne 0) { throw '隔离 Redis RDB 写入失败；目标保持停止' }
& docker @RestoreArgs up -d redis
if ($LASTEXITCODE -ne 0) { throw '隔离 Redis 启动失败；停止目标并保留证据' }
& docker @RestoreArgs exec -T redis sh -ec 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; redis-cli --no-auth-warning PING | grep -q PONG; status=$?; unset REDISCLI_AUTH; exit $status'
if ($LASTEXITCODE -ne 0) { throw '隔离 Redis 恢复验证失败' }
Remove-Item Env:OCC_CONFIRM_ISOLATED_REDIS_RESTORE
```

Linux：

```bash
set -euo pipefail
: "${OCC_CONFIRM_ISOLATED_REDIS_RESTORE:?必须设置确认值}"
[ "$OCC_CONFIRM_ISOLATED_REDIS_RESTORE" = RESTORE_APPROVED_SECONDARY ]
test -f "$restore_set/redis.rdb"
"${restore_compose[@]}" create redis
mapfile -t redis_volumes < <(docker volume ls --quiet --filter "label=com.docker.compose.project=$OCC_RESTORE_PROJECT" --filter label=com.docker.compose.volume=redis-data)
[ "${#redis_volumes[@]}" -eq 1 ]
docker run --rm --mount "type=volume,src=${redis_volumes[0]},dst=/target" --mount "type=bind,src=$restore_set,dst=/restore,readonly" alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c sh -ec 'test -z "$(find /target -mindepth 1 -maxdepth 1 -print -quit)"; test -f /restore/redis.rdb; cp /restore/redis.rdb /target/dump.rdb; chmod 0600 /target/dump.rdb'
"${restore_compose[@]}" up -d redis
"${restore_compose[@]}" exec -T redis sh -ec 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; redis-cli --no-auth-warning PING | grep -q PONG; status=$?; unset REDISCLI_AUTH; exit $status'
unset OCC_CONFIRM_ISOLATED_REDIS_RESTORE
```

Redis 镜像入口应在启动时把 `/data` 调整为运行用户可读；若权限或加载失败，停止 Redis，保留卷和日志，不用宽松权限绕过。RDB 载入后 Redis 会继续使用 AOF；必须从启动日志确认载入来源和错误为零。

Kafka 冷归档恢复风险更高，只允许完全相同的固定 Kafka 版本、隔离 project 和专门演练；默认不导入归档，而是启动空 broker并依据 `kafka-topics.txt` 由应用所有者批准重建 topic。以下命令只启动和验证空隔离 Kafka，不声称恢复历史消息：

```powershell
$ErrorActionPreference = 'Stop'
& docker @RestoreArgs up -d kafka
if ($LASTEXITCODE -ne 0) { throw '隔离空 Kafka 启动失败' }
& docker @RestoreArgs exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
if ($LASTEXITCODE -ne 0) { throw '隔离 Kafka 协议验证失败' }
```

```bash
set -euo pipefail
"${restore_compose[@]}" up -d kafka
"${restore_compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
```

如果确实需要导入 `kafka-data-cold.tar.gz`，必须另写与固定 Kafka 3.9.1、cluster ID、节点 ID 和目录布局匹配的演练操作票；本章不提供可能误用于不同集群的通用解包命令。任何依赖历史 Kafka/Redis 状态的能力在未验证前不得切换。

## 启动应用与恢复验收

辅助存储决定完成后启动完整隔离栈：

```powershell
$ErrorActionPreference = 'Stop'
& docker @RestoreArgs up -d
if ($LASTEXITCODE -ne 0) { throw '隔离完整栈启动失败' }
& docker @RestoreArgs ps -a
if ($LASTEXITCODE -ne 0) { throw '隔离状态查询失败' }
```

```bash
set -euo pipefail
"${restore_compose[@]}" up -d
"${restore_compose[@]}" ps -a
```

验收使用 restore env 的独立有效端口，至少包括：

- 三个 one-shot 精确 `exited 0`，八个长运行服务 `running healthy`，restart count 可解释。
- Core readiness HTTP 200 且仅代表 `ping`/`db`；Core/AI status、OPA、MinIO readiness 成功。
- PostgreSQL 角色连接、备份中的完整 Flyway 历史全成功、八 schema owner、Flowable 表状态与 dump 一致。
- MinIO 桶名精确、对象键和大小清单一致，选定范围内容 checksum 通过，应用账号仅有桶级访问。
- Redis/Kafka 恢复限制已记录；执行认证 PING 和 topic-list，不虚构业务事务。
- 源 revision、Compose、image ID/digest 与备份记录相符；没有让旧应用连接不兼容 schema。
- 记录恢复点、每阶段用时、失败重试、实测 RPO/RTO 和证据。

验收和批准的切换/回退决定完成后，Windows 执行 `$RestoreLifecycleLock.Dispose()`，Linux 执行 `flock -u "$restore_lifecycle_lock_fd"; exec {restore_lifecycle_lock_fd}>&-`。失败时保持现场并退出当前进程，由操作系统释放锁；不得通过删除锁文件绕过占用。

## 切换与回退

**当前支持边界：** 本章提供可执行的隔离恢复和恢复演练，不提供正式生产切换。当前仓库没有负载均衡/DNS failover、Compose project/卷重命名、跨存储增量追平或经验证的 canonical `innorder-occ` 覆盖恢复自动化。隔离恢复成功只能证明所选集合可恢复，不能自行改端口或把 restore project 宣称为生产。正式切换必须使用另行批准、逐平台实测的组织操作票；该操作票至少绑定资产、canonical 配置、旧环境静默、最终差异处理、端口/服务所有权、回退点和完整验收。没有该操作票时保持隔离环境，不切换。

切换前必须有数据所有者、恢复负责人、安全/变更审批人共同签字。生产旧环境保持停止写入但不删除；最终增量差异如何处理必须由实际应用能力定义，当前没有跨 PostgreSQL/MinIO 增量协调工具。若无法证明从备份时点到切换时点的数据处理，不能切换并宣称零丢失。

若组织补充了已实测切换操作票，切换后必须重复完整验收并观察初始阈值窗口。以下任一触发该操作票的回退：核心验收失败、schema/owner 不符、对象缺失/checksum 失败、凭据范围错误、未知数据差异、版本不符或安全控制缺失。

回退优先让旧环境恢复原端口并解除静默，前提是旧环境在切换后未接受会与新环境冲突的写入。新环境一旦接受写入，不能直接双向切换；立即停止双方写入，保留两边备份和日志，由数据所有者制定合并/前向恢复。任何删除新环境卷的清理都在事件关闭后另行审批。

## 季度恢复演练

每季度从异地目标随机选择一个符合保留策略的完整集合，在隔离环境执行：secret escrow 取回、checksum、PostgreSQL、MinIO、辅助存储决策、全栈启动和完整验收。演练不连接生产端口，不使用生产卷，不把成功启动当作成功恢复。

报告包含集合时点/大小/对象数、工具与镜像版本、每阶段时长、实际恢复点、RPO/RTO 差距、权限/审批等待、失败和修复、未验证 Kafka/Redis 语义、证据位置和下一次责任人。任何 checksum、角色/owner、对象或验收失败都使演练失败，修复后重做；不得改报告为“部分通过”来满足指标。

## 完整灾难、误删与退役

主机/站点完全损失时：宣布事件并停止旧端点写入 -> 保护剩余介质和审计 -> 在独立干净主机取得批准 revision/镜像/配置路径 -> 从独立 escrow 取回密钥 -> 从异地复制验证 checksum -> 按本章隔离顺序恢复 -> 完整验收。到此为本手册的可执行边界；后续生产接管只能进入上述另行实测的组织切换操作票。旧主机若重新出现，保持隔离，不能与恢复环境同时提供写入。

误执行 `down --volumes` 或发现空数据库时立即停止 Core/客户端，禁止初始化空栈产生新写入，保存 Docker/主机状态并升级数据丢失事件。不要反复启动、运行清理工具或从镜像层猜测数据；只从已验证外部备份恢复。

永久退役是独立破坏性流程：核对客户/资产、法务保留、诉讼冻结和备份到期；先做最终备份和隔离恢复；双人确认后停止服务。数据卷、主机数据、密钥 escrow、异地备份、日志和 registry 镜像各有独立保留/销毁审批，不能用一个 `down --volumes` 代表全部销毁。每个删除步骤都必须记录影响、删除前备份/保留决定、精确确认、删除后清单验证和删除失败恢复；部分失败时冻结现场，不重复执行。
