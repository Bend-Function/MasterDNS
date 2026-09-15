# Azure 与 Linode 多云扩展

用户要求在两个独立 worktree 上同步开发，沿用已完成并批准的 AWS 管理、IPv4/IPv6 绑定、Go 外部探测、有限预算换址与验证后发布设计。本次扩展现有 MasterDNS，Agent 协议和职责不变。设计与执行已获本轮“按同样原理接入”的授权；厂商差异以 API 能力约束处理。

## 范围与隔离

集成分支 `codex/azure-linode-cloud`；Azure worktree `.worktrees/azure`、分支 `codex/azure-cloud`；Linode worktree `.worktrees/linode`、分支 `codex/linode-cloud`。两个厂商适配器由不同子代理并行实现，只写各自厂商文件；公共契约、迁移与应用接线由集成分支单写者维护，独立评审后汇合。保留原 AWS 行为及其已推送分支。没有实际云凭证时不调用真实云写接口，不推送新分支、不部署、不发布新 Agent。

## 公共模型

`CloudProvider = 'aws' | 'azure' | 'linode'`，`CloudService = 'ec2' | 'lightsail' | 'azure_vm' | 'linode'`。CloudRef 沿用 accountId/service/region/instanceId。Azure 一个受管接口对应精确 NIC IP configuration ARM ID；真正 NIC ID 保留为元数据，避免同 NIC 多个配置混淆。Linode 使用稳定公共逻辑接口标识，保留原接口模式和配置证据。前缀只能展示，不能直接作为 A/AAAA 主机地址绑定。

凭证联合类型保留 AWS access_key/role，新增 `{kind:'azure_service_principal',tenantId,subscriptionId,clientId,clientSecret}` 和 `{kind:'linode_token',token}`。验证 provider/service/credential 一致性，凭证按现有方式加密；身份替换仍须同一外部账号。Azure 身份为验证后的规范 subscription UUID，Linode 为已认证 API 响应的 X-Customer-UUID；缺失或不一致时拒绝。服务器只接受固定官方 HTTPS API，重定向和分页/异步 URL 不得把令牌送到其他主机。

CloudInventory、接口和地址增加可选、无敏感信息的 `metadata: Record<string,unknown>`；扫描持久化并在 API 能力计算中完整重建，保存私网地址和资源 ID 等现有标准字段。数据库增加地址 metadata；外部账号 ID、ARM VM/NIC/IP 配置、allocation/resource IDs 使用能容纳完整 ARM 路径的 text 字段。只生成一次前向迁移，保留所有现有数据。区域字符串改为厂商无关的有界标识，在服务中按 provider 校验，保留 AWS 区域严格验证及 null=全部可用区域。

公共能力、计划、清理以服务分派，未知服务拒绝，绝不落入 Lightsail 分支。适配器提供普通 CloudAdapter 方法，单独导出各自 capability/rotation plan/cleanup plan 函数供公共入口分派。工厂按服务与凭证类型构造。全链路实例管理勾选、分地址族开关、预算/间隔、固定票数、版本检查、暂停、TTL 和资源归属保持现有语义。

## Azure

初期支持现有独立 VM、已有 NIC IP 配置、直接附着的 Standard/Regional/Static 公网 IPv4 或 IPv6。订阅/VM/NIC/PIP/子网均检查实际归属和状态；保留 private IP、配置 primary、子网、其他 IP 配置、NSG、DNS、转发和加速网络。拒绝 VMSS、Basic/dynamic/StandardV2、公共前缀、NAT/LB/网关/私有端点等未处理拓扑，以及无法无损表达的可写 NIC 设置。

轮换为 `azure.public-ip.allocate` → `azure.public-ip.associate`。候选使用本次 attempt 的确定性资源名和归属标签，在旧公网 IP 的资源组、区域和 zone 设置创建；遇到同名非本次资源拒绝覆盖。公网 IPv6 更改公网资源关联，绝不修改 guest 私网 IPv6 或添加 IPv6 配置。无停机 API 兜底。

REST 固定 Resources 2022-12-01、Compute 2025-04-01、Network 2025-09-01。OAuth 固定 login.microsoftonline.com，ARM 固定 management.azure.com，缓存令牌并脱敏。分页、操作 URL、资源路径都验证订阅与范围；禁用携带凭证的重定向。保存异步 receipt，按 Azure-AsyncOperation/Location 和 Retry-After 观察，成功后仍回读双方关联和精确地址；丢响应时观察原资源，不盲发 PUT 或再分配。NIC PUT 的 If-Match 原子条件并无官方保证，不能声称消除了外部并发修改；临写前比较完整受支持配置，保留所有兄弟字段，文档说明需避免并行外部修改和需真实验收。

