# 云实例月度流量

## 使用

打开「云实例」中的实例详情，在「月度流量」查看当前 UTC 自然月月初至查询时刻的入站、出站、合计流量。卡片独立加载，并有「刷新流量」按钮；成功查询最多缓存五分钟，跨月自动使用新缓存键。云厂商监控数据可能延迟。

该功能只读取云厂商 API，不要求安装 Agent，也不要求开启实例管理或换址授权。没有新增数据库迁移。权限不足、凭证失效、账号停用、实例移出区域范围、远端实例消失或查询失败均显示相应状态；无数据和真实 0 字节分开显示。

## 统计口径与权限

| 服务 | 数据来源 | 额度 | 新增读取权限 |
| --- | --- | --- | --- |
| EC2 | CloudWatch `AWS/EC2` 的 `NetworkIn` / `NetworkOut`，按小时 `Sum` 后汇总 | 不推算单实例套餐额度 | `cloudwatch:GetMetricStatistics` |
| Lightsail | `GetInstanceMetricData` 的 `NetworkIn` / `NetworkOut`，按小时 `Sum` 后汇总 | `GetInstance` 的 `networking.monthlyTransfer.gbPerMonth`，同区域同套餐共享 | `lightsail:GetInstanceMetricData`、`lightsail:GetInstance`、`lightsail:GetInstances` |
| Azure VM | Azure Monitor `Network In Total` / `Network Out Total`，按小时 `Total` 汇总 | 不推算单实例套餐额度 | `Microsoft.Insights/metrics/read`，以及原有订阅读取权限 |
| Linode | `/linode/instances/{id}/transfer/{year}/{month}` 的公网入站、出站字节 | `/linode/instances/{id}/transfer` 的 `quota`，是实例对共享池的贡献额度 | 实例读取权限（`linodes:read_only` 或已有读写权限） |

以上继续使用已有云账号身份校验。EC2、Lightsail 和 Azure 统计所有网卡监控流量，可能包含内网，不能当作公网账单用量。Linode 使用公网月度统计。共享额度不能直接减去单实例用量得到准确剩余，因此页面不展示推算余额或使用率。

流量字节按十进制 KB/MB/GB 展示；额度沿用厂商返回的 GB 数值。卡片同时展示查询范围、获取时间及统计口径。当前版本仅查询本月，不持久化历史数据。

## 接口与隔离

`GET /api/v1/cloud-instances/:id/traffic` 返回 `MonthlyTrafficResponse`。每次请求先做现有实例和账号所有权检查，再访问缓存；普通用户不能获取其他用户实例的流量。管理员遵循已有访问规则。缓存包含 UTC 月份、账号更新时间、实例更新时间，凭证轮换或月度变化后不会复用旧结果；并发相同查询合并。缓存最多保留 1,000 项，仅缓存成功结果，错误内容不透传云端原始文本或凭证。

## 验证

- 云适配器全套 287 项测试通过，其中 10 项新增月度用例覆盖 UTC 月界/跨年、汇总、0 与无数据、权限错误、Lightsail 名称复用、Azure 资源定位及 Linode 共享额度。
- 前端全套 83 项测试通过，其中 3 项新增显示用例验证未知用量、监控/公网口径、共享额度标签，避免生成错误余额。
- 隔离 PostgreSQL 18 上 5 项接口集成测试通过，使用真实迁移/查询与模拟云 API，覆盖所有权、缓存命中、停用/移出范围/实例删除、错误重试、并发合并、五分钟过期、跨月、凭证轮换与远端身份变化。
- Contracts、云适配器和 API 编译通过，Worker 类型检查通过，Web 生产构建（Webpack）通过；冻结锁文件校验通过。
- 使用本地示例数据完成桌面和 390px 手机宽度的浏览器验收，数字与单位无截断；示例明确标注。沙箱下默认开发模式遇到文件监听限制，改用轮询监听的 Webpack 开发模式完成验收，项目配置未变。
- Web 全量 ESLint 与独立只读代码复核通过；未发现需要修复的重大问题。临时测试数据库和开发服务器已停止。
- 未使用真实云账号查询，也未部署。

## 官方依据

- [EC2 CloudWatch 指标](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/viewing_metrics_with_cloudwatch.html)
- [Lightsail GetInstanceMetricData](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetInstanceMetricData.html)
- [Lightsail 流量额度共享规则](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html)
- [Azure VM 指标参考](https://learn.microsoft.com/en-us/azure/virtual-machines/monitor-vm-reference)
- [Azure Monitor Metrics REST API](https://learn.microsoft.com/en-us/rest/api/monitor/metrics/list)
- [Linode 官方 SDK 的月度流量及额度定义](https://github.com/linode/linodego/blob/main/instances.go)
