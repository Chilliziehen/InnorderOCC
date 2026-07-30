# 部署前检查与容量规划

本章用于在创建密钥、拉取镜像或启动容器前形成可审计的通过/失败结论。Windows 与 Linux 检查项等价；命令按目标主机选择一套执行。

## 判定原则

- **安全：** 预检默认只读，不应启动或停止现有容器。
- **注意：** 网络、磁盘和端口结果必须在计划部署时段复测；一次快照不能证明持续可用。
- **验证：** 任一强制项失败即停止部署。容量基线不足、端口占用、Linux 容器不可用、Engine 不可连接、密钥目录不安全均为失败。

## 操作系统、架构和工具链

当前镜像来源已经核对 Linux/AMD64 平台；Windows 主机必须通过 Docker Desktop/WSL2 运行 Linux 容器。当前 Electron 打包范围是 Windows x64，但 Compose 服务与桌面打包是不同边界。

### Windows PowerShell 5.1

```powershell
$PSVersionTable
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, LastBootUpTime
Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, SystemType, HypervisorPresent
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

docker version
docker compose version
docker info --format '{{json .}}'
docker info --format 'OSType={{.OSType}} Architecture={{.Architecture}} CPUs={{.NCPU}} Memory={{.MemTotal}}'

if ([string]::IsNullOrWhiteSpace($env:OCC_REPOSITORY_ROOT)) { throw '必须设置 OCC_REPOSITORY_ROOT' }
git -c "safe.directory=$env:OCC_REPOSITORY_ROOT" rev-parse HEAD
git -c "safe.directory=$env:OCC_REPOSITORY_ROOT" status --short
node --version
npm --version
Get-Command psql -ErrorAction Stop | Select-Object -ExpandProperty Source
psql --version
java -version
./gradlew.bat --version
./gradlew.bat :services:core:compileKotlin :services:core:compileJava --dependency-verification strict --info
opa version
```

通过标准：PowerShell 主版本为 5；Docker Client 与 Server 均响应；`docker compose version` 是 v2；`OSType=linux`；架构为 `x86_64`/AMD64；Node.js 至少 22；host `psql` 客户端可从 PATH 执行并报告版本；wrapper 报告 Gradle 8.14.3；严格编译任务成功解析 Java 21 toolchain 并完成 Core 的 JVM 21 编译；严格发布验证所用 OPA 能真实执行。

Gradle 8.14.3 的 launcher 可运行在 Java 17-24，launcher 版本不等于 Core 编译版本。Windows `gradlew.bat` 检测到当前 Java 25 或更高版本时，会调用仓库选择器，从 `GRADLE_JAVA_HOME`、`JAVA_HOME`、`PATH`、Gradle 缓存和常见本地安装位置选择 Java 17-24；若没有兼容候选则失败。Core 的 Java 与 Kotlin toolchain 均固定为 Java 21，因此只有上述严格 `compileKotlin`/`compileJava` 成功，才证明 Java 21 toolchain 已解析；`java -version` 或 `gradlew --version` 单独不能证明这一点。

### Linux Bash

```bash
set -o pipefail
uname -a
uname -m
cat /etc/os-release
getconf LONG_BIT

docker version
docker compose version
docker info --format '{{json .}}'
docker info --format 'OSType={{.OSType}} Architecture={{.Architecture}} CPUs={{.NCPU}} Memory={{.MemTotal}}'

git rev-parse HEAD
git status --short
node --version
npm --version
command -v psql
psql --version
java -version
./gradlew --version
./gradlew :services:core:compileKotlin :services:core:compileJava --dependency-verification strict --info
opa version
```

通过标准与 Windows 相同。Gradle launcher 必须使用 Java 17-24，Core 严格编译必须解析 Java 21 toolchain。`uname -m` 应为 `x86_64`；非 AMD64 环境必须重新验证每个固定 digest 的平台清单和所有本地构建镜像，未经验证不得部署。

