import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createRotationIntent, parseRotationResumeIntent, rotationResumeScope } from "./rotation-action";

describe("createRotationIntent", () => {
  it("keeps the key and confirmed payload together across a retry", () => {
    const keys = ["intent-1", "intent-2"];
    const intent = createRotationIntent(() => keys.shift()!);

    const first = intent.begin({ expectedPolicyRevision: 7 });
    const retry = intent.begin({ expectedPolicyRevision: 8 });

    expect(retry).toEqual(first);
    expect(retry).toEqual({ generation: 0, key: "intent-1", payload: { expectedPolicyRevision: 7 } });
  });

  it("invalidates stale responses and rotates the key after cancellation", () => {
    const keys = ["intent-1", "intent-2", "intent-3"];
    const intent = createRotationIntent(() => keys.shift()!);
    const cancelled = intent.begin({ slotId: "slot-1" });

    intent.cancel();

    expect(intent.isCurrent(cancelled)).toBe(false);
    const next = intent.begin({ slotId: "slot-2" });
    expect(next).toEqual({ generation: 1, key: "intent-2", payload: { slotId: "slot-2" } });
    expect(intent.complete(next)).toBe(true);
    expect(intent.isCurrent(next)).toBe(false);
    expect(intent.begin({ slotId: "slot-3" }).key).toBe("intent-3");
  });
});

describe("rotationResumeScope", () => {
  it("confirms a new policy-sized segment after a charged partial attempt finishes", () => {
    expect(rotationResumeScope(
      { revision: 7, maxAttempts: 5 },
      { attemptsUsed: 3, maxAttempts: 3 },
      { charged: true, status: "cloud" },
    )).toEqual({
      expectedPolicyRevision: 7,
      currentSegmentAttemptsUsed: 3,
      currentSegmentMaxAttempts: 3,
      newSegmentMaxAttempts: 5,
      finishesChargedAttemptFirst: true,
    });
  });
});

describe("parseRotationResumeIntent", () => {
  it("rejects a stale-shape negative policy revision through the shared schema", () => {
    expect(() => parseRotationResumeIntent({ expectedPolicyRevision: -1 })).toThrow(ZodError);
  });
});
