import type { HealthObservation, ProbeOutcome } from "@masterdns/contracts";
import { applyHealthResult, type HealthThresholds } from "./health-state.js";

export type RoundDecision = "success" | "failure" | "unknown";

export type ConsensusPolicy = {
  mode: "any" | "majority" | "all" | "at_least" | "specified";
  minimumValid: number;
  failureVotes?: number;
  specifiedProbeId?: string;
};

export type RoundHealthObservation = HealthObservation & { lastRoundId?: string };

export function evaluateProbeRound(input: {
  memberIds: string[];
  outcomes: Record<string, ProbeOutcome>;
  policy: ConsensusPolicy;
}): RoundDecision {
  const memberCount = validateConsensusInput(input.memberIds, input.policy);
  const memberOutcomes = input.memberIds.map((memberId) => input.outcomes[memberId]);
  const validCount = memberOutcomes.filter((outcome) => outcome === "success" || outcome === "failure").length;
  if (validCount < input.policy.minimumValid) return "unknown";

  if (input.policy.mode === "specified") {
    const outcome = input.outcomes[input.policy.specifiedProbeId!];
    return outcome === "success" || outcome === "failure" ? outcome : "unknown";
  }

  const failures = memberOutcomes.filter((outcome) => outcome === "failure").length;
  const successes = memberOutcomes.filter((outcome) => outcome === "success").length;
  const failureVotes = requiredFailureVotes(input.policy, memberCount);
  if (failures >= failureVotes) return "failure";
  if (successes > memberCount - failureVotes) return "success";
  return "unknown";
}

export function advanceRoundHealth(
  current: RoundHealthObservation,
  roundId: string,
  decision: RoundDecision,
  thresholds: HealthThresholds,
): RoundHealthObservation {
  if (!roundId) throw new Error("roundId must not be empty");
  if (current.lastRoundId === roundId) return current;
  validateThresholds(thresholds);
  if (decision === "unknown") {
    return { ...current, consecutiveSuccesses: 0, consecutiveFailures: 0, lastRoundId: roundId };
  }
  return { ...applyHealthResult(current, decision === "success", thresholds), lastRoundId: roundId };
}

function validateThresholds(thresholds: HealthThresholds): void {
  if (!Number.isInteger(thresholds.failureThreshold) || thresholds.failureThreshold < 1) {
    throw new Error("failureThreshold must be a positive integer");
  }
  if (!Number.isInteger(thresholds.successThreshold) || thresholds.successThreshold < 1) {
    throw new Error("successThreshold must be a positive integer");
  }
}

function validateConsensusInput(memberIds: string[], policy: ConsensusPolicy): number {
  const memberCount = new Set(memberIds).size;
  if (memberCount === 0 || memberCount !== memberIds.length) throw new Error("memberIds must be a non-empty unique set");
  if (!Number.isInteger(policy.minimumValid) || policy.minimumValid < 1 || policy.minimumValid > memberCount) {
    throw new Error("minimumValid must be within member count");
  }
  if (policy.mode === "at_least" && (
    !Number.isInteger(policy.failureVotes) || policy.failureVotes! < 1 || policy.failureVotes! > memberCount
  )) throw new Error("failureVotes must be within member count");
  if (policy.mode === "specified" && (!policy.specifiedProbeId || !memberIds.includes(policy.specifiedProbeId))) {
    throw new Error("specifiedProbeId must identify a member");
  }
  return memberCount;
}

function requiredFailureVotes(policy: ConsensusPolicy, memberCount: number): number {
  switch (policy.mode) {
    case "any": return 1;
    case "majority": return Math.floor(memberCount / 2) + 1;
    case "all": return memberCount;
    case "at_least": return policy.failureVotes!;
    case "specified": throw new Error("specified policy does not use a vote threshold");
  }
}