Compose 启动本身不依赖 host `psql`，因此缺少客户端时容器仍可能启动；但 PostgreSQL 凭据轮换、独立协议验证和故障恢复依赖 host `psql`，完整运维就绪检查必须判为失败。

### Git 状态解释

记录 revision 和 `git status --short` 的完整结果。工作区不干净并非自动失败，但必须逐项确认变更属于本次发布、经过评审且不会使证据无法复现。不得通过重置工作区来掩盖未知变更。

## Docker Engine 与 Linux 容器

### Windows Docker Desktop 和 WSL2

```powershell
wsl.exe --status
wsl.exe --version
wsl.exe --list --verbose
docker context show
docker context ls
docker run --rm alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c uname -m
```

**验证：** Docker context 指向预期 Engine；测试容器输出 AMD64 对应架构；Docker Desktop 使用 Linux containers。若命令要求切换 Windows containers，当前 Compose 不可部署。

在 Docker Desktop 的 Resources 页面记录分配 CPU、内存和磁盘镜像上限。若使用 WSL 配置限制，还应由管理员检查用户配置中的 `memory`、`processors`、`swap` 和虚拟磁盘剩余空间。界面显示值与 `docker info` 不一致时，以 Engine 实际值作为容量判定，并调查限制来源。

### Linux Engine

```bash
docker context show
docker context ls
docker info --format 'Root={{.DockerRootDir}} Driver={{.Driver}} Cgroup={{.CgroupVersion}}'
docker run --rm alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c uname -m
systemctl is-active docker
```

**验证：** Engine 服务 active，存储驱动和 Docker root 位于计划磁盘，测试容器可运行。rootless 或远程 context 若未在部署设计中明确，不得默认视为等价环境。

## CPU、内存和磁盘

### Windows 检查

```powershell
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory, TotalVisibleMemorySize
Get-Volume | Select-Object DriveLetter, FileSystem, HealthStatus, Size, SizeRemaining
docker system df
docker info --format 'CPUs={{.NCPU}} MemoryBytes={{.MemTotal}} DockerRoot={{.DockerRootDir}}'
```

### Linux 检查

```bash
nproc
lscpu
free -h
df -hT
df -ih
docker system df
docker info --format 'CPUs={{.NCPU}} MemoryBytes={{.MemTotal}} DockerRoot={{.DockerRootDir}}'
```

### 初始规划基线

以下数字是**初始规划基线**，只用于预留主机资源，不是吞吐、延迟、并发、RPO 或 SLA 承诺。磁盘预算是部署初始可用空间，尚未包含备份副本、日志峰值和业务长期增长。

| 指示级别 | 建议用途 | 可供 Docker 的 CPU | 可供 Docker 的内存 | 初始可用磁盘 | 说明 |
|---|---|---:|---:|---:|---|
| 小型 | 开发、短期功能验证 | 4 vCPU | 8 GiB | 60 GiB | 不作为生产容量结论；构建与 Kafka 峰值可能争用 |
| 常规 | 受控单客户试点 | 8 vCPU | 16 GiB | 150 GiB | 为构建、数据库、Kafka、MinIO 和短期增长留余量 |
| 大型 | 较高数据量的单节点验证 | 16 vCPU | 32 GiB | 500 GiB | 仍是单点，不因资源增大而获得 HA |

建议持续保留至少 25% 内存余量、30% 文件系统空间和足够 inode；构建期间应按峰值而非稳定态判定。PostgreSQL、Kafka 和 MinIO 数据增长必须分别建模，不能只看 Docker 总量。

**验证：** 任何真实试点或生产候选都必须使用代表性数据量、对象大小、并发、事件速率和保留期做负载测试与恢复测试。依据 p95/p99 延迟、错误率、CPU、内存、I/O、卷增长和恢复时间重新定容；未完成负载测试时只能标记为容量未验收。

## 时间同步

审计、Kafka、数据库和关联 ID 分析依赖一致时间。

### Windows

```powershell
Get-Date -Format o
w32tm /query /status
w32tm /query /source
Get-TimeZone
```

### Linux

```bash
date --iso-8601=seconds
timedatectl status
timedatectl timesync-status
```

