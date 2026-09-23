import { describe, expect, it } from "vitest";
import { nextRotationAction, type RotationSnapshot, type RotationStepSnapshot } from "./rotation-machine.js";

const now = 1_000_000;
const prepared: RotationStepSnapshot = { stepId: "attempt-1:0:allocate", status: "prepared" };
function snapshot(): RotationSnapshot {
  return {
    phase: "cloud",
    authorization: { managed: true, familyEnabled: true, present: true, regionAllowed: true, conflictingManager: false },
    revisions: { authorization: 1, policy: 2, address: 3 },
    expectedRevisions: { authorization: 1, policy: 2, address: 3 },
    lease: { held: true, revision: 5, expectedRevision: 5 },
    budget: { segmentId: "segment-1", attemptsUsed: 0, maxAttempts: 3, exhausted: false },
    nextAttemptAt: now,
    attempt: { attemptId: "attempt-1", segmentId: "segment-1", charged: false, steps: [prepared], },
    candidate: null,
    publication: { status: "pending" },
    cleanup: { status: "not_required" },
  };
}
function candidateSnapshot(): RotationSnapshot {
  return {
    ...snapshot(), phase: "candidate",
    budget: { segmentId: "segment-1", attemptsUsed: 1, maxAttempts: 3, exhausted: false },
    attempt: { ...snapshot().attempt!, charged: true, steps: [{ ...prepared, status: "applied" }] },
    candidate: {
      addressVersion: 3, probeConfigRevision: 2, successThreshold: 3, failureThreshold: 3,
      probeWindowEndsAt: now + 180_000, nextProbeAt: now,
      evidence: { addressVersion: 3, probeConfigRevision: 2, decision: "success", consecutiveSuccesses: 3, consecutiveFailures: 0, observedAt: now - 1_000, expiresAt: now + 59_000 },
    },
  };
}

describe("rotation preparation and cloud steps", () => {
  it("prepares a durable attempt before cloud execution and preserves DB identities on dispatch", () => {
    const state = snapshot();
    expect(nextRotationAction({ ...state, attempt: null }, now)).toEqual({ kind: "execute", operation: "prepare_attempt", budgetSegmentId: "segment-1" });
    expect(nextRotationAction(state, now)).toEqual({ kind: "execute", operation: "cloud_step", attemptId: "attempt-1", stepId: "attempt-1:0:allocate" });
  });

  it("waits until the exact persisted cooldown boundary", () => {
    const state = { ...snapshot(), nextAttemptAt: now + 60_000 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "cooldown", until: now + 60_000 });
    expect(nextRotationAction(state, now + 60_000).kind).toBe("execute");
  });

  it.each(["in_flight", "pending"] as const)("observes a %s step with its original IDs after restart and revocation", (status) => {
    const state = snapshot();
    state.attempt!.steps = [{ ...prepared, status, observeDeadline: now + 120_000 }];
    state.authorization.managed = false;
    state.revisions.authorization++;
    const restored = JSON.parse(JSON.stringify(state)) as RotationSnapshot;
    expect(nextRotationAction(restored, now)).toEqual({ kind: "observe", attemptId: "attempt-1", stepId: "attempt-1:0:allocate" });
    expect(restored).toEqual(state);
  });

  it("observes the first incomplete adapter step instead of executing a later step", () => {
    const state = snapshot();
    state.attempt!.charged = true;
    state.attempt!.steps = [{ ...prepared, status: "pending", observeDeadline: now + 120_000 }, { stepId: "attempt-1:1:attach", status: "prepared" }];
    expect(nextRotationAction(state, now).kind).toBe("observe");
    state.attempt!.steps[0] = { ...prepared, status: "applied" };
    state.nextAttemptAt = now + 60_000;
    state.budget.attemptsUsed = 3;
    expect(nextRotationAction(state, now)).toEqual({ kind: "execute", operation: "cloud_step", attemptId: "attempt-1", stepId: "attempt-1:1:attach" });
  });

  it.each([
    ["ambiguous", "resource_ownership_ambiguous"], ["not_applied", "cloud_not_applied"], ["abandoned", "cloud_not_applied"],
  ] as const)("does not redispatch an observed %s write", (status, reason) => {
    const state = snapshot();
    state.attempt!.steps = [{ ...prepared, status }];
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason });
  });

  it("bounds convergence without allocating a replacement for an uncertain write", () => {
    const state = snapshot();
    state.attempt!.steps = [{ ...prepared, status: "pending", observeDeadline: now + 120_000 }];
    expect(nextRotationAction(state, now + 120_000)).toEqual({ kind: "observe", attemptId: "attempt-1", stepId: "attempt-1:0:allocate", convergenceExpired: true });
  });

  it.each(["permission_denied", "quota_exceeded", "credentials_expired"] as const)("pauses an explicit no-effect %s rejection without spending budget", (reason) => {
    const state = snapshot();
    state.attempt!.steps = [{ ...prepared, status: "rejected_no_effect", reason, retryAt: null }];
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason });
    expect(state.budget.attemptsUsed).toBe(0);
    expect(state.attempt!.charged).toBe(false);
  });

  it("retries an explicitly rejected throttle on the same attempt after provider backoff", () => {
    const state = snapshot();
    state.attempt!.steps = [{ ...prepared, status: "rejected_no_effect", reason: "rate_limited", retryAt: now + 90_000 }];
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "rate_limited", until: now + 90_000 });
    expect(nextRotationAction(state, now + 90_000)).toEqual({ kind: "execute", operation: "cloud_step", attemptId: "attempt-1", stepId: "attempt-1:0:allocate" });
    expect(state.budget.attemptsUsed).toBe(0);
  });

  it("waits for the coordinator to persist a candidate after every step is remotely applied", () => {
    const state = snapshot();
    state.attempt!.steps = [{ ...prepared, status: "applied" }];
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "candidate_required" });
  });
});

