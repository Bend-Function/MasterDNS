# 多云 IP 轮换平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 MasterDNS 中交付 AWS 实例授权、双栈外部探测、IP 轮换与 DNS 联动，并与独立 MasterDNS-Agent 仓库互通。

**Architecture:** TypeScript API 管理权限与资源，Worker 执行持久任务，云计算适配器隔离 AWS 行为，现有 DNS Operation 负责发布。Go Agent 独立构建，仅通过 probe-agent/v1 契约拉取任务和提交结果。先完成只读发现与探测，再接通云写操作。

**Tech Stack:** Node.js >=22、pnpm 11、TypeScript、NestJS/Fastify、PostgreSQL/Drizzle、BullMQ/Redis、AWS SDK for JavaScript v3、Vitest、Next.js/React。

**Spec:** `docs/superpowers/specs/2026-09-15-multicloud-ip-rotation-design.md`

## Global Constraints

- 用户补充：不做无谓的哈希验证；协议兼容依靠解析和行为测试。保持代码风格简洁、高效，复用现有模式，避免过度抽象。

- 仓库 `/Users/funcma/Project/MasterDNS`；分支 `codex/multicloud-ip-rotation`。禁止在 master 上开发、自动合并或推送。
- 外部 Agent 在 `/Users/funcma/Project/MasterDNS-Agent` 的 `codex/external-health-agent` 分支，不能把 Go 源码加进本仓库。
- 第一阶段只实现 AWS EC2 与 Lightsail，GCP/Azure/Vultr 仅预留接口；DNS 厂商与云计算厂商分开。
- 实例默认只读；IPv4/IPv6 自动轮换、允许停止再启动、原有地址自动释放均默认关闭。
- 默认每次故障最多 3 次实际换址，最小间隔 60 秒，等待云端生效 120 秒，候选复测窗口 180 秒。
- 外部检查默认间隔 15 秒、超时 3 秒、成功/失败各 3 轮，轮次截止 10 秒，结果有效期 60 秒。
- 探测方式只有 TCP 与 HTTP/HTTPS；unknown 不等于 failure。新地址必须按版本完成外部复测后才能发布 DNS。
- AWS 限流/权限/配额错误不触发停止实例。次数耗尽锁存，重启和持续失败不能刷新预算。
- 所有副作用具备持久步骤、授权复核、幂等与远端读取验证；不得释放没有授权或无法确认归属的资源。
- 本计划仅在隔离测试资源上验收真实 AWS 操作；不使用现有生产实例代替测试实例。

## 文件与边界

新增 `packages/cloud-providers`，包名 `@masterdns/cloud-providers`，其构建配置参考现有 `packages/providers`。AWS SDK 仅被该包引入；API/Worker 通过包接口调用，不将 SDK 类型泄漏到领域层。

数据表拆分为 `packages/db/src/schema/cloud.ts`、`probes.ts`、`rotation.ts`，从现有 `schema/index.ts` 导出。迁移由 Drizzle 生成，保留现有 0000–0010 迁移。任务顺序执行时各任务生成下一份迁移，不手工复用已有编号。

API 新建 `modules/cloud`、`modules/probes`、`modules/rotation`；Worker 新建 `cloud`、`probes`、`rotation`。协议和纯计算分别位于 `packages/contracts`、`packages/automation`。页面分成 cloud-accounts、cloud-instances、probes、rotations；不把新逻辑全部塞入现有 pools.service.ts。

## 执行准备与依赖

先核对 `git branch --show-current`、`git status --short`，不覆盖用户未提交改动。独立 Agent 计划在其仓库的 `docs/superpowers/plans/2026-09-15-external-health-agent.md`。

任务依赖：P1 → P2/P3；P2+P3 → P4；P1 → P5 → P6 → P7；P3+P4+P7 → P8 → P9 → P10；P4+P7+P9 → P11；全部 → P12。跨仓库 Agent 任务依赖 P1 冻结的协议，P7 与 Agent A6 完成后做联调。

## Task 1: P1 — 冻结跨仓库探测契约与云地址身份

**Files:**
- Create: `packages/contracts/src/probes.ts`, `cloud.ts`, `rotation.ts`, `probes.test.ts`
- Create: `docs/contracts/probe-agent-v1.schema.json`, `docs/contracts/probe-agent-v1.md`, `docs/contracts/fixtures/probe-task-v1.json`, `docs/contracts/fixtures/probe-result-v1.json`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:** 本任务定义后续使用的公共形状；现有 `HealthCheckConfig` 继续引用 `health.ts`。

