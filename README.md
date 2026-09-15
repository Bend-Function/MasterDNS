# MasterDNS

内部部署的多用户 DNS 管理、健康检查、DDNS 和自动故障转移平台。

## 项目状态

PRD v1.0、架构和数据模型已经确认。当前实现包含本地多用户、云账号加密、Cloudflare/阿里云适配、AWS EC2/Lightsail 地址轮换、周期同步与漂移修复、DNS Operation、外部探测、IP Pool 调度、DDNS Agent、Webhook/Telegram 通知和响应式管理控制台。

正式文档入口见 [docs/README.md](docs/README.md)，部署、备份和升级步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## Docker Compose

```bash
install -m 0600 .env.example .env
openssl rand -base64 32
# 将生成值写入 MASTER_ENCRYPTION_KEY，并修改 POSTGRES_PASSWORD
# 和 BOOTSTRAP_ADMIN_PASSWORD。外部探测可选；配置已发布并审核的
# NEXT_PUBLIC_PROBE_AGENT_VERSION=vN.N.N 后才会启用 Agent 安装指引
docker compose up --build
```

默认入口：Web `http://localhost:3000`，API `http://localhost:4000/api/health`。Compose 默认只监听 `127.0.0.1`；需要由其他主机访问时，应明确修改 `BIND_ADDRESS` 并同时配置防火墙。

生产部署应在 Web/API 前配置 HTTPS 反向代理，并将 `WEB_URL`、`PUBLIC_API_URL`、`NEXT_PUBLIC_API_URL` 和 `TRUSTED_PROXY_CIDRS` 设置为实际地址。数据库卷包含加密后的云凭证；`MASTER_ENCRYPTION_KEY` 必须独立备份，不能提交到 Git。

外部 Probe Agent 是可选组件，来自独立的 `Bend-Function/MasterDNS-Agent` 发布仓库；平台镜像不包含 Go 工具链或 Agent 二进制。未配置 `NEXT_PUBLIC_PROBE_AGENT_VERSION` 时核心平台仍可部署，Agent 安装控件保持不可用。配置后必须使用已经发布的精确版本，浏览器安装指引只使用固定 GitHub Release 来源，不接受任意下载源。Agent 的安装、授权、网络策略与轮换恢复限制见部署手册。

首次启动由 `migrate` 服务执行全部 migration，并仅在空用户表中创建初始管理员。运行状态可用 `docker compose ps` 查看；API 健康检查会同时验证 PostgreSQL 与 Redis。

## 本地校验

需要 Node.js 22 和 pnpm 11：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Cloudflare 隔离 CRUD/回滚测试只从环境变量读取 Token，并始终尝试清理测试记录：

```bash
MASTERDNS_E2E_CLOUDFLARE_API_TOKEN=... \
MASTERDNS_E2E_CLOUDFLARE_ZONE=example.com \
pnpm --filter @masterdns/providers test:e2e:cloudflare
```

真实云凭证只能通过环境变量或控制台导入，不得写入源码、`.env.example`、Git 或测试快照。
