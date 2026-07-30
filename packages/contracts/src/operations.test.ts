import { describe, expect, it } from "vitest";
import { queueNames } from "./operations.js";

describe("queue names", () => {
  it("uses unique BullMQ-compatible names", () => {
    const names = Object.values(queueNames);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => !name.includes(":"))).toBe(true);
  });
});
