# Linux 部署操作规程

本章是在 Linux AMD64 主机上部署当前单客户、单节点 Compose 栈的完整 Bash 操作票。目标平台是 Docker Engine、Docker Compose v2 plugin、Bash 和 systemd；全部仓库命令从仓库根目录执行。先阅读[架构、所有权与故障边界](01-architecture-and-boundaries.md)，并把[部署前检查与容量规划](02-preflight-and-capacity.md)和[密钥与配置管理](03-secrets-and-configuration.md)作为强制门禁。

## 前置条件、权限与严格会话

### Docker 权限和文件所有权边界

- Docker daemon 通常以 root 运行。能访问 `/var/run/docker.sock`、属于 `docker` 组或能执行相关 `sudo` 的账号，可以挂载主机文件、启动特权容器并获得等价 root 的主机控制；`docker` 组不是低权限授权边界。
- 系统管理员负责 Docker Engine/Compose plugin 安装升级、systemd、磁盘、时间、防火墙、服务账号和 `/etc/innorder-occ` 权限。部署操作员负责批准 revision、来源验证、构建、启动和验收。日常只读值班账号不应默认加入 `docker` 组。
- 本章交互流程假定当前批准账号直接执行 `docker`。若组织要求 `sudo docker`，应在审批的非交互运行模型中统一配置；不要只给部分命令加 `sudo`，否则会生成混合所有权文件并使 systemd 与人工操作控制不同的 Engine/context。
- 推荐固定仓库为 `/opt/innorder-occ`，外部密钥为 `/etc/innorder-occ/secrets`，证据为 `/var/lib/innorder-occ/evidence`。systemd 部分以这些精确路径运行；采用其他路径需要作为部署设计变更同步修改 unit 和路径环境文件，不能靠交互 shell 的 `cd`、alias 或 PATH 补偿。

每个新 Bash 会话先由批准的会话配置设置三个绝对路径，再运行独立初始化。严格模式使未设置变量、失败命令和管道中间失败立即终止；`umask 077` 防止新证据或配置被组/其他用户读取。

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
secret_root=$(realpath "$OCC_SECRET_ROOT")
evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
cd -- "$repository_root"
test -f package.json
compose_file="$repository_root/infra/compose/compose.yml"
compose_env="$repository_root/infra/compose/.env"
compose=(docker compose --env-file "$compose_env" -f "$compose_file")
lifecycle_lock_path="$evidence_root/innorder-occ-lifecycle.lock"
lifecycle_lock_fd=
acquire_lifecycle_lock() { command -v flock >/dev/null; exec {lifecycle_lock_fd}>"$lifecycle_lock_path"; flock -n "$lifecycle_lock_fd" || { exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; printf '另一个受管 OCC 操作持有项目全局锁\n' >&2; return 1; }; }
release_lifecycle_lock() { if [ -n "$lifecycle_lock_fd" ]; then flock -u "$lifecycle_lock_fd"; exec {lifecycle_lock_fd}>&-; lifecycle_lock_fd=; fi; }
acquire_lifecycle_lock
test "$(docker info --format '{{.OSType}}')" = linux
"${compose[@]}" version
```

**验证：** `uname -m` 为 `x86_64`，Docker Client/Server 均响应，Compose 是 v2 plugin，Engine context 和 Docker root 位于批准主机。rootless、远程 context、非 AMD64 或非 systemd 主机不是本章默认等价目标，必须先重新完成平台验证。

### 执行第 02 章部署前检查

逐项执行[第 02 章 Linux 预检](02-preflight-and-capacity.md)：OS/AMD64、Engine、Compose、CPU、内存、磁盘/inode、时间同步、官方 DNS/TLS、最终八端口、Git revision、Node 22、host `psql`、JDK 21 toolchain 和真实 OPA。容量数值只是初始规划基线，生产候选仍需代表性负载和恢复测试。

```bash
set -euo pipefail
uname -a
uname -m
cat /etc/os-release
docker version
docker compose version
docker info --format 'OSType={{.OSType}} Architecture={{.Architecture}} CPUs={{.NCPU}} Memory={{.MemTotal}} Root={{.DockerRootDir}}'
systemctl is-active --quiet docker
git rev-parse HEAD
git status --short
node --version
npm --version
psql --version
java -version
./gradlew --version
```

**验证：** 第 02 章检查单全部通过并归档。端口占用、Engine/context 错误、容量不足、密钥目录不安全、DNS/TLS 失败或未知工作区变更时停止；不得杀死未知进程、禁用证书校验、放宽 Docker socket 或重置工作区来获得表面通过。

## 密钥、umask 与配置文件准备

严格执行[第 03 章 Linux 密钥和配置步骤](03-secrets-and-configuration.md)。八个互异密钥必须位于仓库外持久本地文件系统；目录 `0700`、文件 `0600`，由执行 Compose 的批准身份拥有。`infra/compose/.env` 只能包含八个绝对密钥路径和十二个非敏感覆盖值。

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_SECRET_ROOT:?必须设置 OCC_SECRET_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
secret_root=$(realpath "$OCC_SECRET_ROOT")
case "$secret_root/" in "$repository_root/"*) printf '密钥目录不能位于仓库内\n' >&2; exit 1;; esac
test "$(stat -c '%u' "$secret_root")" -eq "$(id -u)"
test "$(stat -c '%a' "$secret_root")" = 700
expected=(postgres-admin-password postgres-flyway-password postgres-runtime-password redis-password minio-root-user minio-root-password minio-app-user minio-app-password)
for name in "${expected[@]}"; do
  path="$secret_root/$name"
  test -f "$path" && test ! -L "$path"
  test "$(stat -c '%u' "$path")" -eq "$(id -u)"
  test "$(stat -c '%a' "$path")" = 600
done
cd -- "$repository_root"
git check-ignore --quiet infra/compose/.env
test -f infra/compose/.env && test ! -L infra/compose/.env
printf '密钥位置、所有者、模式和 .env 忽略门禁通过；继续执行第 03 章内容与唯一性验证\n'
```

