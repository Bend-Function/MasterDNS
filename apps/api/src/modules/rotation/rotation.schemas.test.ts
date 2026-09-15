import { expect, it } from "vitest";
import { rotationPolicySchema, rotationStartSchema, rotationResumeSchema } from "./rotation.schemas.js";
it("uses opt-in defaults and rejects unsafe intervals, impossible budgets and extra authority", () => {
  expect(rotationPolicySchema.parse({ revision: 0 })).toMatchObject({ enabled: false, maxAttempts: 3, minIntervalSeconds: 60, cloudWaitSeconds: 120, candidateWindowSeconds: 180 });
  for (const input of [{ revision: 0, maxAttempts: 0 }, { revision: 0, minIntervalSeconds: 1 }, { revision: 0, maxAttempts: 100 }, { revision: 0, sourceEventId: "fake" }]) expect(rotationPolicySchema.safeParse(input).success).toBe(false);
  expect(rotationStartSchema.safeParse({ slotId: "00000000-0000-4000-8000-000000000001", sourceEventId: "fake" }).success).toBe(false);
});

it("accepts omitted resume input and validates the displayed policy revision", () => {
  expect(rotationResumeSchema.parse(undefined)).toEqual({});
  expect(rotationResumeSchema.parse({})).toEqual({});
  expect(rotationResumeSchema.parse({ expectedPolicyRevision: 3 })).toEqual({ expectedPolicyRevision: 3 });
  for (const input of [{ expectedPolicyRevision: -1 }, { expectedPolicyRevision: 1.5 }, { expectedPolicyRevision: "3" }, { maxAttempts: 100 }]) expect(rotationResumeSchema.safeParse(input).success).toBe(false);
});
