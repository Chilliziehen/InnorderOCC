# 安全加固

本章定义当前单客户、单主机 Compose 栈的最低安全基线。它不是公网发布设计，也不把回环绑定、Docker 网络或容器化误写成完整安全边界。事实拓扑见[架构与边界](01-architecture-and-boundaries.md)，密钥实现见[密钥与配置](03-secrets-and-configuration.md)，事件处置见[事件手册](09-incident-runbooks.md)。

## 威胁模型与范围

需要防范的主要威胁是：未经授权的本机用户或管理员、恶意/被攻陷进程、Docker socket/daemon 控制、密钥或备份泄露、供应链替换、镜像/策略/revision 漂移、日志与支持包外泄、DNS/TLS/时间劫持、勒索软件与主机/磁盘损失、错误运维和未设计的远程暴露。

当前安全边界与限制：

- 一个 Compose 实例只服务一个客户，运行于单主机；没有租户间隔离、HA、自动故障转移或跨节点一致性。
- `backend` 为 `internal: true`，后端容器不直接发布端口；只有 `host-gateway` 同时加入 `backend` 与 `host-access`，发布八个 `127.0.0.1` 端口。
- 回环绑定阻止正常远程直连，但不能防御主机上的恶意进程、管理员、Docker 控制者、代理转发、端口转发或主机失陷。
- Kafka 外部 listener 当前为 `PLAINTEXT` 且无协议认证。其风险只能由本机边界限制，不能扩展为远程入口。
- 当前 HTTP 路由没有可声明为外部身份边界的认证/TLS 终止。OPA 是无状态授权决策组件，不是用户认证服务。
- Core readiness 只包含 `ping` 和 `db`；健康不是授权、完整性或依赖全面可用的证明。

安全责任按层划分：主机所有者负责账号、补丁、防火墙、磁盘加密、时间和 Docker；发布负责人负责 revision、依赖、镜像和验证；应用/数据库/策略所有者负责最小权限与数据边界；备份负责人负责加密、不可变副本和恢复；安全负责人批准远程访问设计、例外和事件处置。

## 网络暴露与回环门禁

### 支持的默认边界

Compose 中只允许以下八个主机入口，地址必须精确为 `127.0.0.1`：PostgreSQL、Kafka、Redis、MinIO API/Console、OPA、AI、Core。后端服务不能新增 `ports`，不能加入 `host-access`；网关不能挂载密钥、Docker socket或主机目录。

Windows 检查发布监听与进程，任何非回环结果都失败：

```powershell
$ErrorActionPreference = 'Stop'
$allowedKeys = @('POSTGRES_ADMIN_PASSWORD_FILE','POSTGRES_FLYWAY_PASSWORD_FILE','POSTGRES_RUNTIME_PASSWORD_FILE','REDIS_PASSWORD_FILE','MINIO_ROOT_USER_FILE','MINIO_ROOT_PASSWORD_FILE','MINIO_APP_USER_FILE','MINIO_APP_PASSWORD_FILE','POSTGRES_DB','POSTGRES_PORT','KAFKA_PORT','REDIS_PORT','MINIO_API_PORT','MINIO_CONSOLE_PORT','OPA_PORT','AI_PORT','CORE_PORT','AI_LOG_LEVEL','APP_VERSION','OBJECT_STORAGE_BUCKET')
$config = @{}
Get-Content -LiteralPath 'infra/compose/.env' | ForEach-Object {
  if ($_ -and -not $_.StartsWith('#')) {
    $parts=$_ -split '=',2
    if ($parts.Count -ne 2 -or $allowedKeys -notcontains $parts[0] -or $config.ContainsKey($parts[0])) { throw '未知、重复或无效 .env key' }
    $config[$parts[0]]=$parts[1]
  }
}
$portDefaults=[ordered]@{ POSTGRES_PORT=5432; KAFKA_PORT=9092; REDIS_PORT=6379; MINIO_API_PORT=9000; MINIO_CONSOLE_PORT=9001; OPA_PORT=8181; AI_PORT=3100; CORE_PORT=8080 }
$expectedPorts=New-Object System.Collections.Generic.List[int]
foreach ($entry in $portDefaults.GetEnumerator()) {
  $raw=$config[$entry.Key]; if ([string]::IsNullOrEmpty($raw)) { $raw=[string]$entry.Value }
  $port=0
  if ($raw -notmatch '^[0-9]+$' -or -not [int]::TryParse($raw,[ref]$port) -or $port -lt 1 -or $port -gt 65535 -or $expectedPorts.Contains($port)) { throw "无效或重复有效端口：$($entry.Key)" }
  $expectedPorts.Add($port)
}
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $expectedPorts -contains $_.LocalPort })
foreach ($port in $expectedPorts) {
  $matches = @($listeners | Where-Object LocalPort -eq $port)
  if ($matches.Count -ne 1 -or $matches[0].LocalAddress -ne '127.0.0.1') { throw "端口 $port 未精确绑定一个 IPv4 回环监听器" }
}
$listeners | Sort-Object LocalPort | Select-Object LocalAddress,LocalPort,OwningProcess
```

