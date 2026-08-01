# 密钥与配置管理

本章给出当前 Compose 所需的八个文件型密钥、`.env.example` 的全部变量与默认值、权限、生成、验证和协调轮换方法。`.env` 只能保存密钥文件路径及非敏感覆盖值，不能保存密钥内容。

## 配置模型

Compose 从 `infra/compose/.env` 插值，八个必填变量使用 `${VAR:?message}`，未设置或空值会使配置失败。其余变量使用 `${VAR:-default}`，未设置或空字符串都采用 Compose 默认值。

**安全：** 密钥文件位于仓库外；每个文件只包含一个部署专用非空值，不带引号。文件路径应为稳定的绝对路径。

## `.env.example` 全部变量与默认值

### 八个必填密钥路径

| 变量 | `.env.example` 值 | Compose 行为 |
|---|---|---|
| `POSTGRES_ADMIN_PASSWORD_FILE` | 空 | 必填，无默认值 |
| `POSTGRES_FLYWAY_PASSWORD_FILE` | 空 | 必填，无默认值 |
| `POSTGRES_RUNTIME_PASSWORD_FILE` | 空 | 必填，无默认值 |
| `REDIS_PASSWORD_FILE` | 空 | 必填，无默认值 |
| `MINIO_ROOT_USER_FILE` | 空 | 必填，无默认值 |
| `MINIO_ROOT_PASSWORD_FILE` | 空 | 必填，无默认值 |
| `MINIO_APP_USER_FILE` | 空 | 必填，无默认值 |
| `MINIO_APP_PASSWORD_FILE` | 空 | 必填，无默认值 |

### 十二个可选非敏感覆盖

| 变量 | `.env.example` 值 | 空值时 Compose 默认 | 目标 |
|---|---|---|---|
| `POSTGRES_DB` | 空 | `innorder_occ` | PostgreSQL 数据库名和 Core JDBC URL |
| `POSTGRES_PORT` | 空 | `5432` | 主机 PostgreSQL 回环端口、Kafka 广告无关 |
| `KAFKA_PORT` | 空 | `9092` | 主机 Kafka 回环端口和 external advertised listener |
| `REDIS_PORT` | 空 | `6379` | 主机 Redis 回环端口 |
| `MINIO_API_PORT` | 空 | `9000` | 主机 MinIO API 回环端口 |
| `MINIO_CONSOLE_PORT` | 空 | `9001` | 主机 MinIO Console 回环端口 |
| `OPA_PORT` | 空 | `8181` | 主机 OPA 回环端口 |
| `AI_PORT` | 空 | `3100` | 主机 AI 回环端口 |
| `CORE_PORT` | 空 | `8080` | 主机 Core 回环端口 |
| `AI_LOG_LEVEL` | 空 | `info` | AI `LOG_LEVEL` |
| `APP_VERSION` | 空 | `0.1.0` | Core 版本和 AI `npm_package_version` |
| `OBJECT_STORAGE_BUCKET` | 空 | `innorder-occ` | MinIO 初始化桶和 Core 桶名 |

`SERVER_PORT` 在 Compose 内固定为 Core 容器端口 `8080`；AI `PORT` 固定为 `3100`。主机覆盖只改变网关发布端口，不改变这些容器端口。`APP_VERSION` 是状态/版本标识，不会替换镜像 tag 或 digest。`AI_LOG_LEVEL` 增大日志量时必须同步容量和敏感信息审查。

桶名必须为小写 S3 风格名称，不得以点开头或结尾，只能使用小写字母、数字、点和连字符。更改桶名不会迁移旧桶中的对象。

## 八个文件、唯一性和消费者

| 主机文件用途 | Compose secret | 消费者 | 最终目标 |
|---|---|---|---|
| PostgreSQL admin 密码 | `postgres_admin_password` | `postgres` | `/run/secrets/postgres_admin_password` |
| PostgreSQL Flyway 密码 | `postgres_flyway_password` | `postgres`、`core` | 初始化文件；`spring.flyway.password` |
| PostgreSQL runtime 密码 | `postgres_runtime_password` | `postgres`、`core` | 初始化文件；`spring.datasource.password` |
| Redis 密码 | `redis_password` | `redis`、`core` | Redis 文件；`spring.data.redis.password` |
| MinIO root 用户名 | `minio_root_user` | `minio`、`minio-init` | `/run/secrets/minio_root_user` |
| MinIO root 密码 | `minio_root_password` | `minio`、`minio-init` | `/run/secrets/minio_root_password` |
| MinIO 应用用户名 | `minio_app_user` | `minio-init`、`core` | 初始化文件；`occ.object-storage.access-key` |
| MinIO 应用密码 | `minio_app_password` | `minio-init`、`core` | 初始化文件；`occ.object-storage.secret-key` |

唯一性规则：

- 三个 PostgreSQL 密码必须两两不同；初始化脚本会强制检查。
- MinIO root 用户名与应用用户名必须不同。
- MinIO root 密码与应用密码必须不同。
- 运维基线要求八个值全部独立，禁止跨 PostgreSQL、Redis 和 MinIO 复用。
- 用户名也按不可猜测密钥保管，不写入工单或命令历史。

## 安全创建目录和权限

### Windows PowerShell 5.1

由部署账号在仓库外的持久本地文件系统创建目录：

```powershell
$secretRoot = $env:OCC_SECRET_ROOT
if ([string]::IsNullOrWhiteSpace($secretRoot)) { throw '必须设置 OCC_SECRET_ROOT' }
if (-not [System.IO.Path]::IsPathRooted($secretRoot)) { throw 'OCC_SECRET_ROOT 必须是绝对路径' }
New-Item -ItemType Directory -Path $secretRoot -ErrorAction Stop | Out-Null
icacls.exe $secretRoot /inheritance:r
icacls.exe $secretRoot /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
icacls.exe $secretRoot
```

如果 Docker Engine 由不同服务身份读取文件，只增加该明确身份的读取权限。不要授予 `Users`、`Authenticated Users` 或 `Everyone`。创建文件后再次移除继承并核对 ACL：

```powershell
Get-ChildItem -LiteralPath $secretRoot -File | ForEach-Object {
  icacls.exe $_.FullName /inheritance:r
  icacls.exe $_.FullName /grant:r "$($env:USERNAME):F" 'SYSTEM:F' '*S-1-5-32-544:F'
}
Get-Acl $secretRoot | Format-List Owner, AccessToString, AreAccessRulesProtected
```

### Linux Bash

```bash
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
secret_root=$OCC_SECRET_ROOT
case "$secret_root" in /*) ;; *) printf '必须使用绝对路径\n' >&2; exit 1;; esac
umask 077
install -d -m 0700 "$secret_root"
chown "$(id -u):$(id -g)" "$secret_root"
stat -c '%U:%G %a %n' "$secret_root"
```

生成后执行：

```bash
find "$secret_root" -maxdepth 1 -type f -exec chmod 0600 {} +
find "$secret_root" -maxdepth 1 -type f -exec stat -c '%U:%G %a %n' {} +
```

SELinux/AppArmor 或 rootless Docker 环境还需验证 Engine 对文件的实际只读访问；不得用 `chmod 644` 解决挂载问题。

## 直接写文件的密码学生成

以下方法不把值输出到终端，不把值写入 shell 历史。运行前关闭命令追踪；不要在调试器、录屏或会记录进程环境的包装器中执行。

### Windows PowerShell 5.1

```powershell
$secretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
$spec = @(
  @('postgres-admin-password', 32)
  @('postgres-flyway-password', 32)
  @('postgres-runtime-password', 32)
  @('redis-password', 32)
  @('minio-root-user', 10)
  @('minio-root-password', 32)
  @('minio-app-user', 10)
  @('minio-app-password', 32)
)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$encoding = New-Object System.Text.UTF8Encoding($false)
try {
  foreach ($entry in $spec) {
    $bytes = [byte[]]::new([int]$entry[1])
    $rng.GetBytes($bytes)
    $value = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [System.IO.File]::WriteAllText((Join-Path $secretRoot $entry[0]), $value, $encoding)
    [Array]::Clear($bytes, 0, $bytes.Length)
    $value = $null
  }
} finally {
  $rng.Dispose()
}
```

### Linux Bash