```ts
export type AddressFamily = 4 | 6;
export type ProbeOutcome = 'success' | 'failure' | 'unavailable';
export type CloudRef = {
  accountId: string; service: 'ec2' | 'lightsail';
  region: string; instanceId: string;
};
export type SlotRef = CloudRef & {
  slotId: string; interfaceId: string; family: AddressFamily;
};
export type CloudStep = {
  id: string; action: string; resourceKey: string;
  arguments: Record<string, unknown>; destructive: boolean;
};
export type ProbeTask = {
  protocol: 'probe-agent/v1'; taskId: string; roundId: string;
  probeId: string; leaseId: string; addressVersion: number;
  configVersion: number; address: string; family: AddressFamily;
  hostname?: string; config: HealthCheckConfig; deadline: string;
  networkPolicy?: { allowedPrivateCIDRs: string[] };
};
export type ProbeResult = {
  protocol: 'probe-agent/v1'; taskId: string; leaseId: string;
  addressVersion: number; configVersion: number;
  outcome: ProbeOutcome; latencyMs: number; measuredAt: string;
  statusCode?: number; errorCode?: string;
};
```

- [ ] 在 probes.test.ts 编写真实 JSON fixture 解析测试，以及 IPv6/IPv4 不匹配、过长错误字符串、NaN/负延迟、未知协议版本拒绝测试。

```ts
expect(probeTaskSchema.safeParse({ ...taskFixture, family: 6, address: '192.0.2.1' }).success).toBe(false);
expect(probeResultSchema.safeParse({ ...resultFixture, latencyMs: -1 }).success).toBe(false);
expect(probeResultSchema.parse(resultFixture).outcome).toBe('success');
```

- [ ] 执行 `pnpm --filter @masterdns/contracts test`，确认失败来自新增 schema 缺失。
- [ ] 用 Zod strict object 实现上述 schema，UUID/ISO 时间戳/地址族/配置版本/长度边界校验；建立 `probeTaskSchema`、`probeResultSchema`、`leaseResponseSchema`、`resultAckSchema` 导出。批量结果最多 100 个，每个响应包含 taskId 与 accepted/duplicate/stale/rejected。networkPolicy 缺失或列表为空时不允许私网；列表仅由管理员授权的探测配置生成，禁止客户端领取请求自行扩张范围。
- [ ] 协议文档定义 POST `/api/v1/probe-agent/exchange`、`heartbeat`、`tasks/lease`、`results`。安装输入 `{installToken}`，返回 `{probeId,runtimeToken,protocol}`；心跳 `{protocol,agentVersion,capabilities:{ipv4,ipv6},maxConcurrency}`；租约请求 `{protocol,capacity}`，响应 `{serverTime,tasks,retryAfterMs}`；结果 `{protocol,results}`。401 吊销，409 版本/租约冲突，429 带 Retry-After。
- [ ] 创建可直接解析的 fixture：taskId/roundId/probeId/leaseId 使用固定测试 UUID；地址 `192.0.2.10`；family=4；TCP port=443、timeoutMs=3000；version=1；deadline 固定 ISO 时间。成功结果与任务 ID/版本一致。固定样例时间只能用于注入时钟的测试。
- [ ] 执行 contracts test/typecheck；将 schema、fixture 和文档复制为 Agent 仓库的 `protocol/v1` 版本快照，用两个仓库各自的解析测试验证兼容性，不增加契约哈希清单；禁止构建时读取兄弟目录。
- [ ] 提交：`git add packages/contracts docs/contracts`，`git commit -m 'feat: define cloud identity and external probe protocol v1'`。

## Task 2: P2 — 持久云资源、地址槽位与授权

**Files:**
- Create: `packages/db/src/schema/cloud.ts`, `packages/db/src/cloud-schema.test.ts`
- Create: `apps/api/src/modules/cloud/cloud-access.ts`, `cloud-access.test.ts`
- Modify: `packages/db/src/schema/index.ts`, `apps/api/src/modules/pools/pools.schemas.ts`

**Interfaces:** `assertCloudAccess(actor: AuthUser, ownerId: string): void`；数据导出 `cloudAccounts`, `cloudScanScopes`, `cloudInstances`, `cloudInterfaces`, `cloudAddresses`, `managedAddressSlots`, `instanceAuthorizations`, `cloudEndpointLinks`。

- [ ] 写隔离 PostgreSQL 测试：同名不同区域实例可共存，同一完整身份重复拒绝；默认未授权；一个 endpoint/family 只能引用一个槽位；云来源与 DDNS 输入互斥。数据库测试使用独立 `MASTERDNS_TEST_DATABASE_URL`，不得 fallback 到应用 DATABASE_URL。

