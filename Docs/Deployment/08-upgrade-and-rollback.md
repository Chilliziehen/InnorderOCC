# 升级与回滚

本章用于把已审批 release commit 升级到当前单主机 Compose 环境，并在失败时区分应用/镜像回滚、配置回退和数据库前向修复/备份恢复。Core 启动会运行 Flyway；因此“把旧镜像重新启动”不等于数据库回滚，旧应用也不能在未经证明兼容的新 schema 上运行。

## 变更原则与停止条件

- **安全：** 构建与运行分离。先完成来源验证、测试、备份和镜像身份记录，再改变运行容器。
- **注意：** 当前栈没有滚动多副本、流量切换或 HA。升级采用批准维护窗口和受控停机，不宣称零中断。
- **危险：** 永远不删除或编辑已应用迁移，不修改其 checksum，不删除 `flyway_schema_history`，不手工标记失败迁移成功，不用关闭 Flyway 绕过启动。
- **危险：** migration 已开始后，只有确认旧应用与当前 schema 双向兼容才允许应用回滚。不可逆迁移需要经批准的前向修复迁移，或从已验证备份恢复整个隔离验证过的数据集合。
- **停止条件：** release commit/工作区不符、来源或 `verify:full` 失败、备份/checksum/隔离恢复无效、容量不足、迁移修改已应用版本、镜像 digest 不符、静默失败、任何服务状态不明、迁移失败、数据验证失败或维护窗口余量不足。
- 不对失败做自动重启、自动 schema repair、自动恢复或数据卷删除。保留第一现场，由发布负责人、DBA 和数据所有者决定。

## 变更记录与角色

变更单在执行前固定：客户/主机资产、Compose project、变更号、当前/目标 release commit、发布说明、镜像来源、配置/密钥差异、数据库迁移差异、维护窗口、预计/最大停机、容量、备份集合、恢复演练证据、验收、停止条件、回滚决策人、DBA、应用/安全/值班联系人和沟通时间。

| 角色 | 责任 |
|---|---|
| 发布负责人 | revision、依赖来源、构建、运行命令和证据完整性 |
| DBA/迁移所有者 | Flyway 差异、可逆性、schema 兼容性、前向修复/恢复决定 |
| 数据所有者 | 静默、允许数据损失、恢复点和切换接受 |
| 值班人员 | 升级前基线、窗口监控、告警和交接 |
| 安全/配置所有者 | 镜像 provenance、secret escrow、权限和凭据变更顺序 |
| 变更审批人 | 窗口开始、继续/停止、回滚或恢复批准 |

当前没有可执行的业务交易验收。不得编造订单、审批或干预队列测试；使用状态、数据库迁移、协议和对象存储边界验收，业务能力实现后再由其所有者增加真实只读/受控测试。

## Windows 发布会话

由审批系统设置 `OCC_RELEASE_COMMIT`、`OCC_PREVIOUS_RELEASE_COMMIT`、`OCC_CHANGE_ID`、`OCC_RELEASE_EVIDENCE_ROOT`、`OCC_REPOSITORY_ROOT`、`OCC_BACKUP_SET`、`OCC_BACKUP_MAX_AGE_MINUTES`、`OCC_BACKUP_EARLIEST_UTC` 和 `OCC_ROLLBACK_POLICY`。回滚政策只能是 `local-integrity-allowed` 或 `off-host-immutable-required`；后者还要求外部验证工具与 record ID/version。变更号限制为本地 Docker tag 可用字符，不含客户名或秘密。

```powershell
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw '必须使用 Windows PowerShell 5.1' }
foreach ($name in 'OCC_RELEASE_COMMIT','OCC_PREVIOUS_RELEASE_COMMIT','OCC_CHANGE_ID','OCC_RELEASE_EVIDENCE_ROOT','OCC_REPOSITORY_ROOT','OCC_BACKUP_SET','OCC_BACKUP_MAX_AGE_MINUTES','OCC_BACKUP_EARLIEST_UTC','OCC_ROLLBACK_POLICY','OCC_EVIDENCE_ROOT') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "缺少 $name" }
}
if ($env:OCC_RELEASE_COMMIT -notmatch '^[0-9a-fA-F]{40}$' -or $env:OCC_PREVIOUS_RELEASE_COMMIT -notmatch '^[0-9a-fA-F]{40}$') { throw 'release commit 必须是完整 40 位对象 ID' }
if ($env:OCC_CHANGE_ID -notmatch '^[a-z0-9][a-z0-9.-]{0,63}$') { throw 'OCC_CHANGE_ID 不符合本地镜像 tag 规则' }
$BackupMaxAgeMinutes = 0
if (-not [int]::TryParse($env:OCC_BACKUP_MAX_AGE_MINUTES,[ref]$BackupMaxAgeMinutes) -or $BackupMaxAgeMinutes -lt 1) { throw 'OCC_BACKUP_MAX_AGE_MINUTES 必须是正整数' }
$BackupEarliestUtc = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($env:OCC_BACKUP_EARLIEST_UTC,[ref]$BackupEarliestUtc) -or $BackupEarliestUtc.Offset -ne [TimeSpan]::Zero) { throw 'OCC_BACKUP_EARLIEST_UTC 必须是 UTC 时间' }
if ($env:OCC_ROLLBACK_POLICY -notin @('local-integrity-allowed','off-host-immutable-required')) { throw 'OCC_ROLLBACK_POLICY 无效' }
if ($env:OCC_ROLLBACK_POLICY -eq 'off-host-immutable-required') { foreach ($name in 'OCC_EXTERNAL_VERIFY_TOOL','OCC_EXTERNAL_RECORD_ID','OCC_EXTERNAL_RECORD_VERSION') { if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "外部回滚政策缺少 $name" } } }
$RepositoryRoot = (Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT).Path
$EvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_RELEASE_EVIDENCE_ROOT).Path
$BackupSet = (Resolve-Path -LiteralPath $env:OCC_BACKUP_SET).Path
$LifecycleEvidenceRoot = (Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT).Path
try { $LifecycleLock = [IO.File]::Open((Join-Path $LifecycleEvidenceRoot 'innorder-occ-lifecycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch [IO.IOException] { throw '另一个受管 OCC 操作持有项目全局锁' }
Set-Location -LiteralPath $RepositoryRoot
$ComposeEnv = Join-Path $RepositoryRoot 'infra\compose\.env'
$ComposeFile = Join-Path $RepositoryRoot 'infra\compose\compose.yml'
$ComposeArgs = @('compose','--env-file',$ComposeEnv,'-f',$ComposeFile)
$ReleaseEvidence = Join-Path $EvidenceRoot ("upgrade-{0}-{1}" -f $env:OCC_CHANGE_ID,(Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $ReleaseEvidence) { throw '发布证据目录已存在' }
New-Item -ItemType Directory -Path $ReleaseEvidence -ErrorAction Stop | Out-Null
& icacls.exe $ReleaseEvidence /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw '关闭发布证据 ACL 继承失败' }
& icacls.exe $ReleaseEvidence /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '设置发布证据 ACL 失败' }
function Invoke-ReleaseNative {
  param([string]$FilePath,[string[]]$ArgumentList,[string]$OutputName,[string]$FailureMessage)
  $savedNativeErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedNativeErrorPreference }
  if ($OutputName) { $output | Out-File (Join-Path $ReleaseEvidence $OutputName) -Encoding utf8 }
  if ($exitCode -ne 0) { throw "$FailureMessage，退出码 $exitCode" }
  return $output
}
```

## Linux 发布会话