```bash
set +x
umask 077
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
secret_root=$(realpath "$OCC_SECRET_ROOT")
openssl rand -hex 32 >"$secret_root/postgres-admin-password"
openssl rand -hex 32 >"$secret_root/postgres-flyway-password"
openssl rand -hex 32 >"$secret_root/postgres-runtime-password"
openssl rand -hex 32 >"$secret_root/redis-password"
openssl rand -hex 10 >"$secret_root/minio-root-user"
openssl rand -hex 32 >"$secret_root/minio-root-password"
openssl rand -hex 10 >"$secret_root/minio-app-user"
openssl rand -hex 32 >"$secret_root/minio-app-password"
chmod 0600 "$secret_root"/*
```

**验证：** 预期文件名必须精确匹配以下八个名称，不能有缺项、额外项、目录或符号链接：`postgres-admin-password`、`postgres-flyway-password`、`postgres-runtime-password`、`redis-password`、`minio-root-user`、`minio-root-password`、`minio-app-user`、`minio-app-password`。每个文件只能有一个非空逻辑值；拒绝首尾空白、换行形成的多行值以及首尾单引号/双引号。两个 MinIO 用户名至少 16 个字符，六个密码至少 32 个字符；八个值全部互异。检查只输出通过结论，不输出值或散列。

Windows 目录与文件 ACL 应关闭继承，只允许当前部署身份、`SYSTEM` 和本机 Administrators；目录可由当前身份或本机 Administrators 所有。若 Docker 使用另一个已批准服务 SID，应先将该 SID 加入脚本的允许列表并记录审批，不能放宽为普通用户组。

```powershell
$ErrorActionPreference = 'Stop'
$secretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
$expectedNames = @('postgres-admin-password','postgres-flyway-password','postgres-runtime-password','redis-password','minio-root-user','minio-root-password','minio-app-user','minio-app-password')
$minimumLengths = @(32,32,32,32,16,32,16,32)
$minimumByName = @{}
for ($index = 0; $index -lt $expectedNames.Count; $index++) { $minimumByName[$expectedNames[$index]] = $minimumLengths[$index] }
$entries = @(Get-ChildItem -LiteralPath $secretRoot -Force)
if ($entries.Count -ne 8 -or (Compare-Object $expectedNames @($entries.Name))) { throw '密钥目录必须精确包含八个预期文件' }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$systemSid = 'S-1-5-18'
$adminSid = 'S-1-5-32-544'
$allowedSids = @($currentSid, $systemSid, $adminSid)
$allowedOwnerSids = @($currentSid, $adminSid)
$directoryAcl = Get-Acl -LiteralPath $secretRoot
$directoryOwnerSid = $directoryAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if (-not $directoryAcl.AreAccessRulesProtected -or $allowedOwnerSids -notcontains $directoryOwnerSid) { throw '密钥目录 ACL 继承或所有者不符合要求' }
$directoryAllowSids = @($directoryAcl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
if ($directoryAllowSids | Where-Object { $allowedSids -notcontains $_ }) { throw '密钥目录向未批准身份授予访问' }
foreach ($sid in $allowedSids) { if ($directoryAllowSids -notcontains $sid) { throw '密钥目录缺少批准 ACL' } }
$hashes = New-Object System.Collections.Generic.List[string]
$sha = [Security.Cryptography.SHA256]::Create()
try {
  foreach ($name in $expectedNames) {
    $path = Join-Path $secretRoot $name
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$name 不是普通文件" }
    $value = [IO.File]::ReadAllText($path)
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]' -or $value -ne $value.Trim()) { throw "$name 必须只有一个无首尾空白的非空值" }
    if ($value.StartsWith("'") -or $value.EndsWith("'") -or $value.StartsWith('"') -or $value.EndsWith('"')) { throw "$name 不能带包围引号" }
    if ($value.Length -lt $minimumByName[$name]) { throw "$name 长度低于基线" }
    $acl = Get-Acl -LiteralPath $path
    if (-not $acl.AreAccessRulesProtected) { throw "$name 仍继承 ACL" }
    $allowSids = @($acl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
    if ($allowSids | Where-Object { $allowedSids -notcontains $_ }) { throw "$name 向未批准身份授予访问" }
    foreach ($sid in $allowedSids) { if ($allowSids -notcontains $sid) { throw "$name 缺少批准 ACL" } }
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))
    $hashes.Add([BitConverter]::ToString($digest).Replace('-', ''))
    $value = $null
  }
} finally {
  $sha.Dispose()
}
if (($hashes | Sort-Object -Unique).Count -ne 8) { throw '八个密钥值必须全部互异' }
Write-Output '八个 Windows 密钥文件及 ACL 验证通过'
```

```bash
set -euo pipefail
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
secret_root=$(realpath "$OCC_SECRET_ROOT")
expected=(postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password)
minimum=(32 32 32 32 16 32 16 32)
test "$(stat -c '%u' "$secret_root")" -eq "$(id -u)"
test "$(stat -c '%a' "$secret_root")" = 700
mapfile -t entries < <(find "$secret_root" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
mapfile -t wanted < <(printf '%s\n' "${expected[@]}" | sort)
test "${#entries[@]}" -eq 8
test "$(printf '%s\n' "${entries[@]}")" = "$(printf '%s\n' "${wanted[@]}")"
hashes=()
for index in "${!expected[@]}"; do
  path="$secret_root/${expected[$index]}"
  test -f "$path"
  test ! -L "$path"
  test "$(stat -c '%u' "$path")" -eq "$(id -u)"
  test "$(stat -c '%a' "$path")" = 600
  test "$(awk 'END { print NR }' "$path")" -eq 1
  IFS= read -r value <"$path" || test -n "$value"
  test -n "$value"
  trimmed=$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  test "$value" = "$trimmed"
  case "$value" in \"*|*\"|\'*|*\') exit 1;; esac
  test "${#value}" -ge "${minimum[$index]}"
  # Hash the logical value after read removed the single accepted terminal newline.
  hashes+=("$(printf '%s' "$value" | sha256sum | awk '{print $1}')")
  unset value trimmed
done
test "$(printf '%s\n' "${hashes[@]}" | sort -u | wc -l)" -eq 8
printf '八个 Linux 密钥文件、所有者和 0600 权限验证通过\n'
```

散列也属于敏感元数据，不应打印或长期写入普通工单。Compose `config` 只完成插值和结构渲染，不证明这些源文件存在、是普通文件、内容有效或权限安全；必须先运行本节验证。

## 只用路径创建 `.env`

先确认 `infra/compose/.env` 被版本控制忽略。脚本只写绝对路径和空的非敏感覆盖，不读取或复制密钥值。

### Windows PowerShell 5.1

```powershell
$secretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
$lines = @(
  'POSTGRES_ADMIN_PASSWORD_FILE=' + (Join-Path $secretRoot 'postgres-admin-password')
  'POSTGRES_FLYWAY_PASSWORD_FILE=' + (Join-Path $secretRoot 'postgres-flyway-password')
  'POSTGRES_RUNTIME_PASSWORD_FILE=' + (Join-Path $secretRoot 'postgres-runtime-password')
  'REDIS_PASSWORD_FILE=' + (Join-Path $secretRoot 'redis-password')
  'MINIO_ROOT_USER_FILE=' + (Join-Path $secretRoot 'minio-root-user')
  'MINIO_ROOT_PASSWORD_FILE=' + (Join-Path $secretRoot 'minio-root-password')
  'MINIO_APP_USER_FILE=' + (Join-Path $secretRoot 'minio-app-user')
  'MINIO_APP_PASSWORD_FILE=' + (Join-Path $secretRoot 'minio-app-password')
  'POSTGRES_DB='
  'POSTGRES_PORT='
  'KAFKA_PORT='
  'REDIS_PORT='
  'MINIO_API_PORT='
  'MINIO_CONSOLE_PORT='
  'OPA_PORT='
  'AI_PORT='
  'CORE_PORT='
  'AI_LOG_LEVEL='
  'APP_VERSION='
  'OBJECT_STORAGE_BUCKET='
)
[System.IO.File]::WriteAllLines('infra/compose/.env', $lines, (New-Object System.Text.UTF8Encoding($false)))
```

### Linux Bash