```ts
expect(() => assertCloudAccess({ id: 'u1', role: 'user' } as AuthUser, 'u2')).toThrow();
expect(() => assertCloudAccess({ id: 'admin', role: 'admin' } as AuthUser, 'u2')).not.toThrow();
```

- [ ] 执行 db 和 API 新增测试，先观察约束/函数缺失失败。
- [ ] 实现账号加密字段、完整唯一键 `(accountId,service,region,externalId)`、扫描代次、授权 revision、slot current/candidate version、cloudEndpointLinks 的外键。枚举 `endpoint_address_mode` 加 cloud；旧行保持原默认值。
- [ ] 地址资源字段包含 kind=host/prefix、family、address/prefixLength、remoteAllocationId、interfaceId、origin=user/system、attemptId；slot 必须指向一个主机地址，不允许 CIDR 进入 A/AAAA。
- [ ] 生成迁移 `pnpm db:generate`，在隔离空库和 0010 基线库运行迁移，检查旧 endpoint/current/candidate 唯一约束仍成立。
- [ ] db/API test 与 typecheck 通过后，仅提交本任务 schema、生成迁移和权限函数。

## Task 3: P3 — AWS 只读适配与能力评估

**Files:**
- Create: `packages/cloud-providers/package.json`, `tsconfig.json`
- Create: `packages/cloud-providers/src/{index,provider,errors,factory,aws-credentials,ec2,lightsail,capabilities}.ts`
- Create: `packages/cloud-providers/src/{discovery,capabilities}.test.ts`
- Modify: `apps/api/package.json`, `apps/worker/package.json`, `pnpm-lock.yaml`

**Interfaces:** 接收 P1 CloudRef/SlotRef；导出 `CloudAdapter`、`createCloudAdapter`。认证配置采用判别联合 `{kind:'access_key',accessKeyId,secretAccessKey,sessionToken?}` 或 `{kind:'role',roleArn?,externalId?}`，只在服务端解密使用。

```ts
export type CloudInventory = {
  ref: CloudRef; name: string; state: string;
  interfaces: Array<{ id: string; addresses: Array<{
    address: string; family: 4 | 6; primary: boolean;
    allocationId?: string; prefixLength?: number;
  }> }>;
};
export type CloudPage = { items: CloudInventory[]; cursor?: string };
export type Capability = {
  available: boolean; reason?: string; requiresStop: boolean;
  releasesOldAddress: boolean; canRestoreOldAddress: boolean;
};
export interface CloudAdapter {
  verifyIdentity(): Promise<{ externalAccountId: string }>;
  listScopes(): Promise<string[]>;
  discover(region: string, cursor?: string): Promise<CloudPage>;
  inspect(ref: CloudRef): Promise<CloudInventory>;
  capabilities(slot: SlotRef, inventory: CloudInventory): Capability;
  execute(step: CloudStep): Promise<{ remoteId?: string }>;
  observe(step: CloudStep): Promise<'pending' | 'applied' | 'not_applied' | 'ambiguous'>;
}
```

- [ ] 用注入的 SDK send 函数和脱敏响应写测试：EC2/Lightsail 分页、区域访问拒绝、过期 credentials、IPv6 primary 不可轮换。

```ts
expect(ec2Adapter.capabilities(ipv6Slot, primaryIpv6Inventory)).toMatchObject({
  available: false, reason: 'primary_ipv6_immutable',
});
```

- [ ] `pnpm --filter @masterdns/cloud-providers test` 首次失败后，安装 `@aws-sdk/client-ec2`、`client-lightsail`、`client-sts`、`credential-providers`；用包管理器锁定解析版本。
- [ ] 实现 STS GetCallerIdentity、EC2 DescribeRegions/DescribeInstances/DescribeNetworkInterfaces、Lightsail GetRegions/GetInstances/GetStaticIps；跳过未启用区域，分页 cursor 不互相混用。新包提供 test/build/typecheck 脚本，与现有 workspace 约定一致。
- [ ] 将权限、限流、配额、临时网络错误统一为带 code/retryAfterMs 的 CloudError。错误中不包含请求 headers 或密钥。
- [ ] 此阶段 `execute` 返回明确的 `cloud_writes_not_enabled`，不能假装成功；P8 才解锁已测试 action。实现与 SDK 分离的 capability 纯函数，Lightsail IPv6-only 套餐转换标记不可用。
- [ ] 测试/构建/类型检查通过后提交包、依赖与 lockfile。

