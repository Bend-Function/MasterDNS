# IP 定时轮换验收记录（2026-09-24）

## 范围与结果

为现有 AWS EC2/Lightsail、Azure VM、Linode 公网 IPv4 轮换增加地址槽日程。默认关闭，默认 1440 分钟，接受 1–129600 的整数分钟。scheduled 复用既有跨云执行器、授权、尝试预算、候选复测、DNS 发布和必要清理；AWS manual 快捷入口保持原有语义。本次没有改写云适配器策略，也没有新增 verificationMode。

验收使用隔离 PostgreSQL/Redis、真实服务和执行器、假云传输及假 DNS provider。没有使用真实云凭证或对真实云资源换址。

## 三家服务商的完整日程链路

`apps/api/test/provider-rotation-acceptance.test.ts` 中 6 个 scheduled 用例覆盖：

1. 经 `RotationSchedulesController` / `RotationSchedulesService` 保存 17 分钟日程，健康旧地址与关闭的故障轮换策略不阻止独立日程。未来截止时间不接纳任务。
2. 模拟到期后调用真实 scanner；重复扫描只产生一个 `scheduled-1-<due UTC>` incident 和一次队列唤醒，扫描本身没有云写入。
3. 执行真实 runtime / provider adapter，使用原策略的 3 次预算；本次成功仅消耗 1 次。未经新候选健康验证不写新 DNS。
4. 新 DNS 发布成功后进入 cleanup；TTL 未到时没有清理写入，也没有下一次日程。到期后真实清理完成，再按整个任务的 `completedAt + 17 分钟` 设置下一次日程。重复扫描不漂移该时间、不重复建任务。
5. Linode 清理阶段重启后，旧健康证据仍阻止完成；注入高于 cleanup cutoff 的新健康序列后才完成并推进日程。
6. 对三家分别撤销 managed 授权，既有执行器暂停任务，scanner 记录 `authorization_revoked`；恢复授权并显式恢复日程会重排时间，但不会恢复旧 incident，旧任务仍阻止新接纳。

| Provider | 保持的实际执行步骤 | 完成条件 |
| --- | --- | --- |
| AWS EC2 EIP | allocate → associate → release | 新候选健康、DNS applied、TTL、旧 EIP 已释放 |
| Azure VM | public-IP allocate → associate → delete | 新候选健康、DNS applied、TTL、旧 Public IP 已删除 |
| Linode | IPv4 allocate → instance reboot → IPv4 release → instance reboot | 新候选健康、DNS applied、TTL、旧地址释放、清理重启后的新健康证据 |

AWS 使用 `Ec2CloudAdapter` 和假 SDK responder；Azure/Linode 使用真实适配器和假 HTTP responder。所有 runtime 账户身份检查仍执行。既有 AWS scheduled/health 计划与预算对比，以及 manual/health 回归仍在 worker 测试中运行。33 个 fake-provider 验收用例也覆盖外部资源身份改变、凭证替换、模糊写入观察而不重复写、失败候选清理、DNS 发布与人工恢复。全局回归包含云限流、预算、租约、恢复及后台扫描竞态。

## 验证命令与计数

环境：Node.js 22.22.3、pnpm 11.25.0、Vitest 4.0.18，隔离 PostgreSQL 18 / Redis 8。仓库声明 pnpm 11.9.0；此工作区沿用已配置的 11.25.0，没有修改 lockfile 或 packageManager。

测试命令均先加载隔离测试环境：`source .superpowers/sdd/2026-09-24-interval-ip-rotation/test-env.sh`。该工作文件不提交；其他环境可设置 `MASTERDNS_TEST_DATABASE_URL` / `MASTERDNS_TEST_REDIS_URL` 和应用所需的本地测试环境后复跑。

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 134 文件、1420 测试通过 |
| `pnpm --filter @masterdns/api test:provider-rotation` | 1 文件、33 测试通过；此 suite 不包含在根 `pnpm test` 中 |
| `pnpm typecheck` | 所有配置的 workspace TypeScript 检查通过 |
| `pnpm lint` | 配置的 Web ESLint 检查通过 |
| `pnpm test:coverage` | 3 文件、116 测试通过；配置的 90% gate 通过 |
| `unset NEXT_PUBLIC_UI_PREVIEW; NODE_ENV=production pnpm build` | shared packages、API、worker、Next.js 16.2.12 生产构建通过；18/18 静态页面生成 |
| `git diff --check` | 通过 |

