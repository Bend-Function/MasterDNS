import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function tokenHashMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}