Linux 使用同名变量：

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_RELEASE_COMMIT:?必须设置 OCC_RELEASE_COMMIT}"
: "${OCC_PREVIOUS_RELEASE_COMMIT:?必须设置 OCC_PREVIOUS_RELEASE_COMMIT}"
: "${OCC_CHANGE_ID:?必须设置 OCC_CHANGE_ID}"
: "${OCC_RELEASE_EVIDENCE_ROOT:?必须设置 OCC_RELEASE_EVIDENCE_ROOT}"
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_BACKUP_SET:?必须设置 OCC_BACKUP_SET}"
: "${OCC_BACKUP_MAX_AGE_MINUTES:?必须设置 OCC_BACKUP_MAX_AGE_MINUTES}"
: "${OCC_BACKUP_EARLIEST_UTC:?必须设置 OCC_BACKUP_EARLIEST_UTC}"
: "${OCC_ROLLBACK_POLICY:?必须设置 OCC_ROLLBACK_POLICY}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
[[ $OCC_RELEASE_COMMIT =~ ^[0-9a-fA-F]{40}$ ]]
[[ $OCC_PREVIOUS_RELEASE_COMMIT =~ ^[0-9a-fA-F]{40}$ ]]
[[ $OCC_CHANGE_ID =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]]
[[ $OCC_BACKUP_MAX_AGE_MINUTES =~ ^[0-9]+$ ]] && [ "$OCC_BACKUP_MAX_AGE_MINUTES" -ge 1 ]
case "$OCC_ROLLBACK_POLICY" in local-integrity-allowed) ;; off-host-immutable-required) : "${OCC_EXTERNAL_VERIFY_TOOL:?必须设置外部验证工具}"; : "${OCC_EXTERNAL_RECORD_ID:?必须设置外部 record ID}"; : "${OCC_EXTERNAL_RECORD_VERSION:?必须设置外部 record version}";; *) exit 1;; esac
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
evidence_root=$(realpath "$OCC_RELEASE_EVIDENCE_ROOT")
backup_set=$(realpath "$OCC_BACKUP_SET")
lifecycle_evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
lifecycle_lock_fd=
exec {lifecycle_lock_fd}>"$lifecycle_evidence_root/innorder-occ-lifecycle.lock"
flock -n "$lifecycle_lock_fd" || { exec {lifecycle_lock_fd}>&-; printf '另一个受管 OCC 操作持有项目全局锁\n' >&2; exit 1; }
cd -- "$repository_root"
compose=(docker compose --env-file "$repository_root/infra/compose/.env" -f "$repository_root/infra/compose/compose.yml")
release_evidence="$evidence_root/upgrade-$OCC_CHANGE_ID-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$release_evidence"
install -d -m 0700 "$release_evidence"
```

## Revision、干净状态与发布来源

运行目录必须已经由批准发布机制定位到目标 commit。本流程不执行 `git reset`、`git clean` 或隐式拉取；未知变更必须评审，而不是删除。

```powershell
$ErrorActionPreference = 'Stop'
$head = (& git -c "safe.directory=$RepositoryRoot" rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $env:OCC_RELEASE_COMMIT.ToLowerInvariant()) { throw "HEAD $head 不是批准 release commit" }
$oldType = (& git -c "safe.directory=$RepositoryRoot" cat-file -t $env:OCC_PREVIOUS_RELEASE_COMMIT).Trim()
if ($LASTEXITCODE -ne 0 -or $oldType -ne 'commit') { throw 'previous release commit 不可解析' }
$status = @(& git -c "safe.directory=$RepositoryRoot" status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Git 状态查询失败' }
if ($status.Count -ne 0) { $status | ForEach-Object { [Console]::Error.WriteLine($_) }; throw '发布工作区必须干净' }
$head | Out-File (Join-Path $ReleaseEvidence 'release-commit.txt') -Encoding ascii
$env:OCC_PREVIOUS_RELEASE_COMMIT | Out-File (Join-Path $ReleaseEvidence 'previous-release-commit.txt') -Encoding ascii
$releaseRecord = & git -c "safe.directory=$RepositoryRoot" show --no-patch --format=fuller $env:OCC_RELEASE_COMMIT 2>&1
$releaseRecordExit = $LASTEXITCODE
if ($releaseRecordExit -ne 0) { throw 'release commit 记录失败' }
$releaseRecord | Out-File (Join-Path $ReleaseEvidence 'release-commit-record.txt') -Encoding utf8
```

```bash
set -euo pipefail
[ "$(git rev-parse HEAD)" = "${OCC_RELEASE_COMMIT,,}" ]
[ "$(git cat-file -t "$OCC_PREVIOUS_RELEASE_COMMIT")" = commit ]
status=$(git status --porcelain=v1 --untracked-files=all)
[ -z "$status" ] || { printf '%s\n' "$status" >&2; exit 1; }
git rev-parse HEAD >"$release_evidence/release-commit.txt"
printf '%s\n' "$OCC_PREVIOUS_RELEASE_COMMIT" >"$release_evidence/previous-release-commit.txt"
git show --no-patch --format=fuller "$OCC_RELEASE_COMMIT" >"$release_evidence/release-commit-record.txt"
```

发布 provenance 至少关联受保护分支/签名或组织批准的 commit 验证、代码评审、依赖 lockfile、镜像 registry digest 和构建主机。仓库命令只能证明本地对象与内容，不能替代组织身份和审批验证。

## 安装、完整验证与 Compose 门禁

`install:verified` 必须先于构建；它按 lockfile 和来源守卫安装。`verify:full` 要求真实 Docker Engine、PostgreSQL 集成和真实 OPA，不允许 skipped。

```powershell
$ErrorActionPreference = 'Stop'
$OpaPath = (Get-Command opa -CommandType Application -ErrorAction Stop).Source
$previousOpa = $env:OPA_PATH
try {
  $env:OPA_PATH = $OpaPath
  Invoke-ReleaseNative 'npm' @('run','install:verified') 'install-verified.txt' '来源验证安装失败' | Out-Null
  Invoke-ReleaseNative 'npm' @('run','verify:full') 'verify-full.txt' '完整发布验证失败' | Out-Null
} finally {
  if ($null -eq $previousOpa) { Remove-Item Env:OPA_PATH -ErrorAction SilentlyContinue } else { $env:OPA_PATH = $previousOpa }
}
Invoke-ReleaseNative 'docker' ($ComposeArgs + @('config','--quiet')) 'compose-config.txt' 'Compose 配置验证失败' | Out-Null
```

```bash
set -euo pipefail
OPA_PATH=$(command -v opa)
test -n "$OPA_PATH" && test "${OPA_PATH#/}" != "$OPA_PATH"
export OPA_PATH
npm run install:verified >"$release_evidence/install-verified.txt" 2>&1
npm run verify:full >"$release_evidence/verify-full.txt" 2>&1
unset OPA_PATH
"${compose[@]}" config --quiet >"$release_evidence/compose-config.txt" 2>&1
```

失败时运行容器尚未改变。保存脱敏输出，修复来源、依赖、测试或配置根因后从 revision 门禁重跑；不得换成 `npm install`、`verify:local` 或跳过 Docker/OPA 测试。

## 已部署迁移不可变与新增迁移差异

`OCC_PREVIOUS_RELEASE_COMMIT` 是当前已部署 revision，`OCC_RELEASE_COMMIT` 是目标 revision。门禁动态枚举当前 revision 中每个 `database/migrations/V*__*.sql`，要求目标 revision 保留同一路径和相同 Git blob；因此 V010 及以后在部署后自动进入不可变集合。删除、重命名和内容修改都会失败。目标中只允许把新路径列入 `migration-added.txt` 供 DBA 评审；数据库 `flyway_schema_history` 和已执行的严格 `verify:full` 提供运行历史与 Flyway validation 证据。

Windows 记录源码差异和目标数据库历史：

```powershell
$ErrorActionPreference = 'Stop'
function Get-VersionedMigrations([string]$Commit) {
  $output = & git -c "safe.directory=$RepositoryRoot" ls-tree -r --name-only $Commit -- database/migrations 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "无法枚举 revision $Commit 的迁移，退出码 $exitCode" }
  $paths = @($output | Where-Object { $_ -match '^database/migrations/V[0-9]+__[^/]+\.sql$' } | Sort-Object -Unique)
  if ($paths.Count -eq 0) { throw "revision $Commit 没有版本化迁移" }
  return $paths
}
$deployedMigrations = @(Get-VersionedMigrations $env:OCC_PREVIOUS_RELEASE_COMMIT)
$targetMigrations = @(Get-VersionedMigrations $env:OCC_RELEASE_COMMIT)
$removedMigrations = @($deployedMigrations | Where-Object { $targetMigrations -notcontains $_ })
if ($removedMigrations.Count -ne 0) { $removedMigrations | ForEach-Object { [Console]::Error.WriteLine($_) }; throw '目标 revision 删除或重命名了已部署迁移' }
foreach ($path in $deployedMigrations) {
  $deployedSpec = '{0}:{1}' -f $env:OCC_PREVIOUS_RELEASE_COMMIT,$path
  $targetSpec = '{0}:{1}' -f $env:OCC_RELEASE_COMMIT,$path
  $deployedBlob = (& git -c "safe.directory=$RepositoryRoot" rev-parse $deployedSpec 2>&1).Trim()
  $deployedBlobExit = $LASTEXITCODE
  if ($deployedBlobExit -ne 0) { throw "无法读取已部署迁移 blob：$path" }
  $targetBlob = (& git -c "safe.directory=$RepositoryRoot" rev-parse $targetSpec 2>&1).Trim()
  $targetBlobExit = $LASTEXITCODE
  if ($targetBlobExit -ne 0) { throw "目标 revision 缺少已部署迁移：$path" }
  if ($deployedBlob -ne $targetBlob) { throw "已部署迁移内容被修改：$path" }
}
$addedMigrations = @($targetMigrations | Where-Object { $deployedMigrations -notcontains $_ } | Sort-Object)
[IO.File]::WriteAllLines((Join-Path $ReleaseEvidence 'migration-added.txt'),$addedMigrations,(New-Object Text.UTF8Encoding($false)))
$migrationDiff = & git -c "safe.directory=$RepositoryRoot" diff --name-status $env:OCC_PREVIOUS_RELEASE_COMMIT $env:OCC_RELEASE_COMMIT -- database/migrations 2>&1
$migrationDiffExit = $LASTEXITCODE
if ($migrationDiffExit -ne 0) { throw '迁移差异查询失败' }
$migrationDiff | Out-File (Join-Path $ReleaseEvidence 'migration-diff-name-status.txt') -Encoding utf8
$flywayBefore = & docker @ComposeArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --csv --command "SELECT installed_rank,version,description,checksum,installed_by,success FROM flyway_schema_history ORDER BY installed_rank;"; status=$?; unset PGPASSWORD; exit $status' 2>&1
$flywayBeforeExit = $LASTEXITCODE
if ($flywayBeforeExit -ne 0) { throw '升级前 Flyway 历史查询失败' }
$flywayBefore | Out-File (Join-Path $ReleaseEvidence 'flyway-before.csv') -Encoding utf8
```

Linux：

```bash
set -euo pipefail
set +e
deployed_output=$(git ls-tree -r --name-only "$OCC_PREVIOUS_RELEASE_COMMIT" -- database/migrations 2>&1); deployed_exit=$?
target_output=$(git ls-tree -r --name-only "$OCC_RELEASE_COMMIT" -- database/migrations 2>&1); target_exit=$?
set -e
[ "$deployed_exit" -eq 0 ] && [ "$target_exit" -eq 0 ]
mapfile -t deployed_migrations < <(printf '%s\n' "$deployed_output" | grep -E '^database/migrations/V[0-9]+__[^/]+\.sql$' | sort -u)
mapfile -t target_migrations < <(printf '%s\n' "$target_output" | grep -E '^database/migrations/V[0-9]+__[^/]+\.sql$' | sort -u)
[ "${#deployed_migrations[@]}" -gt 0 ] && [ "${#target_migrations[@]}" -gt 0 ]
mapfile -t removed_migrations < <(comm -23 <(printf '%s\n' "${deployed_migrations[@]}") <(printf '%s\n' "${target_migrations[@]}"))
[ "${#removed_migrations[@]}" -eq 0 ] || { printf '%s\n' "${removed_migrations[@]}" >&2; exit 1; }
for path in "${deployed_migrations[@]}"; do
  set +e
  deployed_blob=$(git rev-parse "$OCC_PREVIOUS_RELEASE_COMMIT:$path" 2>&1); deployed_blob_exit=$?
  target_blob=$(git rev-parse "$OCC_RELEASE_COMMIT:$path" 2>&1); target_blob_exit=$?
  set -e
  [ "$deployed_blob_exit" -eq 0 ] && [ "$target_blob_exit" -eq 0 ]
  [ "$deployed_blob" = "$target_blob" ] || { printf '已部署迁移被修改：%s\n' "$path" >&2; exit 1; }
