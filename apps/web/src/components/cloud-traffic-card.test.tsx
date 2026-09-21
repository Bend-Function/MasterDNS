import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MonthlyTraffic } from "@masterdns/contracts";
import { CloudTrafficSummary } from "./cloud-traffic-card";

const traffic: MonthlyTraffic = { month: "2026-09", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-09-20T12:00:00Z", fetchedAt: "2026-09-20T12:01:00Z", source: "cloudwatch", incomingBytes: 0, outgoingBytes: null, totalBytes: null, allowance: null };

describe("monthly traffic display", () => {
  it("distinguishes zero bytes from missing data and explains monitoring scope", () => {
    const html = renderToStaticMarkup(createElement(CloudTrafficSummary, { traffic }));
    expect(html).toContain("0 B");
    expect(html).toContain("暂无数据");
    expect(html).toContain("所有网卡");
    expect(html).toContain("非账单用量");
    expect(html).toContain("UTC");
  });
  it("shows shared Lightsail allowance without inventing a remaining balance", () => {
    const html = renderToStaticMarkup(createElement(CloudTrafficSummary, { traffic: { ...traffic, source: "lightsail", outgoingBytes: 2_000_000_000, incomingBytes: 1_000_000_000, totalBytes: 3_000_000_000, allowance: { gigabytes: 1024, scope: "region_bundle" } } }));
    expect(html).toContain("3 GB");
    expect(html).toContain("1,024 GB");
    expect(html).toContain("同区域同套餐共享");
    expect(html).not.toContain("1,021");
  });
  it("labels Linode quota as a pool contribution and public traffic", () => {
    const html = renderToStaticMarkup(createElement(CloudTrafficSummary, { traffic: { ...traffic, source: "linode", allowance: { gigabytes: 1000, scope: "account_pool" } } }));
    expect(html).toContain("公网");
    expect(html).toContain("共享流量池");
    expect(html).not.toContain("非账单用量");
  });
});
