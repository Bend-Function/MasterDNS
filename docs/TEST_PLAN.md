# MasterDNS 验收与真实 API 测试计划

## 1. 测试层级

### Docker 日志配置验收（2026-10-23）

用仅含占位凭证的隔离环境运行 `docker compose --env-file /dev/null -f docker-compose.yml config --format json`，不要把真实部署的完整配置输出到测试记录。检查全部六个服务均解析出 `json-file`、字符串 `max-size: "10m"`、`max-file: "3"`、`compress: "true"`；同时检查自定义 `DOCKER_LOG_MAX_SIZE=5m` / `DOCKER_LOG_MAX_FILES=2` 生效、变量未设置或为空时回落到默认值。无需启动业务容器或访问云账号。

有 Docker daemon 的隔离环境还应以小阈值持续输出测试日志，验证自动轮转、最旧文件淘汰、压缩及 `docker logs` 可读性；部署验收按[部署手册](DEPLOYMENT.md)重建后检查所有服务的 `HostConfig.LogConfig`，确认数据卷仍是原卷。配置解析通过不代表已完成真实轮转或生产磁盘回收。记录见[容器日志限制验证](validation/2026-10-23-docker-log-limits.md)。

### 单元测试

- Provider 数据标准化和错误分类。
- HTTP/TCP Checker 参数校验和结果映射。
- 健康阈值状态机。
- 三种 Pool 策略和四种选择算法。
- 随机算法在固定事件种子下可重现。
- Webhook 签名和 Token 哈希。

### 集成测试

- PostgreSQL Repository、约束和 migration。
- BullMQ 投递、重试和重启恢复。
- Operation 的部分成功、过期决策和幂等性。
- 使用本地 HTTP/TCP 测试服务模拟健康、超时、拒绝和恢复。
- 使用 Provider Fake 验证限流、权限、超时和读取验证流程。
- 在隔离 PostgreSQL 中从持久健康/轮换状态重建通知，使用 Fake Queue 验证 Redis wake 丢失后的稳定去重、跨 Pool 同 owner 路由和敏感字段隔离；不调用真实 Webhook、Telegram 或收件人。

### 换址失败恢复回归（2026-10-23）

使用隔离 PostgreSQL 的 `MASTERDNS_TEST_DATABASE_URL` 和隔离 Redis 的 `MASTERDNS_TEST_REDIS_URL`，先运行 `pnpm build:packages`，再运行：

```bash
pnpm --filter @masterdns/worker exec vitest run src/rotation --maxWorkers=3
pnpm --filter @masterdns/db exec vitest run src/rotation-recovery-migration.test.ts src/rotation-schema.test.ts src/interval-rotation-migration.test.ts
pnpm --filter @masterdns/cloud-providers test
pnpm --filter @masterdns/contracts test
pnpm --filter @masterdns/api exec vitest run src/modules/rotation
pnpm --filter @masterdns/web test
pnpm typecheck
pnpm lint
```

追加检查：发布身份/清单挂起后退出，任务关联的 DNS 失败按预算等待再投递且保留成功步骤，人工暂停/耗尽不重投递，complete 不因迟到失败复活；Azure operation 404/失败时核对实际资源并保留旧计划 GUID/发布地址校验；EC2 缺字段响应不能冒充清理成功；Linode 派发前事件水位变化拒绝执行。

验收要求：首次失败后最多 5 次自动恢复，0/自定义上限生效；重启与重复入队不刷新计数；重试间隔与 Retry-After 生效；云请求挂起能释放队列执行并保留迟到回执；明确未生效重试保留原申请和预算；收敛超时继续观察而不重放不确定写入；旧版临时暂停可接续；人工暂停/终止、授权撤销和归属不明仍受保护；scheduled 恢复期间不暂停周期计划；升级保留原开关与换址预算并校验范围约束。Lightsail 清理必须覆盖真实 adapter + Fake SDK 的失败释放后重试完成、首次加 5 次重试耗尽、旧 IP 已删除但旧操作失败、并行操作未结束/资源重建/附着变化拒绝重放，以及 200 个耗尽任务不阻塞后续扫描；cleanup 四种云调用挂起都应退出，旧 pending 不覆盖 confirmed not_applied，页面不再将 active 显示为正常。Linode 电源失败需通过失败事件水位和原资源身份复核后重试，不能重复建临时实例或交换地址。Fake 云用例不构成真实云或生产验收。