done
comm -13 <(printf '%s\n' "${deployed_migrations[@]}") <(printf '%s\n' "${target_migrations[@]}") >"$release_evidence/migration-added.txt"
set +e
git diff --name-status "$OCC_PREVIOUS_RELEASE_COMMIT" "$OCC_RELEASE_COMMIT" -- database/migrations >"$release_evidence/migration-diff-name-status.txt" 2>&1
git_diff_exit=$?
set -e
[ "$git_diff_exit" -eq 0 ]
"${compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --csv --command "SELECT installed_rank,version,description,checksum,installed_by,success FROM flyway_schema_history ORDER BY installed_rank;"; status=$?; unset PGPASSWORD; exit $status' >"$release_evidence/flyway-before.csv"
```

任何已部署路径缺失会把删除和重命名都判为失败；同路径 blob 不同会判为修改。新增迁移只出现在 `migration-added.txt`。若目标数据库历史与 deployed revision 不一致、存在失败行、checksum 不符、目标源码缺少历史版本或 `installed_by` 异常，停止；不能仅凭文件名判断可逆。

迁移评审逐项记录：是否事务化；失败中间态；锁和预计时长；临时/永久磁盘；数据回填；新应用对旧 schema、旧应用对新 schema 是否兼容；是否删除/收紧字段、约束、权限或语义；前向修复；备份恢复触发点。任何“未知”都按不兼容处理。

## 备份检查点、容量和窗口

按[备份、恢复与灾难恢复](07-backup-restore-and-dr.md)创建升级前完整集合，验证 `COMPLETE`、checksum、PostgreSQL `pg_restore --list`、MinIO 清单，并引用最近一次隔离恢复。备份 metadata 的 source/deployed revision、change ID、结束 UTC 必须匹配本次变更及批准年龄窗口。若回滚政策要求主机损失后仍可取回，必须实时调用外部系统验证 off-host immutable/object-lock 或 detached signature；同主机 staging 和本机 checksum 不满足该政策。

```powershell
$ErrorActionPreference = 'Stop'
foreach ($name in 'COMPLETE','backup-artifacts.inventory','backup-manifest.sha256','backup-trust-status.txt','backup-policy-metadata.txt','backup-end-utc.txt') {
  if (-not (Test-Path -LiteralPath (Join-Path $BackupSet $name) -PathType Leaf)) { throw "备份集合缺少 $name" }
}
$backupTrustStatus = [IO.File]::ReadAllText((Join-Path $BackupSet 'backup-trust-status.txt')).Trim()
$backupControlFiles = @('backup-manifest.sha256','COMPLETE')
if ($backupTrustStatus -eq 'external-verification-required') { $backupControlFiles += 'external-trust-evidence.txt' }
$backupInventory = @(Get-Content -LiteralPath (Join-Path $BackupSet 'backup-artifacts.inventory'))
if ($backupInventory.Count -eq 0 -or (Compare-Object $backupInventory @($backupInventory | Sort-Object -Unique))) { throw '升级备份 artifact inventory 为空、重复或未排序' }
$actualBackupFiles = @(Get-ChildItem -LiteralPath $BackupSet -File -Recurse | ForEach-Object { $_.FullName.Substring($BackupSet.Length + 1).Replace('\','/') } | Sort-Object -Unique)
$allowedBackupFiles = @($backupInventory + $backupControlFiles | Sort-Object -Unique)
if (Compare-Object $allowedBackupFiles $actualBackupFiles) { throw '升级备份有缺失或未声明 artifact' }
$manifestEntries = @{}
Get-Content -LiteralPath (Join-Path $BackupSet 'backup-manifest.sha256') | ForEach-Object {
  if ($_ -notmatch '^([0-9a-f]{64})  (.+)$' -or $manifestEntries.ContainsKey($Matches[2])) { throw '升级备份 checksum 清单格式无效或路径重复' }
  $manifestEntries[$Matches[2]] = $Matches[1]
}
if (Compare-Object $backupInventory @($manifestEntries.Keys | Sort-Object)) { throw '升级备份 manifest 与 artifact inventory 不同' }
foreach ($entry in $manifestEntries.GetEnumerator()) {
  $path = Join-Path $BackupSet ($entry.Key.Replace('/','\'))
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "升级备份缺少 $($entry.Key)" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $entry.Value) { throw "升级备份 checksum 失败：$($entry.Key)" }
}
$requiredRecovery = @('postgresql-restore-list.txt','minio/source-objects.json','minio/source-object-count.txt','minio/minio-files.sha256','secret-escrow-receipt.txt','backup-policy-metadata.txt','backup-trust-status.txt')
foreach ($relative in $requiredRecovery) { if ($backupInventory -notcontains $relative) { throw "升级备份缺少恢复必需 artifact：$relative" } }
$backupMetadata = @{}
Get-Content -LiteralPath (Join-Path $BackupSet 'backup-policy-metadata.txt') | ForEach-Object { $parts=$_ -split '=',2; if ($parts.Count -ne 2 -or $backupMetadata.ContainsKey($parts[0])) { throw '升级备份政策元数据格式无效' }; $backupMetadata[$parts[0]]=$parts[1] }
$previousRevision = $env:OCC_PREVIOUS_RELEASE_COMMIT.ToLowerInvariant()
if ($backupMetadata['backup-source-revision'] -ne $previousRevision -or $backupMetadata['backup-deployed-revision'] -ne $previousRevision) { throw '备份 source/deployed revision 不是 pre-upgrade revision' }
if ($backupMetadata['backup-change-id'] -ne $env:OCC_CHANGE_ID) { throw '备份 change ID 与批准变更不匹配' }
$backupEndUtc = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($backupMetadata['backup-end-utc'],[ref]$backupEndUtc) -or $backupEndUtc.Offset -ne [TimeSpan]::Zero) { throw '备份结束 UTC 无效' }
if ([IO.File]::ReadAllText((Join-Path $BackupSet 'backup-end-utc.txt')).Trim() -ne $backupMetadata['backup-end-utc']) { throw '备份结束 UTC artifact 与政策元数据不同' }
$rollbackGateUtc = [DateTimeOffset]::UtcNow
if ($backupEndUtc -gt $rollbackGateUtc) { throw '备份结束时间在当前/rollout gate 之后' }
if ($backupEndUtc -lt $BackupEarliestUtc -or ($rollbackGateUtc - $backupEndUtc).TotalMinutes -gt $BackupMaxAgeMinutes) { throw '备份不在批准最早时间或最大年龄窗口内' }
if ($backupTrustStatus -eq 'external-verification-required') {
  foreach ($name in 'OCC_EXTERNAL_VERIFY_TOOL','OCC_EXTERNAL_RECORD_ID','OCC_EXTERNAL_RECORD_VERSION') { if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "外部备份重验缺少 $name" } }
  if ($backupMetadata['trust-mode'] -ne 'external-verified' -or $backupMetadata['fault-domain-status'] -ne 'off-host-immutable-copy' -or $backupMetadata['external-record-id'] -ne $env:OCC_EXTERNAL_RECORD_ID -or $backupMetadata['external-record-version'] -ne $env:OCC_EXTERNAL_RECORD_VERSION) { throw '外部备份 record/version 或 fault-domain 元数据不匹配' }
  $verifyTool = (Resolve-Path -LiteralPath $env:OCC_EXTERNAL_VERIFY_TOOL).Path
  $externalGateEvidence = & $verifyTool verify-manifest --manifest (Join-Path $BackupSet 'backup-manifest.sha256') --record-id $env:OCC_EXTERNAL_RECORD_ID --record-version $env:OCC_EXTERNAL_RECORD_VERSION --require-off-host-immutable 2>&1
  $externalGateExit = $LASTEXITCODE
  if ($externalGateExit -ne 0 -or @($externalGateEvidence).Count -eq 0) { throw '升级前外部 immutable/signature 重验失败' }
  if ([IO.File]::ReadAllText((Join-Path $BackupSet 'COMPLETE')).Trim() -ne 'external-verified-off-host-immutable') { throw '外部备份 COMPLETE 分类不一致' }
  $externalGateEvidence | Out-File (Join-Path $ReleaseEvidence 'backup-external-trust-gate.txt') -Encoding utf8
} elseif ($backupTrustStatus -eq 'local/internal-integrity-only') {
  if ($env:OCC_ROLLBACK_POLICY -ne 'local-integrity-allowed' -or $backupMetadata['trust-mode'] -ne 'internal-only' -or [IO.File]::ReadAllText((Join-Path $BackupSet 'COMPLETE')).Trim() -notmatch '^local/internal-integrity-only') { throw '回滚政策不允许或分类不接受本地内部完整性备份' }
} else { throw '未知备份 trust status' }
if ($env:OCC_ROLLBACK_POLICY -eq 'off-host-immutable-required' -and $backupTrustStatus -ne 'external-verification-required') { throw '回滚政策要求 off-host immutable 备份' }
[IO.File]::WriteAllText((Join-Path $ReleaseEvidence 'backup-gate-utc.txt'),($rollbackGateUtc.ToString('o') + "`r`n"),(New-Object Text.UTF8Encoding($false)))
$dumpRelatives = @($backupInventory | Where-Object { $_ -match '^occ-[^/]+\.dump$' })
if ($dumpRelatives.Count -ne 1) { throw '升级备份必须精确声明一个 PostgreSQL dump' }
$dumps = @(Get-Item -LiteralPath (Join-Path $BackupSet $dumpRelatives[0]))
if ($dumps[0].Length -eq 0 -or (Get-Item -LiteralPath (Join-Path $BackupSet 'postgresql-restore-list.txt')).Length -eq 0) { throw '升级备份 PostgreSQL artifact 为空' }
$minioCount = 0
if (-not [int]::TryParse([IO.File]::ReadAllText((Join-Path $BackupSet 'minio\source-object-count.txt')).Trim(),[ref]$minioCount) -or $minioCount -lt 0) { throw '升级备份 MinIO 对象计数无效' }
if (@(Get-Content -LiteralPath (Join-Path $BackupSet 'minio\source-objects.json')).Count -ne $minioCount) { throw '升级备份 MinIO 对象清单与计数不符' }
$minioObjectArtifacts = @($backupInventory | Where-Object { $_ -like 'minio/objects/*' })
$minioFileManifest = @(Get-Content -LiteralPath (Join-Path $BackupSet 'minio\minio-files.sha256'))
if ($minioFileManifest.Count -ne $minioObjectArtifacts.Count) { throw '升级备份 MinIO 文件 manifest 与 artifact 数量不符' }
$minioManifestArtifacts = @($minioFileManifest | ForEach-Object { if ($_ -notmatch '^[0-9a-f]{64}  (objects/.+)$') { throw '升级备份 MinIO 文件 manifest 行无效' }; "minio/$($Matches[1])" } | Sort-Object -Unique)
if (Compare-Object @($minioObjectArtifacts | Sort-Object -Unique) $minioManifestArtifacts) { throw '升级备份 MinIO 文件 manifest 路径集合不符' }
& docker run --rm --mount "type=bind,src=$BackupSet,dst=/backup,readonly" pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9 pg_restore --list "/backup/$($dumps[0].Name)"
if ($LASTEXITCODE -ne 0) { throw '升级备份 PostgreSQL 清单失败' }
Get-Volume | Select-Object DriveLetter,HealthStatus,Size,SizeRemaining | Out-File (Join-Path $ReleaseEvidence 'host-volumes.txt') -Encoding utf8
$dockerDfBefore = & docker system df -v 2>&1
$dockerDfBeforeExit = $LASTEXITCODE
if ($dockerDfBeforeExit -ne 0) { throw 'Docker 容量查询失败' }
$dockerDfBefore | Out-File (Join-Path $ReleaseEvidence 'docker-system-df-before.txt') -Encoding utf8
```

```bash
set -euo pipefail
for name in COMPLETE backup-artifacts.inventory backup-manifest.sha256 backup-trust-status.txt backup-policy-metadata.txt backup-end-utc.txt; do test -f "$backup_set/$name"; done
backup_trust_status=$(tr -d '\r\n' <"$backup_set/backup-trust-status.txt")
backup_controls=(backup-manifest.sha256 COMPLETE)
[ "$backup_trust_status" = external-verification-required ] && backup_controls+=(external-trust-evidence.txt)
mapfile -t backup_inventory <"$backup_set/backup-artifacts.inventory"
[ "${#backup_inventory[@]}" -gt 0 ]
mapfile -t sorted_inventory < <(printf '%s\n' "${backup_inventory[@]}" | sort -u)
diff -u <(printf '%s\n' "${backup_inventory[@]}") <(printf '%s\n' "${sorted_inventory[@]}")
mapfile -t actual_backup_files < <(find "$backup_set" -type f -printf '%P\n' | sort -u)
mapfile -t allowed_backup_files < <(printf '%s\n' "${backup_inventory[@]}" "${backup_controls[@]}" | sort -u)
diff -u <(printf '%s\n' "${allowed_backup_files[@]}") <(printf '%s\n' "${actual_backup_files[@]}")
mapfile -t manifest_paths < <(sed -n 's/^[0-9a-f]\{64\}  //p' "$backup_set/backup-manifest.sha256" | sort -u)
diff -u <(printf '%s\n' "${backup_inventory[@]}") <(printf '%s\n' "${manifest_paths[@]}")
(cd -- "$backup_set" && sha256sum --check backup-manifest.sha256)
for relative in postgresql-restore-list.txt minio/source-objects.json minio/source-object-count.txt minio/minio-files.sha256 secret-escrow-receipt.txt backup-policy-metadata.txt backup-trust-status.txt; do printf '%s\n' "${backup_inventory[@]}" | grep -Fqx "$relative"; done
declare -A backup_metadata=()
while IFS='=' read -r key value; do [ -n "$key" ] && [ -z "${backup_metadata[$key]+present}" ] || exit 1; backup_metadata[$key]=$value; done <"$backup_set/backup-policy-metadata.txt"
previous_revision=${OCC_PREVIOUS_RELEASE_COMMIT,,}
[ "${backup_metadata[backup-source-revision]:-}" = "$previous_revision" ] && [ "${backup_metadata[backup-deployed-revision]:-}" = "$previous_revision" ]
[ "${backup_metadata[backup-change-id]:-}" = "$OCC_CHANGE_ID" ]
[ "$(tr -d '\r\n' <"$backup_set/backup-end-utc.txt")" = "${backup_metadata[backup-end-utc]:-}" ]
set +e
backup_end_epoch=$(date -u -d "${backup_metadata[backup-end-utc]:-}" +%s 2>&1); backup_end_exit=$?
earliest_epoch=$(date -u -d "$OCC_BACKUP_EARLIEST_UTC" +%s 2>&1); earliest_exit=$?
set -e
[ "$backup_end_exit" -eq 0 ] && [ "$earliest_exit" -eq 0 ]
rollback_gate_epoch=$(date -u +%s)
[ "$backup_end_epoch" -le "$rollback_gate_epoch" ] && [ "$backup_end_epoch" -ge "$earliest_epoch" ]
[ $((rollback_gate_epoch - backup_end_epoch)) -le $((OCC_BACKUP_MAX_AGE_MINUTES * 60)) ]
case "$backup_trust_status" in
  external-verification-required)
    : "${OCC_EXTERNAL_VERIFY_TOOL:?必须设置外部验证工具}"; : "${OCC_EXTERNAL_RECORD_ID:?必须设置外部 record ID}"; : "${OCC_EXTERNAL_RECORD_VERSION:?必须设置外部 record version}"
    [ "${backup_metadata[trust-mode]:-}" = external-verified ] && [ "${backup_metadata[fault-domain-status]:-}" = off-host-immutable-copy ]
    [ "${backup_metadata[external-record-id]:-}" = "$OCC_EXTERNAL_RECORD_ID" ] && [ "${backup_metadata[external-record-version]:-}" = "$OCC_EXTERNAL_RECORD_VERSION" ]
    verify_tool=$(realpath "$OCC_EXTERNAL_VERIFY_TOOL")
    set +e
    external_gate_evidence=$("$verify_tool" verify-manifest --manifest "$backup_set/backup-manifest.sha256" --record-id "$OCC_EXTERNAL_RECORD_ID" --record-version "$OCC_EXTERNAL_RECORD_VERSION" --require-off-host-immutable 2>&1); external_gate_exit=$?
    set -e
    [ "$external_gate_exit" -eq 0 ] && [ -n "$external_gate_evidence" ]
    [ "$(tr -d '\r\n' <"$backup_set/COMPLETE")" = external-verified-off-host-immutable ]
    printf '%s\n' "$external_gate_evidence" >"$release_evidence/backup-external-trust-gate.txt"
    ;;
  local/internal-integrity-only)
    [ "$OCC_ROLLBACK_POLICY" = local-integrity-allowed ] && [ "${backup_metadata[trust-mode]:-}" = internal-only ]
    case "$(cat "$backup_set/COMPLETE")" in local/internal-integrity-only*) ;; *) exit 1;; esac
    ;;
  *) exit 1;;
