import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CloudRotationLimitStatus } from "@masterdns/contracts/cloud-rotation-limits";
import { CloudRotationLimits, parseRotationLimitPercent } from "./cloud-rotation-limits";

const status: CloudRotationLimitStatus = {
  service: "lightsail",
  utilizationPercent: 80,
  effectivePercent: 60,
  rules: [
    { id: "lightsail.AllocateStaticIp", name: "lightsail.AllocateStaticIp", scope: "region", operations: ["AllocateStaticIp"], kind: "token_bucket", officialCapacity: 1, capacity: 1, officialRefillPerSecond: 1, refillPerSecond: 0.6, windowSeconds: null },
    { id: "lightsail.static-ip.hour", name: "lightsail.static-ip.hour", scope: "global", operations: ["AllocateStaticIp", "AttachStaticIp"], kind: "sliding_window", officialCapacity: 50, capacity: 30, officialRefillPerSecond: null, refillPerSecond: null, windowSeconds: 3600 },
  ],
  usage: [
    { ruleId: "lightsail.AllocateStaticIp", region: "ap-southeast-2", used: 1, remaining: 0, retryAt: "2026-09-21T04:05:06.000Z" },
  ],
};

describe("cloud rotation limit settings", () => {
  it("renders service choice, policy boundaries, official/effective rules, usage and retry time", () => {
    const html = renderToStaticMarkup(createElement(CloudRotationLimits, {
      services: ["ec2", "lightsail"],
      service: "lightsail",
      status,
      utilizationPercent: "80",
      disabled: false,
      onServiceChange: () => undefined,
      onUtilizationPercentChange: () => undefined,
    }));

    expect(html).toContain("Amazon EC2");
    expect(html).toContain("Amazon Lightsail");
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="100"');
    expect(html).toContain('step="1"');
    expect(html).toContain("官方 50 次 / 滚动 1 小时");
    expect(html).toContain("生效 30 次 / 滚动 1 小时");
    expect(html).toContain("ap-southeast-2");
    expect(html).toContain("09/21");
    expect(html).toContain("同一远端账号");
    expect(html).toContain("最低比例");
    expect(html).toContain("其他工具");
    expect(html).toContain("50 次/小时、500 次/天");
    expect(html).toContain("Release");
    expect(html).toContain("任务会暂停");
  });

  it("accepts only integer percentages from 1 through 100", () => {
    expect(parseRotationLimitPercent("1")).toBe(1);
    expect(parseRotationLimitPercent("100")).toBe(100);
    for (const value of ["", "0", "101", "1.5", "80x"]) expect(parseRotationLimitPercent(value)).toBeNull();
  });
});