## Task 4: P4 — 账号 API、清单同步与 DNS 地址来源

**Files:**
- Create: `apps/api/src/modules/cloud/{cloud.module,cloud.controller,cloud.service,cloud.schemas,cloud-access,cloud-bindings.service}.ts`
- Create: `apps/worker/src/cloud/{cloud-sync.service,cloud-runtime.service}.ts`
- Create: `apps/api/src/modules/cloud/cloud.service.test.ts`, `apps/worker/src/cloud/cloud-sync.service.test.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/worker/src/worker.module.ts`, `apps/api/src/modules/pools/pools.service.ts`, `apps/api/src/modules/dns/dns.service.ts`

**Interfaces:** `CloudService.sync(actor,id)`、`authorize(actor,instanceId,{managed,revision})`、`CloudBindingsService.bind(actor,{zoneId,fqdn,recordType,slotId,takeoverExisting})`。`CloudRuntimeService.adapter(accountId,service)` 统一解密与身份加载。

- [ ] 写 service 测试：用户看不到别人的云账号；区域同步失败不删除旧实例；取消授权增加 revision；现有受管 DNS 绑定冲突返回 409。

```ts
expect(await syncFixture({ regionFailure: 'AccessDenied' })).toMatchObject({
  scopeStatus: 'failed', removedInstances: 0,
});
```

- [ ] 运行 `pnpm --filter @masterdns/api test` 和 worker 新测试，确认失败。
- [ ] 增加账号创建/凭证更新/禁用/同步、实例列表/详情/授权、slot 列表和绑定 API，使用现有 AuthUser、ZodBody、审计、幂等与 credential 加密工具。部署身份来源仅管理员可配置给账号，避免普通用户使用平台环境权限。
- [ ] 同步每个 scope 原子提交成功代次；失败仅更新错误。取消授权后已有 DNS 保持可见，但禁止产生新的云写步骤。轮换写授权仍由 P9 每步复核。
- [ ] 直接绑定创建单节点 primary_backup Pool 或引用显式选定的既有 Pool；同 `(zoneId,fqdn,type)` 不允许第二个管理者。现有 Pool 服务对 cloud 来源不允许手工改 IP/DDNS 覆盖。
- [ ] API/worker tests、类型检查通过后提交本任务文件。

## Task 5: P5 — 探测点身份、轮次、租约与结果存储

**Files:**
- Create: `packages/db/src/schema/probes.ts`
- Create: `apps/api/src/modules/probes/{probes.module,probes.controller,probes.service,probe-agent.controller,probe-agent-auth,probe-leases.service,probe-results.service}.ts`
- Create: `apps/api/src/modules/probes/{probe-agent-auth,probe-leases,probe-results}.test.ts`
- Modify: `packages/db/src/schema/index.ts`, `apps/api/src/app.module.ts`, `apps/api/src/auth/rate-limit-policy.ts`

**Interfaces:** `ProbeLeasesService.lease(probeId,capacity,now): Promise<ProbeTask[]>`；`ProbeResultsService.accept(probeId,result,now): Promise<'accepted'|'duplicate'|'stale'|'rejected'>`。

- [ ] 添加真实事务测试：安装 Token 只能兑换一次；并发领租约不重复；重复结果只计一次；跨 probe、旧地址版本、过期 lease、撤销 Token 不得写当前健康。

```ts
expect(await results.accept(probe.id, result, now)).toBe('accepted');
expect(await results.accept(probe.id, result, now)).toBe('duplicate');
expect(await observationsFor(result.taskId)).toHaveLength(1);
```

- [ ] 执行 API/db 测试观察失败；建立 probe_agents/tokens/groups/members、rounds/tasks/observations 及唯一键 `(roundId,probeId)`、`taskId`。
- [ ] 复用现有随机 Token 与 SHA-256 工具，安装 Token 默认 15 分钟、单次事务兑换。公网 Agent 路由使用独立 bearer 鉴权和速率限制，管理路由仍使用浏览器会话；不得复用 DDNS Token。
- [ ] 用 `FOR UPDATE SKIP LOCKED` 获取分配给当前 probe 的待处理任务，生成 leaseId 与截止时间；capacity 上限取平台最大并发和 Agent 上报容量的小值。
- [ ] 结果落库与 task 终态在一个事务中完成，鉴权后再比对 lease、revision、deadline；duplicate 返回原确认，已过期结果仅记历史 stale，不触发聚合。错误长度、批量大小受 P1 schema 限制。
- [ ] 增加迁移并通过事务/重放/权限测试后提交。