Linux 从只含密钥路径和非敏感覆盖的 `.env` 派生八个有效端口，拒绝未知、重复、literal credential key、缺失路径 key和非法/重复端口；`ss` 失败、无监听、输出字段异常、通配或非回环地址均使检查失败。`ss -H -ltn` 的本地地址是通常的第 4 字段，不是行首：

```bash
set -euo pipefail
declare -A config=() allowed=() seen=()
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
required_paths=(POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE)
while IFS='=' read -r key value || [ -n "$key" ]; do
  value=${value%$'\r'}; [ -z "$key" ] && continue; case "$key" in \#*) continue;; esac
  [[ $key =~ (PASSWORD|SECRET|ACCESS_KEY|TOKEN)$ ]] && exit 1
  [[ $key =~ ^MINIO_(ROOT|APP)_USER$ ]] && exit 1
  [ -n "${allowed[$key]:-}" ] && [ -z "${config[$key]+present}" ] || exit 1
  config[$key]=$value
done <infra/compose/.env
for key in "${required_paths[@]}"; do [ -n "${config[$key]:-}" ] || exit 1; done
names=(POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT)
defaults=(5432 9092 6379 9000 9001 8181 3100 8080)
effective_ports=()
for index in "${!names[@]}"; do
  name=${names[$index]}; port=${config[$name]:-${defaults[$index]}}
  [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] && [ -z "${seen[$port]:-}" ] || exit 1
  seen[$port]=1; effective_ports+=("$port")
done
POSTGRES_PORT=${config[POSTGRES_PORT]:-5432}
for port in "${effective_ports[@]}"; do
  set +e
  lines=$(ss -H -ltn "sport = :$port" 2>&1)
  ss_status=$?
  set -e
  [ "$ss_status" -eq 0 ] || { printf 'ss 查询端口 %s 失败：%s\n' "$port" "$lines" >&2; exit "$ss_status"; }
  line_count=$(printf '%s\n' "$lines" | awk 'NF {count++} END {print count+0}')
  [ "$line_count" -gt 0 ] || { printf '端口 %s 没有监听器\n' "$port" >&2; exit 1; }
  mapfile -t local_addresses < <(printf '%s\n' "$lines" | awk 'NF {print $4}')
  [ "${#local_addresses[@]}" -eq "$line_count" ] || exit 1
  for local_address in "${local_addresses[@]}"; do
    [ "$local_address" = "127.0.0.1:$port" ] || { printf '端口 %s 存在非 IPv4 回环监听：%s\n' "$port" "$local_address" >&2; exit 1; }
  done
done
```

Windows 块已经从受限 `.env` 解析最终八端口，不允许手工替换。还应以 `docker compose config --format json` 自动确认：十个服务、只有 `host-gateway` 有 `ports`、`backend.internal=true`、只有网关加入 `host-access`。

### 主机防火墙

- 默认拒绝未经批准的入站连接；不要仅依赖应用回环绑定。Windows Defender Firewall/Linux nftables/firewalld 规则由主机安全基线管理并纳入配置审计。
- 不创建将远程地址 DNAT/portproxy/SSH tunnel 到八个回环端口的常驻规则。VPN 本身不提供应用认证或把当前接口变成受支持远程服务。
- 出站只允许补丁、构建和外部备份设计所需的批准 DNS/TLS 目标；运行容器的出站需求必须逐服务记录。`backend` 为 internal 不代表主机或网关的全部出站都已控制。
- 防火墙变更必须记录规则差异、所有者、到期时间和回退；变更后复测八个本机入口和远程不可达性。

