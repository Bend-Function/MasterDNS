import type { HealthObservation } from "@masterdns/contracts";

export type HealthThresholds = { failureThreshold: number; successThreshold: number };

export function applyHealthResult(
  current: HealthObservation,
  success: boolean,
  thresholds: HealthThresholds,
): HealthObservation {
  validateThresholds(thresholds);
  if (success) {
    const consecutiveSuccesses = current.consecutiveSuccesses + 1;
    const becomesHealthy = consecutiveSuccesses >= thresholds.successThreshold;
    if (current.state === "healthy") return { state: "healthy", consecutiveSuccesses, consecutiveFailures: 0 };
    if (current.state === "unhealthy" || current.state === "recovering") {
      return { state: becomesHealthy ? "healthy" : "recovering", consecutiveSuccesses, consecutiveFailures: 0 };
    }
    return { state: becomesHealthy ? "healthy" : current.state, consecutiveSuccesses, consecutiveFailures: 0 };
  }

  const consecutiveFailures = current.consecutiveFailures + 1;
  const becomesUnhealthy = consecutiveFailures >= thresholds.failureThreshold;
  if (current.state === "unhealthy") return { state: "unhealthy", consecutiveSuccesses: 0, consecutiveFailures };
  if (current.state === "recovering") return { state: "unhealthy", consecutiveSuccesses: 0, consecutiveFailures };
  if (current.state === "healthy" || current.state === "degraded") {
    return { state: becomesUnhealthy ? "unhealthy" : "degraded", consecutiveSuccesses: 0, consecutiveFailures };
  }
  return { state: becomesUnhealthy ? "unhealthy" : "unknown", consecutiveSuccesses: 0, consecutiveFailures };
}

function validateThresholds(thresholds: HealthThresholds) {
  if (!Number.isInteger(thresholds.failureThreshold) || thresholds.failureThreshold < 1) throw new Error("failureThreshold must be a positive integer");
  if (!Number.isInteger(thresholds.successThreshold) || thresholds.successThreshold < 1) throw new Error("successThreshold must be a positive integer");
}