**验证：** 时间同步已启用且状态正常，时区已记录。时间偏差超过组织阈值时停止部署；不得用手工修改时间绕过同步故障。

## DNS 与官方 TLS 端点

构建可能访问 Docker registry 与认证服务、npm registry、Maven Central、Gradle 分发与插件门户、GitHub 和固定 Electron release asset。检查必须完成 DNS 解析和真实 HTTPS 请求；只证明 TCP 443 可连接不够。以下脚本会汇总失败并以非零状态结束，不代表允许绕过组织代理。

### Windows

```powershell
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$checks = @(
  [pscustomobject]@{ Name='docker-registry'; Uri='https://registry-1.docker.io/v2/'; Method='Get'; Allowed=@(401) }
  [pscustomobject]@{ Name='docker-auth'; Uri='https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull'; Method='Get'; Allowed=@(200) }
  [pscustomobject]@{ Name='npm'; Uri='https://registry.npmjs.org/-/ping'; Method='Get'; Allowed=@(200) }
  [pscustomobject]@{ Name='maven-central'; Uri='https://repo.maven.apache.org/maven2/'; Method='Get'; Allowed=@(200) }
  [pscustomobject]@{ Name='gradle-distribution'; Uri='https://services.gradle.org/distributions/gradle-8.14.3-bin.zip'; Method='Head'; Allowed=@(200) }
  [pscustomobject]@{ Name='gradle-plugin-portal'; Uri='https://plugins.gradle.org/m2/'; Method='Get'; Allowed=@(200) }
  [pscustomobject]@{ Name='github'; Uri='https://github.com/'; Method='Get'; Allowed=@(200) }
  [pscustomobject]@{ Name='electron-release-asset'; Uri='https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-win32-x64.zip'; Method='Head'; Allowed=@(200) }
)
$failures = New-Object System.Collections.Generic.List[string]
foreach ($check in $checks) {
  try {
    $hostName = ([Uri]$check.Uri).DnsSafeHost
    Resolve-DnsName -Name $hostName -ErrorAction Stop | Out-Null
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $check.Uri -Method $check.Method -MaximumRedirection 10 -TimeoutSec 30
      $status = [int]$response.StatusCode
    } catch [System.Net.WebException] {
      if ($null -eq $_.Exception.Response) { throw }
      $status = [int]$_.Exception.Response.StatusCode
    }
    if ($check.Allowed -notcontains $status) { $failures.Add("$($check.Name): HTTP $status") }
  } catch {
    $failures.Add("$($check.Name): $($_.Exception.Message)")
  }
}
if ($failures.Count -gt 0) { $failures | ForEach-Object { [Console]::Error.WriteLine($_) }; exit 1 }
Write-Output '全部官方 DNS/TLS 端点检查通过'
```

Docker registry `/v2/` 的未认证预期是 HTTP 401；其余检查跟随重定向后必须得到 HTTP 200。证书、DNS、重定向或状态不符合预期都会使脚本失败。

### Linux

```bash
set -euo pipefail
failures=0
check_https() {
  name=$1
  method=$2
  url=$3
  expected=$4
  host=${url#https://}
  host=${host%%/*}
  if ! getent ahosts "$host" >/dev/null; then
    printf '%s: DNS 解析失败\n' "$name" >&2
    failures=$((failures + 1))
    return
  fi
  curl_args=(--silent --show-error --location --max-time 30 --output /dev/null --write-out '%{http_code}')
  if [ "$method" = HEAD ]; then curl_args+=(--head); fi
  if ! status=$(curl "${curl_args[@]}" "$url"); then
    printf '%s: HTTPS 请求失败\n' "$name" >&2
    failures=$((failures + 1))
  elif [ "$status" != "$expected" ]; then
    printf '%s: HTTP %s，预期 %s\n' "$name" "$status" "$expected" >&2
    failures=$((failures + 1))
  fi
}
check_https docker-registry GET 'https://registry-1.docker.io/v2/' 401
check_https docker-auth GET 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull' 200
check_https npm GET 'https://registry.npmjs.org/-/ping' 200
check_https maven-central GET 'https://repo.maven.apache.org/maven2/' 200
check_https gradle-distribution HEAD 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip' 200
check_https gradle-plugin-portal GET 'https://plugins.gradle.org/m2/' 200
check_https github GET 'https://github.com/' 200
check_https electron-release-asset HEAD 'https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-win32-x64.zip' 200
if [ "$failures" -ne 0 ]; then exit 1; fi
printf '全部官方 DNS/TLS 端点检查通过\n'
```

