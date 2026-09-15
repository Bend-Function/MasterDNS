import type { ConsensusPolicy } from "@masterdns/contracts";

export type ConsensusPreview = {
  failureVotesRequired: number | null;
  successVotesRequired: number | null;
  minimumValid: number;
};

export function defaultMinimumValid(mode: "local" | "external" | "mixed", externalMemberCount: number): number {
  if (mode === "local") return 1;
  return Math.max(1, externalMemberCount + (mode === "mixed" ? 1 : 0));
}

export function isSpecifiedProbeAllowed(targetKind: "slot" | "endpoint", mode: "local" | "external" | "mixed", memberIds: string[], probeId: string): boolean {
  return memberIds.includes(probeId) || (targetKind === "endpoint" && mode === "mixed" && probeId === "local");
}

export function consensusPreview(consensus: ConsensusPolicy, cohortSize: number): ConsensusPreview {
  const size = Math.max(0, cohortSize);
  const failureVotesRequired = consensus.mode === "any" ? 1
    : consensus.mode === "majority" ? Math.floor(size / 2) + 1
      : consensus.mode === "all" ? size
        : consensus.mode === "at_least" ? consensus.failureVotes ?? 1
          : null;

  return {
    failureVotesRequired,
    successVotesRequired: failureVotesRequired === null ? null : size - failureVotesRequired + 1,
    minimumValid: consensus.minimumValid,
  };
}

export type ProbePolicyDraft = {
  cohortSize: number;
  mode: "local" | "external" | "mixed";
  targetKind?: "slot" | "endpoint";
  consensus: ConsensusPolicy;
  checkIntervalSeconds: number;
  executionWindowSeconds: number;
  resultExpirySeconds: number;
  timeoutMs: number;
};

export function validateProbePolicyDraft(input: ProbePolicyDraft): string[] {
  const errors: string[] = [];
  if (input.checkIntervalSeconds < input.executionWindowSeconds) errors.push("interval_before_window");
  if (input.resultExpirySeconds < input.executionWindowSeconds) errors.push("expiry_before_window");
  if (input.timeoutMs + 1_000 > input.executionWindowSeconds * 1_000 && input.mode !== "local") errors.push("timeout_exceeds_window");
  if (input.consensus.minimumValid > input.cohortSize) errors.push("minimum_valid_exceeds_cohort");
  if (input.consensus.mode === "at_least" && (input.consensus.failureVotes ?? 1) > input.cohortSize) errors.push("failure_votes_exceed_cohort");
  if (input.targetKind === "slot" && input.mode === "mixed" && (input.cohortSize < 2 || input.consensus.minimumValid < 2)) errors.push("slot_requires_external_vote");
  return errors;
}

type RoundVoteInput = {
  memberIds: string[];
  localOutcome: "success" | "failure" | "unavailable" | null;
  localReceivedAt?: string | null;
  observations: Array<{ probeId: string; status: "accepted" | "stale"; outcome: "success" | "failure" | "unavailable"; latencyMs: number; statusCode: number | null; receivedAt: string }>;
};

export type RoundVoteRow = {
  id: string;
  source: "probe" | "local";
  outcome: "success" | "failure" | "unavailable" | "unknown";
  latencyMs: number | null;
  statusCode: number | null;
  receivedAt: string | null;
};

export function roundVoteRows(round: RoundVoteInput): RoundVoteRow[] {
  const rows = round.memberIds.map((id): RoundVoteRow => {
    const observation = round.observations.find((item) => item.probeId === id && item.status === "accepted");
    return observation
      ? { id, source: "probe", outcome: observation.outcome, latencyMs: observation.latencyMs, statusCode: observation.statusCode, receivedAt: observation.receivedAt }
      : { id, source: "probe", outcome: "unknown", latencyMs: null, statusCode: null, receivedAt: null };
  });
  if (round.localOutcome) rows.push({ id: "local", source: "local", outcome: round.localOutcome, latencyMs: null, statusCode: null, receivedAt: round.localReceivedAt ?? null });
  return rows;
}
