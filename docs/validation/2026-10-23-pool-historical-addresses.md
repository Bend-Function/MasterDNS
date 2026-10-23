# 历史云地址与 Pool 健康验证（2026-10-23）

## 现象与原因

基线为已推送并核对远端的 `7498b69`。用户反馈 assignment_pool 有两节点，一故障后绑定显示失败/地址健康降级；随后确认健康策略目标为“历史地址、当前清单中不存在”，状态却显示“等待有效结果”。

代码确认两层问题：CloudSync 清空不可用槽位的有效健康证据，探测调度器已经停止派发；Pool 详情将这类目标统一归为 waiting。另一方面，Pool 健康投影与 Reconcile 仅读取 endpoint_addresses 的缓存状态，已离开云清单的 current IP 仍可能被旧 healthy 状态保留为分配目标。

绑定健康是同地址族所有候选的聚合，一好一坏会 degraded；Binding state 是 DNS/调度结果，独立于地址健康。未读取用户线上任务错误，因此不声称这两处代码问题已经解释生产环境所有失败。

## 修复范围

共享只读可用性投影要求 cloud 地址匹配所链接槽位的 currentAddress 且 currentAddressObserved=true，缺失时健康投影 unknown，不参与调度。Binding 检查覆盖和 force 不能绕过；current 仍在但其他 candidate 已失效时不误排除 current，static 保留地址保持原规则。保留原地址及探测历史，不自动信任新 IP。

API evidenceStatus 增加 unavailable，Pool 页面显示“目标不可用，已停止探测”；域名行的次级标签改为“候选地址整体健康”，避免误认为当前分配节点都失败。无需新迁移，部署需更新共享 DB 包、API、Worker、Web。

## 验证

Node.js 22.22.3 / corepack pnpm 11.9.0，隔离本地 PostgreSQL/Redis、Fake DNS 与云适配器，无生产写入。

- 新跨域名回归修复前失败：DNS 仍保留历史 IP `192.0.2.10`，未切至有效 `192.0.2.20`。
- 修复后 cloud-pool-failover 10 项通过，A 记录切至有效节点，AAAA 保持原独立地址。
- Pool API 集成 2 项通过，历史目标 unavailable，健康节点计数不再包含旧 healthy 缓存。
- DB Pool 健康投影 10 项通过，包括健康覆盖不能复活历史地址、current/candidate 分离及 static 保留。
- Worker 云 Pool 故障转移、Publication、health、automation 扩大回归：7 文件、83 项通过。
- Pool API 共 78 项通过：首轮 36 项通过，binding-delete-readback 因遗漏 MASTERDNS_TEST_REDIS_URL 初始化超时；补齐变量后该文件 42 项重跑通过。
- 全仓类型检查、完整构建、Lint、git diff --check、修改文档链接均通过。独立只读审查未发现可操作问题。

API 集成首次运行缺少测试环境变量，未加载用例；补齐隔离测试变量后通过。此环境问题不算代码回归结果。

## 提交前复测

同日按用户要求重新验证最终工作树，新增普通调度、force、Binding 健康覆盖三种全链路场景，确认旧 healthy 缓存不能恢复历史 IP 的候选资格，两个 DNS 厂商的 A 记录均由有效节点接管，AAAA 独立保持正确。

- `corepack pnpm --filter @masterdns/db exec vitest run src/pool-health.test.ts`：10 项通过。
- Worker `src/rotation src/health src/automation --maxWorkers=3`：13 文件、289 项通过。
- API `src/modules/pools --maxWorkers=3`：5 文件、78 项通过，本轮测试环境变量完整。
- Web 全组：34 文件、232 项通过。
- 本轮共 609 项测试通过；完整 build、全仓 typecheck、lint、文档链接和 diff 格式检查通过。

仍未直接读取或修改线上环境，本地回归通过不代表生产部署已经完成。
