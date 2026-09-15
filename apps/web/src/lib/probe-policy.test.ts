import { describe, expect, it } from "vitest";
import { consensusPreview, defaultMinimumValid, validateProbePolicyDraft } from "./probe-policy";

describe("consensusPreview", () => {
  it("uses the fixed cohort for majority failure and success semantics", () => {
    expect(consensusPreview({ mode: "majority", minimumValid: 4 }, 5)).toEqual({
      failureVotesRequired: 3,
      successVotesRequired: 3,
      minimumValid: 4,
    });
  });

  it("keeps minimum-valid independent from the failure threshold", () => {
    expect(consensusPreview({ mode: "at_least", minimumValid: 3, failureVotes: 2 }, 5)).toEqual({
      failureVotesRequired: 2,
      successVotesRequired: 4,
      minimumValid: 3,
    });
  });
});

describe("defaultMinimumValid", () => {
  it("requires the full external cohort and the local vote in mixed mode", () => {
    expect(defaultMinimumValid("external", 3)).toBe(3);
    expect(defaultMinimumValid("mixed", 3)).toBe(4);
    expect(defaultMinimumValid("local", 3)).toBe(1);
  });
});

describe("validateProbePolicyDraft", () => {
  it("rejects incoherent execution and expiry windows", () => {
    const errors = validateProbePolicyDraft({
      cohortSize: 3,
      mode: "external",
      consensus: { mode: "majority", minimumValid: 3 },
      checkIntervalSeconds: 8,
      executionWindowSeconds: 10,
      resultExpirySeconds: 9,
      timeoutMs: 9_500,
    });

    expect(errors).toContain("interval_before_window");
    expect(errors).toContain("expiry_before_window");
    expect(errors).toContain("timeout_exceeds_window");
  });

  it("requires an external vote for a mixed cloud slot cohort", () => {
    expect(validateProbePolicyDraft({
      cohortSize: 1,
      mode: "mixed",
      targetKind: "slot",
      consensus: { mode: "majority", minimumValid: 1 },
      checkIntervalSeconds: 15,
      executionWindowSeconds: 10,
      resultExpirySeconds: 60,
      timeoutMs: 3_000,
    })).toContain("slot_requires_external_vote");
  });
});
