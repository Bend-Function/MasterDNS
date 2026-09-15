import { describe, expect, it } from "vitest";
import { probePolicySchema } from "./probe-policy.js";

const validPolicy = {
  memberIds: ["a", "b", "c"],
  consensus: { mode: "majority", minimumValid: 2 },
  checkIntervalSeconds: 15,
  executionWindowSeconds: 10,
  candidateWindowSeconds: 45,
  failureThreshold: 3,
  successThreshold: 3,
} as const;

describe("probe policy", () => {
  it("accepts a bounded policy", () => {
    expect(probePolicySchema.safeParse(validPolicy).success).toBe(true);
  });

  it.each([
    ["minimumValid below one", { consensus: { mode: "majority", minimumValid: 0 } }],
    ["minimumValid above membership", { consensus: { mode: "majority", minimumValid: 4 } }],
    ["at-least N below one", { consensus: { mode: "at_least", minimumValid: 2, failureVotes: 0 } }],
    ["at-least N above membership", { consensus: { mode: "at_least", minimumValid: 2, failureVotes: 4 } }],
    ["specified member missing", { consensus: { mode: "specified", minimumValid: 2, specifiedProbeId: "d" } }],
    ["execution window above interval", { executionWindowSeconds: 16 }],
    ["candidate window too short", { candidateWindowSeconds: 44 }],
  ])("rejects %s", (_name, replacement) => {
    expect(probePolicySchema.safeParse({ ...validPolicy, ...replacement }).success).toBe(false);
  });

  it("rejects duplicate fixed members", () => {
    expect(probePolicySchema.safeParse({ ...validPolicy, memberIds: ["a", "a"] }).success).toBe(false);
  });
});