根测试分布：contracts 55、crypto 4、automation 116、checkers 9、cloud-providers 376、db 51、providers 11、web 164、api 306、worker 328。

覆盖率仅针对仓库配置的 automation 文件（health-state、probe-consensus、strategy）：statements 96.31%、branches 94.53%、functions 100%、lines 97.58%。该比例不是日程实现或全仓库的覆盖率声明。

## 本轮修复与验证

- PATCH 增加负数和小数 revision 契约断言，和 resume 的边界要求一致。
- 缺失地址槽的 PATCH/resume 统一返回与 GET、跨所有者访问一致的 404；回归测试先复现原 409，再验证三种操作不泄露资源可见性。
- 预期的审计失败和队列失败日志仅在对应 fault-injection 测试内捕获，并断言次数及内容；异常日志仍可暴露真实失败。
- Azure preview 不再继承 AWS `rotation-01` 阻塞或 unavailable capability，移除可选 reason 字段；保留显式 AWS 与 Linode 任务状态。fixture 测试先复现继承错误后通过，Web 类型检查与构建通过。

## 设计决策与部署影响

1. scheduler 注册在仓库实际使用的 `worker.module.ts`，每 10 秒仅查询数据库，分页大小 200。队列负责唤醒，持久 incident 由既有恢复扫描兜底。
2. 无轮换策略行时，首次启用日程在同一事务建立既有的 **disabled** 默认策略。用户无需先开启故障触发；不会因此改变故障轮换开关。
3. 显式恢复日程消费已知的暂停观察，但保留 `activeIncidentId` 表示旧任务冲突。关联任务的后续成功仍独立推进日程。改变间隔或重新启用即使有 active incident，也按数据库当前时间重排展示的截止时间，active 关联仍阻止接纳。
4. 仅用 incident ID 不能区分同一任务在两次扫描之间恢复后再次暂停；schedule.updatedAt 又会被无关 PATCH 改变。因此内部保存 `lastHandledIncidentUpdatedAt`，与 incident ID 一起识别被消费的观察，并保留数据库时间戳精度。它不进入公开 API 响应。迁移前的空标记首次扫描按未处理观察收敛。
5. paused/exhausted 的无状态变化唤醒、相同 status/error 的重复暂停仅推迟 nextRunAt，保持 incident.updatedAt；真实状态、错误或执行效果变化仍刷新时间。否则普通恢复扫描会被误判为新暂停，撤销用户刚恢复的日程。测试包含微秒精度、两次扫描间再次暂停/终止、无关 PATCH、真实 store/processor 的重复唤醒。
6. 部署需先应用两条新增迁移：`0030_first_the_watchers.sql` 新建 `rotation_schedules`、外键与到期索引，并允许 scheduled 携带完整健康 epoch；`0031_true_callisto.sql` 增加内部 nullable 观察时间戳。随后部署兼容的 API/worker/Web。没有新增必须配置的环境变量，已有槽默认无日程且关闭。

## 验收边界

这是 fake-provider 集成验收，不代表真实云 API 或实际 DNS 传播验收。API 配置通过 controller/service 直接调用，覆盖真实归属、事务与审计，不启动完整 HTTP 认证链；请求契约与路由元数据有独立测试。队列唤醒被记录后直接驱动处理器；健康结果和到期/TTL 时间通过测试数据库推进，未等待真实分钟数或运行外部 Probe Agent。

AWS 本轮完整 scheduled 清理轨迹采用 EC2 EIP；Lightsail 和其它既有拓扑由原适配器/worker 回归覆盖，没有宣称逐拓扑都完成了相同日程端到端流程。Web 单元测试和生产构建已验证；Azure 修复后的浏览器操作由控制任务在提交后单独复核。本记录不把 preview 操作视为真实云验收。
