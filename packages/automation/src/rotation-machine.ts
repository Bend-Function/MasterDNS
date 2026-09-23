import type { RoundDecision } from "./probe-consensus.js";

export type RotationCloudRejection =
  | "permission_denied" | "quota_exceeded" | "credentials_expired" | "invalid_credentials"
  | "rate_limited" | "temporary_cloud_error" | "unknown_cloud_error"
  | "rotation_unsupported" | "cloud_writes_not_enabled" | "remote_identity_changed" | "resource_not_found";

/** IDs refer to persisted adapter-plan steps; receipts and arguments remain in the store. */
export type RotationStepSnapshot = { stepId: string } & (
  | { status: "prepared" | "applied" | "not_applied" | "ambiguous" | "abandoned" }
  | { status: "in_flight" | "pending"; observeDeadline: number }
  // Only a positively confirmed rejection without effects is eligible for execution again.
  | { status: "rejected_no_effect"; reason: RotationCloudRejection; retryAt: number | null }
);

export type RotationRevisions = { authorization: number; policy: number; address: number };
export type RotationCandidate = {
  addressVersion: number;
  probeConfigRevision: number;
  successThreshold: number;
  failureThreshold: number;
  probeWindowEndsAt: number;
  nextProbeAt: number;
  /** Latest finalized round, never the retained HealthObservation.state alone. */
  evidence: {
    addressVersion: number;
    probeConfigRevision: number;
    decision: RoundDecision;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    observedAt: number;
    expiresAt: number;
  } | null;
};

/**
 * Trusted, transactionally read coordinator facts. All times are server epoch milliseconds.
 * No counters, phases, IDs, receipts or revisions are updated by this function.
 */
export type RotationSnapshot = {
  phase: "cloud" | "candidate" | "publish" | "cleanup" | "complete";
  authorization: {
    managed: boolean;
    familyEnabled: boolean;
    present: boolean;
    regionAllowed: boolean;
    conflictingManager: boolean;
  };
  revisions: RotationRevisions;
  expectedRevisions: RotationRevisions;
  /** Lease is keyed by physical cloud identity, shared across families and account aliases. */
  lease: { held: boolean; revision: number; expectedRevision: number };
  budget: { segmentId: string; attemptsUsed: number; maxAttempts: number; exhausted: boolean };
  nextAttemptAt: number;
  attempt: {
    attemptId: string;
    segmentId: string;
    /** Persisted actual-effect accounting, once per attempt, not once per API call. */
    charged: boolean;
    steps: RotationStepSnapshot[];
  } | null;
  candidate: RotationCandidate | null;
  publication: { status: "pending" | "failed" } | { status: "in_flight" | "applied"; addressVersion: number };
  cleanup:
    | { status: "not_required" }
    | { status: "failed" }
    | { status: "required"; authorized: boolean; ownershipVerified: boolean; notBefore: number; steps: RotationStepSnapshot[] };
};

export type RotationPauseReason = RotationCloudRejection
  | "authorization_revoked" | "family_disabled" | "region_excluded" | "conflicting_manager"
  | "authorization_changed" | "configuration_changed" | "address_version_changed" | "stale_fence"
  | "attempts_exhausted" | "resource_ownership_ambiguous" | "cloud_not_applied"
  | "candidate_failed" | "dns_partial" | "cleanup_not_authorized" | "cleanup_failed"
  | "invalid_snapshot";

export type RotationAction =
  | { kind: "wait"; reason: "instance_busy" | "cooldown" | "candidate_required" | "probe_insufficient" | "publication_required" | "cleanup_grace" | RotationCloudRejection; until?: number }
  | { kind: "execute"; operation: "prepare_attempt"; budgetSegmentId: string }
  | { kind: "execute"; operation: "cloud_step"; attemptId: string; stepId: string }
  | { kind: "observe"; attemptId: string; stepId: string; convergenceExpired?: true }
  | { kind: "probe"; addressVersion: number; reason: "probe_insufficient"; windowExpired?: true }
  | { kind: "publish"; mode: "dispatch" | "observe"; addressVersion: number }
  | { kind: "cleanup"; attemptId: string; stepId: string }
  | { kind: "pause"; reason: RotationPauseReason }
  | { kind: "complete" };

