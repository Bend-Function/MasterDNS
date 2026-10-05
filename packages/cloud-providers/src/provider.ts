import type { CloudLifecycleAction, CloudLifecycleReceipt, CloudLifecycleSnapshot, CloudRef, CloudStep, SlotRef, MonthlyTraffic } from "@masterdns/contracts";

import type { CloudCredentialInput } from "@masterdns/contracts";
export { credentialsMatchProvider } from "@masterdns/contracts";

/** Proxy injection is runtime-only; account input validation belongs to contracts. */
export type CloudCredentials = CloudCredentialInput & { proxyUrl?: string };
export type AwsCredentials = Extract<CloudCredentials, { kind: "access_key" | "role" }>;
export type AzureCredentials = Extract<CloudCredentials, { kind: "azure_service_principal" }>;
export type LinodeCredentials = Extract<CloudCredentials, { kind: "linode_token" }>;

export type CloudAddress = {
  address: string;
  family: 4 | 6;
  primary: boolean;
  allocationId?: string;
  privateAddress?: string;
  resourceId?: string;
  prefixLength?: number;
  metadata?: Record<string, unknown>;
};

export type CloudInventory = {
  ref: CloudRef;
  nativeName?: string;
  name: string;
  state: string;
  ipv6Only?: boolean;
  metadata?: Record<string, unknown>;
  interfaces: Array<{ id: string; deviceIndex?: number; metadata?: Record<string, unknown>; addresses: CloudAddress[] }>;
};

export type CloudPage = { items: CloudInventory[]; cursor?: string };

export type IdleStaticIp = {
  region: string;
  name: string;
  address: string;
  arn: string;
  createdAt: string;
};

export type IdleStaticIpReleaseResult = {
  status: "released" | "missing" | "skipped" | "pending";
  reason?: string;
  operationIds?: string[];
  rejectedNoEffect?: boolean;
  retryAfterMs?: number;
};

export type Capability = {
  available: boolean;
  reason?: string;
  permission: "unverified";
  requiresStop: boolean;
  releasesOldAddress: boolean;
  canRestoreOldAddress: boolean;
};

export type CloudObservationStatus = "pending" | "applied" | "not_applied" | "ambiguous";

export type CloudStepResult = {
  remoteId?: string;
  resourceId?: string;
  allocationId?: string;
  operationId?: string;
  operationIds?: string[];
  candidateAddress?: string;
  candidateRepeated?: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

export type CloudObservation = CloudStepResult & { status: CloudObservationStatus };

/** Minimum contract: inventory providers need no mutation methods. */
export interface CloudInventoryAdapter {
  verifyIdentity(): Promise<{ externalAccountId: string }>;
  listScopes(): Promise<string[]>;
  discover(region: string, cursor?: string): Promise<CloudPage>;
  inspect(ref: CloudRef): Promise<CloudInventory>;
}

export interface CloudRotationAdapter {
  capabilities(slot: SlotRef, inventory: CloudInventory): Capability;
  execute(step: CloudStep): Promise<CloudStepResult>;
  observe(step: CloudStep): Promise<CloudObservationStatus>;
  observeDetails?(step: CloudStep): Promise<CloudObservation>;
}

export interface CloudLifecycleAdapter {
  inspectLifecycle(ref: CloudRef): Promise<CloudLifecycleSnapshot>;
  mutateLifecycle(action: CloudLifecycleAction, snapshot: CloudLifecycleSnapshot): Promise<CloudLifecycleReceipt>;
}

export interface CloudTrafficAdapter {
  monthlyTraffic(ref: CloudRef, now?: Date): Promise<MonthlyTraffic>;
}

export interface CloudIdleIpAdapter {
  listIdleStaticIps(region: string): Promise<IdleStaticIp[]>;
  releaseIdleStaticIp(target: IdleStaticIp): Promise<IdleStaticIpReleaseResult>;
  observeIdleStaticIp?(target: IdleStaticIp): Promise<IdleStaticIpReleaseResult>;
}

/** Factory result: consumers must narrow capabilities before performing mutations. */
export type CloudProviderAdapter = CloudInventoryAdapter & Partial<CloudRotationAdapter & CloudLifecycleAdapter & CloudTrafficAdapter & CloudIdleIpAdapter>;
/** Compatibility contract for existing implementations that explicitly support rotation. */
export type CloudAdapter = CloudProviderAdapter & CloudRotationAdapter;

export type AwsSend = (command: any) => Promise<any>;

export type AwsAdapterDependencies = {
  fetch?: typeof fetch;
  stsSend?: AwsSend;
  ec2Send?: AwsSend;
  lightsailSend?: AwsSend;
  cloudwatchSend?: AwsSend;
};
