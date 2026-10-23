# 其余换址路径恢复审查（2026-10-23）

用户在 Lightsail cleanup 修复后要求继续检查其余链路。本次基于同一未提交工作树，重点检查 EC2、Azure、Linode、发布、DNS 重试及终态；之前两份记录的测试数字仅代表各自当时的代码。

## 发现与修正

1. PublicationService 身份/清单调用没有协调器超时，临时失败可将 publish 任务永久暂停。改用共享取消与有界云调用，恢复时间和 Retry-After 持久化，轮换 Worker 和独立 publication scanner 均遵守；已有运行错误暂停可以接续，人工暂停不覆盖。
2. 已关联 Incident 的 DNS 失败原先由观察器无限重置为 pending。现在先消耗并持久安排一次恢复，到期只重投失败 Operation/Step。暂停/耗尽不重投递，成功步骤保留；初始绑定无 Incident 时保留原行为。
3. Azure operation URL 404 永久返回 pending，历史 Failed/Canceled 也可能挡住已完成删除。现在核对实际资源；原 PIP 已不存在则在确认当前发布候选身份后收尾。旧资源存在且明确删除失败才可 not_applied；记录缺失、资源重建或附着变化不能当作重发授权。
4. Linode 额外 IP/清理电源派发前未对比事件水位，丢失响应可能将先前重启归因于本次。现在在 POST 前拒绝变化水位，以 remote_identity_changed 记录无效果拒绝，避免误发布。临时实例交换路径和重试的水位校验也统一为明确无效果拒绝，防止用 ambiguous 错误进入旧事件观察。
5. EC2 DescribeAddresses 缺少 Addresses 字段会被误认为 EIP 已释放。现在拒绝缺字段数据，并将返回其他 allocation 的情况标为 ambiguous。
6. 完成事件收到迟到运行错误时存在重新安排恢复的入口。共享恢复和 pause 路径显式保留 complete 终态。

独立只读审查还发现 Azure 新增提前完成分支可能跳过旧版计划候选 GUID/地址校验；新增两项红绿测试并恢复这些校验。发布代码独立审查未发现剩余可操作问题。

## 验证范围

使用 Node.js 22.22.3 和 corepack pnpm 11.9.0。本地隔离 PostgreSQL/Redis、真实 adapter 搭配 Fake HTTP/SDK；没有生产数据库、真实云/DNS/通知写入。新用例在修复前分别复现无限/未计数重投递、永久等待、错误 applied 或错误接受旧事件。

- 发布、主 Processor、超时 3 文件：136 项通过；后续 complete 终态回归也进入整组。
- Worker 换址加通知状态扫描：9 文件、272 项通过。
- 云适配器最终整组：25 文件、523 项通过（含 Azure 旧计划候选身份回归）；随后统一 Linode 交换/电源重试的水位拒绝码并补测试，Linode 两文件最终 118 项通过。
- Web 状态/云错误展示：40 项通过。最后的 Linode 拒绝码补充后，全仓类型检查、完整构建与 Lint 再次通过。文档链接与 git diff --check 通过。

本次未增加数据库迁移；使用前次 0034 的恢复字段。只改云适配器、Worker 和展示文案，部署新版服务后生效。上述离线结果不代表已部署或通过真实云验收。
