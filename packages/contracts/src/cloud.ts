import type { CloudService } from "./cloud-catalog.js";
export * from "./cloud-catalog.js";
export * from "./cloud-credentials.js";
export { supportsRotationTrigger } from "./cloud-rotation-policy.js";

export type AddressFamily = 4 | 6;

export type CloudRef = {
  accountId: string;
  service: CloudService;
  region: string;
  instanceId: string;
};

export type SlotRef = CloudRef & {
  slotId: string;
  interfaceId: string;
  address: string;
  family: AddressFamily;
};

/** Month-to-date usage. Null means unavailable, never zero usage. */
export type MonthlyTraffic = {
  month: string;
  periodStart: string;
  periodEnd: string;
  fetchedAt: string;
  source: "cloudwatch" | "lightsail" | "azure_monitor" | "linode";
  incomingBytes: number | null;
  outgoingBytes: number | null;
  totalBytes: number | null;
  /** Provider-reported GB. Shared allowance cannot be subtracted from one VM's traffic. */
  allowance: { gigabytes: number; scope: "region_bundle" | "account_pool" } | null;
};

export type MonthlyTrafficResponse =
  | { status: "available"; traffic: MonthlyTraffic }
  | { status: "unavailable"; reason: "account_disabled" | "out_of_scope" | "resource_not_found" | "permission_denied" | "invalid_credentials" | "credentials_expired" | "rate_limited" | "remote_identity_changed" | "query_failed" };