**注意：** TLS 检查失败时先确认企业代理和受信 CA。不得关闭证书校验、配置不受控镜像或替换下载源来获得表面通过。

## 八个端口的占用检查

计划端口为 `5432`、`9092`、`6379`、`9000`、`9001`、`8181`、`3100`、`8080`。如果 `.env` 覆盖端口，应使用最终值重跑全部检查。

### Windows

```powershell
$ports = 5432,9092,6379,9000,9001,8181,3100,8080
$allListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
$allListeners |
  Where-Object { $ports -contains $_.LocalPort } |
  Sort-Object LocalPort |
  Select-Object LocalAddress, LocalPort, OwningProcess
$occupiedPorts = @()
$results = foreach ($port in $ports) {
  $listeners = @($allListeners | Where-Object LocalPort -eq $port)
  $available = $listeners.Count -eq 0
  if (-not $available) { $occupiedPorts += $port }
  [pscustomobject]@{
    Port = $port
    Available = $available
    Status = if ($available) { 'PASS available' } else { 'FAIL occupied' }
  }
}
$results | Format-Table -AutoSize
if ($occupiedPorts.Count -gt 0) { throw "端口被占用: $($occupiedPorts -join ', ')" }
```

### Linux

```bash
set -euo pipefail
occupied_ports=()
for port in 5432 9092 6379 9000 9001 8181 3100 8080; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    printf 'FAIL port %s is occupied\n' "$port"
    occupied_ports+=("$port")
  else
    printf 'PASS port %s is available\n' "$port"
  fi
done
if [ "${#occupied_ports[@]}" -gt 0 ]; then
  printf 'FAIL occupied required ports: %s\n' "${occupied_ports[*]}" >&2
  exit 1
fi
printf 'PASS all required ports are available\n'
```

**验证：** 部署前所有最终主机端口都可绑定 `127.0.0.1`。占用端口只能通过审批后的端口覆盖或协调现有所有者解决；不得终止未知进程。

## 文件系统与密钥卷规划

密钥必须位于仓库外、非临时、受备份/恢复政策明确管理的本地文件系统。Docker Engine 服务账号必须能读取文件，普通用户不能读取。不要使用网络共享、同步盘、下载目录或世界可读目录。

### Windows

```powershell
$repositoryRoot = Resolve-Path -LiteralPath $env:OCC_REPOSITORY_ROOT
$secretRoot = Resolve-Path -LiteralPath $env:OCC_SECRET_ROOT
Get-Item $repositoryRoot, $secretRoot | Select-Object FullName, Attributes
Get-Acl $secretRoot | Format-List Owner, AccessToString, AreAccessRulesProtected
Get-Volume | Select-Object DriveLetter, FileSystem, HealthStatus, SizeRemaining
docker info --format '{{.DockerRootDir}}'
```

确认密钥目录不是仓库子目录，也不是用户临时目录。Windows Docker Desktop 必须能从该持久目录读取文件；组织策略禁止共享该位置时，应先解决访问模型，而不是放宽到所有用户。

### Linux

```bash
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
secret_root=$(realpath "$OCC_SECRET_ROOT")
printf 'Repository: %s\nSecrets: %s\n' "$repository_root" "$secret_root"
findmnt -T "$repository_root"
findmnt -T "$secret_root"
stat -c '%U:%G %a %n' "$secret_root"
df -hT "$repository_root" "$secret_root"
df -ih "$repository_root" "$secret_root"
docker info --format '{{.DockerRootDir}}'
```