esac
if [ "$OCC_ROLLBACK_POLICY" = off-host-immutable-required ]; then [ "$backup_trust_status" = external-verification-required ]; fi
date -u --iso-8601=seconds >"$release_evidence/backup-gate-utc.txt"
mapfile -t dump_relatives < <(printf '%s\n' "${backup_inventory[@]}" | grep -E '^occ-[^/]+\.dump$')
[ "${#dump_relatives[@]}" -eq 1 ]
dumps=("$backup_set/${dump_relatives[0]}")
test -s "${dumps[0]}" && test -s "$backup_set/postgresql-restore-list.txt"
minio_count=$(tr -d '\r\n' <"$backup_set/minio/source-object-count.txt")
[[ $minio_count =~ ^[0-9]+$ ]]
[ "$(wc -l <"$backup_set/minio/source-objects.json")" -eq "$minio_count" ]
mapfile -t minio_object_artifacts < <(printf '%s\n' "${backup_inventory[@]}" | grep '^minio/objects/' || true)
mapfile -t minio_file_manifest <"$backup_set/minio/minio-files.sha256"
[ "${#minio_object_artifacts[@]}" -eq "${#minio_file_manifest[@]}" ]
mapfile -t minio_manifest_artifacts < <(sed -n 's/^[0-9a-f]\{64\}  objects\//#minio/objects/#p' "$backup_set/minio/minio-files.sha256" | sort -u)
diff -u <(printf '%s\n' "${minio_object_artifacts[@]}") <(printf '%s\n' "${minio_manifest_artifacts[@]}")
docker run --rm --mount "type=bind,src=$backup_set,dst=/backup,readonly" pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9 pg_restore --list "/backup/$(basename "${dumps[0]}")" >"$release_evidence/pg-restore-list.txt"
df -hT >"$release_evidence/host-disk-before.txt"
df -ih >"$release_evidence/host-inode-before.txt"
docker system df -v >"$release_evidence/docker-system-df-before.txt"
```

变更审批人据 migration 评审、镜像构建峰值、数据库/对象增长和恢复演练确定空间与窗口。至少为新旧镜像、构建 cache、数据库迁移临时空间、日志和备份保留余量；不得在已超过[日常初始紧急阈值](06-daily-operations-and-monitoring.md)时开始。窗口剩余时间小于“停止+证据+批准恢复/前向修复”的实测时间时停止发布。

## 配置与凭据变更顺序

配置差异与代码一起评审，但 secret 值只在外部 escrow 比较版本引用，不进入 diff/证据。顺序取决于兼容性：

1. 先部署能同时接受旧/新配置或凭据的服务端能力。
2. 变更服务端凭据状态，再原子替换外部 secret 文件，再强制重建消费者；PostgreSQL、Redis、MinIO 使用[第 03 章协调轮换](03-secrets-and-configuration.md)，不能只改文件。
3. 验证新消费者后才撤销旧凭据；撤销是单独变更点，有回退材料。
4. 删除旧配置字段/凭据兼容只能在全部消费者验证后进行。

如果发布必须同时改变不兼容凭据和 schema，拆分变更；无法拆分则需要完整停机、逐步确认和经演练恢复，不得让旧 Core 接触新凭据/schema或新 Core接触旧不兼容配置。

## 构建前保留旧镜像与身份

构建四个本地服务会移动 Compose 默认 tag。先从运行容器读取实际 image ID，并为旧 ID 增加受控本地 rollback tag；tag 不复制镜像内容，但防止旧 ID 因悬空而难以选择。外部镜像由旧 commit 的 digest 识别。

```powershell
$ErrorActionPreference = 'Stop'
$LocalServices = 'opa','ai','core','host-gateway'
foreach ($service in $LocalServices) {
  $id = & docker @ComposeArgs ps -q $service
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($id)) { throw "$service 运行容器不存在" }
  $imageId = (& docker inspect --format '{{.Image}}' $id).Trim()
  if ($LASTEXITCODE -ne 0 -or $imageId -notmatch '^sha256:[0-9a-f]{64}$') { throw "$service image ID 无效" }
  $rollbackTag = "innorder-occ-rollback:$($env:OCC_CHANGE_ID)-$service"
  & docker image tag $imageId $rollbackTag
  if ($LASTEXITCODE -ne 0) { throw "$service 旧镜像保留 tag 失败" }
  "$service $imageId $rollbackTag" | Out-File (Join-Path $ReleaseEvidence 'images-before.txt') -Encoding ascii -Append
}
$composeImagesBefore = & docker @ComposeArgs images 2>&1
$composeImagesBeforeExit = $LASTEXITCODE
if ($composeImagesBeforeExit -ne 0) { throw '升级前镜像清单失败' }
$composeImagesBefore | Out-File (Join-Path $ReleaseEvidence 'compose-images-before.txt') -Encoding utf8
```

```bash
set -euo pipefail
local_services=(opa ai core host-gateway)
: >"$release_evidence/images-before.txt"
for service in "${local_services[@]}"; do
  id=$("${compose[@]}" ps -q "$service")
  [ -n "$id" ]
  image_id=$(docker inspect --format '{{.Image}}' "$id")
  [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]
  rollback_tag="innorder-occ-rollback:$OCC_CHANGE_ID-$service"
  docker image tag "$image_id" "$rollback_tag"
  printf '%s %s %s\n' "$service" "$image_id" "$rollback_tag" >>"$release_evidence/images-before.txt"
