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
```

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

## 7. 备份与恢复

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

恢复操作会覆盖目标数据库，应只在明确的恢复窗口执行。完整恢复需要同时具备数据库备份和对应的 `MASTER_ENCRYPTION_KEY`；Redis 卷可以重建，Worker 会扫描未完成的 Operation 与通知投递并重新入队。

## 8. 升级与回退

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

migration 只向前执行。若应用版本需要回退，应先确认旧版本能够读取新 schema；否则应在维护窗口恢复升级前数据库备份和旧镜像。不要只回退代码而忽略数据库兼容性。

## 9. 常见检查

- API 不健康：检查 `postgres`、`redis` 与 `migrate` 日志以及 `DATABASE_URL` 或 `PG*` 数据库配置。
- 无法登录：确认访问协议为 HTTPS、`WEB_URL` 与浏览器 Origin 完全一致，Cookie 未被代理删除。
- Zone 不同步：检查云账号最小权限、账号状态和 Worker 日志。
- DDNS heartbeat 401：重新生成安装 Token 并安装，或检查 Agent 是否已被吊销。
- DDNS 地址不发布：检查 candidate 对应健康检查结果，不要绕过候选地址验证。
- 自动化没有切换：检查失败阈值、冷却时间、Pool 是否暂停，以及是否仍存在健康候选节点。
