export type OperationSource = "user" | "failover" | "recovery" | "ddns" | "drift" | "sync" | "rollback";
export type OperationStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "superseded";
export type OperationStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export const queueNames = {
  operations: "masterdns-operations",
  health: "masterdns-health",
  reconcile: "masterdns-reconcile",
  sync: "masterdns-sync",
  notifications: "masterdns-notifications",
} as const;

export type OperationJob = { operationId: string };
export type HealthCheckJob = {
  endpointId: string;
  bindingId?: string;
  configId: string;
  addressId?: string;
  manual?: boolean;
};
export type PoolReconcileJob = {
  poolId: string;
  eventId: string;
  trigger: "failure" | "recovery" | "rebalance" | "configuration" | "repair";
  source?: OperationSource;
  endpointId?: string;
  force?: boolean;
};
export type ZoneSyncJob = { providerAccountId: string; zoneId?: string };
export type NotificationEvent = {
  eventId: string;
  eventType: string;
  ownerUserId: string;
  poolId?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};
export type NotificationJob =
  | { kind: "fanout"; event: NotificationEvent }
  | { kind: "deliver"; deliveryId: string };
