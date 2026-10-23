# MasterDNS 文档

截至 2026-10-05，主仓库已实现 DNS 管理、Pool 故障转移、DDNS、外部多探针健康检查、多云资源发现、受限 IP 换址、实例生命周期操作、通知和 Docker Compose 部署。架构与数据模型按代码基线 `cc4b90d` 更新；真实云、浏览器及生产环境验收必须查看各自记录，不能由功能存在或历史测试结果推断通过。

2026-10-11 增补地址健康策略删除功能及其权限、版本与轮换依赖限制。该增量的实现和验证范围见[地址健康策略删除记录](validation/2026-10-11-health-policy-deletion.md)；基础架构基线和历史验收范围保持原有标注。

2026-10-23 增补云端换址失败自动恢复：新增默认 5 次的独立重试上限、云请求超时退出和持久恢复记录，并补齐 AWS Lightsail 清理失败恢复与任务状态显示，保留换址进度及自动开关。该增量基于已检查的 `2fb6238` 工作树，范围与验证见[换址自动恢复记录](validation/2026-10-23-rotation-recovery.md)；不扩大前述历史基线的验收范围。

同日继续检查其余厂商和发布路径，修复 Azure 异步记录过期后无法完成清理、Linode 旧重启事件误归因、EC2 缺字段响应误判，以及发布超时/无限重投递；详见[后续恢复审查](validation/2026-10-23-rotation-follow-up-audit.md)。

2026-10-23 补充历史云地址的 Pool 调度过滤与停止探测状态提示，见[历史云地址与池健康验证](validation/2026-10-23-pool-historical-addresses.md)。

2026-10-23 为全部 Compose 服务增加可配置的日志大小和文件数量上限，并压缩轮转日志；已有部署的生效步骤见[部署与运维手册](DEPLOYMENT.md)，验证范围见[容器日志限制记录](validation/2026-10-23-docker-log-limits.md)。

同日提供 `apply-log-limits.sh`，备份配置与数据库后固定现有镜像及数据卷应用日志限制；脚本测试、真实 Compose 解析和尚未完成的运行验收范围见[日志配置应用脚本验证](validation/2026-10-23-apply-log-limits.md)。

2026-10-23 修复旧任务终止后“当前地址仍存在、发布记录已作废”无法恢复的路径，增加新版本复测及分配过滤，并补齐变更历史失败详情和 Cloudflare 校验错误的安全诊断信息。见[作废发布恢复与失败详情验证](validation/2026-10-23-dns-validation-diagnostics.md)；本地回归不代替生产部署后的 DNS 发布验收。

2026-10-24 为已开启自动轮换的 AWS EC2/Lightsail 接入自动同步云端、重置本地状态和重新验证流程；恢复次数跨新旧任务累计，上限默认 5。需要迁移 0035，行为与验证见[自动同步重置记录](validation/2026-10-24-cloud-reset-recovery.md)。此前关于原任务接续的记录仍只对应其历史版本；当前 AWS 自动恢复以本条及部署手册为准。

## 阅读入口

- [系统架构](ARCHITECTURE.md)：运行拓扑、代码分层、领域边界、核心流程、并发与故障恢复；建议先读。
- [数据模型](DATA_MODEL.md)：DNS/Pool、云资源槽位、探测证据、换址与生命周期表及状态归属。
- [产品需求文档](PRD.md)：首版产品需求基线；后续能力结合当前架构及专题设计阅读。
- [部署与运维手册](DEPLOYMENT.md)：安装、配置、升级、备份和恢复。
- [验收与真实 API 测试计划](TEST_PLAN.md)：检查入口、环境要求及验收边界。
- [历史文档拆分入口](PRODUCT_AND_ARCHITECTURE.md)。

## 厂商能力与验证记录

- [Cloudflare 域名单个与批量添加](providers/cloudflare-dns.md)：账号权限、Account ID、NS 激活、API 及本地测试。

- [云厂商扩展边界验证](validation/2026-10-05-cloud-provider-extensibility.md)。

- [运行时修复与临时实例清理验证](validation/2026-10-05-runtime-fixes.md)。

- [新增云厂商指南](providers/ADDING_PROVIDER.md)：注册目录、能力接口、持久扩展和验收步骤。
- [Azure](providers/azure.md)、[Linode](providers/linode.md)：支持拓扑、授权、换址与恢复限制。
- [AWS Lightsail 清理恢复](providers/aws-lightsail.md)：失败释放、真实资源读回、重试和界面状态。
- [AWS 控制平面验收入口](validation/aws-control-plane.md)。
- [多云换址闭环验证](validation/multicloud-ip-rotation.md)、[Probe 二进制联调](validation/probe-binary-integration.md)、[Azure/Linode 验证记录](validation/azure-linode.md)。
- `validation/` 其余文件按专题和日期保存证据；`superpowers/specs/` 与 `superpowers/plans/` 保存专题设计和实施记录。历史记录只对注明的提交、环境和范围有效。

## 仓库分工

主仓库 `apps/web`、`apps/api`、`apps/worker` 分别承担控制台、API 和后台自动化，七个 `packages/` 包提供共享能力。主仓库 `agent/` 是 Linux DDNS 客户端；独立 MasterDNS-Agent 仓库提供 Go 外部探测器，两者职责不同。

MasterDNS-Ansible 负责配置编译与机器/软件部署，目前与平台的自动建机、到期补建及 Pool/DNS 发布闭环尚未集成。Linode 换址临时实例不能等同于通用部署编排。

真实云凭证只能通过运行环境或加密后的应用数据库管理，不得进入源码和 Git；`MASTER_ENCRYPTION_KEY` 必须独立备份。