## 主机管理员、Docker 与操作账号

访问 Docker daemon、Windows Docker Desktop 管理能力、Linux `/var/run/docker.sock` 或 `docker` 组等价于主机 root/管理员：控制者可挂载主机路径、读取 Compose secret 源、替换镜像或启动特权容器。它不是低权限运维接口。

账号分离要求：

| 身份 | 允许 | 禁止或需单独审批 |
|---|---|---|
| 主机管理员 | OS/Docker 安装、补丁、防火墙、磁盘、时间 | 日常使用共享管理员账号 |
| 发布身份 | 批准 revision、构建、Compose 生命周期、验收 | 无变更单发布、读取不相关客户目录 |
| 只读值班身份 | HTTP/TCP/主机指标、受控日志摘要 | 默认 Docker socket、停止/重建/删除 |
| DBA/恢复身份 | 批准的备份、角色、恢复和迁移证据 | 让应用 runtime 成为 superuser |
| 安全审计身份 | 配置、ACL、镜像/策略/证据只读复核 | 修改运行态后审计自己的变更 |

采用命名个人账号、MFA（平台支持处）、最短授权时段和会话审计；禁止共享密码和永久临时管理员。离职/角色变更立即撤销本机组、Docker、仓库、备份、escrow 和监控访问。至少每月对实际成员与批准清单做差异检查。

Windows 重点核对本机 Administrators、Docker 相关组和敏感目录 ACL：

```powershell
$ErrorActionPreference = 'Stop'
Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | Select-Object Name,ObjectClass,PrincipalSource
Get-LocalGroup -ErrorAction Stop | Where-Object Name -Match 'docker' | ForEach-Object { Get-LocalGroupMember -Group $_.Name -ErrorAction Stop }
Get-Acl -LiteralPath $env:OCC_SECRET_ROOT | Format-List Owner,AreAccessRulesProtected,AccessToString
Get-Acl -LiteralPath $env:OCC_EVIDENCE_ROOT | Format-List Owner,AreAccessRulesProtected,AccessToString
```

Linux：

```bash
set -euo pipefail
getent group docker || true
stat -c '%U:%G %a %n' /var/run/docker.sock
stat -c '%U:%G %a %n' "$OCC_SECRET_ROOT" "$OCC_EVIDENCE_ROOT"
find "$OCC_SECRET_ROOT" -maxdepth 1 -type f -exec stat -c '%U:%G %a %n' {} +
```

## Windows ACL 与 Linux 所有权/模式

### Windows

仓库应由发布管理身份/Administrators 拥有，普通运行用户不可修改发布源码、Dockerfile、Compose、策略、迁移或脚本。密钥、备份、事件证据目录关闭继承，只授权明确部署/备份身份、`SYSTEM` 和本机 Administrators；批准的 Docker 服务 SID仅获得实际需要的读取。

```powershell
$ErrorActionPreference = 'Stop'
$secretRoot = (Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT).Path
$expectedNames = @('postgres-admin-password','postgres-flyway-password','postgres-runtime-password','redis-password','minio-root-user','minio-root-password','minio-app-user','minio-app-password')
$entries = @(Get-ChildItem -LiteralPath $secretRoot -Force)
if ($entries.Count -ne 8 -or (Compare-Object @($expectedNames | Sort-Object) @($entries.Name | Sort-Object))) { throw '密钥目录必须精确包含八个预期文件' }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$systemSid = 'S-1-5-18'; $administratorsSid = 'S-1-5-32-544'
$allowedSids = @($currentSid,$systemSid,$administratorsSid)
$allowedOwnerSids = @($currentSid,$administratorsSid)
$directoryAcl = Get-Acl -LiteralPath $secretRoot
$directoryOwnerSid = $directoryAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$directoryAllowSids = @($directoryAcl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
if (-not $directoryAcl.AreAccessRulesProtected -or $allowedOwnerSids -notcontains $directoryOwnerSid -or (Compare-Object @($allowedSids | Sort-Object) $directoryAllowSids)) { throw '密钥目录 owner/ACL 不是批准的精确集合' }
foreach ($name in $expectedNames) {
  $item = Get-Item -LiteralPath (Join-Path $secretRoot $name) -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0) { throw "$name 必须是非空普通非重解析文件" }
  $acl = Get-Acl -LiteralPath $item.FullName
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowSids = @($acl.Access | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if (-not $acl.AreAccessRulesProtected -or $allowedOwnerSids -notcontains $ownerSid -or (Compare-Object @($allowedSids | Sort-Object) $allowSids)) { throw "$name owner/ACL 不符合精确基线" }
}
```

