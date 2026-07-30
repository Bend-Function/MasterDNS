import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, hashPassword, hashToken, parseEncryptionKey, signWebhook, tokenHashMatches } from "./index.js";

describe("crypto utilities", () => {
  it("encrypts and authenticates JSON", () => {
    const key = parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"));
    const encrypted = encryptJson({ token: "secret", count: 2 }, key);
    expect(decryptJson(encrypted, key)).toEqual({ token: "secret", count: 2 });
  });

  it("hashes passwords with argon2id", async () => {
    const encoded = await hashPassword("a-secure-test-password");
    expect(await import("./passwords.js").then(({ verifyPassword }) => verifyPassword(encoded, "a-secure-test-password"))).toBe(true);
  });

  it("compares opaque tokens without storing the token", () => {
    expect(tokenHashMatches("token", hashToken("token"))).toBe(true);
    expect(tokenHashMatches("other", hashToken("token"))).toBe(false);
  });

  it("signs webhook payloads with their timestamp", () => {
    expect(signWebhook("secret", 42, "{}")).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});
