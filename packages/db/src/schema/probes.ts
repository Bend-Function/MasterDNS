import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, real, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { ConsensusPolicy, ProbeResult, ProbeTask } from "@masterdns/contracts";
import { addressFamilyEnum } from "./cloud.js";

type Dependencies = { userId: () => AnyPgColumn; endpointId: () => AnyPgColumn; endpointAddressId: () => AnyPgColumn; configId: () => AnyPgColumn; slotId: () => AnyPgColumn };
const time = (name: string) => timestamp(name, { withTimezone: true });
export function defineProbeSchema(dependencies: Dependencies) {
  const probeAgents = pgTable("probe_agents", {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(dependencies.userId, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    maxConcurrency: integer("max_concurrency").notNull().default(16),
    reportedConcurrency: integer("reported_concurrency").notNull().default(100),
    capabilities: jsonb("capabilities").$type<{ ipv4: boolean; ipv6: boolean }>().notNull().default({ ipv4: false, ipv6: false }),
    agentVersion: varchar("agent_version", { length: 64 }),
    lastSeenAt: time("last_seen_at"),
    revokedAt: time("revoked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [index("probe_agents_owner_idx").on(t.ownerUserId), check("probe_agents_capacity", sql`${t.maxConcurrency} between 1 and 100 and ${t.reportedConcurrency} between 1 and 1000`)]);
  const probeTokens = pgTable("probe_tokens", {
    id: uuid("id").primaryKey().defaultRandom(),
    probeId: uuid("probe_id").notNull().references(() => probeAgents.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).$type<"install" | "runtime">().notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: time("expires_at"),
    usedAt: time("used_at"),
    revokedAt: time("revoked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [index("probe_tokens_probe_idx").on(t.probeId), check("probe_tokens_kind", sql`${t.kind} in ('install', 'runtime') and (${t.kind} <> 'install' or ${t.expiresAt} is not null)`)]);
  const probeGroups = pgTable("probe_groups", {
    revision: integer("revision").notNull().default(1),
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(dependencies.userId, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [index("probe_groups_owner_idx").on(t.ownerUserId)]);
  const probeGroupMembers = pgTable("probe_group_members", {
    groupId: uuid("group_id").notNull().references(() => probeGroups.id, { onDelete: "cascade" }),
    probeId: uuid("probe_id").notNull().references(() => probeAgents.id, { onDelete: "cascade" }),
  }, t => [primaryKey({ columns: [t.groupId, t.probeId] })]);
  // Survives config deletion and round retention; only the actual target owns its lifetime.
  const probeRoundSequences = pgTable("probe_round_sequences", {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id").references(dependencies.slotId, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").references(dependencies.endpointId, { onDelete: "cascade" }),
    family: addressFamilyEnum("family").notNull(),
    lastSequence: integer("last_sequence").notNull(),
  }, t => [
    check("probe_round_sequences_target", sql`num_nonnulls(${t.slotId}, ${t.endpointId}) = 1`),
    check("probe_round_sequences_positive", sql`${t.lastSequence} > 0`),
    uniqueIndex("probe_round_sequences_slot_unique").on(t.slotId).where(sql`${t.slotId} is not null`),
    uniqueIndex("probe_round_sequences_endpoint_family_unique").on(t.endpointId, t.family).where(sql`${t.endpointId} is not null`),
  ]);
  const addressHealthPolicies = pgTable("address_health_policies", {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id").references(dependencies.slotId, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").references(dependencies.endpointId, { onDelete: "cascade" }),
    family: addressFamilyEnum("family").notNull(),
    configId: uuid("config_id").notNull().references(dependencies.configId, { onDelete: "cascade" }),
    mode: varchar("mode", { length: 16 }).$type<"local" | "external" | "mixed">().notNull().default("external"),
    groupId: uuid("group_id").references(() => probeGroups.id, { onDelete: "set null" }),
    revision: integer("revision").notNull().default(1),
    consensus: jsonb("consensus").$type<ConsensusPolicy>().notNull().default({ mode: "majority", minimumValid: 1 }),
    checkIntervalSeconds: integer("check_interval_seconds").notNull().default(15),
    executionWindowSeconds: integer("execution_window_seconds").notNull().default(10),
    resultExpirySeconds: integer("result_expiry_seconds").notNull().default(60),
    successThreshold: integer("success_threshold").notNull().default(3),
    failureThreshold: integer("failure_threshold").notNull().default(3),
    networkPolicy: jsonb("network_policy").$type<ProbeTask["networkPolicy"]>(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [
    check("address_health_policy_target", sql`num_nonnulls(${t.slotId}, ${t.endpointId}) = 1`),
    check("address_health_policy_mode", sql`${t.mode} in ('local', 'external', 'mixed')`),
    check("address_health_policy_bounds", sql`${t.revision} > 0 and ${t.successThreshold} > 0 and ${t.failureThreshold} > 0 and ${t.executionWindowSeconds} > 0 and ${t.checkIntervalSeconds} >= ${t.executionWindowSeconds} and ${t.resultExpirySeconds} >= ${t.executionWindowSeconds}`),
    uniqueIndex("address_health_policy_slot_unique").on(t.slotId),
    uniqueIndex("address_health_policy_endpoint_family_unique").on(t.endpointId, t.family),
  ]);
  // Deliberately no config/round/address FK: evidence identity and replay fence survive retention.
  const addressHealthStates = pgTable("address_health_states", {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id").references(dependencies.slotId, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").references(dependencies.endpointId, { onDelete: "cascade" }),
    family: addressFamilyEnum("family").notNull(),
    addressId: uuid("address_id"),
    addressVersion: integer("address_version").notNull().default(0),
    configId: uuid("config_id"),
    configVersion: integer("config_version").notNull().default(0),
    policyId: uuid("policy_id"),
    policyRevision: integer("policy_revision").notNull().default(0),
    groupRevision: integer("group_revision"),
    healthState: varchar("health_state", { length: 16 }).$type<"unknown" | "healthy" | "unhealthy" | "degraded" | "recovering">().notNull().default("unknown"),
    consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastAppliedSequence: integer("last_applied_sequence").notNull().default(0),
    lastRoundId: uuid("last_round_id"),
    latestDecision: varchar("latest_decision", { length: 16 }).$type<"success" | "failure" | "unknown">().notNull().default("unknown"),
    evidenceExpiresAt: time("evidence_expires_at"),
    lastCheckedAt: time("last_checked_at"),
    nextRoundAt: time("next_round_at"),
    stateChangedAt: time("state_changed_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [
    check("address_health_state_target", sql`num_nonnulls(${t.slotId}, ${t.endpointId}) = 1`),
    check("address_health_state_counters", sql`${t.addressVersion} >= 0 and ${t.lastAppliedSequence} >= 0 and ${t.consecutiveSuccesses} >= 0 and ${t.consecutiveFailures} >= 0`),
    uniqueIndex("address_health_state_slot_unique").on(t.slotId),
    uniqueIndex("address_health_state_endpoint_family_unique").on(t.endpointId, t.family),
  ]);
  const probeRounds = pgTable("probe_rounds", {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id").references(dependencies.slotId, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").references(dependencies.endpointId, { onDelete: "cascade" }),
    endpointAddressId: uuid("endpoint_address_id").references(dependencies.endpointAddressId, { onDelete: "cascade" }),
    configId: uuid("config_id").notNull().references(dependencies.configId, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => probeGroups.id, { onDelete: "set null" }),
    groupRevision: integer("group_revision"),
    policyId: uuid("policy_id"),
    policyRevision: integer("policy_revision"),
    localOutcome: varchar("local_outcome", { length: 16 }).$type<"success" | "failure" | "unavailable">(),
    localReceivedAt: time("local_received_at"),
    sequence: integer("sequence").notNull(),
    addressVersion: integer("address_version").notNull(),
    configVersion: integer("config_version").notNull(),
    address: varchar("address", { length: 45 }).notNull(),
    family: addressFamilyEnum("family").notNull(),
    hostname: varchar("hostname", { length: 255 }),
    config: jsonb("config").$type<ProbeTask["config"]>().notNull(),
    networkPolicy: jsonb("network_policy").$type<ProbeTask["networkPolicy"]>(),
    memberIds: jsonb("member_ids").$type<string[]>().notNull(),
    consensus: jsonb("consensus").$type<ConsensusPolicy>().notNull(),
    deadline: time("deadline").notNull(),
    resultExpiresAt: time("result_expires_at").notNull(),
    status: varchar("status", { length: 16 }).$type<"pending" | "completed" | "superseded">().notNull().default("pending"),
    consensusResult: varchar("consensus_result", { length: 16 }).$type<"success" | "failure" | "unknown">(),
    finalizedAt: time("finalized_at"),
    appliedAt: time("applied_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [
    check("probe_rounds_target", sql`(${t.slotId} is not null and ${t.endpointId} is null and ${t.endpointAddressId} is null) or (${t.slotId} is null and ${t.endpointId} is not null and ${t.endpointAddressId} is not null)`),
    check("probe_rounds_versions", sql`${t.addressVersion} > 0 and ${t.configVersion} > 0 and ${t.sequence} > 0`),
    check("probe_rounds_status", sql`${t.status} in ('pending', 'completed', 'superseded')`),
    check("probe_rounds_deadlines", sql`${t.resultExpiresAt} >= ${t.deadline}`),
    uniqueIndex("probe_rounds_slot_sequence_unique").on(t.slotId, t.sequence).where(sql`${t.slotId} is not null`),
    uniqueIndex("probe_rounds_endpoint_sequence_unique").on(t.endpointId, t.family, t.sequence).where(sql`${t.endpointId} is not null`),
    index("probe_rounds_pending_idx").on(t.status, t.deadline),
  ]);
  const probeTasks = pgTable("probe_tasks", {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id").notNull().references(() => probeRounds.id, { onDelete: "cascade" }),
    probeId: uuid("probe_id").notNull().references(() => probeAgents.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 }).$type<"pending" | "leased" | "accepted" | "stale">().notNull().default("pending"),
    leaseId: uuid("lease_id"),
    leaseDeadline: time("lease_deadline"),
    leasedAt: time("leased_at"),
    finishedAt: time("finished_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  }, t => [uniqueIndex("probe_tasks_round_probe_unique").on(t.roundId, t.probeId), index("probe_tasks_pending_idx").on(t.probeId, t.status), check("probe_tasks_status", sql`${t.status} in ('pending', 'leased', 'accepted', 'stale')`)]);
  const probeObservations = pgTable("probe_observations", {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().unique().references(() => probeTasks.id, { onDelete: "cascade" }),
    roundId: uuid("round_id").notNull().references(() => probeRounds.id, { onDelete: "cascade" }),
    probeId: uuid("probe_id").notNull().references(() => probeAgents.id, { onDelete: "restrict" }),
    leaseId: uuid("lease_id").notNull(),
    addressVersion: integer("address_version").notNull(),
    configVersion: integer("config_version").notNull(),
    status: varchar("status", { length: 16 }).$type<"accepted" | "stale">().notNull(),
    outcome: varchar("outcome", { length: 16 }).$type<ProbeResult["outcome"]>().notNull(),
    latencyMs: real("latency_ms").notNull(),
    statusCode: integer("status_code"),
    errorCode: varchar("error_code", { length: 128 }),
    measuredAt: time("measured_at").notNull(),
    receivedAt: time("received_at").notNull().defaultNow(),
  }, t => [index("probe_observations_round_idx").on(t.roundId), check("probe_observations_status", sql`${t.status} in ('accepted', 'stale')`), check("probe_observations_outcome", sql`${t.outcome} in ('success', 'failure', 'unavailable')`)]);
  const probeObservationStats = pgTable("probe_observation_stats", {
    id: uuid("id").primaryKey().defaultRandom(),
    targetKey: varchar("target_key", { length: 80 }).notNull(),
    probeId: varchar("probe_id", { length: 40 }).notNull(),
    family: addressFamilyEnum("family").notNull(),
    period: varchar("period", { length: 8 }).$type<"hour" | "day">().notNull(),
    bucketStart: time("bucket_start").notNull(),
    sampleCount: integer("sample_count").notNull(),
    successCount: integer("success_count").notNull(),
    unavailableCount: integer("unavailable_count").notNull(),
    averageLatencyMs: real("average_latency_ms"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  }, t => [uniqueIndex("probe_observation_stats_bucket_unique").on(t.targetKey, t.probeId, t.family, t.period, t.bucketStart)]);
  return { probeObservationStats, addressHealthPolicies, addressHealthStates, probeAgents, probeTokens, probeGroups, probeGroupMembers, probeRoundSequences, probeRounds, probeTasks, probeObservations };
}