## Task 6: P6 — 按轮次聚合健康状态

**Files:**
- Create: `packages/automation/src/probe-consensus.ts`, `probe-consensus.test.ts`
- Create: `packages/contracts/src/probe-policy.ts`
- Modify: `packages/automation/src/index.ts`, `packages/contracts/src/index.ts`

**Interfaces:**

```ts
export type RoundDecision = 'success' | 'failure' | 'unknown';
export type ConsensusPolicy = {
  mode: 'any' | 'majority' | 'all' | 'at_least' | 'specified';
  minimumValid: number; failureVotes?: number; specifiedProbeId?: string;
};
export function evaluateProbeRound(input: {
  memberIds: string[]; outcomes: Record<string, ProbeOutcome>;
  policy: ConsensusPolicy;
}): RoundDecision;
```

- [ ] 测试固定分母、unknown、指定节点、N 越界及所有规则真值表。

```ts
expect(evaluateProbeRound({memberIds:['a','b','c'],outcomes:{a:'failure'},
  policy:{mode:'majority',minimumValid:1}})).toBe('unknown');
expect(evaluateProbeRound({memberIds:['a','b','c'],outcomes:{a:'failure',b:'failure',c:'success'},
  policy:{mode:'majority',minimumValid:3}})).toBe('failure');
```

- [ ] 执行 automation test 观察缺失实现；实现固定成员集合、有效数门槛 Q、故障票数 K，以及 `F>=K`/`S>M-K`/unknown 的决策。
- [ ] 新增 `advanceRoundHealth`，输入上一状态、唯一 roundId、decision、连续阈值，unknown 清空连续计数；同一 roundId 不得二次计数。把去重持久约束与纯函数测试分开。
- [ ] probe-policy schema 校验 `1<=minimumValid<=memberCount`、N 范围、specified 存在、执行窗口<=检查间隔、候选窗口足够覆盖成功轮数。
- [ ] 执行 `pnpm --filter @masterdns/automation test`、`pnpm test:coverage`、contracts tests 后提交。

## Task 7: P7 — 外部调度与本地结果共用应用入口

**Files:**
- Create: `apps/worker/src/probes/{probe-scheduler.service,probe-rounds.service,probe-health.service}.ts`
- Create: `apps/worker/src/health/health-result.service.ts`, `health-result.service.test.ts`
- Create: `apps/worker/src/probes/probe-rounds.service.test.ts`
- Modify: `apps/worker/src/health/health.processor.ts`, `health-scheduler.service.ts`, `apps/worker/src/worker.module.ts`
- Modify: `packages/db/src/schema/probes.ts`, `apps/worker/src/health/health-retention.service.ts`

**Interfaces:** `HealthResultService.apply({addressId,addressVersion,configId,configVersion,roundId,decision,checkedAt})`；`ProbeHealthService.closeRound(roundId,now)` 事务内调用 P6 并推进当前健康。

- [ ] 用现有 HealthProcessor 测试先补回归：本地静态/DDNS 候选提升不变，外部模式不被 local 单次结果覆盖，旧地址迟到结果不能提升新候选。

```ts
await resultService.apply({ ...oldVersionResult, decision: 'success' });
expect(await currentSlotVersion(slot.id)).toBe(newVersion);
expect(await currentSlotHealth(slot.id)).toBe('unknown');
```

- [ ] 执行 worker tests 观察新增场景失败；只提取现有版本校验、阈值和地址提升事务，不整体重写 processor。
- [ ] 调度器以数据库唯一轮次键创建固定成员列表，只向支持地址族且已分配到组的 probe 发任务；一轮截止后统一聚合，一票不能直接更新 endpoint。
- [ ] local-only 沿用原调度；external-only 不再安排原本地检查；explicit mixed 模式把 local 作为固定成员之一走轮次，不重复应用健康状态。
- [ ] unknown 导致轮换等待和通知，不产生目标 failure；新地址重置轮次和阈值，Worker 重启按 deadline 结算未完成轮次。统计和保留任务按探测点/地址族存储，避免不可执行任务污染失败率。
- [ ] 运行 worker tests、原有 DDNS tests 与一次使用 Agent A6 的本地租约/上报联调后提交。

## Task 8: P8 — AWS 可观察换址步骤

