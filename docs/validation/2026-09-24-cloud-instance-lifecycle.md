# 云实例启停、月流量停机与 SOCKS 代理

## 使用与升级

升级前备份数据库，执行项目正常迁移流程应用 `0028_cloud_instance_lifecycle.sql`，再启动新版本 API/Worker。新增实例删除授权默认关闭；月流量停机默认关闭。现有实例授权不会自动扩大。

实例详情提供启动、停止、删除和持久操作历史。先保存“允许 MasterDNS 管理”和相应启停/删除授权，再提交操作。删除需输入完整远端 ID，并拒绝仍被 Pool、DNS 或未完成清理引用的实例。Azure 停止执行 deallocate；删除遵循厂商自身磁盘与附属资源行为，不代表所有独立资源一并删除。

月流量停机使用 UTC 自然月，阈值按十进制 GB 输入，可选总流量或仅出站。默认每 60 分钟检查，可设置 1–1440 分钟。首次检查到达到阈值后排队停止，不保证精确在阈值字节处中断：指标发布、检查周期和云端操作均有延迟。无数据、权限失效、实例身份变化均不触发停止。关闭策略、跨月不会自动启动；停止保持会阻止新的换址写操作。已启用策略且本月仍超限时，人工启动也会被拒绝。

独立“SOCKS 代理”页面按云账号配置 `socks5://` 或 `socks5h://`，推荐后者由代理端解析 DNS。支持用户名和密码，配置加密保存，不回显认证信息。代理地址的 localhost 指 API/Worker 所在服务器或容器。保存前通过候选代理核对同一云账号身份；移除恢复直连。凭据轮换保留代理配置。

主动检测只请求固定 HTTPS [ipify](https://www.ipify.org/) 端点，返回连通性、出口 IP、延迟和检测时间；不查询或显示国家、城市等位置。超时 10 秒，限制响应体和重定向，每账号每分钟最多 6 次检测。检测成功代表出口网络可用，保存时仍独立校验云 API 身份。

## AWS 权限增量

保留现有身份、清单、监控与换址权限，仅对需管理的实例增加以下权限；只启用月流量停机时不需要授予删除权限。

| 服务 | 启动 | 停止 / 自动停机 | 删除 |
| --- | --- | --- | --- |
| EC2 | `ec2:StartInstances` | `ec2:StopInstances` | `ec2:TerminateInstances` |
| Lightsail | `lightsail:StartInstance` | `lightsail:StopInstance` | `lightsail:DeleteInstance` |

应将写权限限制到目标实例资源。权限名称和资源范围参见 AWS 官方 [EC2 授权参考](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)及 [Lightsail 授权参考](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lightsail.html)。月流量读取沿用 [现有流量权限说明](2026-09-21-monthly-cloud-traffic.md)。SOCKS 本身不要求增加 IAM 权限。

## 一致性与验证

操作在写云 API 前持久记录，共享物理实例租约及服务商限速。结果不明确时只观察，不盲目重发。适配器重新校验资源身份，防止同名实例重建后误操作。轮换、DNS 发布、地址引用和状态重置遵循同一保护；已派发操作仍可观察完成。

测试使用隔离 PostgreSQL/Redis、本地 SOCKS 服务和模拟云 API，不调用真实云机器启停或删除。覆盖授权撤销、幂等、跨月、策略变更、指标缺失、并发启动、调度公平、未知结果、代理路由/认证、凭据保密及现有轮换兼容性。共 1,312 项测试通过：API 278、Worker 303、云适配器 376、Web 113、数据库 48、共享契约 48、自动化规则 116、跨服务验收 30。API/Worker/共享包 TypeScript 构建通过；Web lint 和生产构建通过。浏览器检查了桌面及 390px 手机布局、默认关闭/每小时策略、独立代理表单及仅 IP/延迟的检测结果。
