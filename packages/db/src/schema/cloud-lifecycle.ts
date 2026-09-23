import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { CloudLifecycleAction, CloudLifecycleSnapshot, CloudLifecycleStatus } from "@masterdns/contracts";
const time = (name: string) => timestamp(name, { withTimezone: true });
export function defineCloudLifecycleSchema(d: { instanceId: () => AnyPgColumn; userId: () => AnyPgColumn }) {
  const cloudInstanceControls = pgTable("cloud_instance_controls", {
    physicalKey: text("physical_key").primaryKey(), powerHold: text("power_hold").$type<"manual_stop" | "traffic_limit" | "deleted">(), updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [check("cloud_instance_controls_hold", sql`${t.powerHold} is null or ${t.powerHold} in ('manual_stop','traffic_limit','deleted')`)]);
  const cloudTrafficStopPolicies = pgTable("cloud_traffic_stop_policies", {
    instanceId: uuid("instance_id").primaryKey().references(d.instanceId, { onDelete: "restrict" }),
    resourceIdentity: text("resource_identity"),
    revision: integer("revision").notNull().default(1), enabled: boolean("enabled").notNull().default(false), thresholdBytes: bigint("threshold_bytes", { mode: "number" }),
    direction: text("direction").$type<"total" | "outgoing">().notNull().default("total"), checkIntervalSeconds: integer("check_interval_seconds").notNull().default(3600),
    actorUserId: uuid("actor_user_id").notNull().references(d.userId, { onDelete: "restrict" }),
    month: text("month"), lastUsageBytes: bigint("last_usage_bytes", { mode: "number" }), lastCheckedAt: time("last_checked_at"), lastError: text("last_error"), triggeredAt: time("triggered_at"),
    nextCheckAt: time("next_check_at").notNull().defaultNow(), leaseHolder: uuid("lease_holder"), leaseExpiresAt: time("lease_expires_at"), updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [index("cloud_traffic_policy_due_idx").on(t.nextCheckAt).where(sql`${t.enabled}`), check("cloud_traffic_policy_bounds", sql`${t.revision}>0 and ${t.checkIntervalSeconds} between 60 and 86400 and ${t.direction} in ('total','outgoing') and (${t.thresholdBytes} is null or ${t.thresholdBytes} between 1 and 9007199254740991) and (not ${t.enabled} or ${t.thresholdBytes} is not null)`)]);
  const cloudLifecycleOperations = pgTable("cloud_lifecycle_operations", {
    id: uuid("id").primaryKey().defaultRandom(), instanceId: uuid("instance_id").notNull().references(d.instanceId, { onDelete: "restrict" }), physicalKey: text("physical_key").notNull(),
    ownerUserId: uuid("owner_user_id").notNull().references(d.userId, { onDelete: "restrict" }), actorUserId: uuid("actor_user_id").notNull().references(d.userId, { onDelete: "restrict" }),
    action: text("action").$type<CloudLifecycleAction>().notNull(), source: text("source").$type<"user" | "traffic">().notNull(), status: text("status").$type<CloudLifecycleStatus>().notNull().default("queued"),
    idempotencyKey: text("idempotency_key"), requestHash: text("request_hash"), externalAccountId: text("external_account_id").notNull(), credentialFingerprint: text("credential_fingerprint").notNull(),
    snapshot: jsonb("snapshot").$type<CloudLifecycleSnapshot>(), protectedAddresses: jsonb("protected_addresses").$type<string[]>().notNull().default([]), policyRevision: integer("policy_revision"), policyMonth: text("policy_month"),
    errorCode: text("error_code"), leaseHolder: uuid("lease_holder"), leaseExpiresAt: time("lease_expires_at"),
    createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(), dispatchedAt: time("dispatched_at"), completedAt: time("completed_at"), nextRunAt: time("next_run_at").notNull().defaultNow(),
  }, t => [uniqueIndex("cloud_lifecycle_active_physical_unique").on(t.physicalKey).where(sql`${t.status} in ('queued','in_flight','unknown')`), uniqueIndex("cloud_lifecycle_idempotency_unique").on(t.actorUserId, t.idempotencyKey), index("cloud_lifecycle_due_idx").on(t.nextRunAt).where(sql`${t.status} in ('queued','in_flight','unknown')`), check("cloud_lifecycle_state", sql`${t.action} in ('start','stop','delete') and ${t.source} in ('user','traffic') and ${t.status} in ('queued','in_flight','succeeded','failed','unknown','cancelled')`)]);
  return { cloudInstanceControls, cloudTrafficStopPolicies, cloudLifecycleOperations };
}
