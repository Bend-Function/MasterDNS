# Azure / Linode 验收记录

日期：2026-09-16。五项实现均已通过独立评审及必要的修复复审，本地组合验证通过；整分支评审随后执行。本文中的云接口使用模拟 HTTP 边界，不代表真实云部署验收。

## 分支与功能

- 集成分支：codex/azure-linode-cloud，目录 /Users/funcma/Project/MasterDNS。
- Azure 开发与控制台：codex/azure-cloud，目录 /Users/funcma/Project/MasterDNS/.worktrees/azure。
- Linode 开发：codex/linode-cloud，目录 /Users/funcma/Project/MasterDNS/.worktrees/linode。

沿用现有实例显式授权、A/AAAA 槽位绑定、独立地址族开关、外部探测、有限尝试预算、候选验证后发布 DNS、暂停与旧地址清理流程。独立 Go Agent 和 probe-agent/v1 协议没有改变。

| 厂商 | 本期换址范围 | 约束 |
| --- | --- | --- |
| Azure | 独立 VM 已有 NIC IP 配置直接关联的 Standard/Regional/Static 公网 IPv4 或 IPv6 | 保留私网地址与其他配置；拒绝尚未支持的 VMSS、NAT/LB、Basic、StandardV2 等拓扑 |
| Linode | legacy_config、唯一配置、已开启 Network Helper 的普通公网 IPv4 | 必须明确允许重启并有额外 IPv4 配额；分配后重启，清理后再重启并重新验证健康；释放开关仅控制用户原有地址，系统地址自动清理可能多次额外重启 |
| Linode IPv6 | 已有 SLAAC 地址可绑定与监测 | 不支持自动轮换；不会从路由前缀随意生成主机地址 |

账号表单区分 AWS 凭证、Azure service principal 和 Linode PAT，服务名称、区域提示、能力原因与重启提示均按厂商展示。详细设置与 API 边界见 [Azure](../providers/azure.md)、[Linode](../providers/linode.md)。

## 已执行检查

所有 pnpm 命令使用本机兼容参数 pnpm_config_verify_deps_before_run=false，未重新安装共享依赖。数据库测试显式使用仅监听本机的专用 PostgreSQL/Redis；测试创建并清理独立数据库，不回退到生产配置。

| 检查点 | 结果 |
| --- | --- |
| 公共基础 441202c | 迁移 0020 的空库及保留既有 AWS 数据的 0019 升级测试通过；长 ARM ID、元数据往返、凭证与厂商匹配、账号身份和区域检查通过 |
| 控制台 02967dc | 50 项 Web 测试、Lint、全工作区类型检查及实际 Turbopack 生产构建通过 |
| 后端集成 60a06c0 | 247 项云适配器、186 项 Worker、151 项 API/集成测试通过；包括 12 项真实运行时、数据库和 DNS 执行器配合模拟云 HTTP 的验收；三个后端包构建和跨应用类型检查通过 |
| 组合分支 6c54890 | 完整 pnpm build、pnpm lint、pnpm test 通过；85 个测试文件、817 项测试通过，包含 AWS 回归和空库/旧库迁移测试 |
| 响应异常修复 3bb0625 | 109 项相关适配器、64 项清理/协调器、20 项运行时验收测试通过；相关三项构建、跨应用类型检查及全仓库 pnpm typecheck 通过 |

不同代码检查点分别记录，未将早期完整套件描述为在每个后来提交上重复执行。Web 测试使用纯函数和服务端渲染，没有声称完成浏览器交互验收。

运行新的集成验收前，显式设置 MASTERDNS_TEST_DATABASE_URL、MASTERDNS_TEST_REDIS_URL，以及指向相同隔离服务的 DATABASE_URL、REDIS_URL 和专用测试 MASTER_ENCRYPTION_KEY，然后运行：

~~~sh
pnpm --filter @masterdns/api test:provider-rotation
pnpm --filter @masterdns/api exec tsc -p test/tsconfig.integration.json
~~~

验收覆盖真实 CloudRuntimeService、加密账号、RotationProcessor、CloudBindingsService、ReconcileProcessor 和 OperationProcessor；模拟边界只替代外部 HTTP。包括两家候选换址、验证后发布、外来所有者和凭证竞态拒绝、写入已生效但响应丢失的恢复、旧尝试资源在新尝试发布后的清理、从未关联的失败候选，以及同一资源历史别名只触发一次释放/重启。

Linode 清理重启后使用持久序号界线排除旧探测轮次；新的连续失败保持可见，新的合格连续成功后才完成。云端成功响应的身份、正文或操作 URL 无法验证时保留未知效果，不清除原意图、不错误退回分配次数、不盲目重发写入，也不向不可信重定向地址发送凭证。

## 未执行与使用边界

- 未使用真实 AWS、Azure、Linode、Cloudflare 或其他厂商凭证进行资源操作；真实重启、Network Helper、IPv4/IPv6 连通性、配额、计费、DNS 与旧资源清理仍需隔离云资源验收。
- Azure NIC 整体 PUT 没有已验证的外部原子 CAS 保证；Linode 普通 IPv4 分配缺少归属标签/请求幂等键，重启事件缺少请求关联 ID。避免同时从平台外修改同一资源。无法归属的分配保持 ambiguous，不根据清单差值认领。
- 浏览器验收未执行：本次工具检查返回 Mac 锁定、浏览器授权不可用；没有尝试绕过限制或把 SSR 测试当成视觉验收。
- 本次没有推送新分支、部署、发送真实通知，或构建/安装/发布新 Agent。上一轮推送的 AWS 与 Agent 分支不受影响。
- 迁移只向前执行；上线前保留数据库备份及原 MASTER_ENCRYPTION_KEY。回退数据库不能撤销已发生的云端写入。

## 实现取舍

1. 复用已批准的多云设计，按实际 API 能力限制拓扑；代价是未支持的配置明确不可轮换，需要单独扩展。
2. 两个厂商在独立 worktree 并行，公共接口与运行时由集成目录单写者维护；代价是需要组合验证。
3. Linode 初期限定唯一 legacy 配置、Network Helper 和明确重启授权，IPv6 SLAAC 只监测；代价是新接口及其他拓扑暂不支持自动换址。
4. Linode 释放和重启分别持久化；代价是清理状态机与恢复测试增加，但不会把多次副作用藏在一个步骤里。
5. 清理重启后等待新一轮完整健康证据；代价是额外等待时间，期间失败会保持可见，不以历史健康结果完成事件。