```bash
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
secret_root=$(realpath "$OCC_SECRET_ROOT")
umask 077
{
  printf 'POSTGRES_ADMIN_PASSWORD_FILE=%s/postgres-admin-password\n' "$secret_root"
  printf 'POSTGRES_FLYWAY_PASSWORD_FILE=%s/postgres-flyway-password\n' "$secret_root"
  printf 'POSTGRES_RUNTIME_PASSWORD_FILE=%s/postgres-runtime-password\n' "$secret_root"
  printf 'REDIS_PASSWORD_FILE=%s/redis-password\n' "$secret_root"
  printf 'MINIO_ROOT_USER_FILE=%s/minio-root-user\n' "$secret_root"
  printf 'MINIO_ROOT_PASSWORD_FILE=%s/minio-root-password\n' "$secret_root"
  printf 'MINIO_APP_USER_FILE=%s/minio-app-user\n' "$secret_root"
  printf 'MINIO_APP_PASSWORD_FILE=%s/minio-app-password\n' "$secret_root"
  printf '%s\n' 'POSTGRES_DB=' 'POSTGRES_PORT=' 'KAFKA_PORT=' 'REDIS_PORT=' 'MINIO_API_PORT=' 'MINIO_CONSOLE_PORT=' 'OPA_PORT=' 'AI_PORT=' 'CORE_PORT=' 'AI_LOG_LEVEL=' 'APP_VERSION=' 'OBJECT_STORAGE_BUCKET='
} >infra/compose/.env
chmod 0600 infra/compose/.env
```

**注意：** Windows 路径若包含 Compose dotenv 解析的特殊字符，应选用组织批准且语法简单的持久目录，并以 `docker compose config` 结果为准。不得把值改成相对路径来掩盖解析问题。

## 配置验证

### 非敏感值约束

Compose 插值只选择字符串和默认值，不验证端口范围、端口冲突、AI 日志级别、数据库名、版本或完整桶规则。以下 Windows/Bash 验证器还把 `.env.example` 的 20 个变量作为精确允许集合：八个路径 key 必须出现，十二个可选 key 可以缺失或为空，重复 key、未知 key 和 literal credential key 一律失败。应用/初始化脚本会在不同阶段拒绝部分错误值，因此必须在启动前统一验证：

- `AI_LOG_LEVEL` 只能是 `fatal`、`error`、`warn`、`info`、`debug`、`trace`，默认 `info`，区分大小写。
- 八个主机端口必须是 `1-65535` 的十进制整数，彼此不同，并在启动前未被监听。
- `POSTGRES_DB` 使用保守标识符规则：小写字母开头，后续仅小写字母、数字或下划线，总长不超过 63；默认 `innorder_occ`。
- `OBJECT_STORAGE_BUCKET` 长度为 3-63，只含小写字母、数字、点和连字符，以字母或数字开头/结尾，不含连续点，也不能是 IPv4 地址形式；默认 `innorder-occ`。
- `APP_VERSION` 去除首尾空白后必须非空；默认 `0.1.0`。它只用于状态标识，不验证镜像身份。

Windows PowerShell 5.1 的预启动验证：

```powershell
$ErrorActionPreference = 'Stop'
$allowedKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
$requiredPathKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE')
$config = @{}
Get-Content -LiteralPath 'infra/compose/.env' | ForEach-Object {
  if ($_ -and -not $_.StartsWith('#')) {
    $parts = $_ -split '=', 2
    if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) { throw '无效的 .env 行' }
    $key = $parts[0]
    if ($key -match '(?:PASSWORD|SECRET|ACCESS_KEY|TOKEN)$' -or $key -match '^MINIO_(?:ROOT|APP)_USER$') { throw "禁止 literal credential key: $key" }
    if ($allowedKeys -notcontains $key) { throw "未知 .env key: $key" }
    if ($config.ContainsKey($key)) { throw "重复 .env key: $key" }
    $config[$key] = $parts[1]
  }
}
foreach ($key in $requiredPathKeys) { if (-not $config.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($config[$key])) { throw "缺少必填路径 key: $key" } }
function Effective([string]$Name, [string]$Default) { if ([string]::IsNullOrEmpty($config[$Name])) { $Default } else { $config[$Name] } }
$secretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
$secretPathNames = [ordered]@{
  POSTGRES_ADMIN_PASSWORD_FILE='postgres-admin-password'; POSTGRES_FLYWAY_PASSWORD_FILE='postgres-flyway-password'
  POSTGRES_RUNTIME_PASSWORD_FILE='postgres-runtime-password'; REDIS_PASSWORD_FILE='redis-password'
  MINIO_ROOT_USER_FILE='minio-root-user'; MINIO_ROOT_PASSWORD_FILE='minio-root-password'
  MINIO_APP_USER_FILE='minio-app-user'; MINIO_APP_PASSWORD_FILE='minio-app-password'
}
foreach ($entry in $secretPathNames.GetEnumerator()) {
  $expectedPath = Join-Path $secretRoot $entry.Value
  if ($config[$entry.Key] -ne $expectedPath) { throw "$($entry.Key) 未指向 OCC_SECRET_ROOT 下的预期文件" }
  $source = Get-Item -LiteralPath $config[$entry.Key] -Force
  if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$($entry.Key) 未指向现有普通文件" }
}
$portDefaults = [ordered]@{ POSTGRES_PORT=5432; KAFKA_PORT=9092; REDIS_PORT=6379; MINIO_API_PORT=9000; MINIO_CONSOLE_PORT=9001; OPA_PORT=8181; AI_PORT=3100; CORE_PORT=8080 }
$ports = New-Object System.Collections.Generic.List[int]
foreach ($entry in $portDefaults.GetEnumerator()) {
  $parsed = 0
  $raw = Effective $entry.Key ([string]$entry.Value)
  if ($raw -notmatch '^[0-9]+$' -or -not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) { throw "$($entry.Key) 必须是 1-65535 的十进制整数" }
  if ($ports.Contains($parsed)) { throw "主机端口 $parsed 重复" }
  if (Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $parsed) { throw "主机端口 $parsed 已被监听" }
  $ports.Add($parsed)
}
$logLevel = Effective 'AI_LOG_LEVEL' 'info'
if (@('fatal','error','warn','info','debug','trace') -notcontains $logLevel) { throw 'AI_LOG_LEVEL 不在允许集合中' }
$database = Effective 'POSTGRES_DB' 'innorder_occ'
if ($database -notmatch '^[a-z][a-z0-9_]{0,62}$') { throw 'POSTGRES_DB 不符合保守标识符规则' }
$bucket = Effective 'OBJECT_STORAGE_BUCKET' 'innorder-occ'
if ($bucket.Length -lt 3 -or $bucket.Length -gt 63 -or $bucket -notmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' -or $bucket.Contains('..') -or $bucket -match '^\d{1,3}(?:\.\d{1,3}){3}$') { throw 'OBJECT_STORAGE_BUCKET 不符合桶命名规则' }
$version = Effective 'APP_VERSION' '0.1.0'
if ([string]::IsNullOrWhiteSpace($version) -or $version -ne $version.Trim()) { throw 'APP_VERSION 必须是无首尾空白的非空值' }
Write-Output 'Windows 非敏感配置和端口可用性验证通过'
```

Linux Bash 的预启动验证：

```bash
set -euo pipefail
declare -A config=()
declare -A allowed=()
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
required_paths=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
while IFS='=' read -r key value || [ -n "$key" ]; do
  value=${value%$'\r'}
  [ -z "$key" ] && continue
  case "$key" in \#*) continue;; esac
  [[ $key =~ (PASSWORD|SECRET|ACCESS_KEY|TOKEN)$ ]] && exit 1
  [[ $key =~ ^MINIO_(ROOT|APP)_USER$ ]] && exit 1
  [ -n "${allowed[$key]:-}" ] || exit 1
  [ -z "${config[$key]+present}" ] || exit 1
  config[$key]=$value
done <infra/compose/.env
for key in "${required_paths[@]}"; do [ -n "${config[$key]:-}" ] || exit 1; done
secret_root=$(realpath "$OCC_SECRET_ROOT")
path_names=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
file_names=(postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password)
for index in "${!path_names[@]}"; do
  name=${path_names[$index]}
  [ "${config[$name]:-}" = "$secret_root/${file_names[$index]}" ] || exit 1
  [ -f "${config[$name]}" ] && [ ! -L "${config[$name]}" ] || exit 1
done
names=(POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT)
defaults=(5432 9092 6379 9000 9001 8181 3100 8080)
declare -A seen=()
for index in "${!names[@]}"; do
  name=${names[$index]}
  port=${config[$name]:-${defaults[$index]}}
  [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || exit 1
  [ -z "${seen[$port]:-}" ] || exit 1
  seen[$port]=1
  if ss -H -ltn "sport = :$port" | grep -q .; then printf '%s 已被监听\n' "$port" >&2; exit 1; fi
done
log_level=${config[AI_LOG_LEVEL]:-info}
case "$log_level" in fatal|error|warn|info|debug|trace) ;; *) exit 1;; esac
database=${config[POSTGRES_DB]:-innorder_occ}
[[ $database =~ ^[a-z][a-z0-9_]{0,62}$ ]] || exit 1
bucket=${config[OBJECT_STORAGE_BUCKET]:-innorder-occ}
[ "${#bucket}" -ge 3 ] && [ "${#bucket}" -le 63 ] || exit 1
[[ $bucket =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || exit 1
[[ $bucket != *..* ]] || exit 1
[[ ! $bucket =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || exit 1
app_version=${config[APP_VERSION]:-0.1.0}
trimmed=$(printf '%s' "$app_version" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
[ -n "$app_version" ] && [ "$app_version" = "$trimmed" ] || exit 1
printf 'Linux 非敏感配置和端口可用性验证通过\n'
```

