# MasterDNS 部署与运维手册

## 1. 部署前提

- Linux 主机或可运行 Docker Compose v2 的环境。
- Docker Engine 24+，建议至少 2 CPU、4 GiB 内存和 20 GiB 可用磁盘。
- 一个只允许内部访问的 HTTPS 域名；至少将 Web 与 API 放在同一站点下或分别配置可信来源。
- Cloudflare 使用具有 Zone Read、DNS Read、DNS Write 最小权限的 API Token。
- 阿里云使用专用 RAM 用户 AccessKey，并只授予云解析所需权限。

## 2. 准备配置

```bash
install -m 0600 .env.example .env
openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
openssl rand -hex 24      # 可用作 POSTGRES_PASSWORD
```

至少修改以下值：

```dotenv
POSTGRES_PASSWORD=<随机数据库密码>
MASTER_ENCRYPTION_KEY=<32 字节 Base64 密钥>
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<高强度初始密码>
WEB_URL=https://dns.example.internal
PUBLIC_API_URL=https://dns-api.example.internal
NEXT_PUBLIC_API_URL=https://dns-api.example.internal
NEXT_PUBLIC_PROBE_AGENT_VERSION=
```

外部 Probe Agent 可选。没有已发布版本时将 `NEXT_PUBLIC_PROBE_AGENT_VERSION` 留空，核心 Web、API 和 Worker 仍可构建与运行，但 Agent 安装控件必须保持不可用。启用安装控件时必须填写已经发布并审核的精确 `vN.N.N` 标签，不能使用 `latest`、分支名或提交名；任何非空非法值会使镜像构建失败。Web 只从固定来源 `https://github.com/Bend-Function/MasterDNS-Agent/releases/download/VERSION/` 生成安装地址。Agent 是独立仓库的发布物；平台生产镜像不会编译、复制或发布 Go Agent。本开发任务没有选择或发布 Agent 版本。

Compose 会将 `POSTGRES_PASSWORD` 作为独立的 `PGPASSWORD` 参数传给应用，因此可安全使用 URL 保留字符。本地直接运行 API 时可设置 `DATABASE_URL`，其中密码的 URL 保留字符必须进行百分号编码；也可以设置完整的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER` 和 `PGPASSWORD`。上述命令会以 `0600` 权限创建 `.env`。`MASTER_ENCRYPTION_KEY` 丢失后无法解密已保存的云凭证，必须与数据库备份分开保管。

`TRUSTED_PROXY_CIDRS` 只能填写实际反向代理网段。未使用反向代理时保留 loopback 默认值；不要设置为 `0.0.0.0/0` 或 `::/0`。

健康检查和 Webhook 默认拒绝 private、loopback、link-local 与保留地址。确需探测内网节点时只设置 `ALLOW_PRIVATE_HEALTH_TARGETS=true`；只有确认所有普通用户都可信且内部接收端可安全接受签名 POST 时，才设置 `ALLOW_PRIVATE_WEBHOOK_TARGETS=true`。两个开关都不会放行 loopback、link-local 或保留地址。

## 3. 启动与检查

```bash
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose logs migrate
curl -fsS http://127.0.0.1:${API_PORT:-4000}/api/health
```

`migrate` 必须以成功状态退出，`postgres`、`redis`、`api`、`worker` 和 `web` 应保持运行或健康。首次登录后立即确认管理员密码，并从“用户管理”创建日常使用账号。

默认端口仅绑定 `127.0.0.1`，便于本机验收和同机反向代理接入。反向代理位于其他主机时，可将 `BIND_ADDRESS` 改为指定内网地址，并通过防火墙限制来源。正式环境应由反向代理终止 TLS，不应将 PostgreSQL 或 Redis 暴露到宿主机或公网。

### 容器日志与磁盘占用

六个 Compose 服务（包括 PostgreSQL、Redis 和一次性 `migrate`）统一使用 `json-file` 日志轮转，并压缩旧文件。可在已有 `.env` 中按需加入以下值；不填写或留空也会使用默认值：

```dotenv
DOCKER_LOG_MAX_SIZE=10m
DOCKER_LOG_MAX_FILES=3
```

`DOCKER_LOG_MAX_SIZE` 为正整数加单位 `k`、`m` 或 `g`；`DOCKER_LOG_MAX_FILES` 为至少 1 的整数，包含当前文件。默认每容器约 30 MB 的未压缩日志预算；单实例六个服务约 180 MB，压缩通常会减少实际占用。这是轮转阈值，不是 Docker 总磁盘配额，单条日志和轮转过程可能产生短暂额外占用。超过文件数量时 Docker 删除最旧日志，排障需长期保留的片段应提前导出。

新容器直接生效。已有容器只执行 `restart` 不会更新日志配置；`bash update.sh` 更新应用服务，但保留 PostgreSQL/Redis 容器，因此其日志设置还需在维护窗口应用。先按“升级与回退”完成代码升级与数据库备份，再执行以下步骤；每个命令成功后才继续：

```bash
docker compose config --quiet
docker compose stop web api worker migrate
docker compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout 180 postgres redis
docker compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout 180 api
docker compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout 180 worker web
docker compose rm -f migrate
docker compose ps
```

这会短暂停服，重建容器时复用原有命名数据卷；最后移除已停止的旧迁移容器，下次迁移创建新容器时自动采用日志限制。旧容器及其本地日志会被替换或移除，如需诊断证据，提前用 `docker compose logs --since=24h > masterdns-before-log-rotation.log` 导出到有空间的目录；导出文件不受容器轮转限制。此配置本身没有数据库迁移。不要通过 `down -v` 或删除数据卷应用日志配置。

检查已创建容器的实际设置（输出应包含 `json-file`、`max-size`、`max-file` 和 `compress`）：

```bash
for service in postgres redis api worker web; do
  docker inspect --format '{{.Name}} {{json .HostConfig.LogConfig}}' "$(docker compose ps -q "$service")"
