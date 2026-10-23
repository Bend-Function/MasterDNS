# 换址失败自动恢复验证（2026-10-23）

## 范围与根因

基于主仓库已检查的 `2fb6238` 工作树修改。此前 RotationRecoveryService 虽然从数据库反复重新入队，但云阶段 paused 在 RotationStore 中只返回 wait；运行异常和 not_applied 不会自动重新准备步骤。观察失败反复记录错误，且 SDK 永久挂起时占用 BullMQ 活动 job，人工终止又关闭了策略开关，形成必须终止后重新启用的操作循环。

本记录先前验证范围为云端阶段；用户随后指出 Lightsail cleanup_failed 仍卡住，后续修复和新增验证见 [Lightsail 清理恢复](2026-10-23-lightsail-cleanup-recovery.md)。下列测试数字保留为当时范围，不代表后续代码重新跑过同一集合。

本次在原 Incident 内接续，不通过人工 terminate/resume 入口重建任务或刷新预算。新增 `maxRecoveryRetries`（默认 5，0–20），首次失败后最多额外恢复 5 次；原 `maxAttempts` 继续限制实际换址次数。计数与到期时间存数据库，重启不清零。达到上限明确 exhausted，保存真实错误，不关闭策略；人工暂停、终止、撤销授权、永久权限/配额和资源归属不明确不会被自动重启覆盖。

## 实现边界

- 云阶段临时错误、确认未生效和收敛超时按最小尝试间隔恢复；身份校验、清单读取、观察、执行均保留更长的 Retry-After。
- 单次云调用最多等待 `min(cloudWaitSeconds, 30)` 秒。调用级 AbortSignal 传到 AWS、Azure、Linode 传输边界，阻止超时预检查继续派发后续请求。已派发请求保留 unresolved fence，超时不是无副作用证明。
- 同一派发的迟到执行回执不会覆盖已确认未生效结果；旧派发 fence 的迟到回执存入历史，不能覆盖重试的新回执/事件水位。已完成的地址申请、资源归属、尝试计费和预算段保留。
- Linode 两种换址方式可在核对失败事件和当前事件水位后，仅重试失败电源步骤。清理阶段保留原有恢复方式，不能由新 not_applied 行为触发无限重启。
- 默认上限同步到数据库迁移、共享契约、API 默认策略、控制台策略编辑和开关切换请求；详情显示累计恢复次数和最近原因。
- 迁移 `0034_rotation-recovery-retries` 为既有策略添加默认值，保留既有开关和 maxAttempts。部署需要先迁移并同步升级 Worker/API/Web。

## 本地验证

环境：Node.js 22.22.3；最终构建、类型检查、Lint、Worker/API 回归使用 `corepack pnpm` 对应仓库锁定的 pnpm 11.9.0。早期红绿测试与部分纯单元测试使用环境中 pnpm 11.25.0，依赖未变更。数据库与 Redis 为本次启动的本地隔离测试服务；云端均为 Fake SDK/HTTP，无真实云、DNS 或通知写入。

已完成：

- `pnpm build`：共享包、API、Worker、Next.js 完整构建通过。
- `pnpm typecheck`：全仓通过。
- `pnpm lint`：通过。
- Worker `src/rotation` 最终整组回归：239 项通过，覆盖执行、超时、发布、清理、周期调度、物理锁和云 Pool 故障转移。其中执行与超时 90 项通过，包含持久 5 次上限、0 次上限、旧暂停接续、人工暂停保护、授权变化、scheduled 保持启用、confirmed not_applied 接续、收敛超时不重放、迟到回执两个时序和读取 Retry-After。
- API rotation 模块：44 项通过。
- DB 新迁移、原 interval 升级和 rotation schema：6 项通过；从迁移 0033 升级、默认值、原预算/开关保留和范围约束均验证。
- Contracts：85 项通过。
- Web：231 项通过，含默认重试表单和开关切换保留自定义上限。
- Cloud providers：505 项整组通过；之后补充清理失败保护并再次跑 Linode 与调用取消相关 51 项全部通过（最终云适配测试集合比整组运行新增 1 项）。

红绿证据：临时失败原先断言为 paused；迟到执行回执把 confirmed not_applied 改回 pending；旧派发覆盖新水位；读取 Retry-After 提前重试；迟到预检查仍发送 POST。上述回归均在修复前失败并在修复后通过。

首次扩大 Worker 测试时 Redis 未启动导致 publication/failover 初始化超时；启动隔离 Redis 并显式传入测试 URL 后重跑通过，不把初始化失败计为功能验收。

本记录不声称真实云、生产部署或浏览器端到端验收通过。原有历史验收记录的代码基线与范围保持不变。