**Files:**
- Create: `packages/cloud-providers/src/{rotation-plan,ec2-rotation,lightsail-rotation,resource-ownership}.ts`
- Create: `packages/cloud-providers/src/{ec2-rotation,lightsail-rotation,resource-ownership}.test.ts`
- Modify: `packages/cloud-providers/src/{ec2,lightsail,index}.ts`

**Interfaces:** `planCloudRotation(slot: SlotRef, inventory: CloudInventory, options: {allowStop:boolean;attemptId:string}): CloudStep[]`；P3 execute/observe 实现本任务 action。

- [ ] SDK fake 验证 EIP 替换不抢占别的实例、自动 IPv4 设置作用于正确主 ENI、Lightsail IPv6 仅双栈/ipv4 循环、不触发 acceptBundleUpdate、primary IPv6 拒绝。

```ts
expect(planCloudRotation(primaryIpv6Slot, primaryIpv6Inventory,
  {allowStop:false,attemptId:'attempt-1'})).toEqual([]);
expect(recordedCommands.some(c => c.name === 'StopInstancesCommand')).toBe(false);
```

- [ ] 运行新测试先失败；把 capability 不可用时无计划与明确 reason 一起返回 API，由调用者暂停，不将空步骤当成功。
- [ ] 实现 EIP Allocate/Associate/Describe、EC2 ModifyNetworkInterfaceAttribute(false/true)/Describe、IPv6 Assign/Describe/Unassign、Lightsail Allocate/Detach/Attach/GetOperation/GetInstance、SetIpAddressType 等实际步骤。IPv6 解绑和 EIP 释放属于发布后清理步骤，不能提前执行。
- [ ] 每一步保存 remoteId、allocationId、operationId 与前后快照。关闭 SDK 隐藏的非幂等自动重复请求，统一由协调器观察并重试。原始异常转换为 P3 CloudError。
- [ ] 无原生 idempotency token 时用 attemptId 标记/名称查找资源，资源归属不明确返回 ambiguous；已分配失败候选再次出现时标记候选重复并消耗既有尝试，不加速无限申请。
- [ ] 显式 allowStop 只启用符合配置的 EC2 动态 IPv4 stop/wait/start/wait 计划；不得为 EIP/IPv6、API 错误兜底自动调用 stop。
- [ ] 契约测试通过后提交。真实 AWS 行为验收在 P12，不在此阶段操作用户实例。

## Task 9: P9 — 持久轮换事件、预算与实例串行化

**Files:**
- Create: `packages/db/src/schema/rotation.ts`
- Create: `packages/automation/src/rotation-machine.ts`, `rotation-machine.test.ts`
- Create: `apps/worker/src/rotation/{rotation.processor,rotation-recovery.service,rotation-lock,rotation-store}.ts`
- Create: `apps/api/src/modules/rotation/{rotation.module,rotation.controller,rotation.service,rotation.schemas}.ts`
- Create: `apps/worker/src/rotation/rotation.processor.test.ts`
- Modify: `packages/contracts/src/operations.ts`, `packages/db/src/schema/index.ts`, `apps/api/src/app.module.ts`, `apps/worker/src/worker.module.ts`, `apps/worker/src/queue-runtime.service.ts`, `apps/api/src/infrastructure/queue.module.ts`

**Interfaces:** `RotationService.start(slotId,sourceEventId)`、`resume(actor,incidentId)`；`RotationProcessor.run(incidentId)`；纯函数 `nextRotationAction(snapshot,now)` 返回 wait/execute/probe/publish/cleanup/pause/complete。

- [ ] 写纯状态机及故障注入测试：第三次失败 exhausted；第 100 次健康失败不刷新预算；重启恢复相同 attempt；一个实例 v4/v6 不同时写；权限撤销后不执行下一步。

```ts
expect(nextRotationAction({ ...failedCandidate, attemptsUsed:3, maxAttempts:3 }, now))
  .toMatchObject({kind:'pause',reason:'attempts_exhausted'});
expect(await activeIncidentsFor(slot.id, 4)).toHaveLength(1);
```

- [ ] 运行 automation/worker tests 确认失败后建 incident/attempt/step/resource 表，唯一活动事件键包括 slot/family，操作幂等键包括 attempt/step，手动恢复增加预算段而不删除历史。
- [ ] 在云 API 前事务提交 attempt/step，明确无副作用的拒绝不计实际尝试，unknown 留在原 attempt 观察。轮换窗口、冷却与租约使用服务器时钟，UI 展示下一次允许时间。
- [ ] 使用实例持久租约和 fencing revision；每步校验授权/配置/地址版本；远端在飞请求不受本地锁强制撤回，恢复必须先 observe 原步骤，不能拿新锁立即重发。
- [ ] 切换候选后调用 P7 调度其版本；探测不足等待且不浪费新地址；失败在预算/间隔内新建下一 attempt。DNS/清理错误停留自己的阶段，不回到 allocate。
- [ ] 添加 API 查询、策略修改、暂停/继续和审计。全链路错误码区分 AWS permission/quota/throttle、probe_insufficient、candidate_failed、dns_partial、cleanup_failed。
- [ ] 迁移、状态机、重复/重启测试通过后提交。

