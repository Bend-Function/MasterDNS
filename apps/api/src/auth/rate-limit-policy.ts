import { createHash } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RateLimitPolicyRequest = {
  ip: string;
  method: string;
  headers: { authorization?: string | undefined };
  cookies?: Record<string, string | undefined> | undefined;
  body?: unknown;
  currentUser?: { id: string } | undefined;
};

export type RateLimitPolicy = { key: string; limit: number; windowMs: number };

export function preAuthRateLimitPolicyFor(request: RateLimitPolicyRequest, route: string): RateLimitPolicy | RateLimitPolicy[] {
  if (route.endsWith("/auth/login")) {
    const identifier = loginIdentifier(request.body);
    return [
      { key: `login-ip:${request.ip}`, limit: 10, windowMs: 60_000 },
      ...(identifier ? [{ key: `login-account:${digest(identifier)}`, limit: 10, windowMs: 60_000 }] : []),
    ];
  }
  if (route.includes("/ddns/heartbeat")) {
    const credential = request.headers.authorization ?? request.ip;
    return [
      { key: `ddns-ip:${request.ip}`, limit: 600, windowMs: 60_000 },
      { key: `ddns-token:${digest(credential)}`, limit: 120, windowMs: 60_000 },
    ];
  }
  if (route.includes("/ddns/exchange")) return { key: `exchange:${request.ip}`, limit: 20, windowMs: 60_000 };
  if (route.endsWith("/health")) return { key: `health:${request.ip}`, limit: 60, windowMs: 60_000 };
  if (route.endsWith("/events")) {
    const session = request.cookies?.masterdns_session;
    return [
      { key: `events-ip:${request.ip}`, limit: 60, windowMs: 60_000 },
      ...(session ? [{ key: `events-session:${digest(session)}`, limit: 20, windowMs: 60_000 }] : []),
    ];
  }
  return { key: `request:${request.ip}`, limit: 600, windowMs: 60_000 };
}

export function rateLimitPolicyFor(request: RateLimitPolicyRequest, _route: string): RateLimitPolicy | RateLimitPolicy[] | null {
  if (!request.currentUser) return null;
  if (SAFE_METHODS.has(request.method)) return null;
  return { key: `write:${request.currentUser.id}`, limit: 300, windowMs: 60_000 };
}

function loginIdentifier(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("identifier" in body)) return undefined;
  const identifier = (body as { identifier?: unknown }).identifier;
  if (typeof identifier !== "string") return undefined;
  const normalized = identifier.trim().toLowerCase();
  return normalized || undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