不要授予 `Everyone`、`Users`、`Authenticated Users`，也不要把密钥移入仓库、同步盘或临时目录。执行 ACL 修复使用[第 03 章的 SID 精确验证器](03-secrets-and-configuration.md)，不能只凭本地化组名输出判断。

### Linux

固定部署时推荐 root 管理只读仓库与 systemd unit；密钥目录 `0700`、密钥文件 `0600`，证据/备份 staging `0700`，新文件使用 `umask 077`。不要混用 root 与普通账号执行 Compose，以免文件所有者、Docker context和生命周期所有者分裂。

```bash
set -euo pipefail
set +x
umask 077
secret_root=$(realpath "$OCC_SECRET_ROOT")
expected=(postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password)
mapfile -t entries < <(find "$secret_root" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
mapfile -t wanted < <(printf '%s\n' "${expected[@]}" | sort)
[ "${#entries[@]}" -eq 8 ] && [ "$(printf '%s\n' "${entries[@]}")" = "$(printf '%s\n' "${wanted[@]}")" ]
test "$(stat -c '%a' "$secret_root")" = 700
test "$(stat -c '%u' "$secret_root")" -eq "$(id -u)"
for name in "${expected[@]}"; do
  path="$secret_root/$name"
  test -f "$path" && test ! -L "$path" && test -s "$path"
  test "$(stat -c '%a' "$path")" = 600
  test "$(stat -c '%u' "$path")" -eq "$(id -u)"
done
```

SELinux/AppArmor 拒绝时修复经批准 label/profile；不得 `chmod 644`、关闭强制访问控制或改用世界可读 bind mount。

## 凭据唯一性、保管与协调轮换

八个文件型值必须部署专用、全部互异；三个 PostgreSQL 密码两两不同，MinIO root/app 用户名和密码分别不同。Core 只持有 runtime/Flyway、Redis 和 MinIO 桶级应用凭据；不得获得 PostgreSQL admin 或 MinIO root。网关、AI、OPA、Kafka 不消费这些密钥。

禁止以下做法：

- 在 `.env`、Compose YAML、Git、工单、聊天、截图、shell history、argv、长期进程环境、日志、支持包或监控标签中保存值。
- 输出值或长期保存值散列；散列仍是敏感元数据。
- 对 PostgreSQL 和临时 Redis 客户端，不得主动把密码放入命令参数；使用隐藏交互、受限 passfile 或容器内短生命周期 secret 读取，并在退出前清除。当前 Compose 的 Redis 服务是明确例外：shell 读取 secret 后展开 `redis-server --requirepass`，长运行进程 argv 含密码。MinIO `mc alias set` 也会让凭据在一次性容器内的 `mc` 进程 argv 中短暂可见；它不是长期进程，但同样禁止并发进程快照、debug trace 和支持包收集。两者都不能宣称零 argv 暴露。
- 只替换主机文件就声称轮换完成。已有 PostgreSQL 角色、Redis进程、MinIO IAM 和运行容器不会统一自动重读。

轮换必须遵循：验证备份与维护窗口，生成受限 staged 文件，保留受限旧值回退，先协调服务端状态，再原子替换文件并重建消费者，验证新值和最小权限，最后撤销/销毁旧值。PostgreSQL、Redis、MinIO 的准确顺序和部分失败回退以[第 03 章](03-secrets-and-configuration.md)为唯一操作规程。

