import { describe, expect, it } from "vitest";
import { rateLimitPolicyFor, type RateLimitPolicyRequest } from "./rate-limit-policy.js";

function request(overrides: Partial<RateLimitPolicyRequest> = {}): RateLimitPolicyRequest {
  return { ip: "192.0.2.50", method: "POST", headers: {}, ...overrides };
}

describe("API rate-limit policy", () => {
  it("uses tighter categories for login and public DDNS exchange", () => {
    expect(rateLimitPolicyFor(request(), "/api/v1/auth/login")).toMatchObject({ key: "login:192.0.2.50", limit: 10 });
    expect(rateLimitPolicyFor(request(), "/api/v1/ddns/exchange")).toMatchObject({ key: "exchange:192.0.2.50", limit: 20 });
  });

  it("hashes DDNS credentials before using them in Redis keys", () => {
    const authorization = `Bearer ${"sensitive-token".repeat(3)}`;
    const policy = rateLimitPolicyFor(request({ headers: { authorization } }), "/api/v1/ddns/heartbeat");
    expect(policy).toMatchObject({ limit: 120, windowMs: 60_000 });
    expect(policy?.key).toMatch(/^ddns:[a-f0-9]{24}$/);
    expect(policy?.key).not.toContain("sensitive-token");
  });

  it("does not rate-limit authenticated safe reads", () => {
    expect(rateLimitPolicyFor(request({ method: "GET", currentUser: { id: "user-1" } }), "/api/v1/pools")).toBeNull();
  });

  it("groups writes by user and anonymous writes by source IP", () => {
    expect(rateLimitPolicyFor(request({ currentUser: { id: "user-1" } }), "/api/v1/pools")?.key).toBe("write:user-1");
    expect(rateLimitPolicyFor(request(), "/api/v1/pools")?.key).toBe("write:192.0.2.50");
  });
});
