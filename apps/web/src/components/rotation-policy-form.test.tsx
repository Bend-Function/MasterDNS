import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import { demoRotationPolicy } from "../lib/rotation-demo";
import { RotationPolicyForm } from "./rotation-policy-form";

describe("rotation policy downtime permission", () => {
  it("keeps Linode opt-in disabled without reboot permission and explains both reboots", () => {
    const base = demoCloudSlots[0]!;
    const slot = { ...base, ref: { ...base.ref!, service: "linode" as const }, capability: { ...base.capability!, requiresStop: true } };
    const authorization = { ...demoCloudInstances[0]!.authorization!, managed: true, allowIpv4Rotation: true, allowStopStart: false, allowReleaseAddress: true };
    const render = (allowStopStart: boolean) => renderToStaticMarkup(createElement(RotationPolicyForm, {
      formId: "policy", slot, authorization: { ...authorization, allowStopStart }, policy: { ...demoRotationPolicy, enabled: false }, onSubmit: async () => undefined,
    }));
    const blocked = render(false);
    expect(blocked.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(blocked).toContain("再次重启");
    expect(render(true).match(/<button[^>]*role="switch"[^>]*>/)?.[0]).not.toContain('disabled=""');
  });
  it("shows the selected stop-start strategy on Linode slots", () => {
    const base = demoCloudSlots[0]!;
    const slot = { ...base, ref: { ...base.ref!, service: "linode" as const }, capability: { ...base.capability!, requiresStop: true } };
    const markup = renderToStaticMarkup(createElement(RotationPolicyForm, {
      formId: "policy", slot, authorization: { ...demoCloudInstances[0]!.authorization!, managed: true, allowStopStart: true },
      policy: { ...demoRotationPolicy, linodeRestartMode: "stop_start" }, onSubmit: async () => undefined,
    }));
    expect(markup).toContain('<option value="stop_start" selected="">关机后开机</option>');
    expect(markup).toContain("先关机再开机");
  });
  it("shows saved swap settings with temporary-instance authorization and no extra-IP quota claim", () => {
    const base = demoCloudSlots[0]!;
    const slot = { ...base, ref: { ...base.ref!, service: "linode" as const }, capability: { ...base.capability!, requiresStop: true } };
    const markup = renderToStaticMarkup(createElement(RotationPolicyForm, {
      formId: "policy", slot, authorization: { ...demoCloudInstances[0]!.authorization!, managed: true, allowStopStart: true },
      policy: { ...demoRotationPolicy, linodeIpv4Strategy: "instance_swap", linodeSwapPlan: "g6-standard-1", linodeAllowTemporaryInstance: true }, onSubmit: async () => undefined,
    }));
    expect(markup).toContain('<option value="instance_swap" selected="">临时实例交换 IPv4</option>');
    expect(markup).toContain('value="g6-standard-1"');
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(markup).toContain("仅限本次换址创建的临时实例");
    expect(markup).not.toContain("额外 IPv4 需获批配额");
  });
  it("prevents enabling swap before granting temporary-instance creation and deletion", () => {
    const base = demoCloudSlots[0]!;
    const markup = renderToStaticMarkup(createElement(RotationPolicyForm, {
      formId: "policy", slot: { ...base, ref: { ...base.ref!, service: "linode" as const } },
      authorization: { ...demoCloudInstances[0]!.authorization!, managed: true, allowStopStart: true },
      policy: { ...demoRotationPolicy, enabled: false, linodeIpv4Strategy: "instance_swap", linodeAllowTemporaryInstance: false }, onSubmit: async () => undefined,
    }));
    expect(markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(markup).toContain("请先授权创建和删除临时实例");
  });
});
