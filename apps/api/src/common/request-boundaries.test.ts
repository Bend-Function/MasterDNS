import { describe, expect, it } from "vitest";
import { publicDatabaseError } from "./database-error.js";
import { parseIdempotencyKey } from "./idempotency.js";

describe("Idempotency-Key validation", () => {
  it("accepts opaque visible ASCII keys", () => {
    expect(parseIdempotencyKey("request_01J-abc.123")).toBe("request_01J-abc.123");
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it("rejects whitespace, controls, and oversized values", () => {
    expect(() => parseIdempotencyKey("contains space")).toThrow(/ASCII/);
    expect(() => parseIdempotencyKey("line\nbreak")).toThrow(/ASCII/);
    expect(() => parseIdempotencyKey("x".repeat(256))).toThrow();
  });
});

describe("database error redaction", () => {
  it("maps unique and foreign-key violations to public conflicts", () => {
    expect(publicDatabaseError({ code: "23505", detail: "secret database detail" })).toEqual({ status: 409, code: "conflict", message: "资源已存在或与现有配置冲突" });
    expect(publicDatabaseError({ code: "23503" })?.status).toBe(409);
  });

  it("maps malformed UUID and check violations to validation errors", () => {
    expect(publicDatabaseError({ code: "22P02" })?.status).toBe(400);
    expect(publicDatabaseError({ code: "23514" })?.code).toBe("validation_failed");
    expect(publicDatabaseError(new Error("unknown"))).toBeNull();
  });
});
