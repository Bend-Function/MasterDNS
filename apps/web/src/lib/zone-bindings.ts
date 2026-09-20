import type { CloudTargetSummary } from "./cloud-types";

export type ZoneBinding = {
  id: string;
  poolId: string;
  poolName: string;
  fqdn: string;
  recordType: string;
  state: string;
  published: boolean;
  inProgress: boolean;
  cancellationBlocked: boolean;
  waitingReason: string | null;
  cloudSources: CloudTargetSummary[];
};