轮换周期由风险、合规、人员变更和事件决定，不在手册虚构固定天数。疑似泄露时立即隔离访问并轮换所有可能派生/复用的凭据，但仍不能跳过协调顺序或备份。

**Redis 残余风险：** 能检查宿主/容器进程的主机管理员、Docker daemon/socket控制者具有 root 等价能力，可能读取当前 Redis argv。补偿控制是严格限制这些身份、审计会话、禁止支持包收集任何进程命令行、按事件/人员变更协调轮换 Redis密码，并保持 `requirepass`。生产使用前必须由安全负责人书面接受该风险或批准整改；将密码从长运行 argv移出需要单独设计并测试兼容启动、health、轮换和恢复，不是现场关闭认证或临时改命令。

**MinIO 短时 argv 风险：** 备份、恢复、初始化和 IAM 验证使用固定 digest 的短生命周期 `minio/mc` 容器；`mc alias set` 的用户名和密码会短暂出现在容器内 argv。只在持有全局锁的受控窗口执行，禁止主机/容器进程命令采集和 shell trace，命令不输出 alias 配置，容器退出即销毁其临时配置。Docker/root 等价身份仍可读取挂载 secret，因此该补偿控制不构成对管理员的机密边界。

## 不在 env、argv、日志和支持包中泄密

运行配置只允许 `infra/compose/.env` 保存八个绝对文件路径和十二个非敏感覆盖。检查进程和 Compose 时不使用会展开敏感环境/挂载的完整 `docker inspect`，也不收集主机或容器进程命令行；普通支持包不包含 Compose `config`，因为它会暴露主机密钥路径。该限制是当前 Redis argv残余风险的必要补偿控制，不代表管理员无法读取 argv。

日志控制要求：

- Core 的错误响应保持 `include-message/stacktrace/exception/binding-errors` 不外显；不得为诊断长期开放。
- AI 日志级别按批准值运行；提高到 debug/trace 前评估敏感信息和磁盘，窗口后恢复并验证。
- Docker daemon 日志驱动与轮转是主机级变更，影响其他容器，须审批、容量与保留评审。
- 原始日志作为敏感证据受限保存；移交副本不可逆遮盖密码、token、认证头、用户名、客户数据、对象键、内部地址和绝对路径，并由第二人复核。
- 支持包只有收集命令成功、写入 `COMPLETE`、ACL/mode 合格、人工脱敏复核后才能移交；`COMPLETE` 本身不证明已脱敏。

## 软件供应链与发布完整性

### npm 与 Electron

唯一批准的安装入口是：

```powershell
npm run install:verified
if ($LASTEXITCODE -ne 0) { throw '经过来源验证的 npm 安装失败' }
npm audit --audit-level=high
if ($LASTEXITCODE -ne 0) { throw 'npm 高严重性审计未通过或审计不可用' }
```

```bash
set -euo pipefail
npm run install:verified
npm audit --audit-level=high
```

`install:verified` 先运行 Electron provenance guard，再以 lockfile执行 `npm ci --registry https://registry.npmjs.org` 并使用仓库内 cache。守卫拒绝继承的 Electron mirror/base URL/custom checksum/download override、本地 zip、绕过 checksum、自定义 downloader和第三方 Electron URL；当前只接受固定官方 GitHub Electron `43.2.0` release asset/SHASUMS。普通 `npm install`、私自镜像、`--ignore-scripts` 的语义改写或审计不可用时继续发布均不受支持。

`npm audit` 是漏洞信号，不是来源证明；发现问题必须结合可利用性、运行边界、修复版本和回归验证。不能通过删除 lockfile、强制不兼容 major 或审计排除来“清零”。组织要求包签名/attestation 时，应在批准 registry/CI中验证并把不可变结果关联 release commit；当前仓库命令不能替代该外部签名控制。

### Gradle、JDK 与 keyring

Core 构建必须使用 wrapper、Java 21 toolchain和严格 dependency verification：

```powershell
./gradlew.bat :services:core:build --dependency-verification strict
if ($LASTEXITCODE -ne 0) { throw 'Gradle strict 构建失败' }
```

```bash
set -euo pipefail
./gradlew :services:core:build --dependency-verification strict
```

