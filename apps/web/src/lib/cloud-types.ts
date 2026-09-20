import type { CloudProvider, CloudService, SlotRef } from "@masterdns/contracts";

export type CloudAccount = {
  id: string;
  ownerUserId: string;
  provider: CloudProvider;
  name: string;
  credentialHint: string | null;
  enabled: boolean;
  regions: string[] | null;
  externalAccountId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudScope = {
  id: string;
  accountId: string;
  service: CloudService;
  region: string;
  generation: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudInstance = {
  id: string;
  accountId: string;
  service: CloudService;
  region: string;
  externalId: string;
  name: string | null;
  state: string | null;
  metadata: Record<string, unknown>;
  scanGeneration: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudAuthorization = {
  instanceId: string;
  revision: number;
  managed: boolean;
  allowIpv4Rotation: boolean;
  allowIpv6Rotation: boolean;
  allowStopStart: boolean;
  allowReleaseAddress: boolean;
  updatedAt?: string;
};

export type CloudInstanceRow = {
  instance: CloudInstance;
  authorization: CloudAuthorization | null;
  inScope: boolean;
  account?: CloudAccount;
  addresses?: CloudAddress[];
};

export type CloudInterface = {
  id: string;
  instanceId: string;
  externalId: string;
  name: string | null;
  metadata: Record<string, unknown>;
  scanGeneration: number;
  lastSeenAt: string;
};

export type CloudAddress = {
  id: string;
  interfaceId?: string;
  address: string;
  family: "4" | "6";
  kind?: "host" | "prefix";
  origin?: "user" | "system";
  remoteAllocationId?: string | null;
  metadata?: Record<string, unknown>;
  scanGeneration?: number;
};

export type CloudInstanceDetail = CloudInstanceRow & {
  interfaces: CloudInterface[];
  addresses: CloudAddress[];
};

export type CloudCapability = {
  available: boolean;
  reason?: string;
  permission: "unverified";
  requiresStop: boolean;
  releasesOldAddress: boolean;
  canRestoreOldAddress: boolean;
};

export type AddressSlot = {
  cloudTarget?: CloudTargetSummary | null;
  slot: {
    id: string;
    interfaceId: string;
    family: "4" | "6";
    name: string;
    currentAddressId: string | null;
    currentVersion: number;
  };
  currentAddress: CloudAddress | null;
  ref: SlotRef | null;
  capability: CloudCapability | null;
  inScope: boolean;
};

export type AuthorizationPayload = Omit<CloudAuthorization, "instanceId" | "updatedAt">;

export type CloudTargetSummary = {
  account: Pick<CloudAccount, "id" | "name" | "provider">;
  instance: Pick<CloudInstance, "id" | "name" | "externalId" | "service" | "region">;
  slot: { id: string; name: string; family: "4" | "6"; currentVersion: number; candidateVersion: number };
  currentAddress: { id: string; address: string } | null;
  candidateAddress: { id: string; address: string } | null;
};
