import { hashPassword } from "@masterdns/crypto";
import { describe, expect, it } from "vitest";
import { verifyLoginCredentials } from "./login-credentials.js";

describe("login credential verification", () => {
  it("runs the sentinel verification path and rejects a missing user", async () => {
    await expect(verifyLoginCredentials(undefined, "any-password")).resolves.toBe(false);
  });

  it("accepts only a matching stored password hash", async () => {
    const hash = await hashPassword("valid-test-password");
    await expect(verifyLoginCredentials(hash, "valid-test-password")).resolves.toBe(true);
    await expect(verifyLoginCredentials(hash, "wrong-password")).resolves.toBe(false);
  });
});