### 端到端测试

- 管理员创建用户及权限隔离。
- 接入云账号并同步域名。
- DNS 普通记录 CRUD、历史和回滚。
- Pool 创建、故障、切换、全池故障及恢复。
- DDNS 安装 Token 兑换、heartbeat、地址提升和 DNS 更新。
- 外部漂移检测和自动纠正。
- Webhook 与 Telegram 测试通知。
- 桌面与移动端关键应急操作。

## 2. Cloudflare 真实 API 测试

### 2.1 凭证处理

- 真实 Token 只通过本地 Secret 或测试环境变量 `MASTERDNS_E2E_CLOUDFLARE_API_TOKEN` 注入。
- Token 不写入源码、Git、快照、测试报告或命令输出。
- 日志只显示 Credential ID 和权限结果，不显示 Token 片段。
- 对话中提供过的 Token 在验收完成后应轮换。

### 2.2 安全边界

- 首先只读验证 Token，并列出可访问 Zone 的 ID 和名称。
- 不修改任何已有记录。
- 从可写 Zone 中确定一个测试 Zone；所有写入均使用本次运行唯一前缀。
- 测试记录使用 `masterdns-e2e-<run-id>`，其中 `run-id` 为短随机值。
- A 记录使用 RFC 5737 TEST-NET 地址 `192.0.2.10` 和 `192.0.2.20`，`proxied=false`，不指向用户基础设施。
- 每个写测试使用 `try/finally` 清理；清理后再次查询确认不存在。
- 如果自动清理失败，测试必须失败并明确报告 Zone 和测试记录名，不静默结束。

### 2.3 成功路径

1. 验证 Token 和 DNS Write 能力。
2. 分页读取两个 Zone，不输出无关记录内容。
3. 创建隔离 A 记录，值为 `192.0.2.10`。
4. 读取并验证类型、名称、值、TTL 和 `proxied`。
5. 更新为 `192.0.2.20` 并读取验证。
6. 通过 MasterDNS 历史将记录回滚到 `192.0.2.10` 并读取验证。
7. 删除测试记录并确认远端不存在。
8. 验证每一步对应的 Operation、Step 和 Audit Log 不含敏感信息。

### 2.4 失败路径

- 无效 Record ID 返回统一 `not_found`。
- 非法 IPv4 在本地校验阶段被拒绝，不发送厂商请求。
- 重复或冲突记录得到稳定 `conflict/validation_failed` 分类。
- Cloudflare 更新的 HTTP 400/422 保留数字错误码、嵌套错误链及已知出错字段；任意消息、未知字段、请求头不进入可见详情，畸形或过长响应不改变分类、不导致诊断崩溃。变更历史打开详情后必须显示已存的 `errorDetail`，可区分本地云发布校验和厂商拒绝；使用 `pnpm --filter @masterdns/providers test` 与 `pnpm --filter @masterdns/web test` 验证。
- 使用隔离 PostgreSQL/Redis 执行 Worker 的 `src/rotation/cloud-pool-failover.test.ts`：Lightsail 当前地址行仍存在但发布被手动终止时，普通/force 分配不得生成引用旧发布的失败更新；后台推进新候选版本，旧证据不能完成发布，复测成功后两个 DNS Provider 的 A 记录接管、AAAA 不变，旧任务与旧发布继续终止。
- 模拟 SDK 超时后先读取远端再决定重试。
- 模拟 429 并验证遵守等待时间；不主动消耗真实账号配额制造限流。
- 使用权限不足的 Fake Credential 验证账号进入需处理状态；不修改真实 Token 权限来测试。

