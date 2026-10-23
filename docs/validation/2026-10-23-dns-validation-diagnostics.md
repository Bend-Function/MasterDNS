# 作废云发布恢复与 DNS 失败详情验证

## 现场报告与已确认问题

用户在历史地址过滤修复后仍看到 Cloudflare 的 `update / failed / validation_failed`。用户提供的操作 JSON 中，四个失败步骤引用同一个 Lightsail Slot、Publication 和地址版本，且 `errorDetail` 均为 `Cloud publication is missing or superseded`。由该分支可确定更新在本地发布有效性校验被拦截，不能将其解释为 Cloudflare 参数拒绝。未将用户的域名、地址、账号或资源 ID 写入本记录。

基于 `e9036e5` 工作树检查确认两个诊断缺口：Worker 已将安全的 `ProviderError.message` 写入 `operation_steps.error_detail`，API 也返回该字段，但 Web 只渲染错误码；Cloudflare HTTP 400/422 映射又将全部厂商详情折叠为固定句子。

进一步复现了终止任务后的发布恢复缺口：终止会将关联 Publication 标记 `manual_terminated`，但 current 地址行保留。旧 Reconcile 在已 applied 发布上只验证当前健康证据，仍会引用该旧发布；Operation Worker 随后按终止标记拒绝。原恢复扫描仅检查地址行缺失，无法恢复这种现存地址。这解释了健康候选存在却整批更新失败的可复现路径。未读取生产 Slot/Publication 数据快照，无法仅由通用错误句排除现场同时存在地址版本变化；生产恢复仍需部署后确认。

## 变更范围

- 操作详情展示既有错误码和错误详情。
- Cloudflare 校验失败保留 HTTP 状态、数字错误码及发送字段白名单，解析有限深度的 `error_chain`；最多收集 8 项并限制为 512 字符。
- 不透传任意厂商消息、字段值、请求头或 SDK 错误正文。畸形响应仍保留原错误分类。
- Reconcile 排除当前版本已终止的发布，force 和绑定健康覆盖不能绕过；直接检查发布上下文时也拒绝终止标记。
- Publication 恢复覆盖 current 行仍存在的终止发布：锁定并复核后推进新候选版本、重置证据，重新通过外部检查及云端清单验证，再生成无 Incident 的独立发布。旧 Incident/Publication 保持终止，旧证据和旧手动授权不复用，不重启换址或清理。
- 无 schema 变更，不修改 DNS 参数，不回填旧历史中已丢失的厂商代码；既有失败操作保留为历史，新版本使用新操作。

## 验证

新增 5 个适配器测试与 2 个页面测试先在旧实现上失败，分别证明厂商代码丢失和已存详情在页面不可见；应用修复后通过。

恢复用例在原恢复器上失败：current 行仍存在时 candidateVersion 没有推进。进一步以 Lightsail 场景验证普通/force 调度；移除新增分配过滤时，两种模式都会再次产生失败 Operation，恢复过滤后通过。用例覆盖：复测前不写 DNS、扫描不会反复增加版本、旧健康证据不能发布、复测成功后两个 DNS Provider 的 A 记录接管、AAAA 不变，旧任务与发布保持终止、自动轮换开关仍为关闭。

- `corepack pnpm --filter @masterdns/providers test`：21 项通过。
- `corepack pnpm --filter @masterdns/web test`：234 项通过。
- `MASTERDNS_TEST_DATABASE_URL=... MASTERDNS_TEST_REDIS_URL=... corepack pnpm --filter @masterdns/worker exec vitest run src/rotation src/health src/automation src/operations --maxWorkers=3`：17 个文件、312 项通过；包含终止后的新发布恢复、旧终止操作隔离、云端待确认步骤隔离、授权撤销、版本变化和历史地址过滤。
- 最终相关测试共 567 项通过；`corepack pnpm build`、`corepack pnpm typecheck`、`corepack pnpm lint` 均通过。
- `git diff --check` 与改动文档的本地链接目标检查通过。
- 独立只读审查覆盖全部改动及新增文件，未发现阻止合入的问题；复核了终止隔离、授权/健康/租约边界和文档链接。审查未重复执行上述测试。

以上使用 SDK 错误对象、浏览器请求替身及隔离 PostgreSQL/Redis 中的云清单/DNS 替身，未调用真实云写入、未写入生产 DNS。文档已同步 README、文档索引、架构、数据模型、部署排查、Cloudflare/Lightsail 厂商指南和测试计划。