**安全：** 不在 argv、shell history、`set -x`、环境转储、`.env`、日志或工单中放置密钥值。三个 PostgreSQL 密码必须互异，MinIO root 与应用用户名/密码必须不同。SELinux/AppArmor 拒绝读取时修正批准的 label/profile，不得用 `chmod 644`、关闭强制访问控制或把密钥移入仓库解决。

## 配置解析、安装和严格验证

### 安全派生默认值与覆盖值

以下独立块只解析允许 key，不 `source` `.env`，因此文件内容不会作为 shell 执行。空端口采用 Compose 默认值；输出仅含非敏感有效端口、数据库名和桶名。

```bash
set -euo pipefail
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
cd -- "$repository_root"
declare -A config=()
declare -A allowed=()
for key in POSTGRES_ADMIN_PASSWORD_FILE POSTGRES_FLYWAY_PASSWORD_FILE POSTGRES_RUNTIME_PASSWORD_FILE REDIS_PASSWORD_FILE MINIO_ROOT_USER_FILE MINIO_ROOT_PASSWORD_FILE MINIO_APP_USER_FILE MINIO_APP_PASSWORD_FILE POSTGRES_DB POSTGRES_PORT KAFKA_PORT REDIS_PORT MINIO_API_PORT MINIO_CONSOLE_PORT OPA_PORT AI_PORT CORE_PORT AI_LOG_LEVEL APP_VERSION OBJECT_STORAGE_BUCKET; do allowed[$key]=1; done
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
OBJECT_STORAGE_BUCKET=${config[OBJECT_STORAGE_BUCKET]:-innorder-occ}
printf '%-16s %s\n' PostgreSQL "$POSTGRES_PORT" Kafka "$KAFKA_PORT" Redis "$REDIS_PORT" MinIO-API "$MINIO_API_PORT" MinIO-Console "$MINIO_CONSOLE_PORT" OPA "$OPA_PORT" AI "$AI_PORT" Core "$CORE_PORT"
```

默认端口精确为 PostgreSQL `5432`、Kafka `9092`、Redis `6379`、MinIO API `9000`、MinIO Console `9001`、OPA `8181`、AI `3100`、Core `8080`。后续探测使用上面派生的有效变量，而不是把默认值硬套到已覆盖环境。

### 依赖来源、OPA 和 Compose 配置门禁

```bash
set -euo pipefail
set +x
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
cd -- "$repository_root"
npm run install:verified
OPA_PATH=$(command -v opa)
test -n "$OPA_PATH" && test "${OPA_PATH#/}" != "$OPA_PATH"
"$OPA_PATH" version
export OPA_PATH
trap 'unset OPA_PATH' EXIT
npm run verify:full
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config --quiet
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml config --services
unset OPA_PATH
trap - EXIT
```

`install:verified` 使用 lockfile、官方 npm registry 和仓库来源守卫，不能换成普通 `npm install`。host OPA 应来自 Open Policy Agent 官方发布渠道，按组织批准的 checksum/签名和版本清单验证；`command -v` 的绝对路径显式传入 `OPA_PATH`。Compose 镜像内 OPA 固定为 `1.5.1` 及 digest。

**验证：** `verify:full`、真实 OPA、Docker/PostgreSQL 集成和 `config --quiet` 全部零退出且没有 skipped。失败时保留脱敏日志、解决根因并重跑；`verify` 或允许跳过的 `verify:local` 不能替代严格门禁。

## 镜像构建

标准构建与启动分离。构建失败不应替换正在运行容器。

```bash
set -euo pipefail
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
"${compose[@]}" build --pull
"${compose[@]}" images
```

**验证：** `opa`、`ai`、`core`、`host-gateway` 四个本地构建服务都有镜像；外部镜像保留 tag 与 `sha256` digest。不得使用未审批 registry、关闭 dependency verification 或来源守卫。

## 分离模式启动

`up -d` 创建/协调容器并在后台返回，不证明健康或初始化完成。

```bash
set -euo pipefail
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
"${compose[@]}" up -d
"${compose[@]}" ps -a
```

**注意：** Compose v5 的 `up -d --wait` 可能因成功完成且退出的 `minio-volume-init`/`minio-init` 返回非零，即使八个长运行服务均健康。标准流程不用该返回值作最终判定；必须分别检查两个精确退出码和八个健康状态。

## 状态、一次性任务和健康验收

