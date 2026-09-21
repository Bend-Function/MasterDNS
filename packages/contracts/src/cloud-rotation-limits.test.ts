import { describe, expect, it } from "vitest";
import { cloudRotationLimitPolicySchema, cloudRotationLimitRules, cloudRotationRulesForAction } from "./cloud-rotation-limits.js";

describe("cloud rotation rules", () => {
  it("uses 80% provider limits and explicit scopes", () => {
    expect(cloudRotationRulesForAction("lightsail", "lightsail.static-ip.allocate").map(r => [r.capacity, r.refillPerSecond, r.scope])).toEqual([[1, 0.8, "region"], [40, null, "global"], [400, null, "global"]]);
    expect(cloudRotationRulesForAction("ec2", "ec2.eip.allocate")[0]).toMatchObject({ officialCapacity: 50, capacity: 40, refillPerSecond: 4 });
    expect(cloudRotationRulesForAction("ec2", "ec2.ipv6.assign")[0]).toMatchObject({ capacity: 80 });
    expect(cloudRotationRulesForAction("ec2", "ec2.auto-ipv4.disable")[0]).toMatchObject({ capacity: 80 });
    expect(cloudRotationRulesForAction("azure_vm", "azure.public-ip.delete").map(r => r.capacity)).toEqual([160, 800]);
    expect(cloudRotationLimitRules("linode")[0]).toMatchObject({ capacity: 1280, windowSeconds: 60, scope: "global" });
  });
  it("shares actual API actions and rejects unknown actions", () => {
    expect(cloudRotationRulesForAction("lightsail", "lightsail.ipv6.enable")[0]?.id).toBe(cloudRotationRulesForAction("lightsail", "lightsail.ipv6.disable")[0]?.id);
    expect(() => cloudRotationRulesForAction("ec2", "unknown")).toThrow("unsupported_rotation_action");
    expect(() => cloudRotationRulesForAction("ec2", "linode.ipv4.allocate")).toThrow("unsupported_rotation_action");
  });
  it("validates integer percentages and retains one token at 1%", () => {
    expect(cloudRotationRulesForAction("lightsail", "lightsail.static-ip.allocate", 1)[0]).toMatchObject({ capacity: 1, refillPerSecond: 0.01 });
    for (const value of [0, 101, 1.5, "80", null]) expect(cloudRotationLimitPolicySchema.safeParse({ utilizationPercent: value }).success).toBe(false);
    expect(cloudRotationLimitPolicySchema.safeParse({ utilizationPercent: 80, extra: true }).success).toBe(false);
  });
});