describe("rotation write gates", () => {
  it.each([
    ["managed", false, "authorization_revoked"], ["familyEnabled", false, "family_disabled"],
    ["present", false, "resource_not_found"], ["regionAllowed", false, "region_excluded"],
    ["conflictingManager", true, "conflicting_manager"],
  ] as const)("blocks writes when %s is %s", (field, value, reason) => {
    const state = snapshot();
    state.authorization[field] = value;
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason });
  });

  it.each([
    ["authorization", "authorization_changed"], ["policy", "configuration_changed"], ["address", "address_version_changed"],
  ] as const)("invalidates stale %s revisions", (field, reason) => {
    const state = snapshot();
    state.revisions[field]++;
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason });
  });

  it("requires the current physical-instance lease across independent v4 and v6 incidents", () => {
    const v4 = snapshot();
    const v6 = snapshot();
    v6.lease.held = false;
    expect(nextRotationAction(v4, now).kind).toBe("execute");
    expect(nextRotationAction(v6, now)).toEqual({ kind: "wait", reason: "instance_busy" });
    v6.lease.held = true;
    v6.lease.revision++;
    expect(nextRotationAction(v6, now)).toEqual({ kind: "pause", reason: "stale_fence" });
  });
});

describe("candidate evidence and incident budget", () => {
  it("publishes only the fresh successful candidate version", () => {
    expect(nextRotationAction(candidateSnapshot(), now)).toEqual({ kind: "publish", mode: "dispatch", addressVersion: 3 });
  });

  it.each(["unknown", "failure"] as const)("does not reuse retained healthy evidence after latest decision %s", (decision) => {
    const state = candidateSnapshot();
    state.candidate!.evidence!.decision = decision;
    expect(nextRotationAction(state, now)).toEqual({ kind: "probe", addressVersion: 3, reason: "probe_insufficient" });
  });

  it.each(["addressVersion", "probeConfigRevision", "consecutiveSuccesses", "expired", "future"] as const)("requires matching, sufficient and current evidence: %s", (invalid) => {
    const state = candidateSnapshot();
    const evidence = state.candidate!.evidence!;
    if (invalid === "expired") evidence.expiresAt = now;
    else if (invalid === "future") evidence.observedAt = now + 1;
    else evidence[invalid]--;
    expect(nextRotationAction(state, now).kind).toBe("probe");
  });

  it("waits for the scheduled round and keeps probing unknown beyond the candidate window", () => {
    const state = candidateSnapshot();
    state.candidate!.evidence = null;
    state.candidate!.nextProbeAt = now + 15_000;
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "probe_insufficient", until: now + 15_000 });
    expect(nextRotationAction(state, now + 180_000)).toEqual({ kind: "probe", addressVersion: 3, reason: "probe_insufficient", windowExpired: true });
    expect(state.budget.attemptsUsed).toBe(1);
  });

  it("starts the next attempt after a charged candidate fails, preserving cooldown", () => {
    const state = candidateSnapshot();
    state.candidate!.evidence = { ...state.candidate!.evidence!, decision: "failure", consecutiveSuccesses: 0, consecutiveFailures: 3 };
    state.nextAttemptAt = now + 60_000;
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "cooldown", until: now + 60_000 });
    // Keep failure evidence fresh at the cooldown boundary.
    state.candidate!.evidence!.expiresAt = now + 90_000;
    expect(nextRotationAction(state, now + 60_000)).toEqual({ kind: "execute", operation: "prepare_attempt", budgetSegmentId: "segment-1" });
  });

  it("latches exhaustion across the third failed candidate, 100 further failures and restart", () => {
    const state = candidateSnapshot();
    state.budget.attemptsUsed = 3;
    state.candidate!.evidence = { ...state.candidate!.evidence!, decision: "failure", consecutiveSuccesses: 0, consecutiveFailures: 3 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "attempts_exhausted" });
    state.budget.exhausted = true;
    for (let round = 0; round < 100; round++) {
      const restored = JSON.parse(JSON.stringify(state)) as RotationSnapshot;
      expect(nextRotationAction(restored, now + round)).toEqual({ kind: "pause", reason: "attempts_exhausted" });
    }
    state.budget.attemptsUsed = 0; // The persisted latch independently prevents accidental counter resets.
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "attempts_exhausted" });
  });

  it("allows a latched candidate to recover naturally and publish", () => {
    const state = candidateSnapshot();
    state.budget = { ...state.budget, attemptsUsed: 3, exhausted: true };
    expect(nextRotationAction(state, now)).toEqual({ kind: "publish", mode: "dispatch", addressVersion: 3 });
    state.candidate!.evidence!.decision = "unknown";
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "attempts_exhausted" });
  });

  it("uses an explicit new budget segment for resume without reusing the old attempt", () => {
    const state = candidateSnapshot();
    state.candidate!.evidence = { ...state.candidate!.evidence!, decision: "failure", consecutiveSuccesses: 0, consecutiveFailures: 3 };
    state.budget = { segmentId: "segment-2", attemptsUsed: 0, maxAttempts: 3, exhausted: false };
    expect(nextRotationAction(state, now)).toEqual({ kind: "execute", operation: "prepare_attempt", budgetSegmentId: "segment-2" });
  });
});