循环条件中的 `|| [ -n "$key" ]` 用于处理最后一行没有终止换行的合法 dotenv 文件；例如文件最后直接结束于 `OBJECT_STORAGE_BUCKET=` 时，该 key 仍必须进入允许集合、重复和取值验证，不能被 `read` 的非零结束状态跳过。

### 静态和插值验证

先运行密钥文件验证和非敏感值验证，再运行以下命令。`config --quiet` 成功只说明 Compose YAML 与插值可渲染；它不证明 secret 源文件存在、权限正确，也不证明 PostgreSQL、MinIO 或 AI 会接受运行值。

```powershell
git check-ignore infra/compose/.env
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config
npm run test:infra
```

```bash
git check-ignore infra/compose/.env
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config
npm run test:infra
```

查看展开配置时应确认：

- 服务恰好为十一个，三个一次性服务保留 `restart: "no"`。
- 只有 `host-gateway` 有 `ports`，且八个绑定都以 `127.0.0.1` 开头。
- `backend` 仍为 internal，只有网关还连接 `host-access`。
- 四个卷名不变；八个 secret 的 `file` 指向预期绝对路径。
- Core 的数据库用户是 `innorder_runtime`，Flyway 用户是 `innorder_flyway`。
- Core config tree 的五个目标文件名与 Spring 属性完全一致。
- `APP_VERSION`、日志级别、桶名和端口覆盖符合变更单。

**安全：** 展开配置不应含密钥值，但会包含主机密钥路径；证据归档前对路径做必要脱敏。

### 运行后验证矩阵

| 配置域 | 验证方法 | 通过标准 |
|---|---|---|
| PostgreSQL runtime | Core readiness | `http://127.0.0.1:8080/actuator/health/readiness` 为成功且 db 健康 |
| Flyway | Core 日志与 Flyway 历史 | V001-V011 成功，无重复迁移进程 |
| Redis | 容器健康和 Core 状态 | Redis 认证 `PING` 成功；Core 使用同一密钥 |
| MinIO root | MinIO readiness | `http://127.0.0.1:9000/minio/health/ready` 成功 |
| MinIO app | `minio-init` 退出码与 Core 状态 | 初始化成功，Core 只使用桶级账号 |
| OPA | 健康路由 | `http://127.0.0.1:8181/health` 成功 |
| AI | 健康路由与状态 | `http://127.0.0.1:3100/health` 成功；不推断模型可用 |
| 端口 | 主机监听检查 | 仅最终八个回环地址监听 |
| 版本 | Core/AI 状态 | `APP_VERSION` 与发布记录一致 |
| 桶 | 初始化日志与对象探测 | 配置桶存在且应用账号权限被限制在该桶 |

## 轮换总则

**危险：** 修改主机密钥文件本身不会更新已有 PostgreSQL 角色密码或 MinIO 持久用户，也不会改变已运行容器内已挂载的 secret。Redis 运行进程同样不会自动重读文件。轮换必须协调服务端状态、文件原子替换和消费者重建。

每次轮换都应：创建已验证备份；确认维护窗口；生成新的 staged 文件；记录受影响消费者；更新服务端凭据；原子替换受管文件；强制重建消费者；执行验证；在观察期后安全销毁旧值。不要覆盖唯一旧文件后才设计回退。

任何轮换先在同一终端执行[第 11 章会话初始化](11-command-reference-and-checklists.md)，再持有项目全局锁直到服务端、正式文件、消费者和回退验证全部关闭。Windows 执行 `$RotationLifecycleLock = Enter-LifecycleLock`；Linux 执行 `acquire_lifecycle_lock`。锁冲突时停止，不得删除锁文件或换用按轮换编号命名的锁。正常完成后 Windows 执行 `$RotationLifecycleLock.Dispose()`，Linux 执行 `release_lifecycle_lock`；异常退出由进程释放锁，现场保持不变。

### PostgreSQL 三个角色

#### Flyway 和 runtime

`\password` 是 psql 元命令：它对一个角色立即执行一次独立密码变更，并通过两次隐藏交互提示读取新值。两个角色的 `\password` 不在一个原子事务中；第一个成功、第二个失败时，数据库会处于部分轮换状态。

操作前设置 `OCC_ROTATION_ROOT`、`OCC_POSTGRES_DB`、`OCC_POSTGRES_PORT`、`OCC_FLYWAY_STAGED` 和 `OCC_RUNTIME_STAGED`。这些变量分别指向仓库外受限目录、有效数据库名、最终主机端口和两个已验证 staged 密钥文件。旧正式文件在轮换结束前保持不变。

1. 验证数据库备份并停止 Core。把当前两个正式文件复制到 `OCC_ROTATION_ROOT` 作为受限回退副本：

```powershell
$rotationRoot = (Resolve-Path -LiteralPath $env:OCC_ROTATION_ROOT).Path
Copy-Item -LiteralPath (Join-Path $env:OCC_SECRET_ROOT 'postgres-flyway-password') -Destination (Join-Path $rotationRoot 'postgres-flyway-password.old') -Force
Copy-Item -LiteralPath (Join-Path $env:OCC_SECRET_ROOT 'postgres-runtime-password') -Destination (Join-Path $rotationRoot 'postgres-runtime-password.old') -Force
```

```bash
rotation_root=$(realpath "$OCC_ROTATION_ROOT")
install -m 0600 "$OCC_SECRET_ROOT/postgres-flyway-password" "$rotation_root/postgres-flyway-password.old"
install -m 0600 "$OCC_SECRET_ROOT/postgres-runtime-password" "$rotation_root/postgres-runtime-password.old"
```
2. 在终端 A 打开并保持 `innorder_admin` 会话；不要在两个角色和 Core 都验证前执行 `\q`：

```powershell
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml stop core
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec postgres psql --username innorder_admin --dbname $env:OCC_POSTGRES_DB
```

```bash
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml stop core
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec postgres psql --username innorder_admin --dbname "$OCC_POSTGRES_DB"
```

3. 在终端 A 输入 `\password innorder_flyway`。psql 会交互提示 `Enter new password for user` 和 `Enter it again`；通过批准的安全输入通道提供 staged 值，屏幕不回显。不要把值粘进 SQL、命令参数、历史或日志。
4. 在终端 B 从 staged 值创建权限受限的临时 libpq passfile，并用独立 TCP 连接验证 Flyway 角色。passfile 含凭据，只能位于 `OCC_ROTATION_ROOT`，验证后删除。

```powershell
$rotationRoot = (Resolve-Path -LiteralPath $env:OCC_ROTATION_ROOT).Path
$flywayPassfile = Join-Path $rotationRoot 'flyway-validation.pgpass'
$value = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $env:OCC_FLYWAY_STAGED))
$escaped = $value.Replace('\','\\').Replace(':','\:')
$passfileLine = '127.0.0.1:{0}:{1}:innorder_flyway:{2}' -f $env:OCC_POSTGRES_PORT,$env:OCC_POSTGRES_DB,$escaped
[IO.File]::WriteAllText($flywayPassfile, $passfileLine, (New-Object Text.UTF8Encoding($false)))
$validationExit = 1
try {
  icacls.exe $flywayPassfile /inheritance:r | Out-Null
  icacls.exe $flywayPassfile /grant:r "$($env:USERNAME):F" 'SYSTEM:F' | Out-Null
  $env:PGPASSFILE = $flywayPassfile
  psql --host 127.0.0.1 --port $env:OCC_POSTGRES_PORT --dbname $env:OCC_POSTGRES_DB --username innorder_flyway --no-password --command 'SELECT current_user;'
  $validationExit = $LASTEXITCODE
} finally {
  if (Test-Path Env:PGPASSFILE) { Remove-Item Env:PGPASSFILE }
  if (Test-Path -LiteralPath $flywayPassfile) { Remove-Item -LiteralPath $flywayPassfile -Force }
  $value = $null
  $escaped = $null
  $passfileLine = $null
}
if ($validationExit -ne 0) { throw 'Flyway 新凭据独立连接失败' }
```