## Task 10: P10 — DNS 发布、资源保留与清理

**Files:**
- Create: `apps/worker/src/rotation/{rotation-publication.service,rotation-cleanup.service}.ts`
- Create: `apps/worker/src/rotation/{rotation-publication,rotation-cleanup}.test.ts`
- Modify: `apps/worker/src/automation/reconcile.processor.ts`, `apps/worker/src/operations/operation.processor.ts`, `apps/api/src/modules/operations/operations.service.ts`

**Interfaces:** `RotationPublicationService.publish(incidentId): Promise<{operationIds:string[]}>`；`RotationCleanupService.run(resourceId,now)`；使用 P9 managedCloudResources 归属，不直接用任意 allocationId 删除。

- [ ] 写跨两个 DNS provider 的 fake 集成：A 发布成功、B 失败时只重试 B，AWS allocate 总次数不增加；关联 Pool 使用备用节点时不强制切回。

```ts
expect(cloudCalls.filter(c => c.action === 'allocate')).toHaveLength(1);
expect(dnsWrites.filter(w => w.zone === 'successful-zone')).toHaveLength(1);
expect(await rotationStatus(incident.id)).toBe('dns_partial');
```

- [ ] 测试原有用户地址默认不能释放、系统旧地址 TTL 之前不释放、被其他实例重新关联不释放、最后附着失败候选不释放。
- [ ] 运行 worker tests 观察失败；复用现有 reconcile/outbox/Operation 推进地址版本，所有引用同一 slot 的 endpoint 更新版本后重算，记录 publication child operation IDs。
- [ ] 完全发布成功后，以修改前最大 TTL+60s 设置清理时间。只清理明确 system origin、未附着、无发布引用且版本一致的资源；用户旧地址必须独立 releaseOriginalAddress 授权。
- [ ] 候选未通过保留现有 DNS，但页面明确显示已失效/已释放旧地址，不能显示为恢复成功。API timeout 先读取 DNS 远端结果，再决定是否重复提交。
- [ ] rollback 对 cloud 类型采用当前资源实际状态与重新复测，不把历史 IP 字符串直接写回。清理失败独立重试/告警。
- [ ] 原有 operations/reconcile tests 与新增集成通过后提交。

## Task 11: P11 — 控制台、通知和部署交付

**Files:**
- Create: `apps/web/src/app/cloud-accounts/page.tsx`, `cloud-instances/page.tsx`, `cloud-instances/[instanceId]/page.tsx`, `probes/page.tsx`, `rotations/page.tsx`, `rotations/[rotationId]/page.tsx`
- Create: `apps/web/src/components/{cloud-source-picker,probe-policy-form,rotation-policy-form}.tsx`
- Create: `apps/web/src/lib/{cloud-types,probe-install,rotation-policy}.ts`, `rotation-policy.test.ts`
- Modify: `apps/web/src/components/app-shell.tsx`, `apps/web/src/app/zones/[zoneId]/page.tsx`, `apps/web/src/app/health/page.tsx`, `apps/web/src/app/operations/page.tsx`
- Modify: `apps/worker/src/notifications/notification.processor.ts`, `.env.example`, `docker-compose.yml`, `docs/DEPLOYMENT.md`, `docs/TEST_PLAN.md`, `README.md`

**Interfaces:** UI 消费 P4/P5/P9 管理 API；安装地址来自 `PROBE_AGENT_RELEASE_BASE_URL`，产物和 checksum 来自独立 Agent 发布，不从平台仓库编译 Go。

`validateRotationPolicy(input: {managed:boolean; ipv4Enabled?:boolean; ipv6Enabled?:boolean}): string[]` 为前端权限错误预检查；完整范围/数值验证使用 P9 导出的 rotation schema，服务端始终再次验证。

- [ ] 测试可编辑策略的业务校验和会造成误操作的交互：未授权不能开启轮换、immutable IPv6 显示 reason、A 不能选 IPv6、取消授权后保存响应不能被旧请求覆盖。