export function nextRotationAction(snapshot: RotationSnapshot, now: number): RotationAction {
  if (snapshot.phase === "complete") return { kind: "complete" };
  const attempt = snapshot.attempt;
  const inCleanup = snapshot.phase === "cleanup" || (snapshot.phase === "publish" && snapshot.publication.status === "applied");
  const steps = inCleanup && snapshot.cleanup.status === "required"
    ? snapshot.cleanup.steps : snapshot.phase === "cloud" ? attempt?.steps : undefined;
  const step = steps?.find((item) => item.status !== "applied");
  if (step?.status === "abandoned") return { kind: "pause", reason: "cloud_not_applied" };

  // Reads must still reconcile dispatched effects when authorization or fencing changes.
  if (attempt && step && (step.status === "in_flight" || step.status === "pending")) {
    return { kind: "observe", attemptId: attempt.attemptId, stepId: step.stepId,
      ...(now >= step.observeDeadline ? { convergenceExpired: true as const } : {}) };
  }
  if (snapshot.publication.status === "in_flight") {
    return { kind: "publish", mode: "observe", addressVersion: snapshot.publication.addressVersion };
  }

  if (!Number.isFinite(now)) return { kind: "pause", reason: "invalid_snapshot" };
  const gate = writeGate(snapshot);
  if (gate) return gate;

  switch (snapshot.phase) {
    case "cloud": {
      if (!attempt) return prepareAttempt(snapshot, now);
      if (!attempt.steps.length || attempt.segmentId !== snapshot.budget.segmentId) return { kind: "pause", reason: "invalid_snapshot" };
      if (!step) return { kind: "wait", reason: "candidate_required" };
      if (step.status === "ambiguous") return { kind: "pause", reason: "resource_ownership_ambiguous" };
      if (step.status === "not_applied") return { kind: "pause", reason: "cloud_not_applied" };
      if (step.status === "rejected_no_effect") {
        if ((step.reason !== "rate_limited" && step.reason !== "temporary_cloud_error") || step.retryAt === null) return { kind: "pause", reason: step.reason };
        if (now < step.retryAt) return { kind: "wait", reason: step.reason, until: step.retryAt };
      }
      if (!attempt.charged) {
        const blocked = attemptGate(snapshot, now);
        if (blocked) return blocked;
      }
      return { kind: "execute", operation: "cloud_step", attemptId: attempt.attemptId, stepId: step.stepId };
    }
    case "candidate":
      return candidateAction(snapshot, now, true);
    case "publish":
      if (snapshot.publication.status === "failed") return { kind: "pause", reason: "dns_partial" };
      if (snapshot.publication.status !== "applied") return candidateAction(snapshot, now, false);
      return cleanupAction(snapshot, now);
    case "cleanup":
      return cleanupAction(snapshot, now);
  }
}

function writeGate(snapshot: RotationSnapshot): RotationAction | undefined {
  const auth = snapshot.authorization;
  if (!auth.managed) return { kind: "pause", reason: "authorization_revoked" };
  if (!auth.familyEnabled) return { kind: "pause", reason: "family_disabled" };
  if (!auth.present) return { kind: "pause", reason: "resource_not_found" };
  if (!auth.regionAllowed) return { kind: "pause", reason: "region_excluded" };
  if (auth.conflictingManager) return { kind: "pause", reason: "conflicting_manager" };
  if (snapshot.revisions.authorization !== snapshot.expectedRevisions.authorization) return { kind: "pause", reason: "authorization_changed" };
  if (snapshot.revisions.policy !== snapshot.expectedRevisions.policy) return { kind: "pause", reason: "configuration_changed" };
  if (snapshot.revisions.address !== snapshot.expectedRevisions.address) return { kind: "pause", reason: "address_version_changed" };
  if (!snapshot.lease.held) return { kind: "wait", reason: "instance_busy" };
  if (snapshot.lease.revision !== snapshot.lease.expectedRevision) return { kind: "pause", reason: "stale_fence" };
}

function exhausted(snapshot: RotationSnapshot): boolean {
  return snapshot.budget.exhausted || snapshot.budget.attemptsUsed >= snapshot.budget.maxAttempts;
}