done
docker compose logs --tail=100 api worker
```

如果磁盘仍然占用很大，先用 `docker system df -v` 区分镜像、构建缓存和数据卷占用，用 `docker ps -a --size` 检查容器写入层；这些统计不完整包含容器日志，日志设置仍需单独核对。`update.sh` 会保留带 `masterdns-backup-*` 标签的回退镜像，每次升级也会生成数据库备份，应按实际回退保留期处理；不要把数据库卷当成日志删除。本次配置不会自动清理镜像、构建缓存、数据库或备份。

日志轮转和既有容器生效规则参见 [Docker 官方 json-file 文档](https://docs.docker.com/engine/logging/drivers/json-file/)。

## 4. 反向代理要求

- Web 和 API 全程使用 HTTPS。
- 将浏览器访问 Web 的精确 Origin 写入 `WEB_URL`。
- API 需要保留 `Origin`、`Cookie`、`X-Request-Id`，并传递真实来源地址。
- 只有来自 `TRUSTED_PROXY_CIDRS` 的转发头会被信任；该设置也影响 DDNS 未显式上报地址时的来源 IP 推断。
- API 的 DDNS 脚本与 heartbeat 路径必须可由受管 Linux 节点访问。

## 5. 云账号接入

在“云账号”中导入凭证。系统会先调用厂商 API 验证，再以 AES-256-GCM 加密保存；列表只显示凭证类型或 AccessKey 尾号。接入后检查 Zone 同步结果，并先使用隔离子域名验证普通记录创建、更新、历史与回滚，再绑定生产记录到 Pool。

自动化只修改 Pool 新建或显式接管的受管记录。添加绑定时，系统默认拒绝同名 A/AAAA 记录；启用“接管现有同名记录”后，只会接管唯一一条未受管记录，多记录 RRSet 会拒绝接管。普通 DNS 记录仍可直接编辑；受管记录必须从 Pool 策略修改，避免人工操作与自动故障转移互相覆盖。

## 6. DDNS Agent

在 DDNS 类型节点上生成一次性安装命令，并在目标 systemd Linux 主机执行。安装 Token 默认 15 分钟失效且只能兑换一次；运行 Token 仅以哈希保存在服务端，客户端配置权限为 `0600`。

```bash
sudo systemctl status masterdns-ddns.timer
sudo systemctl start masterdns-ddns.service
sudo journalctl -u masterdns-ddns.service -n 100 --no-pager
```

新地址先进入 candidate 状态，只有通过该节点或 Pool 的 HTTP/TCP 健康检查后才会提升和发布。因此，启用 DDNS 前必须配置至少一个有效健康检查。

## 7. 外部 Probe Agent

Probe Agent 与 API 必须通过 HTTPS 通信。主机需要出站访问 MasterDNS API、策略允许的 TCP/HTTP/HTTPS 目标，以及安装或升级时固定的 GitHub Release 地址。内网目标默认被拒绝；管理员必须在对应健康策略中显式配置允许的 private CIDR，并同时确保 Agent 主机的路由和防火墙只开放必要范围。自定义 HTTP header 属于敏感配置，不会进入通知。

管理员配置已发布的固定版本后，从控制台取得该版本的 `install.sh` 和一次性安装 Token。先安装但不启动服务，再通过标准输入或权限受限的 Token 文件注册：

```bash
sudo sh install.sh install --version vN.N.N --server-url https://dns-api.example.internal
printf '%s\n' "$MASTERDNS_PROBE_INSTALL_TOKEN" | \
  sudo -u masterdns-agent /usr/local/bin/masterdns-agent enroll --config /etc/masterdns-agent/config.json
