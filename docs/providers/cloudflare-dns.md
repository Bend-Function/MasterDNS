# Cloudflare 域名添加

在「域名与解析」页面点击「新增域名」，选择已接入并启用的 Cloudflare DNS 账号。填写 Cloudflare Account ID；如果该 DNS 账号已同步过域名，表单会提供已知 Account ID，只有一个时自动填写。没有现有域名时，从 Cloudflare 控制台的账号概览复制 Account ID。

Token 需要具有目标账号的域名读取和 Zone 编辑权限。现有 Token 能管理 DNS 记录，并不意味着一定能新建 Zone。权限不足时更新「云账号」中的 Token 后重试。

- 单个添加：输入完整域名，例如 `example.com`。中文域名会转换为 Punycode，大小写和末尾的点会被标准化。
- 批量添加：每行一个域名，也可用逗号、分号或空格分隔。每次最多 100 个，重复域名自动去重，所有输入先校验再提交。
- 前端逐项调用创建接口，显示处理进度及各域名结果；一个域名失败不影响其余域名。「重试失败项」只重新处理失败域名。
- 已存在的域名会接入或更新本地列表，不重复创建。创建请求超时或发生冲突时，后端先核对指定 Cloudflare 账号的远端域名，不自动重放创建请求。
- 新增域名及审计记录写入同一数据库事务。只允许账号所有者或管理员操作；管理员操作时，域名仍归属原账号所有者。

域名接入使用 Cloudflare 的 full DNS setup。新增 Zone 通常处于等待激活状态，需要在域名注册商处将 NS 修改为 Cloudflare 分配的服务器。结果和域名详情页都显示 NS 信息。同步 DNS 账号后会更新激活状态。这是接入已有域名的功能，不是购买或注册域名。

## API

`POST /api/v1/zones` 创建或接入一个域名：

```json
{
  "providerAccountId": "3ebae6b0-ff56-4dd0-a1f4-42b8af07aa65",
  "cloudflareAccountId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "name": "example.com"
}
```

响应包含 `name`、`status`（`created` 或 `existing`）、本地 `zoneId`、`zoneStatus` 和 `nameServers`。请求参数错误和权限错误使用现有 API 错误格式。

`POST /api/v1/zones/batch` 接收相同的账号字段及 `names` 数组（1–100 个），返回 `results` 数组。每项状态为 `created`、`existing` 或 `failed`；失败项包含脱敏的 `error.code` 和 `error.message`。账号访问校验失败时整个请求被拒绝；域名单项失败时保留其他项的结果。此接口按顺序处理并等待所有结果，客户端应设置相应请求时限，大批量操作推荐采用前端的逐项请求方式。

创建完成后会尝试安排 DNS 记录同步。队列暂时不可用时保留已创建域名，之后可在页面手动同步。功能使用现有 Zone 元数据保存 NS 和 Cloudflare 激活状态，无数据库迁移。

官方接口：[Create Zone](https://developers.cloudflare.com/api/resources/zones/methods/create/)、[List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)。

## 本地验收

```sh
pnpm --filter @masterdns/contracts test
pnpm --filter @masterdns/providers test
pnpm --filter @masterdns/web test
MASTERDNS_TEST_DATABASE_URL=postgres://... pnpm --filter @masterdns/api exec vitest run src/modules/dns/zone-creation.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

集成测试在临时数据库中验证入库、审计、用户隔离、管理员归属、查重和超时核对；Cloudflare 请求使用 Fake，不需要真实 Token。真实账号域名添加需使用用户明确指定的域名和账号单独验收。
