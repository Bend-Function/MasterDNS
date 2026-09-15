import type { CloudProvider, CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

export type AwsCredentials =
  | { kind: "access_key"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: "role"; roleArn?: string; externalId?: string };

export type AzureCredentials = { kind: "azure_service_principal"; tenantId: string; subscriptionId: string; clientId: string; clientSecret: string };
export type LinodeCredentials = { kind: "linode_token"; token: string };
export type CloudCredentials = AwsCredentials | AzureCredentials | LinodeCredentials;
export function credentialsMatchProvider(provider: CloudProvider, credentials: { kind: string }): boolean {
  return provider === "aws" ? credentials.kind === "access_key" || credentials.kind === "role"
    : provider === "azure" ? credentials.kind === "azure_service_principal"
      : provider === "linode" && credentials.kind === "linode_token";
}

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

export interface CloudAdapter {
  verifyIdentity(): Promise<{ externalAccountId: string }>;
  listScopes(): Promise<string[]>;
  discover(region: string, cursor?: string): Promise<CloudPage>;
  inspect(ref: CloudRef): Promise<CloudInventory>;
  capabilities(slot: SlotRef, inventory: CloudInventory): Capability;
  execute(step: CloudStep): Promise<CloudStepResult>;
  observe(step: CloudStep): Promise<CloudObservationStatus>;
  observeDetails?(step: CloudStep): Promise<CloudObservation>;
}

export type AwsSend = (command: any) => Promise<any>;

export type AwsAdapterDependencies = {
  fetch?: typeof fetch;
  stsSend?: AwsSend;
  ec2Send?: AwsSend;
  lightsailSend?: AwsSend;
};
