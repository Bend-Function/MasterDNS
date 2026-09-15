import type { CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

export type AwsCredentials =
  | { kind: "access_key"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: "role"; roleArn?: string; externalId?: string };

export type CloudAddress = {
  address: string;
  family: 4 | 6;
  primary: boolean;
  allocationId?: string;
  privateAddress?: string;
  resourceId?: string;
  prefixLength?: number;
};

export type CloudInventory = {
  ref: CloudRef;
  nativeName?: string;
  name: string;
  state: string;
  ipv6Only?: boolean;
  interfaces: Array<{ id: string; deviceIndex?: number; addresses: CloudAddress[] }>;
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
  stsSend?: AwsSend;
  ec2Send?: AwsSend;
  lightsailSend?: AwsSend;
};