```bash
set -euo pipefail
set +x
umask 077
rotation_root=$(realpath "$OCC_ROTATION_ROOT")
flyway_passfile="$rotation_root/flyway-validation.pgpass"
trap 'rm -f -- "$flyway_passfile"' EXIT
IFS= read -r value <"$OCC_FLYWAY_STAGED" || test -n "$value"
escaped=${value//\\/\\\\}
escaped=${escaped//:/\\:}
printf '127.0.0.1:%s:%s:innorder_flyway:%s' "$OCC_POSTGRES_PORT" "$OCC_POSTGRES_DB" "$escaped" >"$flyway_passfile"
chmod 0600 "$flyway_passfile"
PGPASSFILE="$flyway_passfile" psql --host 127.0.0.1 --port "$OCC_POSTGRES_PORT" --dbname "$OCC_POSTGRES_DB" --username innorder_flyway --no-password --command 'SELECT current_user;'
rm -f -- "$flyway_passfile"
trap - EXIT
unset value escaped
```

5. Flyway 独立连接成功后，在终端 A 输入 `\password innorder_runtime`，再在终端 B 执行以下对应命令验证 runtime；命令直接使用 `OCC_RUNTIME_STAGED`，无需改写角色或路径：

```powershell
$rotationRoot = (Resolve-Path -LiteralPath $env:OCC_ROTATION_ROOT).Path
$runtimePassfile = Join-Path $rotationRoot 'runtime-validation.pgpass'
$value = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $env:OCC_RUNTIME_STAGED))
$escaped = $value.Replace('\','\\').Replace(':','\:')
$passfileLine = '127.0.0.1:{0}:{1}:innorder_runtime:{2}' -f $env:OCC_POSTGRES_PORT,$env:OCC_POSTGRES_DB,$escaped
[IO.File]::WriteAllText($runtimePassfile, $passfileLine, (New-Object Text.UTF8Encoding($false)))
$validationExit = 1
try {
  icacls.exe $runtimePassfile /inheritance:r | Out-Null
  icacls.exe $runtimePassfile /grant:r "$($env:USERNAME):F" 'SYSTEM:F' | Out-Null
  $env:PGPASSFILE = $runtimePassfile
  psql --host 127.0.0.1 --port $env:OCC_POSTGRES_PORT --dbname $env:OCC_POSTGRES_DB --username innorder_runtime --no-password --command 'SELECT current_user;'
  $validationExit = $LASTEXITCODE
} finally {
  if (Test-Path Env:PGPASSFILE) { Remove-Item Env:PGPASSFILE }
  if (Test-Path -LiteralPath $runtimePassfile) { Remove-Item -LiteralPath $runtimePassfile -Force }
  $value = $null
  $escaped = $null
  $passfileLine = $null
}
if ($validationExit -ne 0) { throw 'runtime 新凭据独立连接失败' }
```

```bash
set -euo pipefail
set +x
rotation_root=$(realpath "$OCC_ROTATION_ROOT")
runtime_passfile="$rotation_root/runtime-validation.pgpass"
trap 'rm -f -- "$runtime_passfile"' EXIT
IFS= read -r value <"$OCC_RUNTIME_STAGED" || test -n "$value"
escaped=${value//\\/\\\\}
escaped=${escaped//:/\\:}
printf '127.0.0.1:%s:%s:innorder_runtime:%s' "$OCC_POSTGRES_PORT" "$OCC_POSTGRES_DB" "$escaped" >"$runtime_passfile"
chmod 0600 "$runtime_passfile"
PGPASSFILE="$runtime_passfile" psql --host 127.0.0.1 --port "$OCC_POSTGRES_PORT" --dbname "$OCC_POSTGRES_DB" --username innorder_runtime --no-password --command 'SELECT current_user;'
rm -f -- "$runtime_passfile"
trap - EXIT
unset value escaped
```
6. 如果 Flyway 变更或验证失败，在仍打开的 admin 会话中再次执行 `\password innorder_flyway`，通过隐藏提示恢复回退副本中的旧值，并从独立连接验证旧值。不要继续 runtime。
7. 如果 runtime 变更或验证失败，先在 admin 会话中用 `\password innorder_runtime` 恢复 runtime 旧值并独立验证，再用 `\password innorder_flyway` 恢复 Flyway 旧值并独立验证。只有两者恢复成功才结束故障处置；任何恢复失败都保持 Core 停止并升级为数据库凭据事件。
8. 只有新 Flyway 与 runtime 均从独立连接验证成功后，才把两个 staged 文件分别替换正式文件并保留回退副本，然后强制重建 Core：

```powershell
$ErrorActionPreference = 'Stop'
function Set-VerifiedRotationAcl([string]$Path) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expectedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  & icacls.exe $Path /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "关闭 ACL 继承失败: $Path" }
  & icacls.exe $Path /grant:r "$($env:USERNAME):F" 'SYSTEM:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "设置 ACL 失败: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw "ACL 继承未关闭: $Path" }
  $allowSids = @($acl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if ($allowSids | Where-Object { $expectedSids -notcontains $_ }) { throw "存在未授权 ACL: $Path" }
  foreach ($sid in $expectedSids) { if ($allowSids -notcontains $sid) { throw "缺少批准 ACL: $Path" } }
}
$flywayNew = Join-Path $env:OCC_SECRET_ROOT 'postgres-flyway-password.new'
$flywayFormal = Join-Path $env:OCC_SECRET_ROOT 'postgres-flyway-password'
$runtimeNew = Join-Path $env:OCC_SECRET_ROOT 'postgres-runtime-password.new'
$runtimeFormal = Join-Path $env:OCC_SECRET_ROOT 'postgres-runtime-password'
Copy-Item -LiteralPath $env:OCC_FLYWAY_STAGED -Destination $flywayNew -Force
Set-VerifiedRotationAcl $flywayNew
Move-Item -LiteralPath $flywayNew -Destination $flywayFormal -Force
Set-VerifiedRotationAcl $flywayFormal
Copy-Item -LiteralPath $env:OCC_RUNTIME_STAGED -Destination $runtimeNew -Force
Set-VerifiedRotationAcl $runtimeNew
Move-Item -LiteralPath $runtimeNew -Destination $runtimeFormal -Force
Set-VerifiedRotationAcl $runtimeFormal
& docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up -d --no-deps --force-recreate core
if ($LASTEXITCODE -ne 0) { throw 'Core 重建失败' }
```

```bash
install -m 0600 "$OCC_FLYWAY_STAGED" "$OCC_SECRET_ROOT/postgres-flyway-password.new"
mv -f -- "$OCC_SECRET_ROOT/postgres-flyway-password.new" "$OCC_SECRET_ROOT/postgres-flyway-password"
install -m 0600 "$OCC_RUNTIME_STAGED" "$OCC_SECRET_ROOT/postgres-runtime-password.new"
mv -f -- "$OCC_SECRET_ROOT/postgres-runtime-password.new" "$OCC_SECRET_ROOT/postgres-runtime-password"
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up -d --no-deps --force-recreate core
```

9. 验证 Core readiness、Flyway 历史和两个新角色连接。Core 验证失败时，保持 admin 会话打开，按第 7 步把两个服务端角色恢复旧值，同时恢复两个正式文件并再次重建 Core。全部验证完成后才在 admin 会话输入 `\q`，删除 passfile 与回退材料，并清除相关会话变量。

#### Admin

**当前不支持直接执行：** 下列条目只是后续组织操作票必须满足的设计要求，不是可执行步骤。仓库没有提供 admin 双凭据、自动回退或经测试脚本；在另行批准、实现并完成双平台隔离演练前，不得在生产轮换 PostgreSQL admin。

