import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../auth/auth.types.js";
import { assertCloudAccess } from "./cloud-access.js";

const user = (id: string, role: AuthUser["role"] = "user") => ({ id, role }) as AuthUser;

describe("cloud access", () => {
  it("allows resource owners", () => {
    expect(() => assertCloudAccess(user("u1"), "u1")).not.toThrow();
  });

  it("rejects another non-admin user", () => {
    expect(() => assertCloudAccess(user("u1"), "u2")).toThrow(/cloud resource/i);
  });

  it("allows administrators", () => {
    expect(() => assertCloudAccess(user("admin", "admin"), "u2")).not.toThrow();
  });
});
