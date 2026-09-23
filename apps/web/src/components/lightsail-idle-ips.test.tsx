import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { IdleIpResults } from "./lightsail-idle-ips";

it("distinguishes verified deletion, protected addresses and incomplete region scans", () => {
  const target = { region: "ap-northeast-1", name: "old-ip", address: "203.0.113.9", arn: "arn:one", createdAt: "2026-09-01T00:00:00Z" };
  const html = renderToStaticMarkup(createElement(IdleIpResults, { preview: {
    id: "batch", accountId: "account", regions: [target.region], confirmedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-23T00:15:00Z", createdAt: "2026-09-23T00:00:00Z",
    items: [{ ...target, status: "released" }, { ...target, arn: "arn:two", status: "skipped", reason: "rotation_in_progress" }],
    scanErrors: [{ region: "ap-southeast-1", reason: "permission_denied" }],
  } }));
  expect(html).toContain("已释放");
  expect(html).toContain("轮换候选地址待挂载，或此 IP 释放结果尚未确认");
  expect(html).toContain("该区域未执行清理");
});
