# IP 定时轮换 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 给 AWS、Azure、Linode 的既有 IP 轮换策略增加每隔 N 分钟触发的能力。

**Architecture:** 独立日程表与数据库调度器创建现有轮换任务，增加 scheduled 来源来区分到期和故障触发。执行器沿用现有策略；只调整初始故障门槛、健康旧地址提前结束及触发开关的判断。

**Tech Stack:** PostgreSQL/Drizzle、NestJS、BullMQ、Next.js/React、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-24-interval-ip-rotation-design.md`

## Global Constraints

- 三家服务商现有支持范围内的公网 IPv4；不重写适配器、不增加 verificationMode、不新设云商复测策略。
- 次数、等待窗口、复测、DNS、重启、清理和 API 限制继承既有策略；定时事件只去重任务，不强制任务只有一次换址尝试。
- 日程默认关闭；默认 1440 分钟（24 小时）；正整数 1–129600 分钟（最多 90 天）。
- 按设计文档处理时间、恢复、关闭和后台更新；仅数据库调度，不在扫描阶段访问云 API。
- 保持 AWS manual 快捷入口原语义；scheduled 接入现有跨云流程。

## Task 1: 日程表与契约

**Files:** `packages/db/src/schema/rotation.ts`, `packages/db/src/schema/index.ts`, `packages/contracts/src/rotation.ts`，由 Drizzle 生成下一条迁移及 snapshot。

- [ ] 编写 DB 升级测试与契约测试：旧任务不变，scheduled 使用完整健康 epoch；间隔和修订号边界有效。
- [ ] 添加设计文档中的 rotationSchedules 字段、slotId 外键、activeIncidentId 外键和到期索引；trigger 增加 scheduled，扩展 CHECK。
- [ ] 定义读取响应及三个请求契约：GET、PATCH `{ revision, enabled, intervalMinutes }`、resume `{ revision }`。
- [ ] 使用测试 PostgreSQL 运行 `packages/db` 的迁移和约束测试，并运行 contracts 测试及类型检查。

## Task 2: 最小触发接入

**Files:** `packages/db/src/rotation-incidents.ts`, `packages/db/src/rotation-context.ts`, `apps/worker/src/rotation/rotation-store.ts`，对应 DB/API/Worker 轮换测试。

- [ ] 先写差异测试：健康旧地址允许 scheduled、不允许 health；manual 的现有范围和语义不变。
- [ ] 从正常跨云任务创建流程提取内部公共逻辑：共同校验已有执行前提、保存配置版本、使用 `policy.maxAttempts` 创建预算；health 入口保留故障证据检查，scheduled 入口只由锁定有效日程的事务调用。
- [ ] 故障开关仅控制 health 入场；scheduled 的入场由日程开关控制，后续仍校验既有授权和配置版本。关闭日程不阻断已接纳任务。
- [ ] 将旧 IP 健康导致的换址前提前完成限制到 health；scheduled 的候选复测、发布、清理和预算恢复走现有正常跨云分支，禁止将 scheduled 全部替换成 manual 判断。
- [ ] 覆盖 trigger 分支，包括 `resumeRotationIncident` 的预算创建与 current/pending segment 关联，确保复用原有正常恢复语义而不产生不存在的 segment。
- [ ] 在三个服务商的模拟资源上对比执行轨迹：相同策略生成相同云步骤、尝试预算和收尾条件。现有手动/故障回归通过后继续。

## Task 3: 日程 API

**Files:** 新建 `apps/api/src/modules/rotation/rotation-schedules.service.ts` 与测试；修改 rotation controller、module、schemas；数据库时间/状态计算放入 `packages/db/src/rotation-schedules.ts` 并导出。

- [ ] 测试默认关闭、首次启用、修改间隔、相同输入不重置时间、关闭、恢复、修订冲突和跨所有者访问。
- [ ] 实现 GET/PATCH/resume，复用既有资源归属与执行条件检查，事务锁顺序遵循设计；仅配置变更递增 revision。
- [ ] PATCH 改变间隔或开关时按数据库时间重排，resume 清除暂停并重新起算；两者不得恢复旧 incident。
- [ ] 写审计记录，API 返回 nextRunAt、关联任务与暂停原因；运行 API 测试和类型检查。

## Task 4: 调度、去重和状态收敛

**Files:** 新建 `apps/worker/src/rotation/rotation-scheduler.service.ts` 与测试；修改 `apps/worker/src/worker.module.ts` 注册服务；扩展 `packages/db/src/rotation-schedules.ts`。

- [ ] 先写并发认领、失败回滚、队列丢失、跨周期重启、已有任务、关闭/暂停与接纳竞争测试。
- [ ] 每 10 秒按键扫描并处理任务结果：成功推进计时；暂停/耗尽/终止暂停日程；限流、收敛和 TTL 等待保留同一任务。以 lastHandledIncidentId 防止重复处理同一完成事件。
- [ ] 接纳事务按 context → schedule → incident 顺序上锁，再查日程/归属/版本/到期条件；唯一来源 scheduled-revision-due，任务与日程关联同事务提交。
- [ ] 队列仅负责唤醒，沿用现有 RotationRecoveryService 找回已创建但丢失唤醒的任务；扫描不访问云 API。
- [ ] 测试手动/故障成功后延后日程、故障未完成时不抢占、关闭后后台不重新启用、配置修改后旧结果不覆盖新状态，以及 200 项以上分页不会被阻塞前缀饿死。

## Task 5: 现有机器页面中的定时设置

**Files:** `apps/web/src/components/rotation-machines.tsx`, `apps/web/src/components/rotation-policy-form.tsx`, `apps/web/src/app/rotations/page.tsx`, `apps/web/src/app/rotations/[rotationId]/page.tsx`, `apps/web/src/lib/rotation-types.ts`, `apps/web/src/lib/rotation-machines.ts` 与对应测试/demo。

- [ ] 新增独立定时区块：开关、N（分钟）、下次执行、最近任务、暂停原因及恢复日程操作；同页引用既有换址策略。
- [ ] 显示 scheduled 为「定时触发」；保留现有任务的等待/暂停/耗尽等状态和操作，展示以分钟为单位的实际间隔。
- [ ] 测试分钟输入边界、三家服务商能力展示、定时/故障开关独立、请求失败和过期响应不能覆盖较新设置。
- [ ] 运行 Web 测试、Lint、构建，使用模拟数据核对页面和设置流程。

## Task 6: 回归与交付

**Files:** `apps/api/test/provider-rotation-acceptance.test.ts`，新增 schedule 集成测试，`docs/validation/2026-09-24-interval-ip-rotation.md`。

- [ ] 对 AWS、Azure、Linode 分别模拟保存日程 → 到期 → 既有执行器 → 成功/暂停 → 下次执行；断言执行策略与现有路径一致。
- [ ] 回归现有云商限流、授权撤销、模糊写入不盲目重复、候选复测、DNS 发布、清理和人工恢复；不对真实云资源换址。
- [ ] DB/API/Worker/Web 及相关 contracts/cloud-providers 测试、类型检查、Web 构建通过后记录验收证据。最终改动应集中于调度与入口衔接，不包含适配器策略重写。