1. 保持 Core 运行不受影响或进入维护窗口，使用当前 admin 身份打开受控本机会话。
2. 生成新的 admin staged 文件，在现有 admin 的本机受控 `psql` 会话内执行 `\password innorder_admin`，通过隐藏交互提示设置新值。
3. 成功后原子替换 admin 文件，并重建 PostgreSQL 容器以同步挂载文件；已有数据卷不会重跑初始化脚本。
4. 验证新 admin 受控登录、Core readiness 和旧 admin 凭据失效。

**注意：** `010-create-roles.sh` 只在空 `postgres-data` 初始化时运行。删除卷以“应用新密码”会删除数据库，绝对不是轮换方法。

### Redis

**当前不支持直接执行：** 当前 Redis 只有单密码且密码进入长运行 argv，没有双凭据过渡或原子服务端回退。下列顺序只是组织操作票的设计要求；必须另行提供完整 PowerShell/Bash 命令、确认门禁、失败清理和隔离演练后才能用于生产。

1. 进入维护窗口并停止 Core，确认 `redis-data` 备份/可重建策略。
2. 生成新的 Redis staged 文件，验证非空和权限。
3. 原子替换 Redis 密钥文件；强制重建 Redis，使启动命令读取新值。
4. 等待 Redis 认证健康检查通过，再强制重建 Core以加载 `spring.data.redis.password`。
5. 验证 Redis 健康、Core 状态和旧密码失败。

该顺序包含短暂不可用，但避免同时维护运行态和配置态两套密码。若业务上线后要求无中断轮换，必须另行设计经测试的双凭据或代理机制；当前栈没有该能力。

### MinIO 应用账号

本流程同时轮换应用用户名和密码，staged 用户名必须与当前正式用户名不同。这样 `minio-init` 创建新 IAM 用户时，运行中的 Core 仍持有有效旧用户；在新用户验证成功前不替换正式文件、不重建 Core，也不禁用旧用户。

操作前设置 `OCC_ROTATION_ROOT`、`OCC_MINIO_APP_USER_STAGED` 和 `OCC_MINIO_APP_PASSWORD_STAGED`，并先运行本章的 staged 文件内容/权限验证。临时 env 位于仓库外，只复制正式 `.env`，且只替换 `MINIO_APP_USER_FILE` 和 `MINIO_APP_PASSWORD_FILE` 两行；其中仍然只有路径，没有凭据值。

#### Windows PowerShell 5.1

以下脚本先确认 MinIO 已健康，再使用 `--no-deps` 运行一次性初始化器，并以新 IAM 用户在目标桶写入、读回和删除无业务内容的临时对象。只列桶或只检查 IAM 用户存在都不能证明 Core 所需对象权限。`mc alias set` 会让凭据在短生命周期容器内的 `mc` 进程 argv 中短暂可见；执行窗口禁止进程快照、debug trace 和支持包采集，且不得把输出写入日志。`--no-deps` 只能在健康检查成功后使用，否则应停止并修复 MinIO，而不是让 `run` 隐式启动依赖。

```powershell
$ErrorActionPreference = 'Stop'
$rotationRoot = (Resolve-Path -LiteralPath $env:OCC_ROTATION_ROOT).Path
$stagedUser = (Resolve-Path -LiteralPath $env:OCC_MINIO_APP_USER_STAGED).Path
$stagedPassword = (Resolve-Path -LiteralPath $env:OCC_MINIO_APP_PASSWORD_STAGED).Path
$formalUser = Join-Path $env:OCC_SECRET_ROOT 'minio-app-user'
$formalPassword = Join-Path $env:OCC_SECRET_ROOT 'minio-app-password'
$oldUserBackup = Join-Path $rotationRoot 'minio-app-user.old'
$oldPasswordBackup = Join-Path $rotationRoot 'minio-app-password.old'
$rotationEnv = Join-Path $rotationRoot 'minio-app-rotation.env'
$oldUserValue = [IO.File]::ReadAllText($formalUser).TrimEnd("`r","`n")
$newUserValue = [IO.File]::ReadAllText($stagedUser).TrimEnd("`r","`n")
if ($oldUserValue -eq $newUserValue) { throw 'staged MinIO 应用用户名必须不同于当前用户名' }
$oldUserValue = $null
$newUserValue = $null
Copy-Item -LiteralPath $formalUser -Destination $oldUserBackup -Force
Copy-Item -LiteralPath $formalPassword -Destination $oldPasswordBackup -Force
$userLines = 0
$passwordLines = 0
$rotationLines = Get-Content -LiteralPath 'infra/compose/.env' | ForEach-Object {
  if ($_ -match '^MINIO_APP_USER_FILE=') { $userLines++; "MINIO_APP_USER_FILE=$stagedUser" }
  elseif ($_ -match '^MINIO_APP_PASSWORD_FILE=') { $passwordLines++; "MINIO_APP_PASSWORD_FILE=$stagedPassword" }
  else { $_ }
}
if ($userLines -ne 1 -or $passwordLines -ne 1) { throw '正式 .env 中的 MinIO 应用路径 key 不唯一' }
[IO.File]::WriteAllLines($rotationEnv, $rotationLines, (New-Object Text.UTF8Encoding($false)))
function Set-VerifiedRotationAcl([string]$Path) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expectedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  & icacls.exe $Path /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "关闭 ACL 继承失败: $Path" }
  & icacls.exe $Path /grant:r "$($env:USERNAME):F" 'SYSTEM:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "设置 ACL 失败: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw "ACL 继承未关闭: $Path" }
  $allowSids = @($acl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if ($allowSids | Where-Object { $expectedSids -notcontains $_ }) { throw "存在未授权 ACL: $Path" }
  foreach ($sid in $expectedSids) { if ($allowSids -notcontains $sid) { throw "缺少批准 ACL: $Path" } }
}
Set-VerifiedRotationAcl $rotationEnv
try {
  & docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec -T minio curl -fsS http://localhost:9000/minio/health/ready
  if ($LASTEXITCODE -ne 0) { throw 'MinIO 尚未健康，禁止使用 --no-deps' }
  & docker compose --env-file $rotationEnv -f infra/compose/compose.yml run --rm --no-deps minio-init
  if ($LASTEXITCODE -ne 0) { throw 'staged minio-init 失败' }
  & docker compose --env-file $rotationEnv -f infra/compose/compose.yml run --rm --no-deps --entrypoint /bin/sh minio-init -ec 'root_user="$(cat /run/secrets/minio_root_user)"; root_password="$(cat /run/secrets/minio_root_password)"; app_user="$(cat /run/secrets/minio_app_user)"; app_password="$(cat /run/secrets/minio_app_password)"; mc alias set rootcheck http://minio:9000 "$root_user" "$root_password" >/dev/null; mc alias set staged http://minio:9000 "$app_user" "$app_password" >/dev/null; canary="occ-deny-$PPID-$$"; key="staged/$MINIO_BUCKET/.occ-credential-validation-$$"; cleanup() { mc rm --force "$key" >/dev/null 2>&1 || true; mc rb --force "rootcheck/$canary" >/dev/null 2>&1 || true; }; trap cleanup EXIT; mc mb "rootcheck/$canary" >/dev/null; printf occ-validation | mc pipe "$key" >/dev/null; [ "$(mc cat "$key")" = occ-validation ]; mc rm --force "$key" >/dev/null; if mc ls "staged/$canary" >/dev/null 2>&1; then exit 1; fi; if mc admin info staged >/dev/null 2>&1; then exit 1; fi; mc rb "rootcheck/$canary" >/dev/null; trap - EXIT'
  if ($LASTEXITCODE -ne 0) { throw '新 MinIO IAM 凭据验证失败' }
  Copy-Item -LiteralPath $stagedUser -Destination "$formalUser.new" -Force
  Copy-Item -LiteralPath $stagedPassword -Destination "$formalPassword.new" -Force
  Set-VerifiedRotationAcl "$formalUser.new"
  Set-VerifiedRotationAcl "$formalPassword.new"
  Move-Item -LiteralPath "$formalUser.new" -Destination $formalUser -Force
  Move-Item -LiteralPath "$formalPassword.new" -Destination $formalPassword -Force
  Set-VerifiedRotationAcl $formalUser
  Set-VerifiedRotationAcl $formalPassword
  & docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up -d --no-deps --force-recreate core
  if ($LASTEXITCODE -ne 0) { throw 'Core 重建失败' }
  & docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec -T core curl -fsS http://localhost:8080/actuator/health/readiness
  if ($LASTEXITCODE -ne 0) { throw 'Core readiness 失败' }
} catch {
  [Console]::Error.WriteLine('MinIO 应用轮换失败；保留临时 env、staged IAM 用户、回退文件和日志，立即执行下方回退流程。')
  throw
}
Remove-Item -LiteralPath $rotationEnv -Force
```