## 3. 阿里云验收

在获得专用 RAM 测试凭证和测试域名后，复用与 Cloudflare 相同的隔离前缀和清理规则，并额外验证：

- `RR/Type/Value/TTL/Line/Weight/Status` 标准化。
- `RecordId` 在更新和重新创建后的处理。
- RAM 权限不足和 OpenAPI 错误映射。
- SDK 重试与 API 级限流。

在没有真实阿里云测试凭证前，Provider Contract 必须通过 Fake 和录制后脱敏的响应 Fixture，但不得把 Fixture 当作真实 API 验收通过。

## 4. Pool 场景矩阵

历史云地址回归入口：`pnpm --filter @masterdns/db exec vitest run src/pool-health.test.ts`、`pnpm --filter @masterdns/api exec vitest run src/modules/pools/pool-health.integration.test.ts`、`pnpm --filter @masterdns/worker exec vitest run src/rotation/cloud-pool-failover.test.ts`。API 测试需隔离 DATABASE_URL/REDIS_URL 与仅用于测试的 MASTER_ENCRYPTION_KEY；数据库用例另需 MASTERDNS_TEST_DATABASE_URL，Worker 及使用 Redis 的 API 用例需 MASTERDNS_TEST_REDIS_URL。先运行 `pnpm build:packages`。

新增要求：云清单标记 current 地址缺失后，旧 healthy 与 Binding 覆盖均不得使其继续参与 assignment_pool 分配；其他有效节点可接管 A 记录，不影响独立 AAAA。旧 candidate 缺失但 current 仍在时不误排除 current；显式保留的 static 地址保持原行为。API unavailable 状态与 UI“目标不可用，已停止探测”一致。


| 场景 | 预期 |
| --- | --- |
| 单次检查失败 | 状态 degraded，不切换 |
| 连续失败达到 3 次 | 状态 unhealthy，生成一次决策 |
| 冷却期内再次波动 | 不重复切换 |
| 主备主节点恢复 | 按 recovery mode 处理 |
| healthy_set 单节点失败 | 仅移除该节点 |
| assignment_pool 一个节点承载多域名后失败 | 所有受影响域名分别重新调度 |
| 全池故障 | 保留当前 DNS 并告警 |
| 随机调度 | 只选择健康、启用、非维护节点 |
| 顺序调度 | 选择优先级最高健康节点 |
| 轮询调度 | 从上次游标继续 |
| 最少分配 | 选择当前活动绑定最少节点 |
| Provider 部分失败 | 成功项保留，失败项独立重试 |
| 策略修改导致旧任务到达 | 旧任务标记 superseded |

## 5. DDNS Agent 验收

- 安装 Token 只能使用一次且按时过期。
- systemd service 使用低权限用户，Token 配置权限为 `0600`。
- IPv4/IPv6 未变化时只更新 heartbeat，不调用 Provider。
- 新地址作为 candidate，检查成功后才提升。
- 新地址检查失败时不发布，并触发 Pool 调度。
- Agent Token 不能读取任何管理 API。
- Token 吊销后下次 heartbeat 失败，现有 DNS 不被直接删除。
- 安装、状态、更新、卸载命令在受支持 Linux 发行版验证。

## 6. 发布门槛

`pnpm test:probe-integration` 顺序执行 P12a 独立 Agent 协议验收与 P12b 完整闭环/进程崩溃恢复验收。覆盖真实二进制、HTTPS API、三轮故障/成功、换址预算、DNS 部分成功重启、TTL 清理和 Pool 备用地址切换；仅远端云/DNS 控制面使用 fake，不代表真实 AWS 写入验收。环境和边界见 [二进制协议说明](validation/probe-binary-integration.md) 与 [闭环验收说明](validation/multicloud-ip-rotation.md)。

