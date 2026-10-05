# Cloud Provider Extensibility Implementation Plan

**Goal:** 完成已确认的云厂商扩展边界整理，保留现有厂商行为与持久任务兼容。
**Architecture:** contracts 管理浏览器安全目录；cloud-providers 管理服务端扩展注册与能力接口；Worker/db 通过命名策略调用厂商差异。显式权限和恢复状态仍由通用执行层维护。
**Tech Stack:** TypeScript、Zod、NestJS、Drizzle、Vitest、Next.js。
**Spec:** `docs/superpowers/specs/2026-10-05-cloud-provider-extensibility-design.md`。
**Execution:** 测试先行；任务 1/2 按文件所有权并行，随后完成消费层整合和契约/文档；每个任务独立复核，最后整分支复核。集成控制器负责提交。

## Global Constraints

- 不连接真实云服务；隔离测试库/队列。禁止修改授权范围和持久 CloudStep 语义。
- API payload、凭证 kind、数据库 enum 保持兼容；无 schema migration。
- 不引入服务端 SDK 到浏览器，不增加运行时插件加载。
- 同一文件只由一个任务写入；跨任务接口先通知控制器。

## Task 1: Browser-safe catalog and credentials

Files: contracts cloud catalog/credentials/types/exports and tests; API cloud.schemas/service credential boundary; Web credential draft/form/catalog labels tests.
- [x] 建立单一目录与共享凭证校验，保留现有导出接口。
- [x] 写失败回归：服务/区域/凭证匹配、前后端严格校验与隐藏字段隔离。
- [x] 迁移 API/Web，构建 contracts，跑相关单元测试/类型检查。
- [x] 独立复核并修正。

## Task 2: Server registry and capability interfaces

Files: cloud-providers provider/factory/capabilities/plans plus service registration modules and tests; 必需的能力守卫消费点（提前协调）。
- [x] 按最小清单、换址、生命周期、流量、空闲地址拆接口。
- [x] 注册工厂、能力判断、换址/清理规划，保留原公共函数委托。
- [x] 先验证只读适配器可注册、缺能力拒绝、现有规划快照与身份边界。
- [x] 跑厂商离线回归及类型检查，独立复核。

## Task 3: Workflow/persistence policy integration

Files: Worker cloud/rotation、db rotation-context/incidents、必要的 contracts/cloud-providers 策略扩展。
- [x] 将支持矩阵、身份校验、地址角色与清理判定移入集中策略/厂商模块。
- [x] 通用协调器只消费扩展能力和结果；数据库相关临时实例逻辑保留独立持久扩展。
- [x] 用现有真实数据库回归锁定旧行为，补边界测试。
- [x] 跑 Worker/API 集成与独立复核。

## Task 4: Reusable contracts and delivery

Files: reusable cloud-provider test suite/fixtures；docs/ARCHITECTURE.md、新增 docs/providers/ADDING_PROVIDER.md、验证记录。
- [x] 新契约测试可由每个厂商复用，覆盖最小只读能力与恢复观察边界。
- [x] 文档说明添加厂商的具体入口、数据库 enum 迁移及厂商专属测试要求。
- [x] 全仓 build/typecheck/lint/test、核心 coverage 和相关 API 集成。
- [x] 整分支独立复核，修正后提交、清理临时服务，保留分支。

## 完成记录

四项交付完成，分项及整分支复核通过。精确验证范围与计数见 [验证记录](../../validation/2026-10-05-cloud-provider-extensibility.md)。