Windows 回退必须作为独立受控步骤执行；任何一步失败都会立即停止，临时 env 和 staged IAM 用户继续保留：

```powershell
$ErrorActionPreference = 'Stop'
$rotationRoot = (Resolve-Path -LiteralPath $env:OCC_ROTATION_ROOT).Path
$formalUser = Join-Path $env:OCC_SECRET_ROOT 'minio-app-user'
$formalPassword = Join-Path $env:OCC_SECRET_ROOT 'minio-app-password'
$oldUserBackup = Join-Path $rotationRoot 'minio-app-user.old'
$oldPasswordBackup = Join-Path $rotationRoot 'minio-app-password.old'
$rotationEnv = Join-Path $rotationRoot 'minio-app-rotation.env'
function Set-VerifiedRotationAcl([string]$Path) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expectedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  & icacls.exe $Path /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "关闭 ACL 继承失败: $Path" }
  & icacls.exe $Path /grant:r "$($env:USERNAME):F" 'SYSTEM:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "设置 ACL 失败: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw "ACL 继承未关闭: $Path" }
  $allowSids = @($acl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if ($allowSids | Where-Object { $expectedSids -notcontains $_ }) { throw "存在未授权 ACL: $Path" }
  foreach ($sid in $expectedSids) { if ($allowSids -notcontains $sid) { throw "缺少批准 ACL: $Path" } }
}
$rollbackUser = "$formalUser.rollback"
$rollbackPassword = "$formalPassword.rollback"
Copy-Item -LiteralPath $oldUserBackup -Destination $rollbackUser -Force
Copy-Item -LiteralPath $oldPasswordBackup -Destination $rollbackPassword -Force
Set-VerifiedRotationAcl $rollbackUser
Set-VerifiedRotationAcl $rollbackPassword
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackUser).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $oldUserBackup).Hash) { throw '用户名回退内容验证失败' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackPassword).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $oldPasswordBackup).Hash) { throw '密码回退内容验证失败' }
Move-Item -LiteralPath $rollbackUser -Destination $formalUser -Force
Move-Item -LiteralPath $rollbackPassword -Destination $formalPassword -Force
Set-VerifiedRotationAcl $formalUser
Set-VerifiedRotationAcl $formalPassword
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $formalUser).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $oldUserBackup).Hash) { throw '正式用户名内容未恢复' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $formalPassword).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $oldPasswordBackup).Hash) { throw '正式密码内容未恢复' }
& docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up -d --no-deps --force-recreate core
if ($LASTEXITCODE -ne 0) { throw '回退后 Core 重建失败；保留 staged 用户和全部证据并升级事件' }
& docker compose --env-file infra/compose/.env -f infra/compose/compose.yml run --rm --no-deps --entrypoint /bin/sh minio-init -ec 'app_user="$(cat /run/secrets/minio_app_user)"; app_password="$(cat /run/secrets/minio_app_password)"; mc alias set rollback http://minio:9000 "$app_user" "$app_password" >/dev/null; key="rollback/$MINIO_BUCKET/.occ-credential-validation-$$"; cleanup() { mc rm --force "$key" >/dev/null 2>&1 || true; }; trap cleanup EXIT; printf occ-validation | mc pipe "$key" >/dev/null; [ "$(mc cat "$key")" = occ-validation ]; mc rm --force "$key" >/dev/null; trap - EXIT'
if ($LASTEXITCODE -ne 0) { throw '旧 IAM 访问验证失败；保留 staged 用户和全部证据并升级事件' }
& docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec -T core curl -fsS http://localhost:8080/actuator/health/readiness
if ($LASTEXITCODE -ne 0) { throw '回退后 Core readiness 失败；保留 staged 用户和全部证据并升级事件' }
Remove-Item -LiteralPath $rotationEnv -Force
```

#### Linux Bash

Linux 使用相同顺序。正常路径仅在全部验证成功后删除临时 env；任一失败立即退出并保留临时 env、staged IAM 用户、回退文件和日志，随后执行独立回退块。

```bash
set -euo pipefail
set +x
rotation_root=$(realpath "$OCC_ROTATION_ROOT")
staged_user=$(realpath "$OCC_MINIO_APP_USER_STAGED")
staged_password_path=$(realpath "$OCC_MINIO_APP_PASSWORD_STAGED")
formal_user="$OCC_SECRET_ROOT/minio-app-user"
formal_password_path="$OCC_SECRET_ROOT/minio-app-password"
old_user_backup="$rotation_root/minio-app-user.old"
old_password_backup_path="$rotation_root/minio-app-password.old"
rotation_env="$rotation_root/minio-app-rotation.env"
IFS= read -r old_user_value <"$formal_user" || test -n "$old_user_value"
IFS= read -r new_user_value <"$staged_user" || test -n "$new_user_value"
[ "$old_user_value" != "$new_user_value" ]
unset old_user_value new_user_value
install -m 0600 "$formal_user" "$old_user_backup"
install -m 0600 "$formal_password_path" "$old_password_backup_path"
awk -v user_path="$staged_user" -v password_path="$staged_password_path" '
  BEGIN { users=0; passwords=0 }
  /^MINIO_APP_USER_FILE=/ { print "MINIO_APP_USER_FILE=" user_path; users++; next }
  /^MINIO_APP_PASSWORD_FILE=/ { print "MINIO_APP_PASSWORD_FILE=" password_path; passwords++; next }
  { print }
  END { if (users != 1 || passwords != 1) exit 42 }
' infra/compose/.env >"$rotation_env"
chmod 0600 "$rotation_env"
if ! docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec -T minio curl -fsS http://localhost:9000/minio/health/ready; then printf 'MinIO 尚未健康，保留证据并停止\n' >&2; exit 1; fi
if ! docker compose --env-file "$rotation_env" -f infra/compose/compose.yml run --rm --no-deps minio-init; then printf 'staged minio-init 失败，保留 staged 用户和证据\n' >&2; exit 1; fi
if ! docker compose --env-file "$rotation_env" -f infra/compose/compose.yml run --rm --no-deps --entrypoint /bin/sh minio-init -ec 'root_user="$(cat /run/secrets/minio_root_user)"; root_password="$(cat /run/secrets/minio_root_password)"; app_user="$(cat /run/secrets/minio_app_user)"; app_password="$(cat /run/secrets/minio_app_password)"; mc alias set rootcheck http://minio:9000 "$root_user" "$root_password" >/dev/null; mc alias set staged http://minio:9000 "$app_user" "$app_password" >/dev/null; canary="occ-deny-$PPID-$$"; key="staged/$MINIO_BUCKET/.occ-credential-validation-$$"; cleanup() { mc rm --force "$key" >/dev/null 2>&1 || true; mc rb --force "rootcheck/$canary" >/dev/null 2>&1 || true; }; trap cleanup EXIT; mc mb "rootcheck/$canary" >/dev/null; printf occ-validation | mc pipe "$key" >/dev/null; [ "$(mc cat "$key")" = occ-validation ]; mc rm --force "$key" >/dev/null; if mc ls "staged/$canary" >/dev/null 2>&1; then exit 1; fi; if mc admin info staged >/dev/null 2>&1; then exit 1; fi; mc rb "rootcheck/$canary" >/dev/null; trap - EXIT'; then printf '新 IAM 目标桶对象操作或桶外/admin 拒绝验证失败，保留 staged 用户和证据\n' >&2; exit 1; fi
install -m 0600 "$staged_user" "$formal_user.new"
install -m 0600 "$staged_password_path" "$formal_password_path.new"
mv -f -- "$formal_user.new" "$formal_user"
mv -f -- "$formal_password_path.new" "$formal_password_path"
if ! docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up -d --no-deps --force-recreate core; then printf 'Core 重建失败，保留 staged 用户和证据并执行回退\n' >&2; exit 1; fi
if ! docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec -T core curl -fsS http://localhost:8080/actuator/health/readiness; then printf 'Core readiness 失败，保留 staged 用户和证据并执行回退\n' >&2; exit 1; fi
if ! rm -f -- "$rotation_env"; then printf '轮换成功但临时 env 清理失败，保留证据并升级事件\n' >&2; exit 1; fi
```