```bash
set -euo pipefail
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
for service in minio-volume-init minio-init; do
  container_id=$("${compose[@]}" ps -a -q "$service")
  test -n "$container_id"
  state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container_id")
  test "$state" = 'exited 0'
  printf '%s PASS exited 0\n' "$service"
done
deadline=$((SECONDS + 600))
long_running=(postgres kafka redis minio opa ai core host-gateway)
while :; do
  failures=()
  for service in "${long_running[@]}"; do
    container_id=$("${compose[@]}" ps -q "$service")
    if [ -z "$container_id" ]; then failures+=("$service=missing"); continue; fi
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' "$container_id")
    [ "$state" = 'running healthy' ] || failures+=("$service=$state")
  done
  [ "${#failures[@]}" -eq 0 ] && break
  [ "$SECONDS" -lt "$deadline" ] || { printf '%s\n' "${failures[@]}" >&2; exit 1; }
  sleep 5
done
"${compose[@]}" ps -a
```

**验证：** 精确终态为 `minio-volume-init` 和 `minio-init` 各 `exited 0`，其余八个服务各 `running healthy`。任一一次性任务非零时先保存其日志并修复卷权限、MinIO readiness、桶名或密钥差异；不得改 restart policy 或无限重跑。网关 healthy 不证明上游，Core readiness 只证明 `ping` 与数据库。

## HTTP 探测与有效端口

先运行“安全派生默认值与覆盖值”块。以下默认 URL 分别为 `http://127.0.0.1:8080/actuator/health/readiness`、`http://127.0.0.1:3100/health`、`http://127.0.0.1:8181/health`、`http://127.0.0.1:9000/minio/health/ready`，但命令始终采用 `.env` 有效端口。Console 可达不等于 MinIO ready。

```bash
set -euo pipefail
checks=(
  "core-readiness|http://127.0.0.1:$CORE_PORT/actuator/health/readiness|200"
  "core-status|http://127.0.0.1:$CORE_PORT/api/v1/system/status|200"
  "ai-health|http://127.0.0.1:$AI_PORT/health|200"
  "ai-status|http://127.0.0.1:$AI_PORT/api/v1/system/status|200"
  "opa-health|http://127.0.0.1:$OPA_PORT/health|200"
  "minio-readiness|http://127.0.0.1:$MINIO_API_PORT/minio/health/ready|200"
)
for check in "${checks[@]}"; do
  IFS='|' read -r name url expected <<<"$check"
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 "$url")
  [ "$status" = "$expected" ] || { printf '%s HTTP %s\n' "$name" "$status" >&2; exit 1; }
  printf '%s PASS HTTP %s %s\n' "$name" "$status" "$url"
done
console_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 15 "http://127.0.0.1:$MINIO_CONSOLE_PORT/")
case "$console_status" in 200|301|302|303|307|308) printf 'minio-console PASS HTTP %s\n' "$console_status";; *) exit 1;; esac
```

检查 Core readiness JSON 总体 `UP` 且组件只有 `ping`、`db`；总体依赖状态结合 Core system status 与各服务原生探测。不要向健康请求添加认证数据或未经审查归档响应正文。

## TCP 与协议探测

### 八个回环 TCP 入口

```bash
set -euo pipefail
for item in "PostgreSQL:$POSTGRES_PORT" "Kafka:$KAFKA_PORT" "Redis:$REDIS_PORT" "MinIO-API:$MINIO_API_PORT" "MinIO-Console:$MINIO_CONSOLE_PORT" "OPA:$OPA_PORT" "AI:$AI_PORT" "Core:$CORE_PORT"; do
  name=${item%%:*}
  port=${item##*:}
  timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1; exec 3>&-; exec 3<&-' bash "$port"
  printf '%s PASS TCP 127.0.0.1:%s\n' "$name" "$port"
done
```

TCP 只证明当前连接路径可建立，不证明认证、数据库查询或 Kafka metadata。

### host 客户端协议验证

优先用 host 客户端验证回环、网关和上游协议。`psql -W` 与 `redis-cli --askpass` 使用隐藏交互提示；操作员从批准密码管理器输入值，密码不进入 argv、history、日志或长期环境。Kafka 当前回环 listener 为 `PLAINTEXT` 且无认证，只执行只读 topic-list。

```bash
set -euo pipefail
command -v psql >/dev/null
psql --host 127.0.0.1 --port "$POSTGRES_PORT" --dbname "$POSTGRES_DB" --username innorder_runtime --password --no-psqlrc --command 'SELECT current_user, current_database();'
if command -v redis-cli >/dev/null; then
  redis-cli -h 127.0.0.1 -p "$REDIS_PORT" --askpass PING
else
  printf 'host redis-cli 不可用；执行下方安全替代并记录 host 协议验收缺口\n' >&2
fi
if command -v kafka-topics >/dev/null; then
  kafka-topics --bootstrap-server "127.0.0.1:$KAFKA_PORT" --list
elif command -v kafka-topics.sh >/dev/null; then
  kafka-topics.sh --bootstrap-server "127.0.0.1:$KAFKA_PORT" --list
else
  printf 'host Kafka client 不可用；执行下方安全替代，不能宣称主机 Kafka 协议完整验证\n' >&2
fi
```

### 安全替代检查

仅在 host Redis/Kafka 客户端不可用时使用；替代在容器内部网络执行，不能验证主机协议路径，必须与八个 TCP 结果组合。secret 值只进入短生命周期容器进程环境，既不在 host argv 也不输出，命令结束立即 `unset`。

```bash
set -euo pipefail
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
"${compose[@]}" exec -T postgres sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"; psql --host 127.0.0.1 --username innorder_runtime --dbname "$POSTGRES_DB" --no-password --command "SELECT current_user, current_database();"; status=$?; unset PGPASSWORD; exit $status'
"${compose[@]}" exec -T redis sh -ec 'export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"; redis-cli --no-auth-warning PING; status=$?; unset REDISCLI_AUTH; exit $status'
"${compose[@]}" exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list
```

