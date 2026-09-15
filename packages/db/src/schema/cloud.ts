import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const cloudProviderEnum = pgEnum("cloud_provider", ["aws"]);
export const cloudServiceEnum = pgEnum("cloud_service", ["ec2", "lightsail"]);
export const cloudAddressKindEnum = pgEnum("cloud_address_kind", ["host", "prefix"]);
export const cloudAddressOriginEnum = pgEnum("cloud_address_origin", ["user", "system"]);
export const endpointAddressModeEnum = pgEnum("endpoint_address_mode", ["static", "ddns", "cloud"]);
export const addressFamilyEnum = pgEnum("address_family", ["4", "6"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

type CloudSchemaDependencies = {
  userId: () => AnyPgColumn;
  endpointId: () => AnyPgColumn;
};

export function defineCloudSchema(dependencies: CloudSchemaDependencies) {
  const cloudApiRequests = pgTable("cloud_api_requests", {
    key: varchar("key", { length: 255 }).notNull(),
    actorUserId: uuid("actor_user_id").notNull().references(dependencies.userId, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").notNull().references(dependencies.userId, { onDelete: "cascade" }),
    action: varchar("action", { length: 40 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    response: jsonb("response").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  }, (table) => [primaryKey({ columns: [table.actorUserId, table.key] })]);

  const cloudAccounts = pgTable("cloud_accounts", {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(dependencies.userId, { onDelete: "cascade" }),
    provider: cloudProviderEnum("provider").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    regions: jsonb("regions").$type<string[] | null>(),
    externalAccountId: varchar("external_account_id", { length: 32 }),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    credentialIv: varchar("credential_iv", { length: 64 }).notNull(),
    credentialTag: varchar("credential_tag", { length: 64 }).notNull(),
    credentialKeyVersion: integer("credential_key_version").notNull().default(1),
    credentialHint: varchar("credential_hint", { length: 120 }),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  }, (table) => [index("cloud_accounts_owner_idx").on(table.ownerUserId)]);

  const cloudScanScopes = pgTable("cloud_scan_scopes", {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => cloudAccounts.id, { onDelete: "cascade" }),
    service: cloudServiceEnum("service").notNull(),
    region: varchar("region", { length: 80 }).notNull(),
    generation: integer("generation").notNull().default(0),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  }, (table) => [
    uniqueIndex("cloud_scan_scopes_identity_unique").on(table.accountId, table.service, table.region),
    check("cloud_scan_scopes_generation_nonnegative", sql`${table.generation} >= 0`),
  ]);

  const cloudInstances = pgTable("cloud_instances", {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => cloudAccounts.id, { onDelete: "cascade" }),
    service: cloudServiceEnum("service").notNull(),
    region: varchar("region", { length: 80 }).notNull(),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }),
    state: varchar("state", { length: 80 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    scanGeneration: integer("scan_generation").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  }, (table) => [
    uniqueIndex("cloud_instances_identity_unique").on(table.accountId, table.service, table.region, table.externalId),
    index("cloud_instances_scan_idx").on(table.accountId, table.service, table.region, table.scanGeneration),
    check("cloud_instances_scan_generation_positive", sql`${table.scanGeneration} > 0`),
  ]);

  const cloudInterfaces = pgTable("cloud_interfaces", {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").notNull().references(() => cloudInstances.id, { onDelete: "cascade" }),
    externalId: varchar("external_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    scanGeneration: integer("scan_generation").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  }, (table) => [
    uniqueIndex("cloud_interfaces_identity_unique").on(table.instanceId, table.externalId),
    check("cloud_interfaces_scan_generation_positive", sql`${table.scanGeneration} > 0`),
  ]);

  const cloudAddresses = pgTable("cloud_addresses", {
    id: uuid("id").primaryKey().defaultRandom(),
    interfaceId: uuid("interface_id").notNull().references(() => cloudInterfaces.id, { onDelete: "cascade" }),
    kind: cloudAddressKindEnum("kind").notNull(),
    family: addressFamilyEnum("family").notNull(),
    address: varchar("address", { length: 45 }).notNull(),
    prefixLength: integer("prefix_length"),
    remoteAllocationId: varchar("remote_allocation_id", { length: 255 }),
    origin: cloudAddressOriginEnum("origin").notNull(),
    attemptId: uuid("attempt_id"),
    scanGeneration: integer("scan_generation").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  }, (table) => [
    uniqueIndex("cloud_addresses_host_identity_unique").on(table.interfaceId, table.family, table.address).where(sql`${table.kind} = 'host'`),
    uniqueIndex("cloud_addresses_prefix_identity_unique").on(table.interfaceId, table.family, table.address, table.prefixLength).where(sql`${table.kind} = 'prefix'`),
    uniqueIndex("cloud_addresses_slot_reference_unique").on(table.id, table.interfaceId, table.family, table.kind),
    check("cloud_addresses_family_valid", sql`${table.family} in ('4', '6')`),
    check("cloud_addresses_prefix_shape", sql`(${table.kind} = 'host' and ${table.prefixLength} is null) or (${table.kind} = 'prefix' and ${table.prefixLength} is not null)`),
    check("cloud_addresses_prefix_length_valid", sql`${table.prefixLength} is null or (${table.family} = '4' and ${table.prefixLength} between 0 and 32) or (${table.family} = '6' and ${table.prefixLength} between 0 and 128)`),
    check("cloud_addresses_scan_generation_positive", sql`${table.scanGeneration} > 0`),
  ]);

  const managedAddressSlots = pgTable("managed_address_slots", {
    id: uuid("id").primaryKey().defaultRandom(),
    interfaceId: uuid("interface_id").notNull().references(() => cloudInterfaces.id, { onDelete: "cascade" }),
    family: addressFamilyEnum("family").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    currentAddressId: uuid("current_address_id"),
    currentAddressKind: cloudAddressKindEnum("current_address_kind").notNull().default("host"),
    currentVersion: integer("current_version").notNull().default(0),
    candidateAddressId: uuid("candidate_address_id"),
    candidateAddressKind: cloudAddressKindEnum("candidate_address_kind").notNull().default("host"),
    candidateVersion: integer("candidate_version").notNull().default(0),
    ...timestamps,
  }, (table) => [
    uniqueIndex("managed_address_slots_name_unique").on(table.interfaceId, table.family, table.name),
    uniqueIndex("managed_address_slots_id_family_unique").on(table.id, table.family),
    foreignKey({
      columns: [table.currentAddressId, table.interfaceId, table.family, table.currentAddressKind],
      foreignColumns: [cloudAddresses.id, cloudAddresses.interfaceId, cloudAddresses.family, cloudAddresses.kind],
      name: "managed_slots_current_host_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.candidateAddressId, table.interfaceId, table.family, table.candidateAddressKind],
      foreignColumns: [cloudAddresses.id, cloudAddresses.interfaceId, cloudAddresses.family, cloudAddresses.kind],
      name: "managed_slots_candidate_host_fk",
    }).onDelete("restrict"),
    check("managed_address_slots_family_valid", sql`${table.family} in ('4', '6')`),
    check("managed_address_slots_host_only", sql`${table.currentAddressKind} = 'host' and ${table.candidateAddressKind} = 'host'`),
    check("managed_address_slots_versions_nonnegative", sql`${table.currentVersion} >= 0 and ${table.candidateVersion} >= 0`),
  ]);

  const instanceAuthorizations = pgTable("instance_authorizations", {
    instanceId: uuid("instance_id").primaryKey().references(() => cloudInstances.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    managed: boolean("managed").notNull().default(false),
    allowIpv4Rotation: boolean("allow_ipv4_rotation").notNull().default(false),
    allowIpv6Rotation: boolean("allow_ipv6_rotation").notNull().default(false),
    allowStopStart: boolean("allow_stop_start").notNull().default(false),
    allowReleaseAddress: boolean("allow_release_address").notNull().default(false),
    updatedByUserId: uuid("updated_by_user_id").references(dependencies.userId, { onDelete: "set null" }),
    ...timestamps,
  }, (table) => [check("instance_authorizations_revision_positive", sql`${table.revision} > 0`)]);

  const cloudEndpointLinks = pgTable("cloud_endpoint_links", {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id").notNull().references(dependencies.endpointId, { onDelete: "cascade" }),
    family: addressFamilyEnum("family").notNull(),
    slotId: uuid("slot_id").notNull(),
    ...timestamps,
  }, (table) => [
    uniqueIndex("cloud_endpoint_links_endpoint_family_unique").on(table.endpointId, table.family),
    foreignKey({ columns: [table.slotId, table.family], foreignColumns: [managedAddressSlots.id, managedAddressSlots.family], name: "cloud_endpoint_links_slot_family_fk" }).onDelete("restrict"),
    check("cloud_endpoint_links_family_valid", sql`${table.family} in ('4', '6')`),
  ]);

  return { cloudApiRequests, cloudAccounts, cloudScanScopes, cloudInstances, cloudInterfaces, cloudAddresses, managedAddressSlots, instanceAuthorizations, cloudEndpointLinks };
}
