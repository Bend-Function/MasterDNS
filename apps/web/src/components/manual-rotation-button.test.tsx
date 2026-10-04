import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import { ManualRotationButton, ManualRotationSummary } from "./manual-rotation-button";
import { demoRotationPolicy } from "../lib/rotation-demo";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("manual Linode rotation button", () => {
  const row = demoCloudInstances[0]!;
  const authorization = { ...row.authorization!, allowStopStart: true };
  const props = {
    account: { ...row.account!, provider: "linode" as const },
    instance: { ...row.instance, service: "linode" as const },
    slot: { ...demoCloudSlots[0]!, ref: { ...demoCloudSlots[0]!.ref!, service: "linode" as const }, capability: { ...demoCloudSlots[0]!.capability!, available: true, requiresStop: true } },
    savedAuthorization: authorization,
    draftAuthorization: authorization,
  };

  it("offers a manual button for Linode with saved downtime authorization", () => {
    const html = renderToStaticMarkup(createElement(ManualRotationButton, props));
    expect(html).toContain("更换 IPv4");
    expect(html).not.toContain('disabled=""');
  });

  it("renders a compact footer action without an expanding explanation row", () => {
    const html = renderToStaticMarkup(createElement(ManualRotationButton, { ...props, compact: true, blockReason: "已有未完成任务" }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="已有未完成任务"');
    expect(html).not.toContain("manual-rotation-action");
    expect(html).not.toContain("<small>");
  });
  it("blocks manual swap without the saved temporary-instance grant", () => {
    const html = renderToStaticMarkup(createElement(ManualRotationButton, { ...props, savedPolicy: { ...demoRotationPolicy, linodeIpv4Strategy: "instance_swap", linodeAllowTemporaryInstance: false } }));
    expect(html).toContain('disabled=""');
    expect(html).toContain("请先授权创建和删除临时实例");
  });
  it("confirms the saved swap plan and power mode without requiring extra-IP approval", () => {
    const html = renderToStaticMarkup(createElement(ManualRotationSummary, { ...props, policy: { ...demoRotationPolicy, linodeIpv4Strategy: "instance_swap", linodeSwapPlan: "g6-standard-1", linodeRestartMode: "stop_start", linodeAllowTemporaryInstance: true }, preview: false }));
    expect(html).toContain("临时实例交换 IPv4");
    expect(html).toContain("g6-standard-1");
    expect(html).toContain("先关机再开机");
    expect(html).toContain("已授权，仅限本次临时实例");
    expect(html).not.toContain("额外 IPv4 需获批配额");
    expect(html).not.toContain("再次重启");
  });
});