`gradle/verification-metadata.xml` 启用 metadata 与 signature 验证，并维护 trusted/ignored key及 checksum fallback。该文件和 Gradle trusted keyring属于安全基线：新增 artifact、checksum、trusted key、ignored key 或 fallback reason必须由依赖所有者和安全评审，关联上游签名/发布证据；不得临时关闭 strict、全局信任未知 key 或自动接受构建机生成的差异。

### Docker 镜像与构建

六个外部服务镜像必须同时保留可读 tag 和 `@sha256:<digest>`；四个本地构建服务 `opa`、`ai`、`core`、`host-gateway` 以 release commit、本地 image ID、Dockerfile和构建证据关联。拉取前验证 registry/TLS，发布前从运行容器记录实际 image ID。

```powershell
& docker @ComposeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose config 失败' }
& docker @ComposeArgs images
if ($LASTEXITCODE -ne 0) { throw '镜像身份查询失败' }
```

```bash
set -euo pipefail
"${compose[@]}" config --quiet
"${compose[@]}" images
```

tag 不是身份；本地 rollback tag 也不是异地供应链。批准 registry应保留 release digest/签名或 attestation，部署门禁验证 signer、repository、digest、构建来源和 policy。当前 Compose 固定 digest不能自动证明 registry 签名，外部签名验证必须由组织工具补充且失败关闭。

### OPA 策略

Compose OPA 镜像构建固定 OPA `1.5.1` 与 digest，入口在启动 server 前执行 `opa check --strict /policies`；host 发布验证还必须运行真实 OPA：

```powershell
$env:OPA_PATH = (Get-Command opa -CommandType Application -ErrorAction Stop).Source
opa check --strict policies/opa; if ($LASTEXITCODE -ne 0) { throw 'OPA strict 失败' }
opa test policies/opa; if ($LASTEXITCODE -ne 0) { throw 'OPA test 失败' }
npm run verify:full; if ($LASTEXITCODE -ne 0) { throw '严格发布验证失败' }
Remove-Item Env:OPA_PATH
```

```bash
set -euo pipefail
export OPA_PATH="$(command -v opa)"
opa check --strict policies/opa
opa test policies/opa
npm run verify:full
unset OPA_PATH
```

基线策略默认拒绝，无效输入拒绝，显式 deny优先；只有无基线拒绝、无匹配 deny且至少一个匹配 allow时允许。策略目录只读挂载，策略 revision与应用 release共同审计。不能用 mock、空脚本或跳过的测试替代真实 OPA。

## 补丁与漏洞管理边界

每月至少审查 OS、Docker Desktop/Engine/Compose、WSL2/内核、Node/npm、JDK/Gradle、Electron、OPA、基础镜像、Core依赖和数据库扩展公告；重大在野利用按组织紧急时限处理。扫描输入必须包括 source lockfile、Gradle graph、Dockerfile和实际运行 image ID/digest，不能只扫仓库 tag。

处置流程：确认资产与可利用路径，记录 CVE/公告、严重性、暴露组件和补丁候选；在隔离环境执行来源验证、`verify:full`、构建、迁移评审和恢复验证；按[升级与回滚](08-upgrade-and-rollback.md)发布；验证实际运行版本并关闭旧镜像保留策略。没有上游修复时采用经批准的最小暴露缓解和期限性风险接受，不能关闭认证、OPA、TLS或审计。

当前手册不宣称自动漏洞扫描、SBOM签名、镜像签名策略引擎或自动补丁已部署。组织工具输出必须关联 release commit/image digest，限制访问并纳入审计。

## 日志、审计与证据

至少保留：登录与提权、Docker/系统服务生命周期、防火墙、文件 ACL/mode、发布 revision/image ID/digest、依赖/签名验证、Compose状态、密钥 escrow/轮换版本、OPA策略 revision和重要决策 reason、数据库迁移历史、备份/恢复/外部 WORM验证、事件时间线与审批。

证据要求：

- UTC、主机资产、个人操作者、变更/事件号、命令和退出状态齐全；失败输出不能被后续成功覆盖。
- 原始证据写入访问受限、加密且有保留策略的位置；需要抗篡改时发送到权限分离的 off-host immutable/WORM或签名系统。
- 本机 checksum只能发现意外变化；能写文件的人也能重写 manifest。恶意篡改抵抗必须依赖权限分离和外部验证。
- 审计读取者与运行修改者尽量分离；任何审计缺口、时间漂移或日志清理都形成事件。