sudo systemctl start masterdns-agent
sudo sh install.sh status
```

不要把 Token 值放入命令参数、下载 URL、日志或世界可读文件。文件方式使用 `masterdns-agent enroll --config /etc/masterdns-agent/config.json --install-token-file PATH`，并确保该文件只有 Agent 账号可读。控制台吊销 Agent 后，下一次认证返回 401，服务停止领取任务；吊销不会删除现有 DNS。升级使用 `sudo sh install.sh update --version vN.N.N`。卸载默认保留配置和缓冲结果；只有明确执行 `sudo sh install.sh uninstall --purge` 才删除它们。

协议固定为 `probe-agent/v1`。每个 Agent 的服务端并发上限默认为 16、最大 100；实际租约数还受 Agent heartbeat 上报能力和未完成租约限制。一次租约最多返回 100 个任务，一次结果提交最多 100 条；Agent 本地缓冲上限为 1,000 条或 10 MiB，达到上限会暂停领取新任务，不会删除结果。`deadline` 是该轮接受测量的截止时间，`resultExpirySeconds` 是已聚合证据的有效期；所有主机应使用 NTP。`minimumValid` 是形成结果所需的有效票数，`majority`、`all` 或指定探测点决定 quorum；不足或过期为 unknown，不能当作目标 failure。

## 8. 地址健康和轮换策略

IPv4 与 IPv6 使用独立健康策略和轮换开关。实例 `managed` 授权默认关闭，并独立于地址族开关、允许停止再启动和允许释放原地址三个 opt-in；发现资源不会自动授权。默认最多实际换址 3 次，最小间隔 60 秒，云端等待 120 秒，candidate 外部复测窗口 180 秒。新地址必须由对应地址族的外部 quorum 验证后才能发布 DNS；unknown 只会等待或告警。

### 删除地址健康策略

1. 打开“健康检查 → 地址健康策略”，找到目标及 IPv4/IPv6 行，点击删除图标。需要查看历史槽位时勾选“显示历史地址策略”。资源所有者和管理员可以操作。
2. 对于云槽位，先在实例的相应地址族设置中关闭故障自动轮换和定时轮换；暂停计划不等于关闭。未完成、暂停或预算耗尽的轮换事件仍阻止删除，需等待完成或终止并完成收尾。
3. 在确认窗口核对目标与地址族，再点击“确认删除”。失败原因保留在窗口；若提示策略版本变化，关闭窗口、刷新并重新核对后再操作。

删除只移除该地址策略，使旧健康证据失效并停止该策略的探测；检查配置、探测组、历史观测与现有 DNS 记录保留。通知扫描不再为已删除策略生成健康事件，既有通知历史保留。普通节点恢复节点/Pool 的本地检查；云槽位须重新配置外部策略才能验证和自动发布新地址。可以再次通过“配置地址策略”创建策略并复用保留的检查配置。此次功能无需数据库迁移，也不修改 Agent 协议。

管理 API 对应 `DELETE /api/v1/address-health-policies/:id`，请求体为 `{"expectedRevision": 当前策略版本}`。401 表示未登录，404 表示不存在或无归属权限，409 表示版本变化或仍有轮换依赖，400 表示请求体或 ID 无效。删除不调用云厂商或 DNS 接口。

### 多台云服务器共用一个 IP Pool

1. 接入云账号、同步实例，并授权需要管理的机器。
2. 在 IP Pool 中选择“添加节点 → 云服务器地址”，选择账号、机器及 IPv4/IPv6 槽位。重复添加其他机器；同一个槽位也可供多个自有 Pool 使用。
3. 在“健康检查”配置各槽位的外部 Agent 策略。Pool 的健康检查页会显示继承的策略、探测组和最近轮次；新增的本地检查与外部策略分开展示。云槽位不能只依赖本地检查取得发布资格。
4. 在同一个 Pool 的“域名绑定”中添加多个域名，可跨 DNS 账号和 Zone。选择主备、健康集合或跨域名分配策略，并设置节点优先级及恢复方式。A 与 AAAA 分别使用对应地址族的健康节点。

若“目标 / 地址”显示历史地址、当前清单中不存在，该目标的探测已停止；等待不会生成新结果。先同步云账号清单，核对 Pool 节点所链接的槽位及当前实际 IP；如需换用其他槽位，在节点配置选择正确来源并完成外部验证，不要把旧历史地址强制标为健康。历史 current 地址即使保留旧健康缓存，也不会成为新 DNS 调度候选；同池仍有效的同地址族节点可以接管。域名行“候选地址整体健康”聚合全部候选，一好一坏会降级；“状态失败”应另查对应 DNS Operation/Step，不能等同于所有节点探测失败。

新增云节点不会把清单 IP 直接当作已验证地址。外部检查通过后才发布；IP 轮换后的候选也必须重新验证，再更新关联域名。地址健康、Pool 可用性与 DNS 发布进度分别显示，检查通过并不代表 DNS 已完成写入。

在域名解析页新建的云地址绑定，即使尚未发布，也会显示在“受管域名绑定”中，可查看等待原因、打开 Pool 或取消绑定。取消仅删除未发布的托管配置；已发布记录需在 Pool 中确认删除。排队、执行中或曾尝试但结果未确认的 DNS 写入会阻止取消，应先处理相关操作，避免留下失去托管关系的远端记录。

停止实例只在 `allowStopStart` 打开时允许。原地址清理只在 `allowReleaseAddress` 打开、资源归属可验证且远端读取确认后执行。EC2 自动公网地址、Lightsail 临时地址及已释放的系统地址通常不能恢复为原值；数据库回退也不会重新取得它们。权限、配额错误不会通过停止实例规避，也不会刷新换址预算。

通知 Worker 从持久健康状态、轮换阶段、DNS publication 和 cleanup 状态恢复事件。Redis 丢失可重新入队，`event/channel` 唯一键避免重复投递。unknown/探测不足、目标失败与恢复分别通知；轮换通知包括预算耗尽、权限/配额、DNS 部分发布、cleanup 失败与完成。Webhook/Telegram 内容只含归属范围内的状态和资源 ID，不含凭证、Token、自定义 header、云请求或完整策略快照。

### 换址失败自动恢复（2026-10-23）

在节点或实例的“换址策略”设置“失败自动重试上限”：默认 5，范围 0–20，0 关闭；与“每个任务最多换址”独立。首次失败不算一次重试，后续最多自动恢复指定次数。临时云错误、观察超时、明确未生效的可恢复步骤（含旧资源清理）及任务关联的 DNS 部分发布会在原任务内继续，间隔使用“尝试最小间隔”（默认 60 秒），且遵守更长的云端限流等待。单次云调用默认最多等待 30 秒（若云端等待配置更短则取更短值），云操作收敛仍使用“等待云端生效”的完整窗口。

详情页展示累计重试次数、最近恢复原因与下次处理时间；任务列表和详情将 active 显示为“执行中”，cleanup_failed 显示“失败”或在等待恢复时显示“重试中”。云端换址、DNS 发布与清理共享本事件的恢复上限，已成功的 DNS 步骤不会重做。达到上限后停止自动恢复，显示“失败自动重试次数已耗尽”；无需先终止任务或重新打开节点自动轮换。处理原因后可点击“恢复执行”重新授权继续，未决云写入须先读回确认。无法确认副作用的操作只观察原步骤；不会因超时重复创建 IP 或临时实例。权限/配额、授权撤销、配置变更和归属不明仍需处理；人工暂停和终止不会被自动重启覆盖。

升级前按下节备份并停止旧 Worker，应用迁移 `0034_rotation-recovery-retries` 后同步部署 API/Web/Worker。已有策略自动获得默认 5 次上限，已有计费尝试上限与开关不变；无需新环境变量。尚未终止且因运行错误暂停的旧 cloud 任务会由新 Worker 接续；已人工终止的任务不复活。回退使用兼容该增量 schema 的代码或按备份恢复流程处理，数据库回退不会撤销云端效果。

## 9. 备份与恢复

数据库是持久状态的事实来源，Redis 仅保存可恢复的队列状态。建议每日执行 PostgreSQL 逻辑备份，并定期在隔离环境演练恢复。备份还应记录应用 Git 版本、API/Worker/Web 镜像的不可变 ID 或 digest、Agent 精确版本、迁移记录和关键业务表行数；对应的 `.env` 和 `MASTER_ENCRYPTION_KEY` 应加密并分开保管。升级前的备份应在停止写入后执行。

以下各命令块在子 shell 中遇错即停止。任何步骤失败都保持维护状态，不应跳过错误继续启动服务。目录名必须唯一：

```bash
(
  set -eu
  umask 077
  backup_dir="../masterdns-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p ../masterdns-backups
  mkdir "$backup_dir"
  cp .env "$backup_dir/.env"
  git rev-parse HEAD > "$backup_dir/app-revision.txt"
  # 在构建新镜像之前保存，避免相同标签指向新版本；保留这些本地镜像。
  for service in api worker web; do
    image_id="$(docker compose images -q "$service")"
    test -n "$image_id"
    docker image inspect --format '{{.Id}}' "$image_id" > "$backup_dir/$service-image.txt"
  done
  docker compose exec -T postgres pg_dump -U masterdns -d masterdns -Fc > "$backup_dir/masterdns.dump.partial"
  mv "$backup_dir/masterdns.dump.partial" "$backup_dir/masterdns.dump"
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U masterdns -d masterdns \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' > "$backup_dir/migrations.txt"
)
```

恢复旧备份必须使用**新建的空数据库**。不要对已升级的原库执行 `pg_restore --clean`：旧备份不包含新表及其外键，清理旧表可能失败并留下部分清理状态；加 `--single-transaction` 只能避免部分提交，不能解决新增依赖。下面的 `masterdns_restore`、`masterdns_before_restore` 必须是未占用的名称；若已存在，选择新的名称并一致修改命令，不要删除原有数据库来腾出名称。

```bash
(
  set -eu
  docker compose stop web api worker migrate
  # 同时停止其他部署副本、手工 migration 和直接连接数据库的写入者。
  docker compose exec -T postgres createdb -U masterdns --template=template0 masterdns_restore
  docker compose exec -T postgres pg_restore --exit-on-error --single-transaction \
    -U masterdns -d masterdns_restore < ../masterdns-backups/SELECT_BACKUP/masterdns.dump
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U masterdns -d masterdns_restore \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id'
)
```

切换前，将迁移记录与备份记录及**目标旧版本**的迁移 journal 核对，并验证用户、DNS 记录、端点/地址、凭证密文字段与关键行数。在隔离环境使用对应旧镜像和密钥完成读取/解密验收，禁用云/DNS 写入。恢复失败时原 `masterdns` 不受影响；保留失败的新库用于诊断，另建空库重试。不要使用最新镜像运行 migration 来“修复”旧备份，否则会再次升级 schema。

验证通过且所有数据库客户端已退出后，从维护数据库 `postgres` 执行事务切换。PostgreSQL 17 支持以下事务内重命名；任何检查或重命名失败，整个事务回滚，原库名保留。命令不会强制断开连接，也不会删除原库：

```bash
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U masterdns -d postgres <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname IN ('masterdns', 'masterdns_restore')) THEN
    RAISE EXCEPTION 'Stop all clients of masterdns and masterdns_restore before switching';
  END IF;
