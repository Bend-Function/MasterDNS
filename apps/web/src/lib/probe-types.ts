import type { ConsensusPolicy, HealthCheckConfig } from "@masterdns/contracts";

export type ProbeAgent = {
  id: string;
  ownerUserId: string;
  name: string;
  enabled: boolean;
  maxConcurrency: number;
  reportedConcurrency: number;
  capabilities: { ipv4: boolean; ipv6: boolean };
  agentVersion: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProbeGroup = {
  id: string;
  ownerUserId: string;
  name: string;
  revision: number;
  memberIds: string[];
  createdAt: string;
};

export type HealthConfigRow = {
  id: string;
  slotId: string | null;
  poolId: string | null;
  endpointId: string | null;
  domainBindingId: string | null;
  checkerType: "http" | "tcp";
  config: HealthCheckConfig;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type AddressHealthState = {
  id: string;
  slotId: string | null;
  endpointId: string | null;
  family: "4" | "6";
  addressId: string | null;
  addressVersion: number;
  configId: string | null;
  configVersion: number;
  policyId: string | null;
  policyRevision: number;
  groupRevision: number | null;
  healthState: "unknown" | "healthy" | "unhealthy" | "degraded" | "recovering";
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastAppliedSequence: number;
  lastRoundId: string | null;
  latestDecision: "success" | "failure" | "unknown";
  evidenceExpiresAt: string | null;
  lastCheckedAt: string | null;
  nextRoundAt: string | null;
  stateChangedAt: string;
  updatedAt: string;
};

export type AddressHealthPolicy = {
  id: string;
  slotId: string | null;
  endpointId: string | null;
  family: "4" | "6";
  configId: string;
  mode: "local" | "external" | "mixed";
  groupId: string | null;
  revision: number;
  consensus: ConsensusPolicy;
  checkIntervalSeconds: number;
  executionWindowSeconds: number;
  resultExpirySeconds: number;
  successThreshold: number;
  failureThreshold: number;
  networkPolicy: { allowedPrivateCIDRs: string[] } | null;
  updatedAt: string;
  state: AddressHealthState | null;
  states?: Array<AddressHealthState & { address: string; addressRole: "current" | "candidate" }>;
  config: HealthConfigRow | null;
};

export type ProbeObservation = {
  id: string;
  taskId: string;
  roundId: string;
  probeId: string;
  status: "accepted" | "stale";
  outcome: "success" | "failure" | "unavailable";
  latencyMs: number;
  statusCode: number | null;
  errorCode: string | null;
  measuredAt: string;
  receivedAt: string;
};

export type ProbeRound = {
  id: string;
  sequence: number;
  address: string;
  family: "4" | "6";
  memberIds: string[];
  localOutcome: "success" | "failure" | "unavailable" | null;
  localReceivedAt: string | null;
  consensus: ConsensusPolicy;
  status: "pending" | "completed" | "superseded";
  consensusResult: "success" | "failure" | "unknown" | null;
  deadline: string;
  finalizedAt: string | null;
  observations: ProbeObservation[];
};

export type ProbeObservationStat = {
  id: string;
  probeId: string;
  family: "4" | "6";
  period: "hour" | "day";
  bucketStart: string;
  sampleCount: number;
  successCount: number;
  unavailableCount: number;
  averageLatencyMs: number | null;
};

export type HealthPolicyInput = {
  slotId?: string;
  endpointId?: string;
  family: "4" | "6";
  configId: string;
  mode: "local" | "external" | "mixed";
  groupId?: string;
  expectedRevision?: number;
  consensus: ConsensusPolicy;
  checkIntervalSeconds: number;
  executionWindowSeconds: number;
  resultExpirySeconds: number;
  successThreshold: number;
  failureThreshold: number;
  networkPolicy?: { allowedPrivateCIDRs: string[] };
};