## 备份安全、加密与恢复访问

[第 07 章](07-backup-restore-and-dr.md)定义完整备份集合。安全控制在其上增加：

- staging、传输和静态介质使用组织批准加密；密钥由独立 KMS/HSM/escrow管理，不与备份集合、manifest或恢复脚本同存。
- 每个集合具有最小读写身份、双人恢复/删除审批和保留/法务冻结；日常发布身份不应能单独删除 WORM副本。
- 至少一个副本在主机故障域之外，采用 immutable/WORM/object lock或 detached signature，并由外部系统实时重验 record ID/version；同主机副本不是 DR。
- 备份包含 PostgreSQL逻辑 dump、MinIO对象、声明的 Redis/Kafka disposition、配置路径、revision/image和独立 secret escrow收据；不把 live volume copy称为一致备份。
- 恢复凭据只在批准窗口取回，使用受限临时材料，完成后轮换/销毁；恢复人员不能把生产密钥带入普通测试环境。
- 每季度隔离恢复并实测 RPO/RTO、owner/grants/Flyway/Flowable、对象/IAM、协议和数据抽样；未演练的备份不能作为可恢复声明。

备份或加密密钥疑似泄露时，先撤销访问、冻结不可变记录并保存审计，再评估数据范围和法律通知；轮换密钥不能改写已泄露历史副本的事实。

## 出站、DNS 与时间

只允许批准的 Docker registry/auth、npm、Maven Central、Gradle distribution/plugin portal、GitHub Electron release及外部备份/监控目标。使用域名允许列表时同时评估 CDN、重定向和代理；不能因 IP变化关闭 TLS。运行容器无已证明出站需求时保持网络最小化，新增外部 AI/对象/消息服务属于架构变更。

DNS 使用组织批准解析器并监控变更；TLS必须验证链、主体、有效期和重定向，禁止 insecure。代理凭据不进入 URL、argv、Dockerfile或日志。时间通过批准 NTP/W32Time源同步，漂移超过组织阈值停止发布、恢复切换和凭据轮换；容器不单独手工改时。

## 远程访问默认禁止

当前 Compose 不提供受支持远程访问。禁止把网关或后端改绑 `0.0.0.0`、LAN/公网地址，禁止直接暴露 PostgreSQL、Kafka、Redis、MinIO API/Console、OPA、AI或Core，也禁止用临时端口转发当生产方案。

若业务确需远程访问，必须先完成独立外部接入设计、威胁建模和渗透/负载/恢复验证。最低要求全部满足后才能更新支持边界：

1. 由受维护的外部 TLS reverse proxy/API gateway终止 TLS 1.2+和组织批准 cipher，自动证书生命周期与 OCSP/吊销策略明确；到后端仍有受控网络和必要的 TLS/身份保证。
2. 强身份认证、MFA/企业 IdP、短会话、明确登出/撤销；认证与 OPA授权分离，服务端每次敏感操作仍以权威事实决策。
3. 最小路由白名单，只发布明确业务 API；永不代理数据库、Kafka、Redis、MinIO管理、OPA、health管理细节或Docker socket。
4. 按身份/IP/租户/操作的速率限制、请求体/头大小、超时、并发、重放和滥用防护；错误响应不泄露内部异常。
5. 端到端审计包含身份、关联 ID、动作、结果和授权 reason，敏感字段遮盖；日志进入权限分离的集中存储。
6. 网络分区、防火墙/WAF（如适用）、管理面独立、DDoS与容量设计；默认拒绝，不允许绕过 proxy直达回环转发。
7. 密钥/证书使用批准 KMS/secret manager并可协调轮换；私钥不进入镜像、Compose env或普通文件包。
8. 明确 owner、SLO、告警、事件响应、补丁、备份、灾备、回退和外部安全评审；完成桌面客户端信任/更新设计。

这些要求不是现成配置，也不表示仓库已支持远程访问。设计批准前保持仅本机。

## 禁止直接暴露与权限边界