## 可选的非生产网关隔离验证

此受控步骤会停止 AI，造成 AI 短时不可用；只允许无业务流量的非生产验收环境。前提是完整初始验收、日志、维护窗口和恢复责任人已确认。生产依赖仓库网关契约测试，不执行现场停服实验。

```bash
set -euo pipefail
: "${OCC_CONFIRM_GATEWAY_ISOLATION:?必须由审批流程设置确认值}"
[ "$OCC_CONFIRM_GATEWAY_ISOLATION" = NON_PRODUCTION_APPROVED ]
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
restore_ai() { "${compose[@]}" start ai >/dev/null || { printf 'AI 恢复启动失败\n' >&2; return 1; }; }
trap restore_ai EXIT
"${compose[@]}" stop ai
sleep 3
if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$AI_PORT/health" >/dev/null; then
  printf 'AI 停止后健康路由仍成功，隔离验证失败\n' >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$CORE_PORT/actuator/health/readiness" >/dev/null
gateway_id=$("${compose[@]}" ps -q host-gateway)
[ -n "$gateway_id" ]
[ "$(docker inspect --format '{{.State.Health.Status}}' "$gateway_id")" = healthy ]
restore_ai
deadline=$((SECONDS + 120))
ai_recovered=false
while [ "$SECONDS" -lt "$deadline" ]; do
  ai_id=$("${compose[@]}" ps -q ai)
  if [ -n "$ai_id" ]; then
    ai_state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$ai_id")
    if [ "$ai_state" = 'running healthy' ] && curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$AI_PORT/health" >/dev/null; then
      ai_recovered=true
      break
    fi
  fi
  sleep 5
done
[ "$ai_recovered" = true ]
trap - EXIT
unset OCC_CONFIRM_GATEWAY_ISOLATION
```

恢复后等待 AI `running healthy`，重跑 AI HTTP/TCP 和总体状态。恢复失败时保持窗口、收集 AI/网关日志并从原验证镜像恢复；不得删除卷。该实验只证明一个上游故障不会使 Core 路由和网关健康消失。

## 重启、重建与 daemon 重启

单服务重启中断连接，先确认维护窗口、调用方静默、备份策略和恢复人。`restart` 不采用新镜像，也不保证加载已变更的 secret/config。

```bash
set -euo pipefail
: "${OCC_RESTART_SERVICE:?由审批流程设置服务名}"
: "${OCC_CONFIRM_RESTART:?由审批流程设置确认值}"
[ "$OCC_CONFIRM_RESTART" = APPROVED ]
case "$OCC_RESTART_SERVICE" in postgres|kafka|redis|minio|opa|ai|core|host-gateway) ;; *) exit 1;; esac
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
"${compose[@]}" restart "$OCC_RESTART_SERVICE"
"${compose[@]}" ps "$OCC_RESTART_SERVICE"
unset OCC_RESTART_SERVICE OCC_CONFIRM_RESTART
```

验证目标 `running healthy` 和相应 HTTP/协议。失败时停止重复重启，收集日志并修复根因；无数据/config 变化时可启动原容器，否则按组件恢复。

应用新本地构建镜像会替换容器并造成目标服务不可用。先记录旧镜像 ID、验证备份、数据库迁移兼容性和回退 revision。Core 镜像回退不等于 Flyway 数据库回退。

```bash
set -euo pipefail
: "${OCC_RECREATE_SERVICE:?由审批流程设置服务名}"
: "${OCC_CONFIRM_RECREATE:?由审批流程设置确认值}"
[ "$OCC_CONFIRM_RECREATE" = APPROVED ]
case "$OCC_RECREATE_SERVICE" in opa|ai|core|host-gateway) ;; *) exit 1;; esac
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
"${compose[@]}" build --pull "$OCC_RECREATE_SERVICE"
"${compose[@]}" up -d --no-deps --force-recreate "$OCC_RECREATE_SERVICE"
unset OCC_RECREATE_SERVICE OCC_CONFIRM_RECREATE
```

Docker daemon/主机重启影响全栈。八个长运行服务的 `unless-stopped` 在 daemon 恢复后通常重启；手工 stop 或 `down` 的状态不能假定恢复。两个一次性服务保持 `restart: "no"`。维护重启前确认静默、备份、开机值班人；恢复后执行 `systemctl is-active docker`、`config --quiet`、`up -d` 及完整验收。失败时禁止删卷，先修复 daemon、磁盘、权限或挂载。

## systemd 生产监督与路径环境

### 固定目录和仅路径环境文件

systemd 不继承交互用户的 PATH、alias、当前目录、Docker context 或 shell 变量。以下布局使用 root 管理的精确路径；仓库由 root 拥有且普通运行身份不可写，密钥仍为 `0600`。若 systemd 以 root 调 Docker，则交互部署也必须明确控制同一系统 Engine。