验证后按正常 DNS 路径发布；授权且 TTL 到期后使用 `azure.public-ip.delete` 清理已脱离且无其他引用的旧 PIP，回读确认删除。

## Linode

列出全部可访问实例和公共 IPv4/SLAAC IPv6，按 region 过滤并完整分页。IPv6 SLAAC 无可用换址/删除 API，允许绑定和探测，轮换返回明确 immutable 原因；路由前缀仅展示。新 Linode interfaces 暂不冒充 legacy profile 流程，返回拓扑不支持原因。

可自动轮换的 IPv4 初期限定：running、legacy_config、恰好一个已读取配置、配置 `helpers.network === true`、单一 public/default 接口、无共享/VPC/NAT 等不支持布局。需要显式 allowStopStart；未授权时不得发起分配或重启。分配额外公共 IPv4 → 使用已核实 config_id 重启 → 观察匹配的 reboot event 与 running 状态 → 外部复测候选 → DNS 发布。额外 IP 额度可能需要向厂商申请，配额不足必须清晰返回且不能无限重试。

分配 API 无幂等键或归属标签：正常响应持久保存精确地址/实例/区域；响应丢失则 ownership ambiguous，即便清单恰好多出一个地址也不将其推断为本次资产，更不重新分配。重启前保存事件水位和配置指纹，使用 API event 与实例回读确认；结果不明继续观察，不能重复重启。无 guest SSH 或 Agent 执行命令扩展。

默认保留用户原有旧 IPv4；旧地址释放开关仅控制此类地址。系统创建的地址（包括失败候选和后续换下的旧地址）仍可在停机授权有效时自动清理，可能产生多次额外重启。适用释放授权、TTL 与 DNS 条件满足后，每次清理采用两个独立、持久化步骤：`linode.ipv4.release` → `linode.instance.reboot`（清理阶段）。旧地址必须仍属于同一实例、不是候选、不是最后一个公共 IPv4、无其他发布引用，且 Network Helper/config/重启授权仍有效。清理重启用于同步 guest 配置，不能藏在第一个 API 调用中。每步分别观察和恢复；用户暂停后不再接受后续新写入。已经发出的效果可以继续回读。

## 持久执行与 UI

原有 CloudStepResult/CloudObservation 保留。RotationStepArguments 增加可选 `priorReceipts: Array<{action:string;receipt:CloudStepResult}>`，用于重启事件证据和多步骤清理；所有分配步骤的 applied receipt 通过现有 candidateReceipt 传给后续步骤，不再特判 Lightsail。新执行前 recheck allowStopStart（仅确需重启动作）并保留所有 captured revisions。

清理计划可包含多步骤。每个资源的完整清理计划在第一个远端调用前入库，稳定 step ID/sequence；cleanupStepId 指向当前步骤，完成当前步骤后原子推进到下一步，最后一步确认后才把整项 cleanup 标为完成。旧单步 AWS 记录仍可恢复。任一步不明只能观察原步骤，不重置预算或重新申请；完成第一步后暂停不允许自动派发第二步。

控制台新增厂商选择和相应凭证字段，凭证更新不允许换厂商/外部账号。区域提示、实例/服务名称、能力失败原因均按 provider 展示；Linode 的重启需求在授权与手动轮换确认中明确展示。Azure/Linode 不使用 AWS AccessKey 表单或 AWS 区域正则。无凭证泄漏到列表、日志、通知或测试快照。

## 验收

保持 AWS 现有测试通过。新增真实请求形状的离线 HTTP 测试覆盖两家认证、分页/作用域、IPv4/IPv6、权限/配额/429、未知副作用、地址归属与恢复；阻止恶意 nextLink/Location、跨订阅或跨实例资源。

隔离 PostgreSQL/Redis 验证 provider 枚举/长 ID/元数据迁移、凭证/provider 不匹配、身份替换、默认未授权、region 扫描失败保留旧清单；协调器与真实适配器模拟 HTTP 跑候选和 DNS 发布、暂停/撤权及多步骤清理重启恢复。Web 测试验证凭证 payload、服务标签、不可变 IPv6 和重启提示；执行 build/typecheck/lint 及相关测试。真实云未执行必须报告 skipped，不能把模拟接口说成真实云验收。

官方研究依据记录在 `docs/providers/azure.md`、`docs/providers/linode.md`（随对应适配器交付）；本次读取的官方研究原件在控制器提供的 research 文件中。
