import { describe, expect, it } from "vitest";
import { cloudLifecycleActionSchema, cloudTrafficStopPolicySchema } from "./cloud-lifecycle.js";
import { cloudRotationRulesForAction } from "./cloud-rotation-limits.js";

describe("lifecycle policy boundaries", () => {
  it("defaults traffic checks to one hour and requires valid evidence thresholds", () => {
    const policy = { revision: 0, enabled: false, thresholdBytes: null, direction: "total" };
    expect(cloudTrafficStopPolicySchema.parse(policy).checkIntervalSeconds).toBe(3600);
    expect(cloudTrafficStopPolicySchema.safeParse({ ...policy, enabled: true }).success).toBe(false);
    for (const thresholdBytes of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) expect(cloudTrafficStopPolicySchema.safeParse({ ...policy, thresholdBytes }).success).toBe(false);
    for (const checkIntervalSeconds of [0, 59, 86401, 3600.5]) expect(cloudTrafficStopPolicySchema.safeParse({ ...policy, checkIntervalSeconds }).success).toBe(false);
    expect(cloudTrafficStopPolicySchema.parse({ ...policy, enabled: true, thresholdBytes: 1, checkIntervalSeconds: 60 }).enabled).toBe(true);
  });
  it("does not accept arbitrary operations or force deletion options", () => {
    expect(cloudLifecycleActionSchema.safeParse({ action: "delete", force: true }).success).toBe(false);
    expect(cloudLifecycleActionSchema.safeParse({ action: "reboot" }).success).toBe(false);
  });
  it("applies lifecycle rate buckets without charging Lightsail static IP quotas", () => {
    expect(cloudRotationRulesForAction("lightsail", "lightsail.instance.stop")).toEqual([expect.objectContaining({ capacity: 16, refillPerSecond: 8, kind: "token_bucket" })]);
    expect(cloudRotationRulesForAction("lightsail", "lightsail.instance.delete")).toEqual([expect.objectContaining({ capacity: 16, refillPerSecond: 0.8, kind: "token_bucket" })]);
    expect(cloudRotationRulesForAction("ec2", "ec2.instance.start")).toEqual([expect.objectContaining({ capacity: 4, refillPerSecond: 1.6 })]);
    expect(cloudRotationRulesForAction("ec2", "ec2.instance.delete")).toEqual([expect.objectContaining({ capacity: 80, refillPerSecond: 4 })]);
    expect(cloudRotationRulesForAction("azure_vm", "azure_vm.instance.stop")).toEqual([expect.objectContaining({ id: "azure.arm.writes", capacity: 160, refillPerSecond: 8 })]);
    expect(cloudRotationRulesForAction("linode", "linode.instance.delete")).toEqual([expect.objectContaining({ id: "linode.mutations", capacity: 1280 })]);
  });
});