```bash
set -euo pipefail
umask 077
test "$(realpath "$OCC_REPOSITORY_ROOT")" = /opt/innorder-occ
test "$(realpath "$OCC_SECRET_ROOT")" = /etc/innorder-occ/secrets
sudo install -d -o root -g root -m 0755 /opt/innorder-occ
sudo install -d -o root -g root -m 0700 /etc/innorder-occ /etc/innorder-occ/secrets
getent group innorder-occ-operators >/dev/null
id -nG | tr ' ' '\n' | grep -Fx innorder-occ-operators >/dev/null
sudo install -d -o root -g root -m 0750 /var/lib/innorder-occ
sudo install -d -o root -g innorder-occ-operators -m 2770 /var/lib/innorder-occ/evidence
sudo install -o root -g innorder-occ-operators -m 0660 /dev/null /var/lib/innorder-occ/evidence/innorder-occ-lifecycle.lock
sudo find /etc/innorder-occ/secrets -maxdepth 1 -type f -exec chown root:root {} +
sudo find /etc/innorder-occ/secrets -maxdepth 1 -type f -exec chmod 0600 {} +
```

`/etc/innorder-occ/compose-paths.env` 只含路径，不含任何密钥值。使用 `sudoedit` 创建以下精确内容并设置 `0600 root:root`；不使用 shell 重定向搭配 `sudo`，因为 `sudo printf ... > file` 的重定向仍由未提升 shell 执行。

```ini
OCC_REPOSITORY_ROOT=/opt/innorder-occ
OCC_COMPOSE_ENV_FILE=/opt/innorder-occ/infra/compose/.env
OCC_COMPOSE_FILE=/opt/innorder-occ/infra/compose/compose.yml
OCC_SECRET_ROOT=/etc/innorder-occ/secrets
OCC_EVIDENCE_ROOT=/var/lib/innorder-occ/evidence
```

```bash
set -euo pipefail
sudo chown root:root /etc/innorder-occ/compose-paths.env
sudo chmod 0600 /etc/innorder-occ/compose-paths.env
sudo stat -c '%U:%G %a %n' /etc/innorder-occ/compose-paths.env /etc/innorder-occ/secrets
sudo /usr/bin/docker compose --env-file /opt/innorder-occ/infra/compose/.env -f /opt/innorder-occ/infra/compose/compose.yml config --quiet
```

### unit 文件

进入 systemd 所有权前先完成交互部署验收并运行 `release_lifecycle_lock`。unit 自己通过相同绝对锁文件包装 config/up 和 down；若备份、恢复、升级或轮换仍持锁，systemd 操作失败关闭而不并发改变栈。

用 `sudoedit /etc/systemd/system/innorder-occ.service` 创建：

```systemd
[Unit]
Description=Innorder OCC single-host Compose stack
Requires=docker.service
PartOf=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/innorder-occ/compose-paths.env
WorkingDirectory=/opt/innorder-occ
ExecStart=/usr/bin/flock --exclusive --nonblock /var/lib/innorder-occ/evidence/innorder-occ-lifecycle.lock /bin/sh -ec '/usr/bin/docker compose --env-file "$OCC_COMPOSE_ENV_FILE" -f "$OCC_COMPOSE_FILE" config --quiet && exec /usr/bin/docker compose --env-file "$OCC_COMPOSE_ENV_FILE" -f "$OCC_COMPOSE_FILE" up -d'
ExecStop=/usr/bin/flock --exclusive --nonblock /var/lib/innorder-occ/evidence/innorder-occ-lifecycle.lock /usr/bin/docker compose --env-file ${OCC_COMPOSE_ENV_FILE} -f ${OCC_COMPOSE_FILE} down --remove-orphans
TimeoutStartSec=30min
TimeoutStopSec=10min

[Install]
WantedBy=multi-user.target
```

`Requires`/`After` 确保 Docker daemon 已启动后才执行 Compose，并使停止顺序反转为 OCC 先执行 `ExecStop down`、Docker 后停止。`PartOf=docker.service` 把 systemd 对 Docker 发起的显式 stop/restart job 传播给 OCC：显式重启 Docker 时，OCC 先 down，Docker 恢复后 OCC 再执行配置验证和 `up -d`。`network-online.target` 只表达主机网络顺序，不证明 registry 或上游健康。`ExecStart` 在一个 `flock` 临界区内依次执行 config validation 和 `up -d`；`ExecStop` 使用同一锁。锁冲突使 unit 失败，操作员必须等待持锁操作关闭后重新发起，不能删除锁文件。它故意使用 `up -d` 而非 `--wait`，避免 Compose v5 将成功 one-shot 误作非零；服务健康仍按本章验收。

`TimeoutStartSec=30min` 给 config/up 拉取与创建留明确上限，不使用无限等待；超时后检查 daemon/journal/Compose 状态，不能盲目重复 start。`RemainAfterExit=yes` 使 oneshot unit 在 `up -d` 返回后保持 active，并使 stop 调用 `ExecStop down`；代价是 systemd 的 active **不代表容器仍在运行或健康**，容器运行由 `restart: unless-stopped` 和独立健康检查负责。若改成不保留 active，后续 `systemctl stop` 可能没有对应生命周期语义，必须另行设计。

### 启用、状态、journal 和开机验证

```bash
set -euo pipefail
release_lifecycle_lock
sudo systemctl daemon-reload
sudo systemctl enable innorder-occ.service
sudo systemctl start innorder-occ.service
sudo systemctl status --no-pager innorder-occ.service
sudo journalctl --unit innorder-occ.service --since today --no-pager
sudo /usr/bin/docker compose --env-file /opt/innorder-occ/infra/compose/.env -f /opt/innorder-occ/infra/compose/compose.yml ps -a
```