**验证：** 密钥目录权限计划为目录 `0700`、文件 `0600`；路径稳定且重启后仍存在；Docker 数据根和命名卷所在文件系统容量满足基线；备份工具不会把密钥与普通日志混放。

## 发布验证

### Windows

```powershell
$env:OPA_PATH = (Get-Command opa -ErrorAction Stop).Source
npm run verify:full
Remove-Item Env:OPA_PATH
```

### Linux

```bash
export OPA_PATH="$(command -v opa)"
npm run verify:full
unset OPA_PATH
```

**验证：** 命令成功结束，Docker 集成与 OPA 测试没有 skipped。失败日志必须保留并解决；`verify` 或允许跳过的 `verify:local` 不能替代发布候选的严格结果。

## 通过/失败检查单

| 检查项 | 通过标准 | 失败处置 |
|---|---|---|
| 平台 | Linux/AMD64 容器可运行 | 停止，重新确认平台支持 |
| Docker | Engine 可连接、Compose v2 | 修复服务/context |
| 源码 | revision 已记录，变更已解释 | 完成评审和发布固定 |
| Node/npm | Node 至少 22，npm 与 lockfile 兼容 | 使用批准工具链 |
| PostgreSQL 客户端 | host `psql` 可执行并报告版本 | 安装组织批准的客户端；运维就绪失败 |
| JDK/Gradle | launcher Java 17-24，wrapper 8.14.3，Core Java 21 严格编译成功 | 修复 launcher/toolchain |
| OPA | 真实可执行文件运行 | 安装并记录来源 |
| 资源 | 达到选定初始基线且保留余量 | 扩容或缩小范围 |
| 时间 | 同步正常、时区已记录 | 修复时间源 |
| DNS/TLS | 官方端点按策略可达且证书有效 | 修复 DNS/代理/CA |
| 端口 | 八个最终回环端口可用 | 协调占用或批准覆盖 |
| 文件系统 | 容量、inode、持久性符合要求 | 调整存储计划 |
| 密钥目录 | 仓库外、非临时、最小权限 | 重建安全目录 |
| 严格验证 | `verify:full` 无失败、无跳过 | 修复后重跑 |

只有全部强制项通过并由变更审批人签字，才进入密钥和启动阶段。

## 证据收集

证据包应使用组织批准的受控目录，至少包含：

- 检查时间、操作员、主机资产标识和变更单号。
- Git revision、已评审的工作区状态和发布版本。
- OS/架构、Docker/Compose、Node/npm、host `psql`、JDK/Gradle、OPA 版本。
- Docker 实际 CPU/内存、主机磁盘/inode、选定容量级别和负载测试引用。
- 时间同步、DNS/TLS 结论、端口检查和文件系统结论。
- `verify:full` 退出状态及脱敏日志。
- 例外、风险接受人、有效期和补救日期。

### Windows 收集框架

```powershell
$evidence = Resolve-Path -LiteralPath $env:OCC_EVIDENCE_ROOT
git -c "safe.directory=$env:OCC_REPOSITORY_ROOT" rev-parse HEAD | Out-File (Join-Path $evidence 'git-revision.txt') -Encoding ascii
docker version | Out-File (Join-Path $evidence 'docker-version.txt') -Encoding utf8
docker compose version | Out-File (Join-Path $evidence 'compose-version.txt') -Encoding utf8
npm run verify:full *> (Join-Path $evidence 'verify-full.txt')
```

### Linux 收集框架

```bash
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
evidence=$(realpath "$OCC_EVIDENCE_ROOT")
git rev-parse HEAD >"$evidence/git-revision.txt"
docker version >"$evidence/docker-version.txt"
docker compose version >"$evidence/compose-version.txt"
npm run verify:full >"$evidence/verify-full.txt" 2>&1
```

**安全：** 不收集 `.env` 内容、密钥文件、完整环境变量、认证头或 Docker inspect 中的敏感挂载详情。提交证据前人工脱敏并限制访问权限。
