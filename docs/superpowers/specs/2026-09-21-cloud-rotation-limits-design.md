# 云换址操作限制设计

用户已要求加入按服务商区分的换 IP 限制，默认使用官方额度的 80%。本次实现延续同一工作区中已完成的月度流量功能，不部署、不调用真实云端写操作。

## 行为

按云账号及服务保存可编辑的 1–100 整数使用比例，默认 80%，不可关闭。AWS 区分 EC2/Lightsail。相同 provider/externalAccountId/service 的多个本地账号共用持久计数，生效比例取各副本的最低值（没有显式配置时视为 80%）。凭证更换、Worker 重启不能清零预算。

按每个实际换址步骤的一次潜在写请求计数，执行入口前持久预扣；现有所有步骤至多执行一次变更 API。只读检查、观察操作不扣写入预算。请求可能被云端拒绝、超时或执行为无操作时不退还 API 预算，保守避免低估；现有失败尝试预算与 API 预算分开。再次实际派发另扣一次；观察已有不确定副作用不派发、也不扣额度。

## 默认规则（2026-09-21 核验）

- Lightsail：每变更 API/区域容量 1，补充 1/s，80% 后容量最低保留 1、补充 0.8/s；静态 IP Allocate/Attach/Detach/Release 共享跨区域滚动 1h、24h 计数。采用官方保证的最低 50/h、500/24h，默认 40/h、400/24h，不用过期或受区域限制的本地实例数放大云端额度。Release 计数但不受动态窗口阻挡，遵循 AWS 清理例外；静态速率仍检查。Detach 在已有换址预留中计数。
- EC2：按区域及单个 API 令牌桶，普通写操作容量 50、补充 5/s（默认 40、4/s）；AssignIpv6Addresses、ModifyNetworkInterfaceAttribute 容量 100、补充 5/s（默认 80、4/s）。未知动作拒绝进入写入，不猜测规则。
- Azure VM：订阅/区域的 ARM writes、deletes 分别容量 200、补充 10/s（默认 160、8/s）；Microsoft.Network 写/删除共享 1000/300s（默认 800/300s）。免费/试用账号实际限额可能更低，云端 Retry-After 优先。
- Linode：文档普通非分页操作 1600/60s（默认 1280/60s）。为避免跨 token 规避，在账号层聚合所有换址变更，严格于厂商的逐用户/操作统计。

这些规则只管 MasterDNS 内的换址写请求；其他工具/控制台、读取 API、云服务更低的实际配额不可观测。20% 余量不保证绝不收到限流。

## 持久限流器

Contracts 新增纯规则模块，统一动作->厂商 API、scope、官方值、有效值与前端显示。DB 新增配置表、按 scopeKey 的令牌/窗口/冷却状态表、Lightsail 待派发步骤预留表。数据库时间为唯一时钟；所有关联 bucket 按 key 排序加行锁，所有检查成功才原子扣减。桶初始化也串行处理；滚动窗口保留精确时间戳，令牌桶支持分数补充且容量至少 1。

Lightsail 第一次静态 IP 派发前原子预留尚未派发的 Allocate/Detach/Attach 步骤，后续派发将自己的预留转为当前窗口用量，其他换址不能抢占。预留关联 step/attempt；只计算仍为 incident.currentAttemptId 且未完成的任务，换尝试或任务完成后无效。暂停任务保留其必要预留，以便恢复绑定。清理 Release 直接记账，不因动态预算满而阻塞。重试已经派发的步骤必须重新取得额度。

在 RotationStore.dispatch 和清理步骤持久派发前接入。拒绝时保留 prepared/not_applied/rejected_no_effect 状态，不置 in_flight，不设置 unresolvedStep，不扣 attemptsUsed；更新 nextRunAt/cleanupDueAt、错误码和可读等待时间。手动/自动路径均通过相同入口。已有 dispatched/unknown 步骤继续观察。

收到真实 rate_limited 时记录共享冷却，采用至少 60s 的有界指数退避并尊重 Retry-After；后续变更共用冷却。保留未知结果的观察语义。等待期不在数据库事务或实例 lease 内 sleep。

## 配置与显示

云账号页增加“换址限制”入口，按该账号支持的服务切换，展示官方基准、本地生效值、作用范围、最近用量/等待至时间，支持比例修改。API 必须复用账号所有权校验、严格校验服务匹配和整数比例，记录脱敏审计；不能通过设置接口清零计数。任务页显示“等待换址额度”和可重试时间，而非错误失败。

## 验证

纯规则测试覆盖每家默认 80%、最小容量、未知动作；真实 PostgreSQL 集成覆盖并发竞争、跨账号副本共享、窗口边界、重启、比例变化、预留/重试/释放例外、冷却。Worker 测试覆盖预算不足无外部写/无失败尝试消耗、到期继续、清理入口与未知观察。API 所有权/校验/审计，Web 状态与输入验证，编译/lint/浏览器验收。现有月度流量和换址回归必须继续通过。

官方依据：
- https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-api-throttling.html
- https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-throttling.html
- https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/request-limits-and-throttling
- https://techdocs.akamai.com/linode-api/reference/rate-limits
