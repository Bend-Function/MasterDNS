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
});
