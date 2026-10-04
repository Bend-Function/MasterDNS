import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseRotationPolicyInput, resolveManualRotationPolicy, validateRotationPolicy } from "./rotation-policy";
import { demoRotationPolicy } from "./rotation-demo";

describe("validateRotationPolicy", () => {
  it("rejects family opt-ins without management authorization", () => {
    expect(validateRotationPolicy({ managed: false, ipv6Enabled: true })).toContain("instance_not_managed");
  });

  it("allows managed instances with both family switches off", () => {
    expect(validateRotationPolicy({ managed: true, ipv4Enabled: false, ipv6Enabled: false })).not.toContain("instance_not_managed");
  });

  it("keeps IPv4 and IPv6 authorization independent", () => {
    expect(validateRotationPolicy({ managed: true, ipv4Enabled: true, ipv4Authorized: false, ipv6Authorized: true })).toContain("ipv4_not_authorized");
    expect(validateRotationPolicy({ managed: true, ipv4Enabled: false, ipv6Enabled: true, ipv4Authorized: true, ipv6Authorized: false })).toContain("ipv6_not_authorized");
  });
});

describe("manual rotation saved policy", () => {
  const swapPolicy = { ...demoRotationPolicy, slotId: "linode/4", linodeIpv4Strategy: "instance_swap" as const, linodeRestartMode: "stop_start" as const, linodeAllowTemporaryInstance: false };
  it("loads the saved strategy, restart mode and grant for instance-detail confirmation", async () => {
    const paths: string[] = [];
    const result = await resolveManualRotationPolicy("linode", swapPolicy.slotId, undefined, false, async path => { paths.push(path); return swapPolicy; });
    expect(result).toMatchObject({ linodeIpv4Strategy: "instance_swap", linodeRestartMode: "stop_start", linodeAllowTemporaryInstance: false });
    expect(paths).toEqual(["/v1/rotation-policies?slotId=linode%2F4"]);
  });
  it("uses a supplied saved policy and does not load it again", async () => {
    expect(await resolveManualRotationPolicy("linode", swapPolicy.slotId, swapPolicy, false, async () => { throw new Error("unexpected request"); })).toEqual(swapPolicy);
  });
  it("uses a preview policy without any API requests", async () => {
    expect(await resolveManualRotationPolicy("linode", "preview-slot", undefined, true, async () => { throw new Error("unexpected preview request"); })).toMatchObject({ slotId: "preview-slot", linodeIpv4Strategy: "additional_ipv4", linodeAllowTemporaryInstance: false });
  });
  it("leaves non-Linode confirmation independent of policy loading", async () => {
    expect(await resolveManualRotationPolicy("ec2", "aws-slot", undefined, false, async () => { throw new Error("unexpected request"); })).toBeNull();
  });
  it("propagates policy-read failure instead of silently confirming the default strategy", async () => {
    await expect(resolveManualRotationPolicy("linode", "slot", undefined, false, async () => { throw new Error("policy unavailable"); })).rejects.toThrow("policy unavailable");
  });
});

describe("parseRotationPolicyInput", () => {
  it("preserves the selected Linode restart mode", () => {
    expect(parseRotationPolicyInput({ revision: 2, linodeRestartMode: "stop_start" }).linodeRestartMode).toBe("stop_start");
  });
  it("preserves the swap strategy, plan and explicit temporary-instance grant", () => {
    expect(parseRotationPolicyInput({ revision: 2, linodeIpv4Strategy: "instance_swap", linodeSwapPlan: "g6-standard-1", linodeAllowTemporaryInstance: true })).toMatchObject({ linodeIpv4Strategy: "instance_swap", linodeSwapPlan: "g6-standard-1", linodeAllowTemporaryInstance: true });
  });
  it("allows revoking temporary-instance permission while an enabled policy has blocked work", () => {
    const savedPolicy = { ...demoRotationPolicy, enabled: true, linodeIpv4Strategy: "instance_swap" as const, linodeAllowTemporaryInstance: true };
    expect(parseRotationPolicyInput({ revision: 2, enabled: true, linodeIpv4Strategy: "instance_swap", linodeAllowTemporaryInstance: false }, { savedPolicy, blockReason: "已有未完成任务" })).toMatchObject({ enabled: true, linodeAllowTemporaryInstance: false });
    expect(() => parseRotationPolicyInput({ revision: 2, enabled: true, linodeIpv4Strategy: "instance_swap", linodeAllowTemporaryInstance: true }, { savedPolicy: { ...savedPolicy, enabled: false }, blockReason: "实例未授权" })).toThrow("实例未授权");
  });
  it("rejects values outside the shared rotation policy bounds", () => {
    expect(() => parseRotationPolicyInput({ revision: 2, enabled: true, maxAttempts: 3, minIntervalSeconds: 59, cloudWaitSeconds: 120, candidateWindowSeconds: 180 })).toThrow(ZodError);
  });
});
