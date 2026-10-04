import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import { ManualRotationButton } from "./manual-rotation-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("manual Linode rotation button", () => {
  const row = demoCloudInstances[0]!;
  const authorization = { ...row.authorization!, allowStopStart: true };
  const props = {
    account: { ...row.account!, provider: "linode" as const },
    instance: { ...row.instance, service: "linode" as const },
    slot: { ...demoCloudSlots[0]!, capability: { ...demoCloudSlots[0]!.capability!, available: true, requiresStop: true } },
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
});
