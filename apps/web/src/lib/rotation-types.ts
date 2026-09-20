import type { CloudTargetSummary } from "./cloud-types";

export type RotationPolicy = {
  slotId: string;
  enabled: boolean;
  revision: number;
  maxAttempts: number;
  minIntervalSeconds: number;
  cloudWaitSeconds: number;
  candidateWindowSeconds: number;
  updatedAt?: string;
};

export type RotationIncident = {
  cloudTarget?: CloudTargetSummary | null;
  id: string;
  ownerUserId: string;
  slotId: string;
  family: "4" | "6";
  sourceEventId: string;
  trigger?: "health" | "manual";
  status: "active" | "paused" | "exhausted" | "complete";
  phase: "cloud" | "candidate" | "publish" | "cleanup" | "complete";
  currentSegmentId: string;
  currentAttemptId: string | null;
  addressVersion: number;
  nextAttemptAt: string;
  nextRunAt: string;
  candidateDeadline: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type RotationDetail = {
  incident: RotationIncident;
  instanceId: string;
  addresses: {
    observedCloud: { addresses: string[]; observedAt: string | null; source: "rotation_observation" | "inventory" };
    candidate: { id: string; address: string; version: number; verified: boolean } | null;
    lastVerified: { id: string; address: string; version: number; cloudState: "present" | "not_observed" | "released"; verifiedNow: boolean } | null;
    published: Array<{ zoneId: string; fqdn: string; recordType: "A" | "AAAA"; address: string; status: "applied" | "observed"; lastObservedAt: string }>;
  };
  segments: Array<{ id: string; maxAttempts: number; attemptsUsed: number; exhausted: boolean; createdAt: string }>;
  attempts: Array<{ id: string; segmentId: string; sequence: number; status: string; charged: boolean; chargedAt: string | null; candidateAddressId: string | null; candidateVersion: number | null; candidateRepeated: boolean }>;
  steps: Array<{ id: string; attemptId: string; sequence: number; status: string; errorCode: string | null; dispatchedAt: string | null; observeDeadline: string | null; retryAt: string | null }>;
  resources: Array<{ id: string; attemptId: string; addressId: string | null; address: string; role: "original" | "candidate"; origin: "user" | "system"; cleanupStatus: string; cleanupDueAt: string | null; cleanupError: string | null; cleanupStepId: string | null }>;
  publications: Array<{ id: string; addressId: string; addressVersion: number; status: string; operationId: string | null; children: Array<{ poolId: string; eventId: string; policyRevision: number; decisionRevision: number; operationId?: string }>; errorCode: string | null; updatedAt: string }>;
};