**验证：** unit 为 `active (exited)` 仅证明 `up -d` 零退出；还必须验证两个 `exited 0`、八个 `running healthy`、HTTP、TCP 和协议。主机重启后 Docker daemon 先启动，unit 再执行 config/up；重复 `up -d` 是协调操作。若 `.env`、密钥路径或仓库在启动时不可读，unit 应失败而不是启动不完整栈。

显式 Docker daemon 重启会中断全部 OCC 连接。仅在维护窗口、调用方静默、备份状态和恢复责任人确认后，由审批流程设置确认值并验证传播顺序：

```bash
set -euo pipefail
: "${OCC_CONFIRM_DOCKER_RESTART:?由审批流程设置确认值}"
[ "$OCC_CONFIRM_DOCKER_RESTART" = APPROVED ]
pending_jobs=$(systemctl list-jobs --no-legend --no-pager)
if printf '%s\n' "$pending_jobs" | grep -Eq '[[:space:]](innorder-occ|docker)\.service[[:space:]]'; then
  printf '%s\n' "$pending_jobs" >&2
  printf 'Docker 或 OCC 已有 systemd job，禁止并发重启\n' >&2
  exit 1
fi
sudo systemctl mask --runtime innorder-occ.service
sudo systemctl stop innorder-occ.service
occ_state=$(systemctl is-active innorder-occ.service 2>/dev/null) || true
[ "$occ_state" = inactive ] || [ "$occ_state" = failed ]
enabled_state=$(systemctl is-enabled innorder-occ.service 2>/dev/null) || true
case "$enabled_state" in masked|masked-runtime) ;; *) printf 'OCC unit 未保持 runtime mask\n' >&2; exit 1;; esac
acquire_lifecycle_lock
sudo systemctl restart docker.service
docker_state=$(systemctl is-active docker.service 2>/dev/null) || true
[ "$docker_state" = active ]
release_lifecycle_lock
sudo systemctl unmask --runtime innorder-occ.service
sudo systemctl start innorder-occ.service
occ_state=$(systemctl is-active innorder-occ.service 2>/dev/null) || true
[ "$occ_state" = active ]
sudo /usr/bin/docker compose --env-file /opt/innorder-occ/infra/compose/.env -f /opt/innorder-occ/infra/compose/compose.yml ps -a
unset OCC_CONFIRM_DOCKER_RESTART
```

随后必须重新验证两个 `exited 0`、八个 `running healthy`、HTTP、TCP 和协议。`PartOf` 只传播 systemd 创建的显式 stop/restart job；Docker daemon 进程崩溃、内核/主机异常或 systemd 外部终止不保证 OCC unit 执行 `ExecStop` 或自动重新执行 `ExecStart`。此类故障恢复 Docker 后，先检查容器和 unit 实际状态，再由操作员执行 `systemctl restart innorder-occ.service` 协调栈并完成全部验收，不能仅凭 `active (exited)` 宣称恢复。

### systemd 回退与移除

unit 变更会影响下次启动/停止。先备份当前 unit 到受控配置库、验证新文件、确认维护窗口；变更失败时用批准的上一版文件恢复，`daemon-reload` 后重新启动并完整验收。不要用 `systemctl revert` 假定能恢复手工 unit。

移除造成全栈不可用但保留四卷。脚本读取 `systemctl is-active` 的精确输出：`active` 时由 `systemctl stop` 调用 `ExecStop down`；`inactive` 或 `failed` 时仍可能存在人工启动或故障遗留容器，必须执行同一精确 Compose `down`；`activating`、`deactivating`、`reloading`、空值或其他未知状态一律停止，等待现有 job 完成或升级处置。前提是静默、备份状态、恢复/退役责任人和确认变量；永久数据删除仍只能走本章危险流程。

```bash
set -euo pipefail
: "${OCC_CONFIRM_SYSTEMD_REMOVAL:?由审批流程设置确认值}"
[ "$OCC_CONFIRM_SYSTEMD_REMOVAL" = APPROVED_KEEP_DATA ]
get_occ_unit_state() {
  local state
  state=$(systemctl is-active innorder-occ.service 2>/dev/null) || true
  case "$state" in active|inactive|failed|activating|deactivating|reloading) printf '%s\n' "$state";; *) printf '未知 OCC unit 状态：%s\n' "$state" >&2; return 1;; esac
}
assert_no_occ_lifecycle_jobs() {
  local jobs
  jobs=$(systemctl list-jobs --no-legend --no-pager)
  if printf '%s\n' "$jobs" | grep -Eq '[[:space:]](innorder-occ|docker)\.service[[:space:]]'; then
    printf '%s\n' "$jobs" >&2
    printf 'Docker 或 OCC 存在待处理 systemd job；等待完成或升级处置\n' >&2
    return 1
  fi
}
assert_no_occ_lifecycle_jobs
unit_state=$(get_occ_unit_state)
sudo systemctl mask --runtime innorder-occ.service
case "$unit_state" in
  active)
    sudo systemctl stop innorder-occ.service
    stopped_state=$(get_occ_unit_state)
    [ "$stopped_state" = inactive ] || { printf 'OCC unit stop 后状态为 %s\n' "$stopped_state" >&2; exit 1; }
    ;;
  inactive|failed) ;;
  activating|deactivating|reloading)
    printf 'OCC unit 状态为 %s；禁止与状态转换竞态，等待完成或升级处置\n' "$unit_state" >&2
    exit 1
    ;;
esac
acquire_lifecycle_lock
if [ "$unit_state" = inactive ] || [ "$unit_state" = failed ]; then
  sudo /usr/bin/docker compose --env-file /opt/innorder-occ/infra/compose/.env -f /opt/innorder-occ/infra/compose/compose.yml down --remove-orphans
fi
if systemctl is-enabled --quiet innorder-occ.service; then
  sudo systemctl disable innorder-occ.service
fi
sudo rm -f -- /etc/systemd/system/innorder-occ.service
sudo systemctl daemon-reload
sudo systemctl reset-failed innorder-occ.service || true
test ! -e /etc/systemd/system/innorder-occ.service
set +e
project_container_output=$(sudo /usr/bin/docker ps -a --quiet --filter label=com.docker.compose.project=innorder-occ)
project_container_status=$?
set -e
if [ "$project_container_status" -ne 0 ]; then printf 'unit 移除后容器清单查询失败\n' >&2; exit "$project_container_status"; fi
project_containers=()
if [ -n "$project_container_output" ]; then mapfile -t project_containers <<<"$project_container_output"; fi
if [ "${#project_containers[@]}" -ne 0 ]; then
  sudo /usr/bin/docker ps -a --filter label=com.docker.compose.project=innorder-occ || true
  printf 'unit 移除后仍有 OCC 项目容器，停止移除验收\n' >&2
  exit 1
fi
unset OCC_CONFIRM_SYSTEMD_REMOVAL
release_lifecycle_lock
```