END $$;
ALTER DATABASE masterdns RENAME TO masterdns_before_restore;
ALTER DATABASE masterdns_restore RENAME TO masterdns;
COMMIT;
SQL
```

创建 `restore-images.yml`，为 `api`、`worker`、`web` 各自设置备份时记录的不可变镜像 ID（`image: sha256:...`）或已保留的固定 digest，并使用旧版本的 Compose 配置与匹配密钥。确认这些镜像仍存在；不得使用 `latest` 或已被新构建覆盖的标签。核对 AWS/Azure/Linode、DNS、candidate/current/publication 与 cleanup 的远端实际状态，处置未完成操作后，才在独立命令块中恢复服务：

```bash
(
  set -eu
  # 使用容器健康检查等待 API，避免宿主 shell 未加载 .env 中自定义端口。
  docker compose -f docker-compose.yml -f restore-images.yml up -d --no-deps --no-build --pull never --wait --wait-timeout 120 api
  docker compose -f docker-compose.yml -f restore-images.yml up -d --no-deps --no-build --pull never web worker
  docker compose ps
)
```

`--no-deps` 防止 Compose 隐式启动 migration；不要改用普通 `up -d` 或 `start` 来启动残留的新版本容器。若切换后验收失败，再停止全部客户端，使用同样的事务检查，将当前 `masterdns` 改名为新的保留名，再将 `masterdns_before_restore` 改回 `masterdns`，两个数据库均保留；重新启动前仍须确认对应镜像和远端状态。验证及保留期结束前不要删除原库。

完整恢复需要数据库备份和对应的 `MASTER_ENCRYPTION_KEY`。Redis 卷可以重建，Worker 会扫描未完成的 Operation、持久通知状态与通知投递并重新入队；恢复旧数据库时应使用空的隔离队列或重建本部署专用 Redis，防止遗留任务混入，不能清空其他系统共享的 Redis。备份只能恢复平台持久状态，不能撤销已经执行的 EC2/Lightsail、Azure/Linode 或 DNS 写入，也不能找回已释放且不可复原的地址。

仓库提供可选隔离演练 `pnpm test:database-restore`，须显式设置 `RESTORE_TEST_ENABLED=1`、`RESTORE_TEST_CONTAINER` 和该测试 PostgreSQL 的 `PG*` 连接参数；它只创建和清理随机命名的测试数据库，验证 0010 旧数据恢复、失败隔离、活动连接拒绝切换及事务正反向切换，不启动应用或调用云服务。

## 10. 升级与回退

已有的单实例 Git + Docker Compose 部署可在项目目录执行：

```bash
bash update.sh
```

首次需要获取脚本时先执行 `git pull --ff-only origin master`。后续脚本自动获取 `origin/master`、只允许快进更新，并拒绝未提交的受跟踪文件修改及本地 master 分叉；不会自动 stash 或覆盖本地修改。当前分支、本地 master 或远端 master 中有受 Git 跟踪的 `.env` 时，也会在切换前拒绝更新以保护现有配置。脚本使用当前 `.env` 和正常 Compose 项目选择，要求 API、Worker、Web 各有一个已有容器，以及支持 `up --wait --wait-timeout` 的 Docker Compose v2。多副本部署需先统一维护窗口、停止其他写入者，再按手工流程操作。

默认备份放在项目同级的 `masterdns-backups/时间-随机串/`，可用 `MASTERDNS_BACKUP_ROOT` 指定其他**项目外**目录。备份包含 `.env`、Compose 配置、升级前检出的源码版本、旧容器的实际镜像 ID、数据库 dump 和迁移记录；旧镜像添加独立备份标签，避免构建覆盖标签后难以定位。检出源码版本与运行镜像 ID 分别记录，不假定二者一定相同。备份文件受限为当前用户访问，仍应按密钥管理要求加密归档。

脚本先构建并只读预检，随后停止 Web/API/Worker/migrate、备份数据库、再次预检、执行迁移，最后等待 API 健康并启动 Web/Worker。`MASTERDNS_UPDATE_WAIT_TIMEOUT` 可调整启动等待时间，默认 180 秒。任何命令失败都会停止后续操作并报告阶段及备份路径；迁移失败后不会自动启动或回滚应用。数据库备份失败时保留 `.partial` 文件用于诊断，它不代表有效备份。仅停止应用服务，保留 PostgreSQL、Redis 及数据卷。

同一检出目录的并发更新由 Git 目录下 `masterdns-update.lock` 拒绝。正常退出或可捕获信号会释放本次锁；断电/强制终止留下的锁不会自动抢占，需根据其中 PID 确认没有更新进程后再处理。更新前确保可用磁盘空间容纳数据库备份和新旧镜像。可用 `pnpm test:update` 在临时 Git 仓库和模拟 Docker 上运行升级脚本回归，不操作实际部署。

以下为需要手工控制时的等价流程：

升级前按上一节保存旧镜像的不可变 ID、代码版本、Agent 版本和匹配密钥，并备份 `.env`。先构建新版本并只读预检；旧服务停止后再取一致的回退备份，重新预检并显式执行迁移。整个命令块中任一步失败都会退出，不启动新服务：

```bash
(
  set -eu
  umask 077
  git pull --ff-only
  docker compose config --quiet
  docker compose build
  docker compose run --rm --no-deps migrate node packages/db/dist/preflight-cli.js
  docker compose stop web api worker migrate
  # 同时停止其他应用副本与直接写入者；postgres、redis 继续运行。
  backup_dir="../masterdns-backups/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p ../masterdns-backups
  mkdir "$backup_dir"
  cp .env "$backup_dir/.env"
  docker compose exec -T postgres pg_dump -U masterdns -d masterdns -Fc > "$backup_dir/masterdns.dump.partial"
  mv "$backup_dir/masterdns.dump.partial" "$backup_dir/masterdns.dump"
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U masterdns -d masterdns \
    -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id' > "$backup_dir/migrations.txt"
  docker compose run --rm --no-deps migrate node packages/db/dist/preflight-cli.js
  docker compose run --rm --no-deps migrate
  docker compose up -d --no-deps --no-build api worker web
  docker compose ps
  docker compose logs --since=10m api worker
)
```

升级预检是只读操作。若它报告同一 Zone、FQDN 和记录类型被多个 Pool 绑定，应在旧版本仍运行时根据报告中的 Binding/Pool ID 保留一个业务上正确的绑定，并删除或改名其他绑定；预检不会替操作员选择或删除数据。重复运行预检直至通过，再进入停止写入、备份与迁移步骤；停服后的第二次预检用于捕获期间新增的冲突。不要在旧 API/Worker 仍运行时迁移，也不要在迁移非零退出后启动服务。健康检查唯一约束升级会按 `updated_at`、`created_at`、`id` 顺序保留每个 scope 最新的启用配置，并自动禁用其余旧配置。

migration 只向前执行。若应用版本需要回退，应先确认旧版本能够读取新 schema；否则按上一节恢复升级前备份到新库，验证并切换，然后启动对应旧镜像。down migration 即使存在也不能撤销已经执行的云计算或 DNS 写入；回退后必须按远端读取结果人工处置 partial publication、ambiguous ownership 和 cleanup failure，不能只回退代码。

## 11. 常见检查

- API 不健康：检查 `postgres`、`redis` 与 `migrate` 日志以及 `DATABASE_URL` 或 `PG*` 数据库配置。
- 无法登录：确认访问协议为 HTTPS、`WEB_URL` 与浏览器 Origin 完全一致，Cookie 未被代理删除。
- Zone 不同步：检查云账号最小权限、账号状态和 Worker 日志。
- DDNS heartbeat 401：重新生成安装 Token 并安装，或检查 Agent 是否已被吊销。
- DDNS 地址不发布：检查 candidate 对应健康检查结果，不要绕过候选地址验证。
- 自动化没有切换：检查失败阈值、冷却时间、Pool 是否暂停，以及是否仍存在健康候选节点。
- Probe 一直 unknown：检查 Agent 时间、在线状态、地址族能力、任务 deadline、有效票数和 private CIDR 策略；不要把 unknown 当作 failure。
- DNS 部分发布：任务按持久恢复上限自动等待并仅重试失败步骤，成功记录保留；检查详情中的累计次数、下次处理和 Operation/Step。暂停或耗尽时不重投递；处理凭证/权限等原因后可显式恢复。无轮换事件的首次绑定发布沿用原有 Operation 恢复规则。
- cleanup 失败：Lightsail 先核对旧静态 IP 是否已删除；已删除则收尾，明确失败且原资源仍未附着则按默认最多 5 次恢复预算重试。无需终止后重新开自动轮换。持续 pending 会按云端等待窗口转为恢复等待，达到上限显示耗尽。核对授权、原 ARN、附着状态和资源详情中的具体原因；归属不明确时保留资源，见 [Lightsail 清理恢复](providers/aws-lightsail.md)。

## 云计算账号、地址绑定与轮换

“云计算账号”与 DNS Provider 凭证独立。选择 AWS、Microsoft Azure 或 Linode / Akamai Cloud 后输入对应凭证；修改凭证必须保持 Provider 和远端账号身份一致。凭证在 API 验证后加密保存，浏览器在关闭表单、切换 Provider 或退出会话时清空草稿。区域标识以 Provider 返回的区域为准，留空表示扫描该账号可见区域，不代表全局写权限。

| 云 Provider / 服务 | 凭证 | 区域示例 | 初始轮换范围 |
| --- | --- | --- | --- |
| AWS / EC2、Lightsail | 专用 IAM AccessKey，可选 Session Token；管理员可使用部署身份或 AssumeRole | `ap-southeast-2` | 保留已有 EC2/Lightsail 能力与限制 |
| Azure / Virtual Machine | Service Principal：Tenant ID、Subscription ID、Client ID、Client Secret | `australiaeast` | 运行中的独立 VM，精确的现有 NIC IP 配置，Standard / Regional / Static 公网 IPv4 或 IPv6 |
| Linode / Akamai Cloud | Personal Access Token | `us-east` | 运行中的实例、唯一旧版配置、已启用 Network Helper、default 启动模式和简单公网接口；仅 IPv4 轮换 |

先同步清单，核对实例、地址和能力原因，再开启“允许 MasterDNS 管理”。只做绑定与监控时可将全部轮换权限保持关闭；Linode SLAAC IPv6 不可替换，但已发现的实际公网主机地址可绑定 AAAA 和监控。新版 Linode Interfaces、复杂网络及不支持的 Azure 拓扑也不得以“开启管理”绕过能力检查。路由前缀不能当作已配置主机地址发布。

IPv4、IPv6、停止/启动/重启和用户原有旧地址释放是独立显式授权，默认关闭；轮换策略也必须单独开启。技术能力可用与凭证验证成功都不证明写权限、配额或公网可达性。Azure 需要 VM/NIC/公网 IP/子网读取、公网 IP write/join、NIC write、适用 join 和异步操作读取权限；清理另需 delete。Linode 轮换需要 `linodes:read_write`、`ips:read_only` 和 `events:read_only`（对应 read_write 或 `*` 可满足 scope 检查），以及用户对所选实例和 profile 的有效访问权限。

Linode 额外 IPv4 需要支持团队批准配额并产生费用。换址会重启实例以应用 Network Helper 配置；候选地址通过外部健康复测后才能发布 DNS。旧地址释放开关仅控制用户原有 IPv4；系统创建的地址（包括失败候选及后续换下的旧地址）仍可自动清理。在停止、启动或重启授权有效时，每次清理都可能再次重启以移除旧配置，因此可能发生多次额外服务中断，不能按固定两次预留。清理重启后的完整健康阈值也需重新满足；`cleanup_health_failed` 表示探测未恢复，`probe_insufficient` 表示证据不足。控制面 running 或重启 API 成功不能代替 guest 网络与外部健康验收。MasterDNS 不会自动启用 Network Helper，也不提交配额申请。

Azure 的 whole-NIC PUT 没有已证明的外部原子 CAS 保证；MasterDNS 内部锁无法防止第三方在最终读取与写入之间修改 NIC。Linode 丢失分配响应时不能根据新增地址清单认领资源或重新分配，重启事件也无法在所有情况下区分同用户的并发手动操作。遇到 ambiguous 状态应先核实远端与持久证据，不能通过反复提交来猜测成功。

完整权限、拓扑、恢复及外部并发边界见 [Azure](providers/azure.md) 和 [Linode](providers/linode.md)。本批验收进度与未执行项目见 [Azure/Linode 验收记录](validation/azure-linode.md)。Go Agent 协议未变，未修改或重新发布 Agent；继续使用已审核的独立发布版本。
