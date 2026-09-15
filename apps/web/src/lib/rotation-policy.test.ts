import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseRotationPolicyInput, validateRotationPolicy } from "./rotation-policy";

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

describe("parseRotationPolicyInput", () => {
  it("rejects values outside the shared rotation policy bounds", () => {
    expect(() => parseRotationPolicyInput({ revision: 2, enabled: true, maxAttempts: 3, minIntervalSeconds: 59, cloudWaitSeconds: 120, candidateWindowSeconds: 180 })).toThrow(ZodError);
  });
});
