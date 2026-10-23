# AWS Lightsail cleanup_failed 修复验证（2026-10-23）

## 根因与范围

用户反馈上次云阶段恢复改动仍未解决 Lightsail 的 cleanup_failed，任务显示正常且停在清理。本次明确补齐这一遗漏，不把[前一记录](2026-10-23-rotation-recovery.md)的历史验证当作本次结果。

原流程先查询历史 release operation，发现 Failed 后直接抛错，不能读回旧 IP 是否已不存在；旧 IP 仍存在时也无法把已失败操作转为可重新派发状态。CleanupService 未接入失败恢复计数、请求超时和收敛截止；部分 pending 读回又清除了 failed 标记。页面直接把 Incident active 交给通用健康徽标，显示绿色“正常”。

## 实现

- Lightsail 清理先读取旧静态 IP，明确 NotFound 即完成；正常响应缺少 staticIp 仍是异常，不能误认删除成功。原 ARN、地址和未附着状态都一致，且原派发全部操作结束、至少一项 Failed，才返回 not_applied。其余 pending/ambiguous 分别继续观察或保留资源，不盲删。
- CleanupService 接入与云端阶段共享的持久恢复预算（默认最多 5 次），读取、执行、观察均有取消/超时。明确未生效时只重试 ReleaseStaticIp，清空旧 operation receipt，保存新 fence。过期观察/旧回执不能覆盖已确认失败或新派发。
- pending 观察超过云端等待窗口按预算继续观察；耗尽不新增写入。failed 标记不会因一次 pending 而变正常。授权、发布、TTL、附着和归属前提继续阻止危险操作，不消耗自动恢复预算来绕过前提。
- 扫描按 due time 排序；过期租约冲突、已耗尽、pending/ambiguous 观察和别名资源都会延后，避免旧任务长期占满前 200 项。
- 列表和详情将 active 显示为执行中；cleanup_failed 或 failed 资源显示失败，等待恢复显示重试中；次数耗尽有独立提示。策略开关保留。
- 复用 0034 的字段，无新增迁移。需要部署 Worker/Web；此前尚未部署失败恢复功能时仍须先应用 0034 并同步升级 API。旧的未终止 cleanup_failed 会接续，人工终止不复活。

## 验证

Node.js 22.22.3，使用 `corepack pnpm` 11.9.0。PostgreSQL/Redis 为本地隔离测试实例；CloudAdapter 通过 Fake SDK/HTTP 模拟 AWS，没有真实云资源、DNS、通知或生产数据库写入。

- Worker `src/rotation` 加 notification-state-scanner：9 文件、265 项通过，涵盖清理、主执行、发布、周期调度、物理锁、故障转移与通知。
- Cloud providers 全组：25 文件、512 项通过；Lightsail 原 ARN 重建、附着变化、多 operation 中仍有 pending、缺失 staticIp 均拒绝不安全重试。
- Web 全组：34 文件、232 项通过，包含任务状态不显示“正常”的回归。
- 在上述整组后补充 ambiguous 清理错误的 NULL SQL 条件和扫描退让验证，并再次运行 cleanup/publication 两组，74 + 41 = 115 项全部通过。
- 最终代码的全仓类型检查、完整 build、Lint 均通过，修改文档的本地链接及 git diff --check 通过。

新回归使用实际 Lightsail adapter 与 Fake SDK 验证：失败释放自动重试并完成；首次加 5 次重试后停止，跨 Worker 实例计数不变；0 上限、人工暂停及授权撤销不重发；旧 IP 已释放且历史 operation 失败仍能完成；持续 pending 不重复删除；四种云调用挂起后退出；旧 pending/执行回执不能覆盖已确认未生效；200 个耗尽资源不会阻止后续清理；身份不明确仍清晰失败且延后扫描。

测试先复现旧代码失败：失败 release 抛 cloud_operation_failed，Worker recoveryRetries 始终为 0。旧网络恢复用例原先连续调用立即观察，本次按持久重试到期推进测试时间；并为 Lightsail fixture 隔离地址与账号，防止跨用例的全局空闲 IP 锁和速率额度干扰。

未做真实 AWS 写入、生产部署和浏览器端到端验收。上述本地 Fake 验证不代表线上任务已被解除。
