# 新增云厂商或服务

本指南针对当前静态注册架构。厂商定义经过 TypeScript 编译和代码审核，运行时不加载用户上传的插件。云计算与 DNS 是两套独立接口；这里描述云计算，DNS 使用 `packages/providers` 的 `DnsProviderAdapter`。

## 1. 先确定需要接入的能力

按实际接口能力实现，不要求新厂商一次支持所有操作。

| 能力 | 接口 | 最小职责 |
| --- | --- | --- |
| 清单 | `CloudInventoryAdapter` | 验证账号、区域发现、分页实例清单、精确实例查询 |
| 换址 | `CloudRotationAdapter` | 能力判断、执行持久步骤、观察步骤实际结果 |
| 生命周期 | `CloudLifecycleAdapter` | 精确生命周期快照、启停/删除 |
| 流量 | `CloudTrafficAdapter` | 月流量数据及来源/统计范围 |
| 空闲地址 | `CloudIdleIpAdapter` | 清单、释放与观察；现有数据契约用于静态 IP，需要适配实际厂商语义 |

工厂返回 `CloudProviderAdapter`：基础清单加可选能力。换址调用方通过 `requireCloudRotation` 等能力检查后才能执行。旧 `CloudAdapter` 类型是明确支持换址的兼容组合，新增只读适配器应选择最小接口，不能填入虚假的成功变更方法。接入平台持久换址/清理执行器时还需要提供详细观察 `observeDetails`，以便在请求结果不确定时恢复；只提供简单状态观察不满足该执行路径。

## 2. 扩展浏览器安全目录

入口为 [cloud-catalog.ts](../../packages/contracts/src/cloud-catalog.ts) 与 [cloud-credentials.ts](../../packages/contracts/src/cloud-credentials.ts)。

- 注册厂商和服务对应关系、显示名称、区域规则/示例、支持的触发方式。
- 增加凭证 kind 的严格 schema 与字段展示元数据。只有所选凭证种类的字段进入请求；隐藏字段不得透传。
- API 和 Web 共用凭证输入 schema，保持 provider 与凭证种类匹配。
- 浏览器目录不导入厂商 SDK、Node 网络模块、数据库或服务端适配器。
- `adminOnly` 等展示元数据不替代服务端授权检查。运行时代理配置仍由服务端注入，不放宽账号凭证输入的白名单。

厂商目录集中消除了多处重复支持列表，但未知厂商仍应拒绝；不要为追求“动态”将严格联合类型降为任意字符串。

## 3. 注册服务端实现

服务端注册项位于 [registrations/](../../packages/cloud-providers/src/registrations/)，由 [registry.ts](../../packages/cloud-providers/src/registry.ts) 汇总；注册结构与能力委托定义在 [service-registry.ts](../../packages/cloud-providers/src/service-registry.ts)。注册内容包括适配器创建、能力判断、换址/清理规划及工作流策略。声明换址规划的注册项必须同时提供工作流策略；只读注册可以省略两者。已有工厂和规划函数保留为兼容入口，调用方不需要自行选择具体厂商类。

实现应分开组织：

- 网络适配器负责认证、分页、错误归类、具体 SDK/HTTP 请求及远端观察。
- 能力与计划函数只消费规范化资源快照及明确授权参数。
- 工作流策略负责厂商特定的地址角色、身份比对、候选元数据及清理条件。
- 数据库副作用（例如临时实例库存、租约和归属记录）留在 Worker/db 的持久扩展中。

具体实现不能反向依赖汇总注册表，否则容易形成 `registry → adapter → registry` 的模块循环。公共类型和步骤构造工具应放在不依赖注册表的模块。

## 4. 保持资源身份与执行语义

1. `externalAccountId` 表示远端账号身份，凭证轮换不能悄悄切换账号。
2. 清单 `ref` 必须保持本地账号、服务、区域和远端实例身份一致；分页失败不得把未读到的资源认定为删除。
3. 公网/私网、host/prefix、IPv4/IPv6、主地址/附加地址需明确，不能仅以字段名称猜测可换址能力。
4. 请求超时不代表没有副作用。执行前保存计划，恢复时先观察同一步骤；无法归属的资源保持不确定状态。
5. `capabilities.available` 只表示技术条件，用户授权、版本、预算、资源租约和健康证据仍由执行层检查。
6. 清理需要原资源归属、当前引用和 DNS 缓存期限证据。厂商不支持的 CAS 或请求幂等不能用本地锁冒充。
7. 保持旧步骤 action、arguments 和 receipt 可恢复；改变持久语义时应提供明确兼容处理及旧任务测试。

## 5. 仍需显式维护的扩展点

- 数据库 `cloud_provider` / `cloud_service` enum：[schema/cloud.ts](../../packages/db/src/schema/cloud.ts) 和新的 Drizzle SQL 迁移。当前重构不修改既有枚举值。
- 厂商专属限流/配额规则、流量来源与地址资源标识。这些协议并非所有厂商一致，应在对应能力模块中明确扩展。
- 特有用户配置，例如 Linode 重启方式、临时实例创建/删除授权，仍需要契约、表单和持久策略字段；不要借用其他厂商字段。
- 特有持久资源，例如临时实例，需接入持久扩展及删除保护，不能把数据库访问塞进浏览器目录或纯适配器。

基础清单接入通常只需要目录、凭证、适配器注册和数据库枚举。完整换址还需要规划/观察/清理语义、持久化扩展以及相应验收。

## 6. 测试与上线

先用 [adapter-contract.test.ts](../../packages/cloud-providers/src/adapter-contract.test.ts) 中的可复用契约和厂商 SDK/HTTP fake 验证，再运行真实数据库/队列的执行器集成。厂商回放数据集中在 [adapter-contract-fixtures.ts](../../packages/cloud-providers/src/adapter-contract-fixtures.ts)；通用断言与每家实际响应映射分开维护。

- 账号与资源身份、分页、清单归一化和重复读取无副作用。
- 缺失能力明确拒绝，不能意外调用其他厂商或执行变更。
- 计划中授权不足、私网/不支持拓扑、未知资源及错误版本均拒绝。
- 响应丢失、部分生效、重启恢复、观察超时和重复任务不盲目重复写入。
- DNS 部分成功、旧地址 TTL、资源引用与清理失败分别保留状态。
- 旧厂商全量回归和 Web/API 凭证字段隔离。

常用入口：

```sh
pnpm --filter @masterdns/contracts test
pnpm --filter @masterdns/cloud-providers test
pnpm --filter @masterdns/worker test
pnpm --filter @masterdns/api test
pnpm --filter @masterdns/web test
pnpm --filter @masterdns/api test:provider-rotation
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

数据库/队列测试按 [TEST_PLAN](../TEST_PLAN.md) 显式配置隔离环境。厂商 fake、编译和契约测试通过不代表真实换址通过；真实验收需要隔离实例与测试 DNS，并核对权限、配额、费用、连通性和清理结果。