function attemptGate(snapshot: RotationSnapshot, now: number): RotationAction | undefined {
  if (!Number.isSafeInteger(snapshot.budget.maxAttempts) || snapshot.budget.maxAttempts < 1
    || !Number.isSafeInteger(snapshot.budget.attemptsUsed) || snapshot.budget.attemptsUsed < 0
    || !Number.isFinite(snapshot.nextAttemptAt)) return { kind: "pause", reason: "invalid_snapshot" };
  if (exhausted(snapshot)) return { kind: "pause", reason: "attempts_exhausted" };
  if (now < snapshot.nextAttemptAt) return { kind: "wait", reason: "cooldown", until: snapshot.nextAttemptAt };
}

function prepareAttempt(snapshot: RotationSnapshot, now: number): RotationAction {
  return attemptGate(snapshot, now) ?? { kind: "execute", operation: "prepare_attempt", budgetSegmentId: snapshot.budget.segmentId };
}

function candidateAction(snapshot: RotationSnapshot, now: number, mayRotate: boolean): RotationAction {
  const candidate = snapshot.candidate;
  if (!candidate) return { kind: "wait", reason: "candidate_required" };
  if (candidate.addressVersion !== snapshot.revisions.address) return { kind: "pause", reason: "address_version_changed" };
  if (!Number.isSafeInteger(candidate.successThreshold) || candidate.successThreshold < 1
    || !Number.isSafeInteger(candidate.failureThreshold) || candidate.failureThreshold < 1) {
    return { kind: "pause", reason: "invalid_snapshot" };
  }
  const evidence = candidate.evidence;
  const fresh = evidence && evidence.addressVersion === candidate.addressVersion
    && evidence.probeConfigRevision === candidate.probeConfigRevision
    && evidence.observedAt <= now && evidence.expiresAt > now;
  if (fresh && evidence.decision === "success" && evidence.consecutiveSuccesses >= candidate.successThreshold) {
    return { kind: "publish", mode: "dispatch", addressVersion: candidate.addressVersion };
  }
  if (mayRotate && exhausted(snapshot)) return { kind: "pause", reason: "attempts_exhausted" };
  if (fresh && evidence.decision === "failure" && evidence.consecutiveFailures >= candidate.failureThreshold) {
    if (!mayRotate) return { kind: "pause", reason: "candidate_failed" };
    if (!snapshot.attempt?.charged) return { kind: "pause", reason: "invalid_snapshot" };
    return prepareAttempt(snapshot, now);
  }
  // A window deadline never turns missing/unknown/stale rounds into candidate failure.
  if (now < candidate.nextProbeAt) return { kind: "wait", reason: "probe_insufficient", until: candidate.nextProbeAt };
  return { kind: "probe", addressVersion: candidate.addressVersion, reason: "probe_insufficient",
    ...(now >= candidate.probeWindowEndsAt ? { windowExpired: true as const } : {}) };
}

function cleanupAction(snapshot: RotationSnapshot, now: number): RotationAction {
  if (snapshot.publication.status === "failed") return { kind: "pause", reason: "dns_partial" };
  if (snapshot.publication.status !== "applied") return { kind: "wait", reason: "publication_required" };
  if (snapshot.publication.addressVersion !== snapshot.revisions.address
    || snapshot.publication.addressVersion !== snapshot.candidate?.addressVersion) {
    return { kind: "pause", reason: "address_version_changed" };
  }
  const cleanup = snapshot.cleanup;
  if (cleanup.status === "failed") return { kind: "pause", reason: "cleanup_failed" };
  if (cleanup.status === "not_required") return { kind: "complete" };
  const step = cleanup.steps.find((item) => item.status !== "applied");
  if (!step) return { kind: "complete" };
  if (!cleanup.authorized) return { kind: "pause", reason: "cleanup_not_authorized" };
  if (!cleanup.ownershipVerified || step.status === "ambiguous") return { kind: "pause", reason: "resource_ownership_ambiguous" };
  if (step.status !== "prepared") return { kind: "pause", reason: "cleanup_failed" };
  if (now < cleanup.notBefore) return { kind: "wait", reason: "cleanup_grace", until: cleanup.notBefore };
  if (!snapshot.attempt) return { kind: "pause", reason: "invalid_snapshot" };
  return { kind: "cleanup", attemptId: snapshot.attempt.attemptId, stepId: step.stepId };
}
