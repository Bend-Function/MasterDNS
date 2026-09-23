import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { cloudServiceEnum } from "./cloud.js";
export function defineCloudRotationLimitSchema(deps: { accountId: () => AnyPgColumn; stepId: () => AnyPgColumn }) {
  const cloudRotationLimitSwitches = pgTable("cloud_rotation_limit_switches", {
    identityKey: text("identity_key").primaryKey(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });
  const cloudRotationLimitPolicies = pgTable("cloud_rotation_limit_policies", {
    accountId: uuid("account_id").notNull().references(deps.accountId, { onDelete: "cascade" }),
    service: cloudServiceEnum("service").notNull(),
    utilizationPercent: integer("utilization_percent").notNull().default(80),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }, t => [primaryKey({ columns: [t.accountId, t.service] }), check("cloud_rotation_limit_percent", sql`${t.utilizationPercent} between 1 and 100`)]);
  // No FK to local accounts: deleting/recreating credentials cannot reset remote budgets.
  const cloudRotationBuckets = pgTable("cloud_rotation_buckets", {
    key: text("key").primaryKey(), identityKey: text("identity_key").notNull(), ruleId: text("rule_id").notNull(),
    region: text("region"), debt: doublePrecision("debt").notNull().default(0),
    events: jsonb("events").$type<number[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    throttleCount: integer("throttle_count").notNull().default(0),
  }, t => [index("cloud_rotation_buckets_identity_idx").on(t.identityKey), check("cloud_rotation_bucket_bounds", sql`${t.debt} >= 0 and ${t.throttleCount} >= 0`)]);
  const cloudRotationReservations = pgTable("cloud_rotation_reservations", {
    stepId: varchar("step_id", { length: 180 }).primaryKey().references(deps.stepId, { onDelete: "cascade" }),
    identityKey: text("identity_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  }, t => [index("cloud_rotation_reservations_identity_idx").on(t.identityKey)]);
  return { cloudRotationLimitPolicies, cloudRotationBuckets, cloudRotationReservations, cloudRotationLimitSwitches };
}
