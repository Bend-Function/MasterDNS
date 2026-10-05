# MasterDNS 文档

截至 2026-10-05，主仓库已实现 DNS 管理、Pool 故障转移、DDNS、外部多探针健康检查、多云资源发现、受限 IP 换址、实例生命周期操作、通知和 Docker Compose 部署。架构与数据模型按代码基线 `cc4b90d` 更新；真实云、浏览器及生产环境验收必须查看各自记录，不能由功能存在或历史测试结果推断通过。

## 阅读入口

- [系统架构](ARCHITECTURE.md)：运行拓扑、代码分层、领域边界、核心流程、并发与故障恢复；建议先读。
- [数据模型](DATA_MODEL.md)：DNS/Pool、云资源槽位、探测证据、换址与生命周期表及状态归属。
- [产品需求文档](PRD.md)：首版产品需求基线；后续能力结合当前架构及专题设计阅读。
- [部署与运维手册](DEPLOYMENT.md)：安装、配置、升级、备份和恢复。
- [验收与真实 API 测试计划](TEST_PLAN.md)：检查入口、环境要求及验收边界。
- [历史文档拆分入口](PRODUCT_AND_ARCHITECTURE.md)。

## 厂商能力与验证记录

- [Azure](providers/azure.md)、[Linode](providers/linode.md)：支持拓扑、授权、换址与恢复限制。
- [AWS 控制平面验收入口](validation/aws-control-plane.md)。
- [多云换址闭环验证](validation/multicloud-ip-rotation.md)、[Probe 二进制联调](validation/probe-binary-integration.md)、[Azure/Linode 验证记录](validation/azure-linode.md)。
- `validation/` 其余文件按专题和日期保存证据；`superpowers/specs/` 与 `superpowers/plans/` 保存专题设计和实施记录。历史记录只对注明的提交、环境和范围有效。

## 仓库分工

主仓库 `apps/web`、`apps/api`、`apps/worker` 分别承担控制台、API 和后台自动化，七个 `packages/` 包提供共享能力。主仓库 `agent/` 是 Linux DDNS 客户端；独立 MasterDNS-Agent 仓库提供 Go 外部探测器，两者职责不同。

MasterDNS-Ansible 负责配置编译与机器/软件部署，目前与平台的自动建机、到期补建及 Pool/DNS 发布闭环尚未集成。Linode 换址临时实例不能等同于通用部署编排。

真实云凭证只能通过运行环境或加密后的应用数据库管理，不得进入源码和 Git；`MASTER_ENCRYPTION_KEY` 必须独立备份。