通知测试中的 “delivered” 只表示 Fake Queue/Fake Delivery 或隔离的自有接收端完成，不能表述为真实邮件、Telegram 或第三方 Webhook 已送达。CI 不向真实人员或第三方频道发消息。真实 AWS 验收必须使用专门隔离的 EC2/Lightsail 资源和测试 DNS，不能使用现有生产实例；没有完成该验收时，构建、Fake Provider 和跨编译结果都不能记为真实云通过。

### 6.1 自动化门槛

- `pnpm build`、`pnpm typecheck`、`pnpm lint` 和 `pnpm test` 全部通过。
- `pnpm test:coverage` 对 `@masterdns/automation` 的核心策略与健康状态机执行 V8 覆盖率检查，branches、functions、lines 和 statements 均不得低于 90%。
- 数据库连接参数、升级预检报告和 migration SQL 的 PostgreSQL 验证通过。

### 6.2 环境验收门槛

- 在隔离 PostgreSQL 中完成空库 migration，并验证从上一发布版本升级；破坏性回退通过恢复升级前备份演练，不宣称 migration 自动向后回滚。
- Provider Adapter Contract 全部通过；Cloudflare 隔离真实 API 测试通过且无残留记录。
- 安全日志测试确认不含 Token、Secret、Cookie 和凭证明文。
- Worker 被强制终止后，未完成 Operation 能够恢复且不产生重复记录。
- Worker/Redis 重启后，持久通知状态和 retrying delivery 能恢复；相同语义状态在同一 channel 只产生一条 delivery，后续状态转换产生新事件。
- 分别验证 probe insufficient/unknown、target failure/recovery、rotation exhausted、permission/quota、DNS partial、cleanup failed/completed；通知 payload 和日志不含 Token、凭证、自定义 header、原始云请求、完整配置或 plan。
- Playwright 验证桌面和移动端无阻塞操作问题。

## 7. Azure / Linode 云计算扩展

状态与精确执行证据统一记录在 [Azure/Linode 验收记录](validation/azure-linode.md)。以下是验收要求，不能据此推断每项已执行。

- Web 表单验证 AWS、Azure Service Principal、Linode PAT 的正确 payload；隐藏的其他 Provider 字段不能发送。覆盖 Provider 切换、关闭、退出会话的草稿清空，服务端 Provider 不匹配、凭证替换保持账号身份，以及失败重试的 idempotency key 和迟到响应隔离。
- 控制台正确显示 Provider、服务、区域示例、实际能力原因、配额错误；Linode 重启授权在策略开启和手动执行前生效，并说明换址重启，以及系统地址自动清理可能引发多次额外重启（即使未授权释放用户原有地址）。不可轮换的 SLAAC IPv6 仍可绑定监控，默认权限均关闭。
- Azure REST fake 覆盖精确 NIC IP 配置、IPv4/IPv6 与 sibling/private 配置保留、异步轮询、所有权、丢失响应和受保护清理；Linode REST fake 覆盖旧版配置、Network Helper、权限/配额、不可认领的未知分配、带 actor/watermark 的换址与清理重启恢复。
- API/Worker/数据库集成覆盖 Provider 凭证与 scope 校验、工厂选择、发现元数据保留、授权与预算、fence/version、候选外部复测先于 DNS，以及重启/崩溃后持久恢复。Linode 清理重启之后必须重新达到完整健康成功阈值；区分 `cleanup_health_failed` 与 `probe_insufficient`。
- AWS EC2/Lightsail 回归、全项目 typing/lint/tests、规范仓库内的生产 Turbopack 构建，以及隔离 PostgreSQL 空库 migration 与升级验收需独立记录。Web worktree 构建不能代替控制器最终集成分支验收。
- 真实云验收仅使用隔离 Azure dual-stack VM 或 Linode 实例与测试 DNS，并验证公网入口、实际出口、guest 网络、DNS 收敛、费用、权限不足、清理和并发外部修改。未执行时必须明确标为未执行；HTTP fake 不等于真实云成功。
- Azure 外部 NIC 并发 CAS 无保证；Linode 不确定分配不能从 inventory 差集推断，普通 IPv4 分配缺少不可变 generation、重启缺少请求相关 token，均需保留运维限制。具体边界见 [Azure](providers/azure.md) 与 [Linode](providers/linode.md)。
- 桌面和移动端视觉/交互验收需在可用的授权浏览器环境完成。当前记录的原生 Mac 锁定与 Codex 浏览器认证不可用不会被自动化绕过；如未恢复，视觉验收保持待完成。
- 本批不修改 Agent 协议，也不重新发布 Go Agent；平台构建不证明已进行新的 Agent 二进制验收。


