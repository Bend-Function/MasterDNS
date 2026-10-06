# 域名绑定删除前的 DNS 核对

问题：删除 Pool 域名时，只要曾有一次 attempted failed/skipped create/update，原逻辑就永久阻止删除；后续成功发布或 DNS 实际已不存在也不能解除。这段判断早于云厂商扩展性重构。

修复：只有发现历史不确定写入时，在现有 Zone 租约和 Pool/Binding 锁下完整读取远端记录。已管理且内容可确认的记录、或与失败写入意图精确匹配的记录，可以进入正常 DNS 删除 Operation；远端已无记录时才移除绑定并更新本地库存。历史操作与尝试次数保留。删除任务持久化后，针对该绑定的自动调和、旧发布重试与实际执行均受删除意图保护，其他绑定继续正常工作。

保护条件：pending/running 仍阻止删除；未知同名记录、不同归属、读取失败、不完整/循环分页、凭证或 Zone 身份变化、租约丢失、账号不可用均不授权删除。unpublishedOnly 取消若发现远端记录，需要回到 Pool 确认删除，不直接删除云端记录。

新增 `pnpm --filter @masterdns/api test:binding-delete-readback` 运行核对回归及真实执行器闭环测试。测试使用隔离 PostgreSQL/Redis，替换 DNS 网络边界，不访问真实云账号。

已验证：

- `pnpm test`：整仓 1711 项通过，其中 API 355 项、Worker 377 项。
- `pnpm --filter @masterdns/api test:binding-delete-readback`：3 个文件、59 项通过，包括核对 42 项、删除执行闭环 2 项、并发意图保护 15 项。
- 全仓类型检查、API 跨应用集成类型检查、API/Worker 编译通过。
- 无 Assignment 的远端创建成功记录可由真实 OperationProcessor 完成删除；删除响应丢失后重试同一 Operation，不重复产生远端效果。
- 并发保护用真实 PostgreSQL、Redis、BullMQ Queues/Workers/QueueEvents 验证，DNS 网络边界替换为 fake。pending/running/failed 删除仍受保护，删除重试允许，无关域名/步骤仍正常发布。
- 独立复核发现的长 TTL 和并发重新发布问题均已修复并定向复核通过。

删除期间使用按 Binding 的持久意图保护，没有提前增加整个 Pool 的策略版本；正常完成时继续沿用已有版本更新，避免使无关域名任务失效。

Pool 的合法 TTL（最高 2147483647）沿用原有范围，核对时保留其他 DNS 字段/IP 校验。无数据库迁移或新增环境变量。此修复需要部署后才对线上删除生效；没有修改任何真实 DNS、实例或生产数据库。