Linux 回退使用以下独立块。它先恢复文件并验证内容、所有者和 `0600`，再重建 Core、验证旧 IAM 和 readiness。任一步失败都会保留 staged 用户、临时 env 和证据并立即退出：

```bash
set -euo pipefail
rotation_root=$(realpath "$OCC_ROTATION_ROOT")
formal_user="$OCC_SECRET_ROOT/minio-app-user"
formal_password_path="$OCC_SECRET_ROOT/minio-app-password"
old_user_backup="$rotation_root/minio-app-user.old"
old_password_backup_path="$rotation_root/minio-app-password.old"
rotation_env="$rotation_root/minio-app-rotation.env"
rollback_user="$formal_user.rollback"
rollback_password_path="$formal_password_path.rollback"
install -m 0600 "$old_user_backup" "$rollback_user"
install -m 0600 "$old_password_backup_path" "$rollback_password_path"
chown "$(id -u):$(id -g)" "$rollback_user" "$rollback_password_path"
if [ "$(stat -c '%u' "$rollback_user")" -ne "$(id -u)" ] || [ "$(stat -c '%a' "$rollback_user")" != 600 ]; then printf '用户名回退文件权限失败\n' >&2; exit 1; fi
if [ "$(stat -c '%u' "$rollback_password_path")" -ne "$(id -u)" ] || [ "$(stat -c '%a' "$rollback_password_path")" != 600 ]; then printf '密码回退文件权限失败\n' >&2; exit 1; fi
if ! cmp -s -- "$old_user_backup" "$rollback_user"; then printf '用户名回退内容失败\n' >&2; exit 1; fi
if ! cmp -s -- "$old_password_backup_path" "$rollback_password_path"; then printf '密码回退内容失败\n' >&2; exit 1; fi
mv -f -- "$rollback_user" "$formal_user"
mv -f -- "$rollback_password_path" "$formal_password_path"
if [ "$(stat -c '%u' "$formal_user")" -ne "$(id -u)" ] || [ "$(stat -c '%a' "$formal_user")" != 600 ]; then printf '正式用户名权限验证失败\n' >&2; exit 1; fi
if [ "$(stat -c '%u' "$formal_password_path")" -ne "$(id -u)" ] || [ "$(stat -c '%a' "$formal_password_path")" != 600 ]; then printf '正式密码权限验证失败\n' >&2; exit 1; fi
if ! cmp -s -- "$old_user_backup" "$formal_user"; then printf '正式用户名内容未恢复\n' >&2; exit 1; fi
if ! cmp -s -- "$old_password_backup_path" "$formal_password_path"; then printf '正式密码内容未恢复\n' >&2; exit 1; fi
if ! docker compose --env-file infra/compose/.env -f infra/compose/compose.yml up -d --no-deps --force-recreate core; then printf '回退后 Core 重建失败，保留 staged 用户和证据\n' >&2; exit 1; fi
if ! docker compose --env-file infra/compose/.env -f infra/compose/compose.yml run --rm --no-deps --entrypoint /bin/sh minio-init -ec 'app_user="$(cat /run/secrets/minio_app_user)"; app_password="$(cat /run/secrets/minio_app_password)"; mc alias set rollback http://minio:9000 "$app_user" "$app_password" >/dev/null; key="rollback/$MINIO_BUCKET/.occ-credential-validation-$$"; cleanup() { mc rm --force "$key" >/dev/null 2>&1 || true; }; trap cleanup EXIT; printf occ-validation | mc pipe "$key" >/dev/null; [ "$(mc cat "$key")" = occ-validation ]; mc rm --force "$key" >/dev/null; trap - EXIT'; then printf '旧 IAM 对象写入、读取或删除验证失败，保留 staged 用户和证据\n' >&2; exit 1; fi
if ! docker compose --env-file infra/compose/.env -f infra/compose/compose.yml exec -T core curl -fsS http://localhost:8080/actuator/health/readiness; then printf '回退后 Core readiness 失败，保留 staged 用户和证据\n' >&2; exit 1; fi
if ! rm -f -- "$rotation_env"; then printf '临时 env 清理失败，保留证据并升级事件\n' >&2; exit 1; fi
```

**危险：** 回退顺序不可改变：旧正式文件及权限验证、Core 重建、旧 IAM 实际访问、Core readiness 和临时 env 清理必须全部成功。任何一步失败都立即停止；staged IAM 用户、临时 env（若尚未清理）、回退文件和日志作为事件证据保留。回退关闭后 staged 用户仍保留；其删除是后续单独审批的安全变更，须重新创建只覆盖两个 staged 路径的临时 env，运行同一 root 管理 `mc admin user remove` 命令并检查非零状态，不属于回退脚本。

成功后在观察期内保留旧 IAM 用户和两个受限回退文件。确认 Core 和对象操作稳定后，使用 MinIO root 管理会话禁用旧用户，验证新用户仍能列出目标桶，再删除旧用户和回退文件。若在删除旧用户前需要回滚，只需恢复两个旧正式文件、强制重建 Core并删除新用户；不要重新运行 `minio-init` 覆盖已验证的新用户。

### MinIO root 凭据

**当前不支持直接执行：** root 凭据与持久 IAM 状态耦合，仓库没有经过双平台验证的 root 轮换/回退脚本。下列条目只是组织操作票必须满足的设计要求；不得把它们当作现场命令执行。

1. 验证对象恢复点并停止 `minio-init` 和管理操作。
2. 生成新的 root 用户名与密码 staged 文件，保持与应用凭据不同。
3. 原子替换两个 root 文件并强制重建 MinIO，使服务启动读取新 root 凭据。
4. MinIO readiness 成功后，强制重建 `minio-init`，确认它能使用新 root 凭据维护桶和应用策略。
5. 验证新 root 管理访问、应用账号访问和旧 root 凭据失效。

**危险：** MinIO 凭据行为与持久卷中的 IAM 状态相关。不得假设只编辑四个 MinIO 文件就会更新已有应用用户；必须观察 `minio-init` 成功并验证实际授权。

## 回退警告

- PostgreSQL 角色密码一旦在数据库中改变，回退必须再次执行受控 `ALTER ROLE`，并同步恢复对应文件和重建 Core；只恢复文件会造成认证失败。
- Redis 回退需要恢复旧文件并按顺序重建 Redis、再重建 Core；期间可能不可用。
- MinIO root 回退需要恢复 root 文件并重建 MinIO；应用账号回退需要重新更新持久 IAM 用户，而不只是恢复文件。
- 若新旧值的生效状态不确定，停止写入并查明服务端、挂载文件和消费者三方状态。不要连续盲目轮换。
- 密钥轮换不得与数据库迁移、镜像升级或桶名变更捆绑，除非已有联合回退演练。

## 禁止实践

- 在 `.env`、Compose、Dockerfile、源码、Markdown、工单或聊天中写密钥值。
- 把密钥放入仓库、临时目录、网络共享、同步盘、容器镜像层或 shell 历史。
- 在命令行参数、进程环境、调试 trace、CI 日志或 `docker inspect` 可见字段中传递值。
- 复用八个值，或让 MinIO 应用账号等于 root 账号。
- 授予普通用户、`Everyone` 或世界可读权限。
- 通过关闭 TLS 校验、改用不受控镜像源或开放公网端口解决部署问题。
- 只编辑密钥文件而不更新 PostgreSQL/MinIO 持久凭据或不重建消费者。
- 在未备份和未验证的情况下删除卷、重新初始化数据库或对象存储。
- 把 `APP_VERSION` 当作镜像完整性证明，或把 debug 日志长期用于生产。
- 变更 `OBJECT_STORAGE_BUCKET` 后假设对象会自动迁移。

## 变更完成验证

**验证：** 密钥或配置变更关闭前必须同时满足：Compose config 通过；十一个服务结构未漂移；受影响容器已重建；PostgreSQL/Redis/MinIO 的服务端状态与文件一致；Core/AI/OPA/MinIO HTTP 探测符合预期；协议探测成功；旧凭据失效；日志和证据不含密钥；回退材料仍在批准的保留期内。
