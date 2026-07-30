# MasterDNS 设计文档

当前状态：PRD v1.0 已确认，首版实现与 Docker Compose 交付已完成，正在执行真实云账号验收。

- [产品需求文档](PRD.md)
- [系统架构设计](ARCHITECTURE.md)
- [数据模型](DATA_MODEL.md)
- [验收与真实 API 测试计划](TEST_PLAN.md)
- [部署与运维手册](DEPLOYMENT.md)
- [产品与架构决策记录](PRODUCT_AND_ARCHITECTURE.md)

实现采用 pnpm monorepo：`apps/web`、`apps/api` 和 `apps/worker` 分别承担控制台、外部 API 与后台自动化；可复用领域代码位于 `packages/`，Linux DDNS 客户端位于 `agent/`。真实云凭证只能通过运行环境或加密后的应用数据库管理，不得进入源码和 Git。