- PostgreSQL只由 Core runtime/Flyway和受控 DBA访问；桌面、AI、OPA不得直写数据库。runtime非 superuser且除 `flowable` 外无 schema `CREATE`。
- MinIO root只用于服务启动、初始化和受控备份；Core只用桶级应用账号。Console不作为常规远程管理入口。
- OPA只接收最小决策事实，不保存业务事实；调用方不能把允许结果当永久授权缓存，也不能在 OPA不可用时默认允许。
- Kafka/Redis不是业务权威主存储；不能通过直接外部写入绕过 Core事务/授权边界。
- `host-gateway`不消费密钥、不挂载卷，保持非 root、只读根文件系统、drop ALL capabilities和 `no-new-privileges`。

## HA 与 Kubernetes 不受支持

当前单节点 Compose 没有复制、leader election、多副本迁移协调、共享会话、分布式锁、跨节点密钥/策略/备份一致性或流量切换。增加第二个容器或把 YAML 转为 Kubernetes不产生 HA。

任何 HA/Kubernetes/服务网格方案都必须重新设计 PostgreSQL/Kafka/Redis/MinIO拓扑、Core/Flyway单写迁移、Flowable调度、AI/OPA扩展、持久卷、网络策略、TLS/身份、secret provider、Pod安全、备份恢复、升级回滚、可观测性和故障注入。完成独立支持声明前，本手册命令和容量结论不适用。

## 安全事件隔离且不削弱控制

疑似凭据、镜像、策略、主机或数据泄露时：建立安全事件、限制远程入口/受影响账号、停止受影响业务写入、保留内存/日志/磁盘/外部审计证据、冻结备份和发布记录，按影响协调凭据轮换和可信重建。隔离可以停止服务或收紧访问，但不能通过关闭认证/TLS/OPA/health、放宽 ACL、启用未知镜像或删除日志恢复可用性。

如果 Docker主机失陷，容器内密钥和本机备份均视为可能失陷；不要在同一主机“清理后继续”。从可信介质重建主机，使用受保护 release/digest和 off-host不可变备份，在隔离环境验证，轮换全部可访问凭据后再切换。详细服务诊断使用[第 09 章](09-incident-runbooks.md)。

## 安全评审检查单

- [ ] 威胁模型、客户/主机范围、数据分类、责任人和例外到期日已批准。
- [ ] 只有 `host-gateway` 发布八个 IPv4回环端口；`backend` internal，后端未加入 `host-access`。
- [ ] 主机防火墙默认拒绝；无端口转发、远程隧道、未批准出站或直达后端。
- [ ] 管理员、Docker、发布、DBA、备份、审计身份分离；成员、MFA和离职撤销已复核。
- [ ] Windows ACL/Linux owner/mode、SELinux/AppArmor和仓库只读边界通过精确检查。
- [ ] 八密钥互异、消费者最小、外部 escrow有效；轮换/部分失败回退已演练。
- [ ] `.env`、环境、日志、支持包、监控和工单无密钥值，支持包无进程命令行；已识别 Redis长运行 argv例外并完成生产风险接受/整改决策。
- [ ] `install:verified`、npm漏洞评审、Electron官方来源守卫、Gradle strict/keyring、真实 OPA strict/test和 `verify:full` 全通过。
- [ ] 外部镜像 tag+digest、本地 image ID+release revision以及组织镜像签名/attestation证据一致。
- [ ] OS/Docker/依赖/镜像漏洞与补丁在批准时限内；任何风险接受有补救日期。
- [ ] 备份传输/静态加密、独立密钥、off-host immutable/WORM、权限分离和季度恢复通过。
- [ ] DNS、TLS、出站和时间同步通过；未使用 insecure、第三方临时源或手工校时。
- [ ] 远程访问保持禁止，或独立设计的 proxy/TLS/认证/限流/审计已完成正式支持评审。
- [ ] PostgreSQL、MinIO、OPA、Docker socket无直接远程暴露；OPA异常时敏感操作失败关闭。
- [ ] 没有把单节点、额外副本或 Kubernetes转换宣称为 HA。
- [ ] 安全事件联系人、可信重建、凭据轮换、证据保全和法务/通知流程已演练。