done
"${compose[@]}" images >"$release_evidence/compose-images-before.txt"
```

rollback tag 是主机本地证据，不是异地镜像供应链。批准 registry 应另行保存 release digest；主机丢失时必须能从可信 registry或相同 release commit 重建。

## 先构建、后发布与 digest 检查

```powershell
$ErrorActionPreference = 'Stop'
Invoke-ReleaseNative 'docker' ($ComposeArgs + @('pull','postgres','kafka','redis','minio-volume-init','minio','minio-init')) 'compose-pull-external.txt' '固定外部镜像拉取失败' | Out-Null
Invoke-ReleaseNative 'docker' ($ComposeArgs + @('build','--pull','opa','ai','core','host-gateway')) 'compose-build.txt' '四个本地服务构建失败' | Out-Null
Invoke-ReleaseNative 'docker' ($ComposeArgs + @('images')) 'compose-images-built.txt' '构建后镜像清单失败' | Out-Null
foreach ($service in 'opa','ai','core','host-gateway') {
  $imageId = (& docker @ComposeArgs images -q $service).Trim()
  if ($LASTEXITCODE -ne 0 -or $imageId -notmatch '^sha256:[0-9a-f]{64}$') { throw "$service 构建镜像 ID 无效" }
  "$service $imageId" | Out-File (Join-Path $ReleaseEvidence 'images-built-ids.txt') -Encoding ascii -Append
}
$configJson = & docker @ComposeArgs config --format json
if ($LASTEXITCODE -ne 0) { throw '无法读取 Compose 服务镜像配置' }
$rendered = $configJson | ConvertFrom-Json
$externalImages = foreach ($service in 'postgres','kafka','redis','minio-volume-init','minio','minio-init') { $rendered.services.$service.image }
if (@($externalImages).Count -ne 6 -or @($externalImages | Where-Object { $_ -notmatch '@sha256:[0-9a-f]{64}$' }).Count -ne 0) { throw '六个外部服务的固定 digest 镜像清单无效' }
foreach ($image in @($externalImages | Sort-Object -Unique)) {
  & docker image inspect $image *> $null
  if ($LASTEXITCODE -ne 0) { throw "固定镜像不存在或 digest 不匹配：$image" }
}
```

```bash
set -euo pipefail
"${compose[@]}" pull postgres kafka redis minio-volume-init minio minio-init >"$release_evidence/compose-pull-external.txt" 2>&1
"${compose[@]}" build --pull opa ai core host-gateway >"$release_evidence/compose-build.txt" 2>&1
"${compose[@]}" images >"$release_evidence/compose-images-built.txt"
: >"$release_evidence/images-built-ids.txt"
for service in opa ai core host-gateway; do
  image_id=$("${compose[@]}" images -q "$service")
  [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]
  printf '%s %s\n' "$service" "$image_id" >>"$release_evidence/images-built-ids.txt"
