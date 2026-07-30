import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const userRoleEnum = pgEnum("user_role", ["admin", "user"]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);
export const providerTypeEnum = pgEnum("provider_type", ["cloudflare", "aliyun"]);
export const resourceStatusEnum = pgEnum("resource_status", ["active", "disabled", "error"]);
export const recordManagementEnum = pgEnum("record_management", ["unmanaged", "managed"]);
export const poolStrategyEnum = pgEnum("pool_strategy", ["primary_backup", "healthy_set", "assignment_pool"]);
export const selectionModeEnum = pgEnum("selection_mode", ["random", "ordered", "round_robin", "least_assigned"]);
export const recoveryModeEnum = pgEnum("recovery_mode", ["automatic", "keep_current", "manual", "delayed"]);
export const endpointAddressModeEnum = pgEnum("endpoint_address_mode", ["static", "ddns"]);
export const endpointLifecycleEnum = pgEnum("endpoint_lifecycle", ["enabled", "disabled", "maintenance", "draining"]);
export const addressFamilyEnum = pgEnum("address_family", ["4", "6"]);
export const addressStateEnum = pgEnum("address_state", ["candidate", "current", "previous"]);
export const healthStateEnum = pgEnum("health_state", ["unknown", "healthy", "degraded", "unhealthy", "recovering"]);
export const healthStatPeriodEnum = pgEnum("health_stat_period", ["hour", "day"]);
export const bindingStateEnum = pgEnum("binding_state", ["healthy", "switching", "failed", "drifted"]);
export const operationSourceEnum = pgEnum("operation_source", ["user", "failover", "recovery", "ddns", "drift", "sync", "rollback"]);
export const operationStatusEnum = pgEnum("operation_status", ["pending", "running", "succeeded", "partial", "failed", "superseded"]);
export const operationStepStatusEnum = pgEnum("operation_step_status", ["pending", "running", "succeeded", "failed", "skipped"]);
export const operationActionEnum = pgEnum("operation_action", ["create", "update", "delete"]);
export const notificationTypeEnum = pgEnum("notification_type", ["webhook", "telegram"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["pending", "delivered", "retrying", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 80 }).notNull(),
  email: varchar("email", { length: 320 }),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  status: userStatusEnum("status").notNull().default("active"),
  sessionVersion: integer("session_version").notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex("users_username_lower_unique").on(sql`lower(${table.username})`),
  uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`).where(sql`${table.email} is not null`),
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  sessionVersion: integer("session_version").notNull(),
  userAgent: varchar("user_agent", { length: 512 }),
  ipAddress: varchar("ip_address", { length: 64 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sessions_user_id_idx").on(table.userId), index("sessions_expires_at_idx").on(table.expiresAt)]);

export const providerAccounts = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: providerTypeEnum("provider").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  credentialCiphertext: text("credential_ciphertext").notNull(),
  credentialIv: varchar("credential_iv", { length: 64 }).notNull(),
  credentialTag: varchar("credential_tag", { length: 64 }).notNull(),
  credentialKeyVersion: integer("credential_key_version").notNull().default(1),
  credentialHint: varchar("credential_hint", { length: 120 }),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  status: resourceStatusEnum("status").notNull().default("active"),
  errorCode: varchar("error_code", { length: 80 }),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [index("provider_accounts_owner_idx").on(table.ownerUserId)]);

export const zones = pgTable("zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerAccountId: uuid("provider_account_id").notNull().references(() => providerAccounts.id, { onDelete: "cascade" }),
  externalId: varchar("external_id", { length: 255 }).notNull(),
  nameAscii: varchar("name_ascii", { length: 255 }).notNull(),
  nameUnicode: varchar("name_unicode", { length: 255 }),
  status: resourceStatusEnum("status").notNull().default("active"),
  providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>().notNull().default({}),
  remoteHash: varchar("remote_hash", { length: 64 }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("zones_account_external_unique").on(table.providerAccountId, table.externalId),
  index("zones_name_idx").on(table.nameAscii),
]);

export const endpointPools = pgTable("endpoint_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  strategy: poolStrategyEnum("strategy").notNull(),
  selectionMode: selectionModeEnum("selection_mode").notNull().default("ordered"),
  recoveryMode: recoveryModeEnum("recovery_mode").notNull().default("keep_current"),
  recoveryDelaySeconds: integer("recovery_delay_seconds").notNull().default(0),
  failureThreshold: integer("failure_threshold").notNull().default(3),
  successThreshold: integer("success_threshold").notNull().default(3),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(15),
  checkTimeoutMs: integer("check_timeout_ms").notNull().default(3000),
  switchCooldownSeconds: integer("switch_cooldown_seconds").notNull().default(300),
  allDownReminderSeconds: integer("all_down_reminder_seconds").notNull().default(1800),
  state: healthStateEnum("state").notNull().default("unknown"),
  policyRevision: integer("policy_revision").notNull().default(1),
  decisionRevision: integer("decision_revision").notNull().default(0),
  roundRobinCursor: uuid("round_robin_cursor"),
  roundRobinCursors: jsonb("round_robin_cursors").$type<Record<string, string>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("endpoint_pools_owner_idx").on(table.ownerUserId),
  check("pool_thresholds_positive", sql`${table.failureThreshold} > 0 and ${table.successThreshold} > 0`),
  check("pool_check_interval_valid", sql`${table.checkIntervalSeconds} >= 5`),
  check("pool_reminder_interval_valid", sql`${table.allDownReminderSeconds} >= 60`),
]);

export const endpoints = pgTable("endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  poolId: uuid("pool_id").notNull().references(() => endpointPools.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  addressMode: endpointAddressModeEnum("address_mode").notNull().default("static"),
  priority: integer("priority").notNull().default(100),
  lifecycle: endpointLifecycleEnum("lifecycle").notNull().default("enabled"),
  healthState: healthStateEnum("health_state").notNull().default("unknown"),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (table) => [uniqueIndex("endpoints_pool_name_unique").on(table.poolId, table.name), index("endpoints_pool_idx").on(table.poolId)]);

export const endpointAddresses = pgTable("endpoint_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id, { onDelete: "cascade" }),
  family: addressFamilyEnum("family").notNull(),
  address: varchar("address", { length: 45 }).notNull(),
  state: addressStateEnum("state").notNull(),
  source: endpointAddressModeEnum("source").notNull(),
  healthState: healthStateEnum("health_state").notNull().default("unknown"),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  replacedAt: timestamp("replaced_at", { withTimezone: true }),
}, (table) => [
  index("endpoint_addresses_endpoint_idx").on(table.endpointId),
  uniqueIndex("endpoint_addresses_active_family_unique").on(table.endpointId, table.family, table.state).where(sql`${table.state} in ('candidate', 'current')`),
]);

export const domainBindings = pgTable("domain_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  poolId: uuid("pool_id").notNull().references(() => endpointPools.id, { onDelete: "cascade" }),
  zoneId: uuid("zone_id").notNull().references(() => zones.id, { onDelete: "restrict" }),
  fqdn: varchar("fqdn", { length: 255 }).notNull(),
  recordType: varchar("record_type", { length: 16 }).notNull(),
  ttl: integer("ttl").notNull().default(60),
  providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>().notNull().default({}),
  originalEndpointId: uuid("original_endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
  desiredRevision: integer("desired_revision").notNull().default(1),
  state: bindingStateEnum("state").notNull().default("healthy"),
  ...timestamps,
}, (table) => [
  uniqueIndex("domain_bindings_pool_fqdn_type_unique").on(table.poolId, table.fqdn, table.recordType),
  uniqueIndex("domain_bindings_zone_fqdn_type_unique").on(table.zoneId, table.fqdn, table.recordType),
  index("domain_bindings_zone_idx").on(table.zoneId),
  check("domain_bindings_address_type", sql`${table.recordType} in ('A', 'AAAA')`),
]);

export const dnsRecords = pgTable("dns_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: uuid("zone_id").notNull().references(() => zones.id, { onDelete: "cascade" }),
  externalId: varchar("external_id", { length: 255 }).notNull(),
  type: varchar("type", { length: 16 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  content: text("content").notNull(),
  ttl: integer("ttl").notNull(),
  priority: integer("priority"),
  providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>().notNull().default({}),
  management: recordManagementEnum("management").notNull().default("unmanaged"),
  managedByPoolId: uuid("managed_by_pool_id").references(() => endpointPools.id, { onDelete: "set null" }),
  remoteHash: varchar("remote_hash", { length: 64 }).notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("dns_records_zone_external_unique").on(table.zoneId, table.externalId),
  index("dns_records_lookup_idx").on(table.zoneId, table.name, table.type),
  check("dns_records_managed_pool", sql`${table.management} = 'unmanaged' or ${table.managedByPoolId} is not null`),
]);

export const bindingAssignments = pgTable("binding_assignments", {
  domainBindingId: uuid("domain_binding_id").notNull().references(() => domainBindings.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id, { onDelete: "restrict" }),
  dnsRecordId: uuid("dns_record_id").references(() => dnsRecords.id, { onDelete: "set null" }),
  desired: boolean("desired").notNull().default(false),
  applied: boolean("applied").notNull().default(false),
  reason: varchar("reason", { length: 80 }).notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.domainBindingId, table.endpointId] }), index("binding_assignments_endpoint_idx").on(table.endpointId)]);

export const healthCheckConfigs = pgTable("health_check_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  poolId: uuid("pool_id").references(() => endpointPools.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "cascade" }),
  domainBindingId: uuid("domain_binding_id").references(() => domainBindings.id, { onDelete: "cascade" }),
  checkerType: varchar("checker_type", { length: 40 }).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
}, (table) => [
  check("health_check_exactly_one_scope", sql`num_nonnulls(${table.poolId}, ${table.endpointId}, ${table.domainBindingId}) = 1`),
  index("health_check_pool_idx").on(table.poolId),
  index("health_check_endpoint_idx").on(table.endpointId),
  uniqueIndex("health_check_one_active_pool_unique").on(table.poolId).where(sql`${table.poolId} is not null and ${table.enabled} = true`),
  uniqueIndex("health_check_one_active_endpoint_unique").on(table.endpointId).where(sql`${table.endpointId} is not null and ${table.enabled} = true`),
  uniqueIndex("health_check_one_active_binding_unique").on(table.domainBindingId).where(sql`${table.domainBindingId} is not null and ${table.enabled} = true`),
]);

export const healthCheckResults = pgTable("health_check_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  configId: uuid("config_id").notNull().references(() => healthCheckConfigs.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id, { onDelete: "cascade" }),
  endpointAddressId: uuid("endpoint_address_id").references(() => endpointAddresses.id, { onDelete: "set null" }),
  domainBindingId: uuid("domain_binding_id").references(() => domainBindings.id, { onDelete: "cascade" }),
  probeId: varchar("probe_id", { length: 120 }),
  success: boolean("success").notNull(),
  latencyMs: real("latency_ms").notNull(),
  statusCode: integer("status_code"),
  errorCode: varchar("error_code", { length: 100 }),
  errorDetail: varchar("error_detail", { length: 512 }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("health_results_endpoint_time_idx").on(table.endpointId, table.checkedAt),
  index("health_results_address_time_idx").on(table.endpointAddressId, table.checkedAt),
  index("health_results_binding_time_idx").on(table.domainBindingId, table.checkedAt),
]);

export const healthCheckStats = pgTable("health_check_stats", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id, { onDelete: "cascade" }),
  domainBindingId: uuid("domain_binding_id").references(() => domainBindings.id, { onDelete: "cascade" }),
  scopeKey: varchar("scope_key", { length: 64 }).notNull(),
  period: healthStatPeriodEnum("period").notNull(),
  bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
  sampleCount: integer("sample_count").notNull(),
  successCount: integer("success_count").notNull(),
  averageLatencyMs: real("average_latency_ms").notNull(),
  minimumLatencyMs: real("minimum_latency_ms").notNull(),
  maximumLatencyMs: real("maximum_latency_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("health_stats_scope_period_bucket_unique").on(table.endpointId, table.scopeKey, table.period, table.bucketStart),
  index("health_stats_endpoint_time_idx").on(table.endpointId, table.period, table.bucketStart),
]);

export const bindingEndpointHealth = pgTable("binding_endpoint_health", {
  domainBindingId: uuid("domain_binding_id").notNull().references(() => domainBindings.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull().references(() => endpoints.id, { onDelete: "cascade" }),
  endpointAddressId: uuid("endpoint_address_id").references(() => endpointAddresses.id, { onDelete: "set null" }),
  healthState: healthStateEnum("health_state").notNull().default("unknown"),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.domainBindingId, table.endpointId] }),
  index("binding_endpoint_health_endpoint_idx").on(table.endpointId),
]);

export const ddnsAgents = pgTable("ddns_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id").notNull().unique().references(() => endpoints.id, { onDelete: "cascade" }),
  installTokenHash: varchar("install_token_hash", { length: 64 }),
  installTokenExpiresAt: timestamp("install_token_expires_at", { withTimezone: true }),
  installTokenUsedAt: timestamp("install_token_used_at", { withTimezone: true }),
  runtimeTokenHash: varchar("runtime_token_hash", { length: 64 }),
  previousRuntimeTokenHash: varchar("previous_runtime_token_hash", { length: 64 }),
  previousRuntimeTokenExpiresAt: timestamp("previous_runtime_token_expires_at", { withTimezone: true }),
  agentVersion: varchar("agent_version", { length: 40 }),
  hostname: varchar("hostname", { length: 255 }),
  status: resourceStatusEnum("status").notNull().default("active"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastIpChangedAt: timestamp("last_ip_changed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps,
});

export const operations = pgTable("operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  source: operationSourceEnum("source").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull().unique(),
  resourceType: varchar("resource_type", { length: 80 }).notNull(),
  resourceId: uuid("resource_id"),
  policyRevision: integer("policy_revision"),
  decisionRevision: integer("decision_revision"),
  status: operationStatusEnum("status").notNull().default("pending"),
  beforeSnapshot: jsonb("before_snapshot").$type<unknown>(),
  desiredSnapshot: jsonb("desired_snapshot").$type<unknown>(),
  errorCode: varchar("error_code", { length: 100 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [index("operations_owner_time_idx").on(table.ownerUserId, table.createdAt), index("operations_status_idx").on(table.status)]);

export const operationSteps = pgTable("operation_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  providerAccountId: uuid("provider_account_id").notNull().references(() => providerAccounts.id, { onDelete: "restrict" }),
  zoneId: uuid("zone_id").notNull().references(() => zones.id, { onDelete: "restrict" }),
  dnsRecordId: uuid("dns_record_id").references(() => dnsRecords.id, { onDelete: "set null" }),
  action: operationActionEnum("action").notNull(),
  status: operationStepStatusEnum("status").notNull().default("pending"),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  remoteSnapshot: jsonb("remote_snapshot").$type<unknown>(),
  attempts: integer("attempts").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  errorCode: varchar("error_code", { length: 100 }),
  errorDetail: varchar("error_detail", { length: 512 }),
  remoteRequestId: varchar("remote_request_id", { length: 255 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("operation_steps_sequence_unique").on(table.operationId, table.sequence), index("operation_steps_retry_idx").on(table.status, table.nextRetryAt)]);

export const policyVersions = pgTable("policy_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  poolId: uuid("pool_id").notNull().references(() => endpointPools.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  reason: varchar("reason", { length: 255 }).notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("policy_versions_pool_version_unique").on(table.poolId, table.version)]);

export const failoverEvents = pgTable("failover_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  poolId: uuid("pool_id").notNull().references(() => endpointPools.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
  operationId: uuid("operation_id").references(() => operations.id, { onDelete: "set null" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  decision: jsonb("decision").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("failover_events_pool_time_idx").on(table.poolId, table.createdAt)]);

export const reconcileIntents = pgTable("reconcile_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().unique(),
  poolId: uuid("pool_id").notNull().references(() => endpointPools.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
  decisionRevision: integer("decision_revision").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  trigger: varchar("trigger", { length: 32 }).$type<"failure" | "recovery" | "rebalance" | "configuration" | "repair">().notNull(),
  source: operationSourceEnum("source").notNull(),
  force: boolean("force").notNull().default(false),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("reconcile_intents_pool_revision_unique").on(table.poolId, table.decisionRevision),
  index("reconcile_intents_pending_idx").on(table.completedAt, table.availableAt),
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  source: operationSourceEnum("source").notNull(),
  action: varchar("action", { length: 120 }).notNull(),
  resourceType: varchar("resource_type", { length: 80 }).notNull(),
  resourceId: uuid("resource_id"),
  beforeSnapshot: jsonb("before_snapshot").$type<unknown>(),
  afterSnapshot: jsonb("after_snapshot").$type<unknown>(),
  requestId: varchar("request_id", { length: 120 }),
  eventId: varchar("event_id", { length: 120 }),
  operationId: uuid("operation_id").references(() => operations.id, { onDelete: "set null" }),
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: varchar("user_agent", { length: 512 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_logs_owner_time_idx").on(table.ownerUserId, table.createdAt)]);

export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: notificationTypeEnum("type").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  endpoint: text("endpoint"),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretIv: varchar("secret_iv", { length: 64 }).notNull(),
  secretTag: varchar("secret_tag", { length: 64 }).notNull(),
  secretKeyVersion: integer("secret_key_version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps,
}, (table) => [index("notification_channels_owner_idx").on(table.ownerUserId)]);

export const poolNotificationChannels = pgTable("pool_notification_channels", {
  poolId: uuid("pool_id").notNull().references(() => endpointPools.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => notificationChannels.id, { onDelete: "cascade" }),
  eventFilter: jsonb("event_filter").$type<string[]>().notNull().default([]),
  overridesDefaults: boolean("overrides_defaults").notNull().default(false),
}, (table) => [primaryKey({ columns: [table.poolId, table.channelId] })]);

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 120 }).notNull(),
  channelId: uuid("channel_id").notNull().references(() => notificationChannels.id, { onDelete: "cascade" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: deliveryStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  durationMs: integer("duration_ms"),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  responseStatus: integer("response_status"),
  responseExcerpt: varchar("response_excerpt", { length: 512 }),
  errorCode: varchar("error_code", { length: 100 }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("notification_event_channel_unique").on(table.eventId, table.channelId), index("notification_retry_idx").on(table.status, table.nextRetryAt)]);
