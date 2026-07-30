CREATE TYPE "public"."address_family" AS ENUM('4', '6');--> statement-breakpoint
CREATE TYPE "public"."address_state" AS ENUM('candidate', 'current', 'previous');--> statement-breakpoint
CREATE TYPE "public"."binding_state" AS ENUM('healthy', 'switching', 'failed', 'drifted');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'delivered', 'retrying', 'failed');--> statement-breakpoint
CREATE TYPE "public"."endpoint_address_mode" AS ENUM('static', 'ddns');--> statement-breakpoint
CREATE TYPE "public"."endpoint_lifecycle" AS ENUM('enabled', 'disabled', 'maintenance', 'draining');--> statement-breakpoint
CREATE TYPE "public"."health_state" AS ENUM('unknown', 'healthy', 'degraded', 'unhealthy', 'recovering');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('webhook', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."operation_action" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."operation_source" AS ENUM('user', 'failover', 'recovery', 'ddns', 'drift', 'sync', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('pending', 'running', 'succeeded', 'partial', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."operation_step_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."pool_strategy" AS ENUM('primary_backup', 'healthy_set', 'assignment_pool');--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('cloudflare', 'aliyun');--> statement-breakpoint
CREATE TYPE "public"."record_management" AS ENUM('unmanaged', 'managed');--> statement-breakpoint
CREATE TYPE "public"."recovery_mode" AS ENUM('automatic', 'keep_current', 'manual', 'delayed');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('active', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."selection_mode" AS ENUM('random', 'ordered', 'round_robin', 'least_assigned');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"source" "operation_source" NOT NULL,
	"action" varchar(120) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"resource_id" uuid,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"request_id" varchar(120),
	"event_id" varchar(120),
	"operation_id" uuid,
	"ip_address" varchar(64),
	"user_agent" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "binding_assignments" (
	"domain_binding_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"dns_record_id" uuid,
	"desired" boolean DEFAULT false NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"reason" varchar(80) NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_assignments_domain_binding_id_endpoint_id_pk" PRIMARY KEY("domain_binding_id","endpoint_id")
);
--> statement-breakpoint
CREATE TABLE "ddns_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"install_token_hash" varchar(64),
	"install_token_expires_at" timestamp with time zone,
	"install_token_used_at" timestamp with time zone,
	"runtime_token_hash" varchar(64),
	"agent_version" varchar(40),
	"hostname" varchar(255),
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_ip_changed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ddns_agents_endpoint_id_unique" UNIQUE("endpoint_id")
);
--> statement-breakpoint
CREATE TABLE "dns_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"type" varchar(16) NOT NULL,
	"name" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"ttl" integer NOT NULL,
	"priority" integer,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"management" "record_management" DEFAULT 'unmanaged' NOT NULL,
	"managed_by_pool_id" uuid,
	"remote_hash" varchar(64) NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_records_managed_pool" CHECK ("dns_records"."management" = 'unmanaged' or "dns_records"."managed_by_pool_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "domain_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"fqdn" varchar(255) NOT NULL,
	"record_type" varchar(16) NOT NULL,
	"ttl" integer DEFAULT 60 NOT NULL,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_endpoint_id" uuid,
	"desired_revision" integer DEFAULT 1 NOT NULL,
	"state" "binding_state" DEFAULT 'healthy' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_bindings_address_type" CHECK ("domain_bindings"."record_type" in ('A', 'AAAA'))
);
--> statement-breakpoint
CREATE TABLE "endpoint_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"family" "address_family" NOT NULL,
	"address" varchar(45) NOT NULL,
	"state" "address_state" NOT NULL,
	"source" "endpoint_address_mode" NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"replaced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "endpoint_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"strategy" "pool_strategy" NOT NULL,
	"selection_mode" "selection_mode" DEFAULT 'ordered' NOT NULL,
	"recovery_mode" "recovery_mode" DEFAULT 'keep_current' NOT NULL,
	"recovery_delay_seconds" integer DEFAULT 0 NOT NULL,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"success_threshold" integer DEFAULT 3 NOT NULL,
	"check_interval_seconds" integer DEFAULT 15 NOT NULL,
	"check_timeout_ms" integer DEFAULT 3000 NOT NULL,
	"switch_cooldown_seconds" integer DEFAULT 300 NOT NULL,
	"state" "health_state" DEFAULT 'unknown' NOT NULL,
	"policy_revision" integer DEFAULT 1 NOT NULL,
	"round_robin_cursor" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_thresholds_positive" CHECK ("endpoint_pools"."failure_threshold" > 0 and "endpoint_pools"."success_threshold" > 0),
	CONSTRAINT "pool_check_interval_valid" CHECK ("endpoint_pools"."check_interval_seconds" >= 5)
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"address_mode" "endpoint_address_mode" DEFAULT 'static' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"lifecycle" "endpoint_lifecycle" DEFAULT 'enabled' NOT NULL,
	"health_state" "health_state" DEFAULT 'unknown' NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failover_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"endpoint_id" uuid,
	"operation_id" uuid,
	"event_type" varchar(80) NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_check_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid,
	"endpoint_id" uuid,
	"domain_binding_id" uuid,
	"checker_type" varchar(40) NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_check_exactly_one_scope" CHECK (num_nonnulls("health_check_configs"."pool_id", "health_check_configs"."endpoint_id", "health_check_configs"."domain_binding_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "health_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"domain_binding_id" uuid,
	"probe_id" varchar(120),
	"success" boolean NOT NULL,
	"latency_ms" real NOT NULL,
	"status_code" integer,
	"error_code" varchar(100),
	"error_detail" varchar(512),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"name" varchar(120) NOT NULL,
	"endpoint" text,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" varchar(64) NOT NULL,
	"secret_tag" varchar(64) NOT NULL,
	"secret_key_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar(120) NOT NULL,
	"channel_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"response_status" integer,
	"response_excerpt" varchar(512),
	"error_code" varchar(100),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"dns_record_id" uuid,
	"action" "operation_action" NOT NULL,
	"status" "operation_step_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb NOT NULL,
	"remote_snapshot" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"error_code" varchar(100),
	"error_detail" varchar(512),
	"remote_request_id" varchar(255),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"source" "operation_source" NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"resource_id" uuid,
	"policy_revision" integer,
	"status" "operation_status" DEFAULT 'pending' NOT NULL,
	"before_snapshot" jsonb,
	"desired_snapshot" jsonb,
	"error_code" varchar(100),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" varchar(255) NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_notification_channels" (
	"pool_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"event_filter" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overrides_defaults" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pool_notification_channels_pool_id_channel_id_pk" PRIMARY KEY("pool_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" "provider_type" NOT NULL,
	"name" varchar(120) NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_iv" varchar(64) NOT NULL,
	"credential_tag" varchar(64) NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"credential_hint" varchar(120),
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"error_code" varchar(80),
	"last_verified_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"session_version" integer NOT NULL,
	"user_agent" varchar(512),
	"ip_address" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(80) NOT NULL,
	"email" varchar(320),
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"name_ascii" varchar(255) NOT NULL,
	"name_unicode" varchar(255),
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"remote_hash" varchar(64),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_assignments" ADD CONSTRAINT "binding_assignments_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_assignments" ADD CONSTRAINT "binding_assignments_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_assignments" ADD CONSTRAINT "binding_assignments_dns_record_id_dns_records_id_fk" FOREIGN KEY ("dns_record_id") REFERENCES "public"."dns_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ddns_agents" ADD CONSTRAINT "ddns_agents_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_managed_by_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("managed_by_pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_bindings" ADD CONSTRAINT "domain_bindings_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_bindings" ADD CONSTRAINT "domain_bindings_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_bindings" ADD CONSTRAINT "domain_bindings_original_endpoint_id_endpoints_id_fk" FOREIGN KEY ("original_endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_addresses" ADD CONSTRAINT "endpoint_addresses_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_pools" ADD CONSTRAINT "endpoint_pools_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failover_events" ADD CONSTRAINT "failover_events_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failover_events" ADD CONSTRAINT "failover_events_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failover_events" ADD CONSTRAINT "failover_events_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_configs" ADD CONSTRAINT "health_check_configs_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_configs" ADD CONSTRAINT "health_check_configs_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_configs" ADD CONSTRAINT "health_check_configs_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_results" ADD CONSTRAINT "health_check_results_config_id_health_check_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."health_check_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_results" ADD CONSTRAINT "health_check_results_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_results" ADD CONSTRAINT "health_check_results_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_steps" ADD CONSTRAINT "operation_steps_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_steps" ADD CONSTRAINT "operation_steps_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_steps" ADD CONSTRAINT "operation_steps_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_steps" ADD CONSTRAINT "operation_steps_dns_record_id_dns_records_id_fk" FOREIGN KEY ("dns_record_id") REFERENCES "public"."dns_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_notification_channels" ADD CONSTRAINT "pool_notification_channels_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_notification_channels" ADD CONSTRAINT "pool_notification_channels_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_owner_time_idx" ON "audit_logs" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "binding_assignments_endpoint_idx" ON "binding_assignments" USING btree ("endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dns_records_zone_external_unique" ON "dns_records" USING btree ("zone_id","external_id");--> statement-breakpoint
CREATE INDEX "dns_records_lookup_idx" ON "dns_records" USING btree ("zone_id","name","type");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_bindings_pool_fqdn_type_unique" ON "domain_bindings" USING btree ("pool_id","fqdn","record_type");--> statement-breakpoint
CREATE INDEX "domain_bindings_zone_idx" ON "domain_bindings" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "endpoint_addresses_endpoint_idx" ON "endpoint_addresses" USING btree ("endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_addresses_active_family_unique" ON "endpoint_addresses" USING btree ("endpoint_id","family","state") WHERE "endpoint_addresses"."state" in ('candidate', 'current');--> statement-breakpoint
CREATE INDEX "endpoint_pools_owner_idx" ON "endpoint_pools" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoints_pool_name_unique" ON "endpoints" USING btree ("pool_id","name");--> statement-breakpoint
CREATE INDEX "endpoints_pool_idx" ON "endpoints" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "failover_events_pool_time_idx" ON "failover_events" USING btree ("pool_id","created_at");--> statement-breakpoint
CREATE INDEX "health_check_pool_idx" ON "health_check_configs" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "health_check_endpoint_idx" ON "health_check_configs" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "health_results_endpoint_time_idx" ON "health_check_results" USING btree ("endpoint_id","checked_at");--> statement-breakpoint
CREATE INDEX "health_results_binding_time_idx" ON "health_check_results" USING btree ("domain_binding_id","checked_at");--> statement-breakpoint
CREATE INDEX "notification_channels_owner_idx" ON "notification_channels" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_event_channel_unique" ON "notification_deliveries" USING btree ("event_id","channel_id");--> statement-breakpoint
CREATE INDEX "notification_retry_idx" ON "notification_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_steps_sequence_unique" ON "operation_steps" USING btree ("operation_id","sequence");--> statement-breakpoint
CREATE INDEX "operation_steps_retry_idx" ON "operation_steps" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "operations_owner_time_idx" ON "operations" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "operations_status_idx" ON "operations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_pool_version_unique" ON "policy_versions" USING btree ("pool_id","version");--> statement-breakpoint
CREATE INDEX "provider_accounts_owner_idx" ON "provider_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_unique" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "zones_account_external_unique" ON "zones" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "zones_name_idx" ON "zones" USING btree ("name_ascii");