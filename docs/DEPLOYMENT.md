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

停止实例只在 `allowStopStart` 打开时允许。原地址清理只在 `allowReleaseAddress` 打开、资源归属可验证且远端读取确认后执行。EC2 自动公网地址、Lightsail 临时地址及已释放的系统地址通常不能恢复为原值；数据库回退也不会重新取得它们。权限、配额错误不会通过停止实例规避，也不会刷新换址预算。

通知 Worker 从持久健康状态、轮换阶段、DNS publication 和 cleanup 状态恢复事件。Redis 丢失可重新入队，`event/channel` 唯一键避免重复投递。unknown/探测不足、目标失败与恢复分别通知；轮换通知包括预算耗尽、权限/配额、DNS 部分发布、cleanup 失败与完成。Webhook/Telegram 内容只含归属范围内的状态和资源 ID，不含凭证、Token、自定义 header、云请求或完整策略快照。

## 9. 备份与恢复

数据库是持久状态的事实来源，Redis 仅保存可恢复的队列状态。建议每日执行 PostgreSQL 逻辑备份，并定期验证恢复流程：

```bash
docker compose exec -T postgres pg_dump -U masterdns -d masterdns -Fc > masterdns.dump

# 恢复窗口：先停止所有可能触发数据库写入的服务和 Web 入口
docker compose stop web api worker migrate
docker compose exec -T postgres pg_restore --clean --if-exists --exit-on-error -U masterdns -d masterdns < masterdns.dump
docker compose run --rm migrate node packages/db/dist/preflight-cli.js
docker compose run --rm migrate
docker compose start api worker web
docker compose ps
```

恢复操作会覆盖目标数据库，应只在明确的恢复窗口执行。完整恢复需要同时具备数据库备份和对应的 `MASTER_ENCRYPTION_KEY`；Redis 卷可以重建，Worker 会扫描未完成的 Operation、持久通知状态与通知投递并重新入队。

备份只能恢复平台的持久状态。恢复旧数据库前先停止 Web、API、Worker 和 migration，防止旧状态继续驱动副作用；恢复后先核对 AWS、DNS、candidate/current/publication 与 cleanup 的远端实际状态，再恢复自动化。数据库备份不能撤销已经执行的 EC2/Lightsail 或 DNS 写入，也不能找回已释放且不可复原的地址。

## 10. 升级与回退

升级前先备份数据库和 `.env`，再构建并启动新版本：

```bash
git pull --ff-only
docker compose build
docker compose run --rm --no-deps migrate node packages/db/dist/preflight-cli.js
docker compose up -d
docker compose ps
docker compose logs --since=10m migrate api worker
```

升级预检是只读操作。若它报告同一 Zone、FQDN 和记录类型被多个 Pool 绑定，应在旧版本仍运行时根据报告中的 Binding/Pool ID 保留一个业务上正确的绑定，并删除或改名其他绑定；预检不会替操作员选择或删除数据。重复运行预检直至通过后再执行 `docker compose up -d`。健康检查唯一约束升级会按 `updated_at`、`created_at`、`id` 顺序保留每个 scope 最新的启用配置，并自动禁用其余旧配置。

migration 只向前执行。升级前必须保存 PostgreSQL 备份、对应的 `MASTER_ENCRYPTION_KEY`、旧镜像标签和旧 Agent 精确版本。若应用版本需要回退，应先确认旧版本能够读取新 schema；否则应在维护窗口恢复升级前数据库备份和旧镜像。down migration 即使存在也不能撤销已经执行的 AWS 或 DNS 写入；回退后必须按远端读取结果人工处置 partial publication、ambiguous ownership 和 cleanup failure，不能只回退代码。

## 11. 常见检查

- API 不健康：检查 `postgres`、`redis` 与 `migrate` 日志以及 `DATABASE_URL` 或 `PG*` 数据库配置。
- 无法登录：确认访问协议为 HTTPS、`WEB_URL` 与浏览器 Origin 完全一致，Cookie 未被代理删除。
- Zone 不同步：检查云账号最小权限、账号状态和 Worker 日志。
- DDNS heartbeat 401：重新生成安装 Token 并安装，或检查 Agent 是否已被吊销。
- DDNS 地址不发布：检查 candidate 对应健康检查结果，不要绕过候选地址验证。
- 自动化没有切换：检查失败阈值、冷却时间、Pool 是否暂停，以及是否仍存在健康候选节点。
- Probe 一直 unknown：检查 Agent 时间、在线状态、地址族能力、任务 deadline、有效票数和 private CIDR 策略；不要把 unknown 当作 failure。
- DNS 部分发布：查看 rotation publication 与对应 Operation/Step，先读取各 DNS 厂商远端值，再决定重试或人工修复。
- cleanup 失败：核对地址归属、引用关系、release opt-in 和远端附着状态；无法确认归属时保留资源并人工处理。
