import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import { demoRotationPolicy } from "../lib/rotation-demo";
import { RotationSlotControl } from "./rotation-machines";

describe("per-machine rotation controls", () => {
  const render = (enabled: boolean, loaded = true) => renderToStaticMarkup(createElement(RotationSlotControl, {
    row: { ...demoCloudInstances[0]!, authorization: null, slots: [] },
    slot: { ...demoCloudSlots[0]!, policy: loaded ? { ...demoRotationPolicy, enabled } : null },
    busy: false, disabled: false, onToggle: () => undefined, onSettings: () => undefined,
  }));
  it("allows disabling an existing policy after authorization is revoked but prevents enabling", () => {
    expect(render(false).match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(render(true).match(/<button[^>]*role="switch"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(render(true)).toContain("实例尚未授权");
  });
  it("displays an unread policy as a read failure rather than a disabled policy", () => {
    const html = render(false, false);
    expect(html).toContain("读取失败");
    expect(html).not.toContain("已关闭");
    expect(html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=""');
  });
});