describe("publication and cleanup stay in their own stages", () => {
  it("observes an uncertain publication even after authorization is revoked", () => {
    const state = candidateSnapshot();
    state.phase = "publish";
    state.publication = { status: "in_flight", addressVersion: 3 };
    state.authorization.managed = false;
    expect(nextRotationAction(state, now)).toEqual({ kind: "publish", mode: "observe", addressVersion: 3 });
  });

  it("pauses a partial DNS failure without creating a cloud attempt", () => {
    const state = candidateSnapshot();
    state.phase = "publish";
    state.publication = { status: "failed" };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "dns_partial" });
  });

  it("rechecks health and authorization immediately before DNS dispatch", () => {
    const state = candidateSnapshot();
    state.phase = "publish";
    state.candidate!.evidence!.expiresAt = now;
    expect(nextRotationAction(state, now).kind).toBe("probe");
    state.authorization.managed = false;
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "authorization_revoked" });
  });

  it("waits for persisted publication and TTL grace before cleanup, then keeps the cleanup step ID", () => {
    const state = candidateSnapshot();
    state.phase = "cleanup";
    state.cleanup = { status: "required", authorized: true, ownershipVerified: true, notBefore: now + 60_000, steps: [{ stepId: "cleanup-1", status: "prepared" }] };
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "publication_required" });
    state.publication = { status: "applied", addressVersion: 3 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "wait", reason: "cleanup_grace", until: now + 60_000 });
    expect(nextRotationAction(state, now + 60_000)).toEqual({ kind: "cleanup", attemptId: "attempt-1", stepId: "cleanup-1" });
  });

  it.each([
    [false, true, "cleanup_not_authorized"], [true, false, "resource_ownership_ambiguous"],
  ] as const)("rechecks cleanup authorization and ownership", (authorized, ownershipVerified, reason) => {
    const state = candidateSnapshot();
    state.phase = "cleanup";
    state.publication = { status: "applied", addressVersion: 3 };
    state.cleanup = { status: "required", authorized, ownershipVerified, notBefore: now, steps: [{ stepId: "cleanup-1", status: "prepared" }] };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason });
  });

  it("observes dispatched cleanup with revoked release permission, and honors the cleanup step’s own deadline", () => {
    const state = candidateSnapshot();
    state.phase = "cleanup";
    state.publication = { status: "applied", addressVersion: 3 };
    state.cleanup = { status: "required", authorized: false, ownershipVerified: true, notBefore: now, steps: [{ stepId: "cleanup-1", status: "in_flight", observeDeadline: now + 300_000 }] };
    expect(nextRotationAction(state, now + 180_000)).toEqual({ kind: "observe", attemptId: "attempt-1", stepId: "cleanup-1" });
  });

  it("keeps cleanup failure in cleanup and completes only after required work is applied", () => {
    const state = candidateSnapshot();
    state.phase = "cleanup";
    state.publication = { status: "applied", addressVersion: 3 };
    state.cleanup = { status: "failed" };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "cleanup_failed" });
    state.cleanup = { status: "required", authorized: true, ownershipVerified: true, notBefore: now, steps: [{ stepId: "cleanup-1", status: "applied" }] };
    expect(nextRotationAction(state, now)).toEqual({ kind: "complete" });
    state.phase = "complete";
    state.authorization.managed = false;
    expect(nextRotationAction(state, now)).toEqual({ kind: "complete" });
  });
});