```ts
expect(validateRotationPolicy({managed:false,ipv6Enabled:true})).toContain('instance_not_managed');
expect(validateRotationPolicy({managed:true,ipv6Enabled:false})).not.toContain('instance_not_managed');
```

- [ ] 执行 web tests 确认失败；实现实例清单/区域错误、管理勾选、独立 v4/v6 开关、allowStop、原地址释放授权、预算与间隔、故障票数和成功语义预览。
- [ ] 探测页提供安装/吊销、组管理、每探测点能力/在线状态、投票明细；轮换页同时显示 actual/candidate/published、步骤、次数和等待原因；重用现有 UI primitives 和错误交互。
- [ ] 扩展通知模板和 dedupe keys 为 incidentId/state；探测不足与目标失败分开。通知不能输出凭证、Agent Token 或自定义 HTTP header。
- [ ] 配置 Agent 发布源、协议版本、最大并发和任务大小，更新部署/升级/回退文档。数据库回退通过备份恢复，不能宣称 down migration 可撤销已执行 AWS 变更。
- [ ] 执行 web test/lint/typecheck，桌面/移动浏览器检查权限、暂停、复测和强制操作；只为真实风险补交互测试，不测试 CSS 细节。通过后提交。

## Task 12: P12 — 隔离联调、发布验证与交接

**Files:**
- Create: `tests/integration/probe-rotation.test.ts`, `tests/integration/rotation-recovery.test.ts`
- Create: `scripts/test-probe-integration.ts`, `packages/cloud-providers/scripts/aws-e2e.ts`
- Create: `docs/validation/multicloud-ip-rotation.md`
- Modify: `package.json`, `packages/cloud-providers/package.json`, `docs/TEST_PLAN.md`

**Interfaces:** `pnpm test:probe-integration` 启动隔离数据库/Redis、可控 TCP/HTTPS 测试服务，使用通过环境变量 `MASTERDNS_TEST_AGENT_BINARY` 指定的独立已构建 Agent；不依赖固定兄弟目录。

- [ ] 构建联调测试断言：任务拉取→3 轮失败→fake AWS 新地址→3 轮成功→DNS 更新；伪造过期结果不触发任何副作用。

```ts
expect(trace.events).toContain('candidate_verified');
expect(trace.events.indexOf('candidate_verified')).toBeLessThan(trace.events.indexOf('dns_published'));
expect(trace.cloudWritesToUnmanagedInstances).toBe(0);
```

- [ ] 用 failpoint 在 allocate 后未记完成、attach 后、DNS 部分成功、清理前终止 Worker，重启验证没有重复分配、预算重置和重复 DNS 创建。
- [ ] 协议 fixture 在两个仓库的解析与行为测试一致，运行 Go Agent A7 的二进制验收与平台 P1 schema 测试；核验 agent version/protocol mismatch 有可解释错误。
- [ ] `aws-e2e.ts` 只从环境读取临时 AWS 身份和显式允许的 instance/ENI/resource IDs，默认只读。写模式要求显式测试范围，测试每个副作用后读取远端，清理仅本次创建且未被复用资源。无凭证/测试实例时报告 skipped 与原因，不报告 passed。
- [ ] 执行 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:coverage`、`pnpm test:probe-integration`。Go 构建与 race test 由 Agent 仓库执行，报告记录双方 commit 与产物版本。
- [ ] 验证日志没有密钥/Token/header，迁移同时覆盖空库和旧库；记录实际通过、失败和未执行项目。保留真实云资源残留 ID 供人工处理，不静默丢弃。
- [ ] 提交测试与验证文档；提交前 `git diff --check`。完成后报告两个分支、验证结果、真实云未验收项，不自动合并/推送/部署。

## 覆盖核对

| 设计章节 | 任务 |
| --- | --- |
| 架构、独立仓库、协议 | P1、Agent A1/A7 |
| 云账号、清单、授权 | P2–P4 |
| 地址模型、AWS 能力与换址 | P1–P4、P8 |
| DNS/Pool 集成 | P4、P7、P10 |
| Go 探测、安装与身份 | P1、P5、Agent A1–A7 |
| 多点判定、本地兼容 | P6–P7 |
| 重试、预算、恢复、清理 | P8–P10 |
| UI、通知、部署 | P11、Agent A7 |
| 测试与真实验收 | 各任务测试、P12 |

任务按上面的顺序执行，不能在 P8 之前将尚未支持的云写接口标记为可用。每个任务先验证新增行为失败，再实现、验证和提交；不将部分阶段完成表述为全部功能完成。
