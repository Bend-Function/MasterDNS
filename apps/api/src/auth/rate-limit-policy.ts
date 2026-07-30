import { createHash } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RateLimitPolicyRequest = {
  ip: string;
  method: string;
  headers: { authorization?: string | undefined };
  currentUser?: { id: string } | undefined;
};

export type RateLimitPolicy = { key: string; limit: number; windowMs: number };

export function rateLimitPolicyFor(request: RateLimitPolicyRequest, route: string): RateLimitPolicy | null {
  if (route.endsWith("/auth/login")) return { key: `login:${request.ip}`, limit: 10, windowMs: 60_000 };
  if (route.includes("/ddns/heartbeat")) {
    const credential = request.headers.authorization ?? request.ip;
    return { key: `ddns:${digest(credential)}`, limit: 120, windowMs: 60_000 };
  }
  if (route.includes("/ddns/exchange")) return { key: `exchange:${request.ip}`, limit: 20, windowMs: 60_000 };
  if (SAFE_METHODS.has(request.method)) return null;
  return { key: `write:${request.currentUser?.id ?? request.ip}`, limit: 300, windowMs: 60_000 };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