验证 unit 不再 enabled/存在、包括两个一次性服务在内的 Compose 项目容器均已删除、四卷仍存在。恢复时还原已评审 unit 和路径文件，执行 `daemon-reload`、`enable`、`start` 和完整验收；若只需恢复人工生命周期，则运行精确 Compose `config --quiet`、`up -d` 和完整验收。仅在系统最终退役且数据销毁另获批准后删除路径环境、密钥和证据。

## 日志与脱敏支持包

日志可能含业务标识、绝对路径或意外敏感值。只收集批准范围，不收集 `.env` 内容、密钥、`docker inspect` 环境、认证头、shell history 或进程环境。

```bash
set -euo pipefail
set +x
umask 077
: "${OCC_REPOSITORY_ROOT:?必须设置 OCC_REPOSITORY_ROOT}"
: "${OCC_EVIDENCE_ROOT:?必须设置 OCC_EVIDENCE_ROOT}"
repository_root=$(realpath "$OCC_REPOSITORY_ROOT")
evidence_root=$(realpath "$OCC_EVIDENCE_ROOT")
cd -- "$repository_root"
bundle_root="$evidence_root/occ-support-$(date -u +%Y%m%d-%H%M%SZ)"
install -d -m 0700 "$bundle_root"
git rev-parse HEAD >"$bundle_root/git-revision.txt"
docker version >"$bundle_root/docker-version.txt"
docker compose version >"$bundle_root/compose-version.txt"
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml ps -a >"$bundle_root/compose-ps.txt"
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml images >"$bundle_root/compose-images.txt"
docker compose --env-file infra/compose/.env -f infra/compose/compose.yml logs --no-color --timestamps --tail 2000 >"$bundle_root/compose-logs-review-required.txt" 2>&1
systemctl status --no-pager innorder-occ.service >"$bundle_root/systemd-status.txt" 2>&1 || true
journalctl --unit innorder-occ.service --since today --no-pager >"$bundle_root/systemd-journal-review-required.txt" 2>&1
find "$bundle_root" -maxdepth 1 -type f -printf '%m %s %f\n'
```

在受控主机人工遮盖密码、token、用户名、对象键、客户数据、密钥路径和认证信息并二次复核后才能压缩移交；原件仍按敏感证据保管。`docker compose config` 和完整 inspect 不进入普通支持包。收集失败不影响容器，修正证据目录后重收，不能转存 `/tmp` 或世界可读目录。

## 日常停止与保留数据的 down

systemd active 时 `systemctl stop` 调用 unit 的 `ExecStop down`，会删除容器和网络但保留四卷；人工 inactive/failed 路径的 Compose `stop` 才保留容器。两条路径都中断服务。执行前确认维护窗口、调用方静默、数据库/对象写入完成、备份状态和恢复人。流程先 runtime mask 防止 systemd 在锁交接期间重新启动；恢复必须先 unmask。

```bash
set -euo pipefail
: "${OCC_CONFIRM_STOP:?由审批流程设置确认值}"
[ "$OCC_CONFIRM_STOP" = APPROVED ]
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
compose=(docker compose --env-file infra/compose/.env -f infra/compose/compose.yml)
unit_state=$(systemctl is-active innorder-occ.service 2>/dev/null) || true
sudo systemctl mask --runtime innorder-occ.service
case "$unit_state" in
  active) sudo systemctl stop innorder-occ.service; acquire_lifecycle_lock;;
  inactive|failed) acquire_lifecycle_lock; "${compose[@]}" stop;;
  *) printf '未知或转换中的 OCC unit 状态：%s\n' "$unit_state" >&2; exit 1;;
esac
"${compose[@]}" ps -a
release_lifecycle_lock
unset OCC_CONFIRM_STOP
```

恢复先执行 `sudo systemctl unmask --runtime innorder-occ.service`；systemd 所有权使用 `systemctl start`，人工所有权使用 `up -d`，随后完整验收。停止部分失败时保持 runtime mask，先核对实际状态，不删除卷。