describe("recovery safety boundaries", () => {
  it("does not redispatch permission or quota failures even with a retry timestamp", () => {
    for (const reason of ["permission_denied", "quota_exceeded"] as const) {
      const state = snapshot();
      state.attempt!.steps = [{ ...prepared, status: "rejected_no_effect", reason, retryAt: now }];
      expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason });
    }
  });

  it("rejects impossible attempt accounting instead of rotating a supposedly uncharged failed candidate", () => {
    const state = candidateSnapshot();
    state.attempt!.charged = false;
    state.candidate!.evidence = { ...state.candidate!.evidence!, decision: "failure", consecutiveSuccesses: 0, consecutiveFailures: 3 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "invalid_snapshot" });
  });

  it("pauses a confirmed candidate failure after entering publication without returning to allocate", () => {
    const state = candidateSnapshot();
    state.phase = "publish";
    state.candidate!.evidence = { ...state.candidate!.evidence!, decision: "failure", consecutiveSuccesses: 0, consecutiveFailures: 3 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "candidate_failed" });
  });

  it.each([0, -1, Number.NaN])("fails closed with invalid success threshold %s", (threshold) => {
    const state = candidateSnapshot();
    state.candidate!.successThreshold = threshold;
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "invalid_snapshot" });
  });

  it("does not allow a corrupt budget or server clock to bypass attempt gates", () => {
    const state = snapshot();
    state.budget.maxAttempts = Number.NaN;
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "invalid_snapshot" });
    expect(nextRotationAction(snapshot(), Number.NaN)).toEqual({ kind: "pause", reason: "invalid_snapshot" });
  });
});


describe("publication version and recovery identity", () => {
  it("observes the dispatched publication version even when the candidate has changed", () => {
    const state = candidateSnapshot();
    state.phase = "publish";
    state.publication = { status: "in_flight", addressVersion: 2 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "publish", mode: "observe", addressVersion: 2 });
  });

  it("never cleans up using an applied DNS result for a different address version", () => {
    const state = candidateSnapshot();
    state.phase = "cleanup";
    state.publication = { status: "applied", addressVersion: 2 };
    expect(nextRotationAction(state, now)).toEqual({ kind: "pause", reason: "address_version_changed" });
  });

  it("observes cleanup if publication is applied before the coordinator advances its phase", () => {
    const state = candidateSnapshot();
    state.phase = "publish";
    state.publication = { status: "applied", addressVersion: 3 };
    state.cleanup = { status: "required", authorized: false, ownershipVerified: true, notBefore: now, steps: [{ stepId: "cleanup-1", status: "pending", observeDeadline: now + 300_000 }] };
    expect(nextRotationAction(state, now)).toEqual({ kind: "observe", attemptId: "attempt-1", stepId: "cleanup-1" });
  });
});