done
config_json=$("${compose[@]}" config --format json)
mapfile -t external_images < <(printf '%s' "$config_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);for(const n of ["postgres","kafka","redis","minio-volume-init","minio","minio-init"])console.log(c.services[n].image)})')
[ "${#external_images[@]}" -eq 6 ]
for image in "${external_images[@]}"; do [[ $image =~ @sha256:[0-9a-f]{64}$ ]]; done
for image in "${external_images[@]}"; do docker image inspect "$image" >/dev/null; done
```

构建失败不会改变运行容器；停止发布并保留构建日志，不执行 `up`。本地 image ID 与 release commit 一起构成构建身份；外部镜像必须保持可读 tag 加 `@sha256`，不能只比较 tag。

## 发布前静默与最终确认

通知窗口开始，阻止客户端新写入，记录当前检查和备份集合。停止 Core 产生全应用停机，但避免旧 Core 在基础服务变化期间继续访问，并把 Flyway 启动变成明确阶段。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_UPGRADE -ne 'UPGRADE_APPROVED') { throw '未批准升级执行' }
& docker @ComposeArgs stop core
if ($LASTEXITCODE -ne 0) { throw 'Core 静默失败；检查实际状态并停止' }
$coreId = & docker @ComposeArgs ps -a -q core
$coreState = & docker inspect --format '{{.State.Status}}' $coreId
if ($LASTEXITCODE -ne 0 -or $coreState -ne 'exited') { throw 'Core 未完全停止' }
[IO.File]::WriteAllText((Join-Path $ReleaseEvidence 'rollout-start-utc.txt'),((Get-Date).ToUniversalTime().ToString('o') + "`r`n"))
```

```bash
set -euo pipefail
: "${OCC_CONFIRM_UPGRADE:?必须设置确认值}"
[ "$OCC_CONFIRM_UPGRADE" = UPGRADE_APPROVED ]
"${compose[@]}" stop core
core_id=$("${compose[@]}" ps -a -q core)
[ "$(docker inspect --format '{{.State.Status}}' "$core_id")" = exited ]
date -u --iso-8601=seconds >"$release_evidence/rollout-start-utc.txt"
```

停止失败时不要继续基础服务或 migration。调查未知写入和容器状态；仅在恢复旧 Core 安全时 `start core` 并完整验收。

## 受控 Compose 发布

先协调不运行 Flyway 的基础/边界服务，再启动 Core。`minio` 通过正常 `depends_on` 处理 `minio-volume-init`；MinIO healthy 后必须强制重建当前 release 的 `minio-init`，并以新 container ID 的精确 `exited 0` 作为 Core 门禁。`--no-build` 保证使用已记录构建产物；不能把旧 one-shot 或 `up --wait` 的结果作为最终结论。

```powershell
$ErrorActionPreference = 'Stop'
& docker @ComposeArgs up -d --no-build postgres kafka redis minio opa ai host-gateway
if ($LASTEXITCODE -ne 0) { throw '非 Core 服务发布失败；保持 Core 停止并收集状态' }
foreach ($service in 'postgres','kafka','redis','minio','opa','ai','host-gateway') {
  $id = & docker @ComposeArgs ps -q $service
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($id)) { throw "$service 容器缺失" }
  $deadline = (Get-Date).AddMinutes(10)
  do {
    $state = & docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' $id
    if ($LASTEXITCODE -ne 0) { throw "$service inspect 失败" }
    if ($state -eq 'running healthy') { break }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  if ($state -ne 'running healthy') { throw "$service 未达到 running healthy：$state" }
}
$volumeInitId = & docker @ComposeArgs ps -a -q minio-volume-init
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($volumeInitId)) { throw '正常 MinIO 依赖未产生 minio-volume-init 容器' }
$volumeInitState = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}} created={{.Created}}' $volumeInitId
if ($LASTEXITCODE -ne 0 -or $volumeInitState -notmatch '^exited 0 created=') { throw "minio-volume-init 未成功完成：$volumeInitState" }
$oldMinioInitId = & docker @ComposeArgs ps -a -q minio-init
if ($LASTEXITCODE -ne 0) { throw '旧 minio-init ID 查询失败' }
& docker @ComposeArgs up -d --no-build --no-deps --force-recreate minio-init
if ($LASTEXITCODE -ne 0) { throw '当前 release minio-init 强制重建失败' }
$CurrentMinioInitId = & docker @ComposeArgs ps -a -q minio-init
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CurrentMinioInitId)) { throw '新 minio-init 容器不存在' }
if (-not [string]::IsNullOrWhiteSpace($oldMinioInitId) -and $CurrentMinioInitId -eq $oldMinioInitId) { throw 'minio-init container ID 未变化，拒绝接受旧 exited 0' }
$minioInitDeadline = (Get-Date).AddMinutes(5)
do {
  $minioInitState = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}} created={{.Created}}' $CurrentMinioInitId
  if ($LASTEXITCODE -ne 0) { throw '新 minio-init 状态查询失败' }
  if ($minioInitState -match '^exited ') { break }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $minioInitDeadline)
if ($minioInitState -notmatch '^exited 0 created=') { throw "新 minio-init 未精确 exited 0：$minioInitState" }
@("minio-volume-init $volumeInitId $volumeInitState","minio-init-old $oldMinioInitId","minio-init-current $CurrentMinioInitId $minioInitState") | Out-File (Join-Path $ReleaseEvidence 'minio-init-rollout.txt') -Encoding ascii
& docker @ComposeArgs up -d --no-build core
if ($LASTEXITCODE -ne 0) { throw 'Core 启动或迁移失败；保持窗口并进入迁移失败路径' }
```

```bash
set -euo pipefail
"${compose[@]}" up -d --no-build postgres kafka redis minio opa ai host-gateway
for service in postgres kafka redis minio opa ai host-gateway; do
  id=$("${compose[@]}" ps -q "$service")
  [ -n "$id" ]
  deadline=$((SECONDS + 600))
  while :; do
    state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$id")
    [ "$state" = 'running healthy' ] && break
    [ "$SECONDS" -lt "$deadline" ] || { printf '%s %s\n' "$service" "$state" >&2; exit 1; }
    sleep 5
  done
done
volume_init_id=$("${compose[@]}" ps -a -q minio-volume-init)
[ -n "$volume_init_id" ]
volume_init_state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} created={{.Created}}' "$volume_init_id")
case "$volume_init_state" in 'exited 0 created='*) ;; *) printf '%s\n' "$volume_init_state" >&2; exit 1;; esac
old_minio_init_id=$("${compose[@]}" ps -a -q minio-init)
"${compose[@]}" up -d --no-build --no-deps --force-recreate minio-init
current_minio_init_id=$("${compose[@]}" ps -a -q minio-init)
[ -n "$current_minio_init_id" ]
if [ -n "$old_minio_init_id" ]; then [ "$current_minio_init_id" != "$old_minio_init_id" ]; fi
minio_init_deadline=$((SECONDS + 300))
while :; do
  minio_init_state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} created={{.Created}}' "$current_minio_init_id")
  case "$minio_init_state" in exited\ *) break;; esac
  [ "$SECONDS" -lt "$minio_init_deadline" ] || { printf '%s\n' "$minio_init_state" >&2; exit 1; }
  sleep 2
done
case "$minio_init_state" in 'exited 0 created='*) ;; *) printf '%s\n' "$minio_init_state" >&2; exit 1;; esac
printf 'minio-volume-init %s %s\nminio-init-old %s\nminio-init-current %s %s\n' "$volume_init_id" "$volume_init_state" "$old_minio_init_id" "$current_minio_init_id" "$minio_init_state" >"$release_evidence/minio-init-rollout.txt"
"${compose[@]}" up -d --no-build core
```

`minio-volume-init` 由当前 MinIO 的正常依赖图执行/协调，并记录其 ID、创建时间和 `exited 0`；`minio-init` 无条件 force-recreate，旧 ID 不得复用。任何非零都先保存新容器日志，检查权限、桶和凭据，不改 restart policy 或无限重跑。

## 一次性任务、健康与发布后验收

Windows：

```powershell
$ErrorActionPreference = 'Stop'
$acceptedMinioInitId = & docker @ComposeArgs ps -a -q minio-init
if ($LASTEXITCODE -ne 0 -or $acceptedMinioInitId -ne $CurrentMinioInitId) { throw '验收时 minio-init 不是发布阶段记录的新容器' }
$acceptedMinioInitState = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' $acceptedMinioInitId
if ($LASTEXITCODE -ne 0 -or $acceptedMinioInitState -ne 'exited 0') { throw '新 minio-init 验收状态不是 exited 0' }
$acceptedVolumeInitId = & docker @ComposeArgs ps -a -q minio-volume-init
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($acceptedVolumeInitId)) { throw 'minio-volume-init 不存在' }
$acceptedVolumeInitState = & docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' $acceptedVolumeInitId
if ($LASTEXITCODE -ne 0 -or $acceptedVolumeInitState -ne 'exited 0') { throw 'minio-volume-init 不是 exited 0' }
foreach ($service in 'postgres','kafka','redis','minio','opa','ai','core','host-gateway') {
  $id = & docker @ComposeArgs ps -q $service
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($id)) { throw "$service 不存在" }
  $state = & docker inspect --format '{{.State.Status}} {{.State.Health.Status}} image={{.Image}} restarts={{.RestartCount}}' $id
  if ($LASTEXITCODE -ne 0 -or $state -notmatch '^running healthy ') { throw "$service 发布后不健康：$state" }
  $state | Out-File (Join-Path $ReleaseEvidence 'container-states-after.txt') -Encoding ascii -Append
}
$flywayAfter = & docker @ComposeArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --csv --command "SELECT installed_rank,version,description,checksum,installed_by,success FROM flyway_schema_history ORDER BY installed_rank;"; status=$?; unset PGPASSWORD; exit $status' 2>&1
$flywayAfterExit = $LASTEXITCODE
if ($flywayAfterExit -ne 0) { throw '发布后 Flyway 历史查询失败' }
$flywayAfter | Out-File (Join-Path $ReleaseEvidence 'flyway-after.csv') -Encoding utf8
```

Linux：

```bash
set -euo pipefail
accepted_minio_init_id=$("${compose[@]}" ps -a -q minio-init)
[ "$accepted_minio_init_id" = "$current_minio_init_id" ]
[ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$accepted_minio_init_id")" = 'exited 0' ]
accepted_volume_init_id=$("${compose[@]}" ps -a -q minio-volume-init)
[ -n "$accepted_volume_init_id" ]
[ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$accepted_volume_init_id")" = 'exited 0' ]
: >"$release_evidence/container-states-after.txt"
for service in postgres kafka redis minio opa ai core host-gateway; do
  id=$("${compose[@]}" ps -q "$service")
  state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}} image={{.Image}} restarts={{.RestartCount}}' "$id")
  case "$state" in 'running healthy '*) ;; *) printf '%s %s\n' "$service" "$state" >&2; exit 1;; esac
  printf '%s %s\n' "$service" "$state" >>"$release_evidence/container-states-after.txt"
done
"${compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"; psql --host 127.0.0.1 --username innorder_admin --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --csv --command "SELECT installed_rank,version,description,checksum,installed_by,success FROM flyway_schema_history ORDER BY installed_rank;"; status=$?; unset PGPASSWORD; exit $status' >"$release_evidence/flyway-after.csv"
```

随后执行[第 06 章](06-daily-operations-and-monitoring.md)的有效端口 HTTP/TCP/协议检查：Core readiness/status、AI health/status、OPA、MinIO、八个回环 TCP、PostgreSQL runtime、Redis PING、Kafka topic-list。检查 `APP_VERSION` 与变更记录，镜像 ID 与 `images-built-ids.txt`，全部历史和新增 Flyway 版本均 success 且 `installed_by=innorder_flyway`，已部署迁移 checksum 未漂移。Core readiness 仍只证明 `ping`/`db`，不能替代依赖检查。

以下发布内检查使用容器内部协议；它不能替代第 06 章对八个主机回环端口和 host-gateway 路径的检查。Windows 每条原生命令立即检查退出码：

```powershell
$ErrorActionPreference = 'Stop'
& docker @ComposeArgs exec -T core curl -fsS http://localhost:8080/actuator/health/readiness
if ($LASTEXITCODE -ne 0) { throw 'Core readiness 发布后检查失败' }
& docker @ComposeArgs exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"; psql --host 127.0.0.1 --username innorder_runtime --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT current_user, current_database();"; status=$?; unset PGPASSWORD; exit $status'
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL runtime 发布后协议检查失败' }
& docker @ComposeArgs exec -T redis sh -ec 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; redis-cli --no-auth-warning PING | grep -q PONG; status=$?; unset REDISCLI_AUTH; exit $status'
if ($LASTEXITCODE -ne 0) { throw 'Redis 发布后协议检查失败' }
& docker @ComposeArgs exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
if ($LASTEXITCODE -ne 0) { throw 'Kafka 发布后协议检查失败' }
& docker @ComposeArgs exec -T minio curl -fsS http://localhost:9000/minio/health/ready
if ($LASTEXITCODE -ne 0) { throw 'MinIO 发布后 readiness 检查失败' }
```

Linux：

```bash
set -euo pipefail
"${compose[@]}" exec -T core curl -fsS http://localhost:8080/actuator/health/readiness
"${compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"; psql --host 127.0.0.1 --username innorder_runtime --dbname "$POSTGRES_DB" --no-password --set ON_ERROR_STOP=1 --command "SELECT current_user, current_database();"; status=$?; unset PGPASSWORD; exit $status'
"${compose[@]}" exec -T redis sh -ec 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; redis-cli --no-auth-warning PING | grep -q PONG; status=$?; unset REDISCLI_AUTH; exit $status'
"${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
"${compose[@]}" exec -T minio curl -fsS http://localhost:9000/minio/health/ready
```

观察期内按需要重复日志、restart count、CPU/内存、磁盘/inode和卷增长。没有真实业务工作流时，验收结论必须写“平台状态与依赖边界通过”，不能写“业务交易通过”。

## 失败路径

### 构建失败

运行环境未改变。停止发布，保留 release commit、安装/验证/构建日志、磁盘和镜像清单。修复源码/来源/容量后生成新 release commit 或按审批重跑同一可复现 commit；不得在运行主机手改产物。

### 非 Core 服务启动失败

Core 已静默。保存 `ps -a`、目标及依赖日志、image ID、health 输出和主机资源。若数据库 migration 尚未开始，可把受影响本地镜像 tag 指回 `images-before.txt` 的保留镜像，或从 previous release commit 恢复外部 digest，然后 `up -d --no-build` 并完整验收。不得删除卷或运行 prune。

### Core 启动但 migration 未开始

从 Core 日志和 `flyway_schema_history` 证明没有新 migration 行或 schema 改变；只有 DBA 确认后才允许旧 Core 镜像回滚。证据不充分按“migration 已开始”处理。

### migration 开始或失败

立即停止 Core 重启循环：

```powershell
& docker @ComposeArgs stop core
if ($LASTEXITCODE -ne 0) { throw '停止 Core 失败；升级数据库事件' }
$migrationFailureLogs = & docker @ComposeArgs logs --no-color --timestamps --tail 2000 core postgres 2>&1
$migrationFailureLogsExit = $LASTEXITCODE
if ($migrationFailureLogsExit -ne 0) { throw '迁移失败日志收集失败' }
$migrationFailureLogs | Out-File (Join-Path $ReleaseEvidence 'migration-failure-review-required.txt') -Encoding utf8
```

```bash
set -euo pipefail
"${compose[@]}" stop core
"${compose[@]}" logs --no-color --timestamps --tail 2000 core postgres >"$release_evidence/migration-failure-review-required.txt" 2>&1
```

保存数据库当前逻辑备份作为故障现场、升级前备份、Flyway 前后历史、失败 SQL/异常、schema/owner 和磁盘。Flyway 事务性取决于具体语句，不能假定失败已完全回滚。

可选路径只有：

1. 根因不改变已应用 migration 内容时，修复环境/权限/空间并重启同一新 Core继续，由 DBA批准。
2. 发布新的、更高版本前向修复 migration，不编辑失败前已成功应用文件；先在升级前备份的隔离恢复中演练。
3. DBA和数据所有者批准恢复升级前完整备份，接受恢复点之后的数据损失；先按第 07 章隔离恢复并验收，再切换。

旧应用回滚只有兼容矩阵明确允许时可用；不可逆 schema 下禁止旧 Core连接数据库。不得 `flyway repair`、删除历史行或手工反向 DDL作为现场快捷方式，除非该精确操作本身是已评审、备份并演练的恢复方案。

## 应用/镜像回滚执行

此路径只适用于：migration 未开始，或 DBA书面确认当前 schema 与 previous app 兼容。**影响：** 替换四个本地服务并中断连接。**备份：** 升级前完整集合和当前故障现场备份均可用。**确认：** `OCC_CONFIRM_IMAGE_ROLLBACK=ROLLBACK_APPROVED_SCHEMA_COMPATIBLE`。**验证：** 旧 image ID、八 healthy、两 one-shot、Flyway history 未被旧应用改变、HTTP/TCP/协议。**恢复：** 回滚失败时保持 Core停止，重新指向新 release 镜像或进入数据库恢复/前向修复决定。

下面把保留 rollback tag 重新指向 Compose 的四个默认本地镜像名；先通过 `docker compose config --images` 在当前主机确认名称精确匹配。当前 project `innorder-occ` 的预期名为 `innorder-occ-opa`、`innorder-occ-ai`、`innorder-occ-core`、`innorder-occ-host-gateway`。

```powershell
$ErrorActionPreference = 'Stop'
if ($env:OCC_CONFIRM_IMAGE_ROLLBACK -ne 'ROLLBACK_APPROVED_SCHEMA_COMPATIBLE') { throw '未批准 schema 兼容的镜像回滚' }
$map = [ordered]@{ opa='innorder-occ-opa:latest'; ai='innorder-occ-ai:latest'; core='innorder-occ-core:latest'; 'host-gateway'='innorder-occ-host-gateway:latest' }
foreach ($entry in $map.GetEnumerator()) {
  $source = "innorder-occ-rollback:$($env:OCC_CHANGE_ID)-$($entry.Key)"
  & docker image inspect $source *> $null
  if ($LASTEXITCODE -ne 0) { throw "缺少回滚镜像 $source" }
  & docker image tag $source $entry.Value
  if ($LASTEXITCODE -ne 0) { throw "$($entry.Key) 回滚 tag 设置失败" }
}
& docker @ComposeArgs up -d --no-build --no-deps --force-recreate opa ai host-gateway
if ($LASTEXITCODE -ne 0) { throw '非 Core 镜像回滚失败；保持 Core 停止' }
& docker @ComposeArgs up -d --no-build --no-deps --force-recreate core
if ($LASTEXITCODE -ne 0) { throw 'Core 镜像回滚失败；停止 Core并升级' }
Remove-Item Env:OCC_CONFIRM_IMAGE_ROLLBACK
```

```bash
set -euo pipefail
: "${OCC_CONFIRM_IMAGE_ROLLBACK:?必须设置确认值}"
[ "$OCC_CONFIRM_IMAGE_ROLLBACK" = ROLLBACK_APPROVED_SCHEMA_COMPATIBLE ]
for item in opa:innorder-occ-opa ai:innorder-occ-ai core:innorder-occ-core host-gateway:innorder-occ-host-gateway; do
  service=${item%%:*}; target=${item##*:}
  source="innorder-occ-rollback:$OCC_CHANGE_ID-$service"
  docker image inspect "$source" >/dev/null
  docker image tag "$source" "$target:latest"
done
"${compose[@]}" up -d --no-build --no-deps --force-recreate opa ai host-gateway
"${compose[@]}" up -d --no-build --no-deps --force-recreate core
unset OCC_CONFIRM_IMAGE_ROLLBACK
```

若 compose image name 与预期不一致，停止并使用 `config --images` 的实际受评审名称更新操作票；不要猜 tag。外部 PostgreSQL/Kafka/Redis/MinIO 镜像也发生变化时，必须使用 previous release commit 中的固定 digest并完成数据格式兼容评审，不能仅回退四个本地镜像。

## 回滚决策矩阵

| 情况 | 应用/镜像回滚 | 配置回退 | 数据库动作 | 决策 |
|---|---|---|---|---|
| 构建/验证失败，未 rollout | 不需要 | 不需要 | 无 | 修复后重新发布 |
| 非 Core 启动失败，migration 未开始 | 可回退受影响镜像 | 兼容且有旧文件/服务端状态时可 | 无 | 发布负责人批准 |
| Core 失败，已证明 migration 未开始 | 可，仍需 schema兼容确认 | 按协调顺序 | 无 | 发布负责人+DBA |
| 新 migration 全成功且双向兼容 | 可在观察期回退 app | 仅兼容变更 | 保留 schema | DBA书面确认 |
| 新 migration 成功但旧 app 不兼容 | 禁止 | 不能靠配置解决 | 前向修复或批准备份恢复 | DBA+数据所有者+审批人 |
| migration 部分失败/状态未知 | 禁止直接启动旧 app | 冻结 | 现场备份后前向修复或批准恢复 | 数据库事件 |
| 凭据部分轮换 | 仅镜像回滚通常无效 | 按第 03 章恢复服务端和文件 | 视组件而定 | 安全/组件所有者 |
| 发布后出现数据差异 | 停止双方写入 | 冻结 | 保留两时点，分析前向修复/恢复 | 数据所有者主导 |
| 外部镜像数据格式升级 | 仅 app 回滚不足 | 不适用 | 按组件兼容与恢复演练 | 组件所有者+DBA |

“回滚更快”不能覆盖数据正确性。窗口压力下若兼容性未知，保持停机并升级，比让旧应用写入不兼容 schema更安全。

## 预演、恢复彩排与凭据彩排

生产变更前在独立 project/端口执行：从升级前备份隔离恢复 previous release -> 记录基线 -> 应用目标 release和 migration -> 完整验收 -> 按矩阵执行计划回退或前向修复。数据量、对象数、CPU/内存/磁盘和工具版本应代表生产；没有代表性时明确风险。

涉及凭据时使用独立 staged secret，不复制生产值到普通测试环境。演练必须证明服务端状态、secret 文件原子替换、消费者重建、旧凭据撤销和回退顺序。涉及不可逆 migration 时至少演练升级前完整备份恢复，记录实测时间和允许数据损失。

升级、回滚或保持停机的正式决定及证据关闭后，Windows 执行 `$LifecycleLock.Dispose()`，Linux 执行 `flock -u "$lifecycle_lock_fd"; exec {lifecycle_lock_fd}>&-`。失败时退出当前进程由操作系统释放；不得提前释放后继续执行 Compose 变更。

## 证据、自检与静默失败审查

发布证据至少包括：变更记录、两个 commit、干净状态、安装/provenance、`verify:full`、Compose config、migration diff/Flyway 前后、备份集合与恢复演练、容量、构建日志、旧/新 image ID/digest、rollout 时间、两 one-shot/八健康、HTTP/TCP/协议、日志、停止/继续/回滚决定和通讯。

对每条原生命令审查：PowerShell 是否紧跟读取 `$LASTEXITCODE`，是否在管道/`Out-File` 后错误读取了另一个命令状态；Bash 是否使用 `set -euo pipefail`，预期无匹配是否显式处理；命令替换是否会把失败吞掉；空容器 ID/空镜像清单是否被检查；支持包是否只有所有收集成功才标记完成。任何“输出为空但退出零”的路径都要有数量/格式断言。

日志和 `docker inspect` 可能含路径、环境或数据。普通发布证据只收集本文限定字段；完整 inspect、`.env`、secret、认证头、shell history和客户对象不进入证据。移交前不可逆脱敏并二次复核。

## 观察、关闭与复盘

发布成功后在变更单定义的观察期按[第 06 章初始阈值](06-daily-operations-and-monitoring.md)跟踪健康、restart、日志、CPU/内存、磁盘/inode、卷增长和备份。阈值需要按工作负载调优，不是 SLA。观察期内不要删除 rollback tag、旧 release镜像或升级前备份。

关闭条件：目标 commit/image ID一致；全部历史及新增 migration 均 success且 owner正确；两 one-shot/八服务、HTTP/TCP/协议通过；配置/凭据状态一致；新备份完成；告警无未解释异常；用户/值班沟通完成；风险、证据和保留到期已记录。写入 `COMPLETE` 前由另一名操作员复核证据；`COMPLETE` 不替代脱敏。

每次失败、回滚、migration超时或阈值越界都做无责事实复盘：时间线、检测来源、影响、决策依据、停止条件是否有效、恢复点和实际RPO/RTO、根因/促成因素、哪些检查静默失败、为何预演未发现、改进责任人/期限。回滚成功也不等于事件关闭；必须确认数据、凭据、schema、镜像、备份和监控均处于一个可支持基线。