`down` 删除项目容器和网络并使全栈不可用，默认保留 `postgres-data`、`kafka-data`、`redis-data`、`minio-data`。只有精确状态 `active` 表示 unit 当前拥有栈生命周期并应通过 `systemctl stop innorder-occ.service` 调用 `ExecStop`；`inactive` 走人工 Compose `down`，`failed` 走故障遗留清理并保留 journal 供恢复判断。unit 仅 enabled 不能证明它拥有容器；转换中、未知状态或 Docker/OCC 待处理 job 必须停止操作，不能与 systemd 竞态。

```bash
set -euo pipefail
: "${OCC_CONFIRM_DOWN:?由审批流程设置确认值}"
[ "$OCC_CONFIRM_DOWN" = APPROVED_KEEP_DATA ]
cd -- "$(realpath "$OCC_REPOSITORY_ROOT")"
get_occ_unit_state() {
  local state
  state=$(systemctl is-active innorder-occ.service 2>/dev/null) || true
  case "$state" in active|inactive|failed|activating|deactivating|reloading) printf '%s\n' "$state";; *) printf '未知 OCC unit 状态：%s\n' "$state" >&2; return 1;; esac
}
pending_jobs=$(systemctl list-jobs --no-legend --no-pager)
if printf '%s\n' "$pending_jobs" | grep -Eq '[[:space:]](innorder-occ|docker)\.service[[:space:]]'; then
  printf '%s\n' "$pending_jobs" >&2
  printf 'Docker 或 OCC 存在待处理 systemd job；等待完成或升级处置\n' >&2
  exit 1
fi
unit_state=$(get_occ_unit_state)
sudo systemctl mask --runtime innorder-occ.service
case "$unit_state" in
  active)
    lifecycle_owner=systemd
    sudo systemctl stop innorder-occ.service
    acquire_lifecycle_lock
    stopped_state=$(get_occ_unit_state)
    [ "$stopped_state" = inactive ] || { printf 'OCC unit stop 后状态为 %s\n' "$stopped_state" >&2; exit 1; }
    ;;
  inactive|failed)
    if [ "$unit_state" = inactive ]; then lifecycle_owner=manual; else lifecycle_owner=failed-unit; fi
    acquire_lifecycle_lock
    docker compose --env-file infra/compose/.env -f infra/compose/compose.yml down --remove-orphans
    ;;
  activating|deactivating|reloading)
    printf 'OCC unit 状态为 %s；禁止与状态转换竞态，等待完成或升级处置\n' "$unit_state" >&2
    exit 1
    ;;
esac
set +e
project_container_output=$(docker ps -a --quiet --filter label=com.docker.compose.project=innorder-occ)
project_container_status=$?
set -e
if [ "$project_container_status" -ne 0 ]; then printf 'down 后容器清单查询失败\n' >&2; exit "$project_container_status"; fi
project_containers=()
if [ -n "$project_container_output" ]; then mapfile -t project_containers <<<"$project_container_output"; fi
if [ "${#project_containers[@]}" -ne 0 ]; then
  docker ps -a --filter label=com.docker.compose.project=innorder-occ || true
  printf 'down 后仍有 OCC 项目容器\n' >&2
  exit 1
fi
docker volume ls --filter label=com.docker.compose.project=innorder-occ
printf '停止前生命周期所有者：%s；项目容器已全部删除，四个数据卷应保留\n' "$lifecycle_owner"
release_lifecycle_lock
unset OCC_CONFIRM_DOWN
```

验证包括两个一次性服务在内的项目容器均不存在、四卷仍存在且 unit 保持 runtime mask。恢复先 `sudo systemctl unmask --runtime innorder-occ.service`；`lifecycle_owner=systemd` 使用 `systemctl start innorder-occ.service`；`lifecycle_owner=manual` 执行精确 Compose `config --quiet`、`up -d`；`lifecycle_owner=failed-unit` 先审查 journal、修复根因并执行 `systemctl reset-failed innorder-occ.service`，再由 systemd start。所有路径随后都执行完整验收。误现空数据库时立即停止，禁止继续写入，并从已验证备份恢复。

## 危险的数据删除与恢复限制

**危险：** `docker compose --env-file infra/compose/.env -f infra/compose/compose.yml down --volumes` 会停止全栈并永久删除 `postgres-data`、`kafka-data`、`redis-data`、`minio-data`，包括数据库事实/Flyway/Flowable、Kafka 日志/KRaft、Redis AOF、MinIO 对象/桶/IAM。源码、镜像、`.env` 和密钥不能恢复这些内容。

本章不提供可执行销毁命令。唯一受支持入口是[第 11 章“永久数据销毁”](11-command-reference-and-checklists.md)；必须在同一会话使用其项目全局锁、systemd 所有权判定、待处理 job 检查、双人审批、nonce、精确项目/卷清单校验和失败冻结逻辑，禁止从该流程摘抄单条命令或自行简化。复制在线卷不是应用一致备份。

**验证：** 只按第 11 章的关闭条件判定销毁是否完成。部分失败时冻结现场、保存卷清单，不重跑或启动空栈。

恢复顺序是密钥/配置、PostgreSQL、MinIO、必要 Kafka/Redis，再启动应用和执行本章全部状态、HTTP、TCP、协议验收。无成功恢复演练时数据可能不可恢复；镜像层、重新初始化和文件系统回收工具不是可靠恢复路径。误删时停止新写入并升级数据丢失事件；永久退役则按独立审批继续删除 unit、路径文件、密钥和外部备份。
