# 升级风险修复验证 — 2026-09-20

修复基于 `codex/azure-linode-cloud` 的 `e58b711`。本次针对升级审查的六项问题，不修改独立 Go Agent 或 probe-agent/v1 协议，不执行真实云资源、DNS 或生产部署操作。

独立代码复审已通过，未发现本次修复范围内的阻断问题；已核对地址身份、云资源证明、0021 迁移与快照衔接，以及恢复演练的资源清理范围。

## 修复内容

1. Azure NIC 换址失去响应时，若仍可确认原绑定和候选身份，继续等待与观察。冲突的资源身份仍进入 ambiguous；不会盲目重发 PUT。
2. EC2 关联和观察同时核对已记录分配回执的 allocation ID 与 IP。替换资源、复制标签、回执缺失或相互矛盾时拒绝写入。
3. DDNS 当前地址和候选地址分别调度、分别保留健康证据。候选持续失败时，当前地址仍可触发正常备用节点切换。候选验证通过后按原有策略提升，保留健康备用节点的选择语义。
4. 端点轮次结算匹配原 endpointAddressId，同一 IP 回滚后创建的新地址不能使用旧地址的已接受结果。
5. HTTP 状态码列表留空时省略 expectedStatuses，使用范围规则；无效的非空状态码产生明确错误。
6. 恢复流程改为新空库恢复、校验对应版本、事务切换数据库名并保留原库。升级流程在旧写入者停止后备份、预检和迁移；任一步失败不启动新应用。

## 数据库与界面兼容

迁移 `0021_endpoint_address_health.sql` 将普通端点健康状态唯一键由 `(endpoint_id, family)` 调整为 `(endpoint_id, family, address_id)`。保留全部原有行、健康证据和序号计数；云槽位唯一键及 Agent 协议不变。升级前需停止旧 API/Worker，避免旧代码按单状态模型访问新数据。

健康 API 保留 `state` 字段，并优先返回当前地址；新增 `states` 展示当前/候选各自状态。控制台投票明细和通知标注地址角色，历史 previous 地址不再发送当前健康通知。健康策略改变时，两个地址的证据都会重置；轮次序号仍按端点/地址族单调分配。

## 实际验证

所有数据库/Redis 测试使用本机专用 PostgreSQL 17 和 Redis，测试分别创建并清理数据库或队列。没有回退使用生产连接。云 SDK/HTTP 和 DNS 厂商只在外部边界模拟。

| 检查 | 结果 |
| --- | --- |
| 全工作区 `pnpm test` | 87 个文件、866 项通过 |
| `pnpm build` | 全部包、API、Worker、默认 Turbopack 生产构建通过 |
| `pnpm typecheck`、`pnpm lint` | 通过 |
| API 跨应用集成源码类型检查 | 通过 |
| DDNS 外部/混合模式闭环 | 两项通过：真实 API 领任务/上报、健康状态、持久 outbox、Redis 队列、调和及 Operation 执行；DNS 从主节点切至独立验证的备用节点；坏候选不发布、候选恢复与旧轮次隔离 |
| Azure 持久恢复验收 | 包含原绑定尚可见与 NIC Updating 两种失去响应场景；单次 PUT、单次计费尝试，最后候选验证及 DNS 发布成功 |
| 0020→0021 升级 | 原状态和序号逐字段保留，允许第二个候选状态，仍拒绝同地址重复状态，重复迁移安全 |
| PostgreSQL 恢复演练 | 实际复现旧原地恢复失败及部分清理；验证新库失败隔离、完整旧数据恢复、活动连接阻止切换、第二次重命名失败时整体回滚、正反向切换均保留两个数据库 |

新增回归在修复前分别观察到：Azure/EC2 七项失败，HTTP 表单十一项失败，DDNS 双地址/旧轮次三项失败，API/通知消费者两项失败。修复后的上述全量测试通过。PostgreSQL 历史迁移中的标识符截断 NOTICE 和刻意失败用例的诊断输出不是生产异常。

可重复运行的独立入口：

```sh
pnpm --filter @masterdns/api test:ddns-external-health
pnpm --filter @masterdns/api test:provider-rotation
pnpm --filter @masterdns/db test
pnpm test:database-restore
```

前三项需显式设置 `MASTERDNS_TEST_DATABASE_URL`，应用集成还需 `MASTERDNS_TEST_REDIS_URL`、对应的 `DATABASE_URL` / `REDIS_URL` 和专用测试加密密钥。恢复演练另需显式 `RESTORE_TEST_ENABLED=1`、`RESTORE_TEST_CONTAINER`、`PG*`，可选 `RESTORE_TEST_ENGINE=podman` / `RESTORE_TEST_CONNECTION`；它只操作自身随机命名的数据库。完整升级/恢复步骤见 [部署说明](../DEPLOYMENT.md)。

## 使用边界

- 已经被旧代码锁存为 ambiguous 的 Azure 事件不会自动改写或强制继续，需核对真实远端状态及持久证据后处置。
- 缺少分配证明的旧 EC2 未决关联会保守停止；修复不会按标签猜测身份或重新分配。尚未发出的步骤继续从原已完成分配回执补充证明。
- 恢复演练验证了样例凭证密文字段保留，不代表验证真实凭证解密或旧镜像运行；须使用原加密密钥与对应旧镜像验收。
- 实际云端的异步延迟、连通性、权限、配额、计费和外部并发仍需专用云测试资源验收。数据库恢复不能撤销已发生的云端写入。
