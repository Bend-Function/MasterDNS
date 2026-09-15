import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { CloudStep } from "@masterdns/contracts";
import { addressFamilyEnum } from "./cloud.js";

type Dependencies = { userId: () => AnyPgColumn; slotId: () => AnyPgColumn };
const time = (name: string) => timestamp(name, { withTimezone: true });
export function defineRotationSchema(dependencies: Dependencies) {
  const rotationPolicies = pgTable("rotation_policies", {
    slotId: uuid("slot_id").primaryKey().references(dependencies.slotId, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(3),
    minIntervalSeconds: integer("min_interval_seconds").notNull().default(60),
    cloudWaitSeconds: integer("cloud_wait_seconds").notNull().default(120),
    candidateWindowSeconds: integer("candidate_window_seconds").notNull().default(180),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [check("rotation_policy_bounds", sql`${t.revision} > 0 and ${t.maxAttempts} between 1 and 20 and ${t.minIntervalSeconds} between 60 and 86400 and ${t.cloudWaitSeconds} between 10 and 3600 and ${t.candidateWindowSeconds} between 15 and 86400`)]);
  const rotationIncidents = pgTable("rotation_incidents", {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(dependencies.userId, { onDelete: "restrict" }),
    slotId: uuid("slot_id").notNull().references(dependencies.slotId, { onDelete: "restrict" }),
    family: addressFamilyEnum("family").notNull(),
    physicalKey: text("physical_key").notNull(),
    sourceEventId: varchar("source_event_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 16 }).$type<"active" | "paused" | "exhausted" | "complete">().notNull().default("active"),
    phase: varchar("phase", { length: 16 }).$type<"cloud" | "candidate" | "publish" | "cleanup" | "complete">().notNull().default("cloud"),
    currentSegmentId: uuid("current_segment_id").notNull(),
    currentAttemptId: uuid("current_attempt_id"),
    pendingSegmentId: uuid("pending_segment_id"),
    authorizationRevision: integer("authorization_revision").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    addressVersion: integer("address_version").notNull(),
    healthPolicyId: uuid("health_policy_id").notNull(),
    healthPolicyRevision: integer("health_policy_revision").notNull(),
    configId: uuid("config_id").notNull(),
    configRevision: integer("config_revision").notNull(),
    groupId: uuid("group_id").notNull(),
    groupRevision: integer("group_revision").notNull(),
    nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    nextRunAt: time("next_run_at").notNull().defaultNow(),
    candidateDeadline: time("candidate_deadline"),
    errorCode: varchar("error_code", { length: 80 }),
    pausedByUserId: uuid("paused_by_user_id"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
  }, t => [
    uniqueIndex("rotation_incidents_active_unique").on(t.slotId, t.family).where(sql`${t.status} <> 'complete'`),
    uniqueIndex("rotation_incidents_source_unique").on(t.slotId, t.sourceEventId),
    index("rotation_incidents_due_idx").on(t.nextRunAt).where(sql`${t.status} <> 'complete'`),
    index("rotation_incidents_owner_idx").on(t.ownerUserId, t.createdAt),
    check("rotation_incidents_status", sql`${t.status} in ('active','paused','exhausted','complete') and ${t.phase} in ('cloud','candidate','publish','cleanup','complete')`),
  ]);
  const rotationBudgetSegments = pgTable("rotation_budget_segments", {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").notNull().references(() => rotationIncidents.id, { onDelete: "restrict" }),
    maxAttempts: integer("max_attempts").notNull(),
    attemptsUsed: integer("attempts_used").notNull().default(0),
    exhausted: boolean("exhausted").notNull().default(false),
    actorUserId: uuid("actor_user_id"),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [check("rotation_budget_bounds", sql`${t.maxAttempts} between 1 and 20 and ${t.attemptsUsed} between 0 and ${t.maxAttempts}`), index("rotation_budget_incident_idx").on(t.incidentId)]);
  const rotationAttempts = pgTable("rotation_attempts", {
    id: uuid("id").primaryKey(),
    incidentId: uuid("incident_id").notNull().references(() => rotationIncidents.id, { onDelete: "restrict" }),
    segmentId: uuid("segment_id").notNull().references(() => rotationBudgetSegments.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    charged: boolean("charged").notNull().default(false),
    status: varchar("status", { length: 20 }).$type<"prepared" | "cloud" | "candidate" | "candidate_failed" | "verified" | "abandoned">().notNull().default("prepared"),
    beforeInventory: jsonb("before_inventory").$type<Record<string, unknown>>().notNull(),
    candidateAddressId: uuid("candidate_address_id"),
    candidateVersion: integer("candidate_version"),
    candidateRepeated: boolean("candidate_repeated").notNull().default(false),
    chargedAt: time("charged_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [uniqueIndex("rotation_attempt_sequence_unique").on(t.incidentId, t.sequence)]);
  const rotationSteps = pgTable("rotation_steps", {
    id: varchar("id", { length: 180 }).primaryKey(),
    attemptId: uuid("attempt_id").notNull().references(() => rotationAttempts.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    plan: jsonb("plan").$type<CloudStep>().notNull(),
    status: varchar("status", { length: 24 }).$type<"prepared" | "in_flight" | "pending" | "applied" | "not_applied" | "ambiguous" | "rejected_no_effect">().notNull().default("prepared"),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    fence: integer("fence"),
    dispatchedAt: time("dispatched_at"),
    observeDeadline: time("observe_deadline"),
    retryAt: time("retry_at"),
    errorCode: varchar("error_code", { length: 80 }),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [uniqueIndex("rotation_step_sequence_unique").on(t.attemptId, t.sequence), check("rotation_step_state", sql`${t.status} in ('prepared','in_flight','pending','applied','not_applied','ambiguous','rejected_no_effect')`)]);
  const rotationStepObservations = pgTable("rotation_step_observations", {
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: varchar("step_id", { length: 180 }).notNull().references(() => rotationSteps.id, { onDelete: "restrict" }),
    observation: boolean("observation").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [index("rotation_step_observations_step_idx").on(t.stepId, t.createdAt)]);
  const rotationLeases = pgTable("rotation_leases", {
    physicalKey: text("physical_key").primaryKey(),
    revision: integer("revision").notNull().default(0),
    holder: uuid("holder"),
    expiresAt: time("expires_at").notNull().defaultNow(),
    incidentId: uuid("incident_id").references(() => rotationIncidents.id, { onDelete: "restrict" }),
    unresolvedStepId: varchar("unresolved_step_id", { length: 180 }).references(() => rotationSteps.id, { onDelete: "restrict" }),
    updatedAt: time("updated_at").notNull().defaultNow(),
  });
  const rotationResources = pgTable("rotation_resources", {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").notNull().references(() => rotationIncidents.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id").notNull().references(() => rotationAttempts.id, { onDelete: "restrict" }),
    addressId: uuid("address_id"),
    address: varchar("address", { length: 45 }).notNull(),
    allocationId: varchar("allocation_id", { length: 255 }),
    resourceId: text("resource_id"),
    origin: varchar("origin", { length: 16 }).$type<"user" | "system">().notNull(),
    ownershipAttemptId: uuid("ownership_attempt_id"),
    role: varchar("role", { length: 16 }).$type<"original" | "candidate">().notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    attached: boolean("attached").notNull().default(true),
    referenced: boolean("referenced").notNull().default(true),
    cleanupDueAt: time("cleanup_due_at"),
    cleanupStatus: varchar("cleanup_status", { length: 20 }).$type<"retained" | "pending" | "released" | "failed">().notNull().default("retained"),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [uniqueIndex("rotation_resource_attempt_role_unique").on(t.attemptId, t.role)]);
  // P10 owns publication and cleanup. Pending is not success; initial binding has no incident.
  const rotationPublications = pgTable("rotation_publications", {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id").notNull().references(dependencies.slotId, { onDelete: "restrict" }),
    addressVersion: integer("address_version").notNull(),
    addressId: uuid("address_id").notNull(),
    incidentId: uuid("incident_id").references(() => rotationIncidents.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 }).$type<"pending" | "in_flight" | "applied" | "failed">().notNull().default("pending"),
    operationId: uuid("operation_id"),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [uniqueIndex("rotation_publication_version_unique").on(t.slotId, t.addressVersion)]);
  return { rotationPolicies, rotationIncidents, rotationBudgetSegments, rotationAttempts, rotationSteps, rotationStepObservations, rotationLeases, rotationResources, rotationPublications };
}
