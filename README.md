# MasterDNS

内部部署的多用户 DNS 管理、健康检查、DDNS 和自动故障转移平台。

## 项目状态

PRD v1.0、架构和数据模型已经确认，当前处于正式实现阶段。后端已具备本地用户、云账号加密、Cloudflare/阿里云适配、DNS Operation、健康检查、IP Pool 调度和 DDNS Agent 主链路；通知、完整管理界面与端到端验收仍在建设中，当前版本不能视为生产发布版。

正式文档入口见 [docs/README.md](docs/README.md)。

## Docker Compose

```bash
cp .env.example .env
openssl rand -base64 32
# 将生成值写入 MASTER_ENCRYPTION_KEY，并设置 BOOTSTRAP_ADMIN_PASSWORD
docker compose up --build
```

默认入口：Web `http://localhost:3000`，API `http://localhost:4000/api/health`。

## 本地校验

需要 Node.js 22 和 pnpm 11：

```bash
pnpm install
pnpm -r build
pnpm -r test
```

真实云凭证只能通过环境变量或控制台导入，不得写入源码、`.env.example`、Git 或测试快照。
