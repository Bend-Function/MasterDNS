import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createManualRotationSubmission, createRotationIntent, createRotationLoadCoordinator, parseRotationResumeIntent, rotationResumeScope, shouldPollRotation } from "./rotation-action";

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

describe("createManualRotationSubmission", () => {
  it("ignores a duplicate click synchronously while the first request is pending", async () => {
    let resolveRequest!: (value: { id: string }) => void;
    const request = vi.fn(() => new Promise<{ id: string }>((resolve) => { resolveRequest = resolve; }));
    const submission = createManualRotationSubmission(() => "manual-key-1");

    const first = submission.submit("slot-1", request);
    const duplicate = submission.submit("slot-1", request);

    expect(submission.isPending()).toBe(true);
    await expect(duplicate).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    resolveRequest({ id: "rotation-1" });
    await expect(first).resolves.toEqual({ id: "rotation-1" });
    expect(submission.isPending()).toBe(false);
  });

  it("retries a network failure with the same key and exact slot payload", async () => {
    const keys = ["manual-key-1", "manual-key-2"];
    const submission = createManualRotationSubmission(() => keys.shift()!);
    const calls: Array<{ key: string; payload: { slotId: string } }> = [];
    const request = vi.fn(async (key: string, payload: { slotId: string }) => {
      calls.push({ key, payload });
      if (calls.length === 1) throw new TypeError("network unavailable");
      return { id: "rotation-1" };
    });

    await expect(submission.submit("slot-1", request)).rejects.toThrow("network unavailable");
    await expect(submission.submit("slot-1", request)).resolves.toEqual({ id: "rotation-1" });

    expect(calls).toEqual([
      { key: "manual-key-1", payload: { slotId: "slot-1" } },
      { key: "manual-key-1", payload: { slotId: "slot-1" } },
    ]);
  });

  it("does not submit again after success while navigation is taking over", async () => {
    const submission = createManualRotationSubmission(() => "manual-key-1");
    const request = vi.fn().mockResolvedValue({ id: "rotation-1" });

    await expect(submission.submit("slot-1", request)).resolves.toEqual({ id: "rotation-1" });
    await expect(submission.submit("slot-1", request)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
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

describe("shouldPollRotation", () => {
  it("polls incomplete progress only while no confirmation or action is active", () => {
    expect(shouldPollRotation("active", false, false)).toBe(true);
    expect(shouldPollRotation("paused", false, false)).toBe(true);
    expect(shouldPollRotation("complete", false, false)).toBe(false);
    expect(shouldPollRotation("active", true, false)).toBe(false);
    expect(shouldPollRotation("active", false, true)).toBe(false);
  });
});

describe("createRotationLoadCoordinator", () => {
  it("coalesces same-route quiet loads while allowing foreground and route changes to supersede", () => {
    let generation = 0;
    const loads = createRotationLoadCoordinator();
    const quiet = loads.start("rotation-1", false, () => ++generation)!;

    expect(loads.start("rotation-1", false, () => ++generation)).toBeNull();

    const foreground = loads.start("rotation-1", true, () => ++generation)!;
    expect(foreground).toEqual({ rotationId: "rotation-1", foreground: true, generation: 2 });
    expect(loads.isCurrent(quiet)).toBe(false);
    expect(loads.finish(quiet)).toBe(false);

    const nextRoute = loads.start("rotation-2", true, () => ++generation)!;
    expect(nextRoute).toEqual({ rotationId: "rotation-2", foreground: true, generation: 3 });
    expect(loads.finish(foreground)).toBe(false);
    expect(loads.finish(nextRoute)).toBe(true);
  });

  it("does not let a duplicate foreground load replace the token that must clear loading", () => {
    let generation = 0;
    const loads = createRotationLoadCoordinator();
    const first = loads.start("rotation-1", true, () => ++generation)!;

    expect(loads.start("rotation-1", true, () => ++generation)).toBeNull();
    expect(loads.isCurrent(first)).toBe(true);
    expect(loads.finish(first)).toBe(true);
    expect(generation).toBe(1);
  });
});

describe("parseRotationResumeIntent", () => {
  it("rejects a stale-shape negative policy revision through the shared schema", () => {
    expect(() => parseRotationResumeIntent({ expectedPolicyRevision: -1 })).toThrow(ZodError);
  });
});