## 8. 运行时边界回归（2026-10-05）

- `pnpm --filter @masterdns/api test:ddns-local-health`：隔离 PostgreSQL/Redis 验证 DDNS 按 IPv4/IPv6 地址策略选择 Pool 检查配置、候选提升、无策略回退、外部/混合模式和配置停用。
- Worker `rotation.processor.test.ts`：撤销 Linode 临时实例授权不能阻断其他实例恢复；新事件准入发生意外数据库错误时，已有到期事件仍需排队且错误保持可观测。
- Worker `rotation-cleanup.test.ts` / `cloud-sync.service.test.ts`：确认删除后清理临时库存树；成功扫描补清历史残留；旧扫描不得重建已删除实例；保留仍在清理、被管理、有不同创建身份或失败扫描涉及的资源。
- Web `use-resource.test.tsx`：使用 happy-dom 和真实 React hook，控制请求完成顺序，验证初始加载、手动刷新、SSE 刷新、路径变化和卸载后的过期响应隔离。该测试不代表完整浏览器视觉验收。
- `rotation-temporary-instances` 的数据库投影与 Web 渲染测试：已释放临时实例不再展示，未清理实例仍显示计费提醒。

以上测试不调用真实云接口，不代替真实 Linode 建机、换址或删除验收。

## 9. 地址健康策略删除（2026-10-11）

- 在隔离 PostgreSQL 设置 `MASTERDNS_TEST_DATABASE_URL` 后，执行 `pnpm --filter @masterdns/api exec vitest run src/modules/probes/health-policy-deletion.test.ts src/modules/probes/health-policies.test.ts src/modules/probes/probe-api.test.ts src/modules/probes/health-policies.schemas.test.ts`。
- 覆盖所有者/管理员删除与越权隐藏、真实会话鉴权、必填版本及非法输入、版本冲突、IPv4/IPv6 隔离、证据重置、pending 轮次/任务失效、迟到结果不被接收、历史/config/stat/序号保留、重建策略继续递增轮次。
- 云槽位覆盖故障自动轮换、启用的定时轮换（含暂停计划）和 active/paused/exhausted 事件阻止删除；关闭开关或事件 complete 后允许删除。持有任务锁的并发处理不能阻塞删除，旧上下文仍须失效。
- Worker `notification-state-scanner.service.test.ts`：删除策略后保留的 unknown 状态不产生新的探测不足告警，其他健康阈值、通知恢复与去重行为继续回归。使用隔离 PostgreSQL 和 `MASTERDNS_TEST_REDIS_URL` 指定的隔离 Redis，不向外部收件人发送通知。
- `pnpm --filter @masterdns/web exec vitest run src/app/health/page.test.tsx`：以真实 React 页面与受控 fetch 验证普通用户入口、取消无请求、版本化确认、重复点击隔离、失败重试、成功移除与卸载后的迟到响应。
- 浏览器检查桌面/移动端的删除按钮、确认目标和地址族、云/普通节点影响说明、加载与错误反馈。React/happy-dom 测试不替代浏览器视觉验收。
- 对此变更执行全仓库类型检查、Web lint 和构建；不把这些离线验证记为真实云/DNS 写入或生产升级验收。详细执行范围见[专题记录](validation/2026-10-11-health-policy-deletion.md)。
