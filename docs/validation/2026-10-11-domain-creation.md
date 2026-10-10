# Cloudflare 域名添加验证

日期：2026-10-11（Pacific/Auckland）。分支：`codex/add-domains`，基于 `05a94cc`。

## 结果与范围

实现域名单个添加、批量添加、批量去重、逐项进度和失败项重试。新增域名结果与详情展示 NS 服务器，尚未激活的 Cloudflare Zone（含 `moved`）显示等待状态。支持已有远端域名接入、创建超时后的按账号核对、用户隔离、管理员归属及审计。记录同步在后台提交，Redis 连接断开不阻塞已持久化的新增域名响应。

Cloudflare List Zones 的请求分页按官方约束设置为 5–50；域名查重和凭据验证使用 5，清单分页使用 50。DNS 记录分页保留原逻辑。

## 自动化验证

使用 Node.js `v22.22.3`、`corepack pnpm` `11.9.0`、隔离本地 PostgreSQL 和 Redis。测试数据库按测试文件动态创建、迁移和删除，未访问生产数据库。Cloudflare 边界使用 Fake，未调用真实 Cloudflare 写接口。

| 检查 | 结果 |
| --- | --- |
| `pnpm test`（测试数据库与 Redis 环境已配置） | 1,873 项通过，0 失败 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 全部共享包、API、Worker 和 Web 通过 |
| `git diff --check` | 通过 |

新增测试为 20 项共享输入契约、5 项 Cloudflare Zone Provider、15 项 API/PostgreSQL 集成、6 项 React 界面行为，共 46 项。覆盖域名/IDN 标准化、无效域名和超限输入、账号权限、重复提交、远端已有域名、批量部分失败、超时核对、NS 元数据、审计、Redis 未决排队、失败项重试和界面卸载后的请求终止。回归测试在对应修正前运行并观察到失败。

## 界面验证

通过本地 `NEXT_PUBLIC_UI_PREVIEW=true` 浏览器预览核对 1280×720 桌面和 390×844 移动端。预览数据仅用于布局与交互验证，不代表真实域名接入成功。

- [单个添加](screenshots/2026-10-11-domain-single.jpg)。
- [批量去重及 NS 结果](screenshots/2026-10-11-domain-batch.jpg)。
- [移动端批量结果](screenshots/2026-10-11-domain-mobile.jpg)。

独立只读代码审查发现的分页参数、`moved` 状态映射及 Redis 未决排队问题均已修正并复核，无遗留可操作问题。

真实 Cloudflare 接入、Token 权限及注册商 NS 激活尚需在指定测试账号和域名上验收。使用说明见 [Cloudflare 域名添加](../providers/cloudflare-dns.md)。
