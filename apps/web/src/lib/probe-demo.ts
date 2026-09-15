import { demoNow, demoUser } from "./demo";
import type { AddressHealthPolicy, ProbeAgent, ProbeGroup, ProbeObservationStat, ProbeRound } from "./probe-types";

export const demoProbes: ProbeAgent[] = [
  { id: "probe-auckland", ownerUserId: demoUser.id, name: "Auckland Edge", enabled: true, maxConcurrency: 16, reportedConcurrency: 12, capabilities: { ipv4: true, ipv6: true }, agentVersion: "1.4.2", lastSeenAt: demoNow, revokedAt: null, createdAt: demoNow, updatedAt: demoNow },
  { id: "probe-singapore", ownerUserId: demoUser.id, name: "Singapore Edge", enabled: true, maxConcurrency: 16, reportedConcurrency: 8, capabilities: { ipv4: true, ipv6: false }, agentVersion: "1.4.2", lastSeenAt: null, revokedAt: null, createdAt: demoNow, updatedAt: demoNow },
];
export const demoProbeGroups: ProbeGroup[] = [{ id: "group-global", ownerUserId: demoUser.id, name: "Global IPv4", revision: 3, memberIds: demoProbes.map((probe) => probe.id), createdAt: demoNow }];
export const demoHealthPolicies: AddressHealthPolicy[] = [{
  id: "policy-slot-v4", slotId: "slot-v4", endpointId: null, family: "4", configId: "health-config-v4", mode: "external", groupId: "group-global", revision: 2,
  consensus: { mode: "majority", minimumValid: 2 }, checkIntervalSeconds: 15, executionWindowSeconds: 10, resultExpirySeconds: 60, successThreshold: 3, failureThreshold: 3, networkPolicy: null, updatedAt: demoNow,
  config: { id: "health-config-v4", slotId: "slot-v4", poolId: null, endpointId: null, domainBindingId: null, checkerType: "https" as "http", config: { type: "http", protocol: "https", method: "GET", path: "/health", expectedStatusMin: 200, expectedStatusMax: 399, headers: {}, followRedirects: true, verifyTls: true, timeoutMs: 3000 }, enabled: true, revision: 1, createdAt: demoNow, updatedAt: demoNow },
  state: { id: "health-state-v4", slotId: "slot-v4", endpointId: null, family: "4", addressId: "address-v4", addressVersion: 2, configId: "health-config-v4", configVersion: 1, policyId: "policy-slot-v4", policyRevision: 2, groupRevision: 3, healthState: "healthy", consecutiveSuccesses: 7, consecutiveFailures: 0, lastAppliedSequence: 18, lastRoundId: "round-18", latestDecision: "success", evidenceExpiresAt: demoNow, lastCheckedAt: demoNow, nextRoundAt: demoNow, stateChangedAt: demoNow, updatedAt: demoNow },
}];
export const demoProbeRounds: ProbeRound[] = [{ id: "round-18", sequence: 18, address: "203.0.113.18", family: "4", memberIds: demoProbes.map((probe) => probe.id), localOutcome: null, consensus: { mode: "majority", minimumValid: 2 }, status: "completed", consensusResult: "success", deadline: demoNow, finalizedAt: demoNow, observations: [
  { id: "obs-a", taskId: "task-a", roundId: "round-18", probeId: "probe-auckland", status: "accepted", outcome: "success", latencyMs: 36, statusCode: 200, errorCode: null, measuredAt: demoNow, receivedAt: demoNow },
  { id: "obs-s", taskId: "task-s", roundId: "round-18", probeId: "probe-singapore", status: "accepted", outcome: "unavailable", latencyMs: 0, statusCode: null, errorCode: "ipv6_unavailable", measuredAt: demoNow, receivedAt: demoNow },
] }];
export const demoProbeStats: ProbeObservationStat[] = [{ id: "stat-a", probeId: "probe-auckland", family: "4", period: "hour", bucketStart: demoNow, sampleCount: 40, successCount: 39, unavailableCount: 0, averageLatencyMs: 38 }];
