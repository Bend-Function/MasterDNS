import { describe, expect, it } from "vitest";
import { preAuthRateLimitPolicyFor, rateLimitPolicyFor, type RateLimitPolicyRequest } from "./rate-limit-policy.js";

function request(overrides: Partial<RateLimitPolicyRequest> = {}): RateLimitPolicyRequest {
  return { ip: "192.0.2.50", method: "POST", headers: {}, ...overrides };
}

describe("API rate-limit policy", () => {
  it("uses tighter categories for login and public DDNS exchange", () => {
    const login = preAuthRateLimitPolicyFor(request({ body: { identifier: " Admin@Example.COM " } }), "/api/v1/auth/login");
    expect(login).toEqual([
      { key: "login-ip:192.0.2.50", limit: 10, windowMs: 60_000 },
      expect.objectContaining({ key: expect.stringMatching(/^login-account:[a-f0-9]{24}$/), limit: 10 }),
    ]);
    expect(JSON.stringify(login)).not.toContain("Admin@Example.COM");
    expect(preAuthRateLimitPolicyFor(request(), "/api/v1/ddns/exchange")).toMatchObject({ key: "exchange:192.0.2.50", limit: 20 });
  });

  it("normalizes login identifiers into the same cross-IP account bucket", () => {
    const first = preAuthRateLimitPolicyFor(request({ ip: "192.0.2.1", body: { identifier: "Admin" } }), "/api/v1/auth/login");
    const second = preAuthRateLimitPolicyFor(request({ ip: "192.0.2.2", body: { identifier: " admin " } }), "/api/v1/auth/login");
    expect(Array.isArray(first) && Array.isArray(second) && first[1]?.key).toBe(Array.isArray(second) ? second[1]?.key : undefined);
  });

  it("hashes DDNS credentials before using them in Redis keys", () => {
    const authorization = `Bearer ${"sensitive-token".repeat(3)}`;
    const policy = preAuthRateLimitPolicyFor(request({ headers: { authorization } }), "/api/v1/ddns/heartbeat");
    expect(policy).toEqual([
      { key: "ddns-ip:192.0.2.50", limit: 600, windowMs: 60_000 },
      expect.objectContaining({ limit: 120, windowMs: 60_000 }),
    ]);
    const credentialPolicy = Array.isArray(policy) ? policy[1] : undefined;
    expect(credentialPolicy?.key).toMatch(/^ddns-token:[a-f0-9]{24}$/);
    expect(credentialPolicy?.key).not.toContain("sensitive-token");
  });

  it("keeps the DDNS source-IP bucket stable when invalid credentials are rotated", () => {
    const first = preAuthRateLimitPolicyFor(request({ headers: { authorization: `Bearer ${"a".repeat(32)}` } }), "/api/v1/ddns/heartbeat");
    const second = preAuthRateLimitPolicyFor(request({ headers: { authorization: `Bearer ${"b".repeat(32)}` } }), "/api/v1/ddns/heartbeat");
    expect(Array.isArray(first) && first[0]?.key).toBe("ddns-ip:192.0.2.50");
    expect(Array.isArray(second) && second[0]?.key).toBe("ddns-ip:192.0.2.50");
    expect(Array.isArray(first) && Array.isArray(second) && first[1]?.key).not.toBe(Array.isArray(second) ? second[1]?.key : undefined);
  });

  it("does not rate-limit authenticated safe reads", () => {
    expect(rateLimitPolicyFor(request({ method: "GET", currentUser: { id: "user-1" } }), "/api/v1/pools")).toBeNull();
  });

  it("limits health, SSE opens, and generic GETs before authentication", () => {
    expect(preAuthRateLimitPolicyFor(request({ method: "GET" }), "/api/health")).toEqual({ key: "health:192.0.2.50", limit: 60, windowMs: 60_000 });
    expect(preAuthRateLimitPolicyFor(request({ method: "GET", cookies: { masterdns_session: "secret-session" } }), "/api/v1/events")).toEqual([
      { key: "events-ip:192.0.2.50", limit: 60, windowMs: 60_000 },
      expect.objectContaining({ key: expect.stringMatching(/^events-session:[a-f0-9]{24}$/), limit: 20 }),
    ]);
    expect(preAuthRateLimitPolicyFor(request({ method: "GET" }), "/api/v1/pools")).toEqual({ key: "request:192.0.2.50", limit: 600, windowMs: 60_000 });
  });

  it("groups authenticated writes by user and leaves public writes to the pre-auth guard", () => {
    const authenticated = rateLimitPolicyFor(request({ currentUser: { id: "user-1" } }), "/api/v1/pools");
    const anonymous = rateLimitPolicyFor(request(), "/api/v1/pools");
    expect(!Array.isArray(authenticated) && authenticated?.key).toBe("write:user-1");
    expect(anonymous).toBeNull();
  });
});
