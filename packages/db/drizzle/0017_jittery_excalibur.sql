CREATE TABLE "address_health_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid,
	"endpoint_id" uuid,
	"family" "address_family" NOT NULL,
	"config_id" uuid NOT NULL,
	"mode" varchar(16) DEFAULT 'external' NOT NULL,
	"group_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"consensus" jsonb DEFAULT '{"mode":"majority","minimumValid":1}'::jsonb NOT NULL,
	"check_interval_seconds" integer DEFAULT 15 NOT NULL,
	"execution_window_seconds" integer DEFAULT 10 NOT NULL,
	"result_expiry_seconds" integer DEFAULT 60 NOT NULL,
	"success_threshold" integer DEFAULT 3 NOT NULL,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"network_policy" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "address_health_policy_target" CHECK (num_nonnulls("address_health_policies"."slot_id", "address_health_policies"."endpoint_id") = 1),
	CONSTRAINT "address_health_policy_mode" CHECK ("address_health_policies"."mode" in ('local', 'external', 'mixed')),
	CONSTRAINT "address_health_policy_bounds" CHECK ("address_health_policies"."revision" > 0 and "address_health_policies"."success_threshold" > 0 and "address_health_policies"."failure_threshold" > 0 and "address_health_policies"."execution_window_seconds" > 0 and "address_health_policies"."check_interval_seconds" >= "address_health_policies"."execution_window_seconds" and "address_health_policies"."result_expiry_seconds" >= "address_health_policies"."execution_window_seconds")
);
--> statement-breakpoint
CREATE TABLE "address_health_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid,
	"endpoint_id" uuid,
	"family" "address_family" NOT NULL,
	"address_id" uuid,
	"address_version" integer DEFAULT 0 NOT NULL,
	"config_id" uuid,
	"config_version" integer DEFAULT 0 NOT NULL,
	"policy_id" uuid,
	"policy_revision" integer DEFAULT 0 NOT NULL,
	"group_revision" integer,
	"health_state" varchar(16) DEFAULT 'unknown' NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_applied_sequence" integer DEFAULT 0 NOT NULL,
	"last_round_id" uuid,
	"latest_decision" varchar(16) DEFAULT 'unknown' NOT NULL,
	"evidence_expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"next_round_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "address_health_state_target" CHECK (num_nonnulls("address_health_states"."slot_id", "address_health_states"."endpoint_id") = 1),
	CONSTRAINT "address_health_state_counters" CHECK ("address_health_states"."address_version" >= 0 and "address_health_states"."last_applied_sequence" >= 0 and "address_health_states"."consecutive_successes" >= 0 and "address_health_states"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "probe_observation_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_key" varchar(80) NOT NULL,
	"probe_id" varchar(40) NOT NULL,
	"family" "address_family" NOT NULL,
	"period" varchar(8) NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"success_count" integer NOT NULL,
	"unavailable_count" integer NOT NULL,
	"average_latency_ms" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD COLUMN "policy_id" uuid;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD COLUMN "policy_revision" integer;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD COLUMN "local_outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD COLUMN "local_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "address_health_policies" ADD CONSTRAINT "address_health_policies_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_health_policies" ADD CONSTRAINT "address_health_policies_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_health_policies" ADD CONSTRAINT "address_health_policies_config_id_health_check_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."health_check_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_health_policies" ADD CONSTRAINT "address_health_policies_group_id_probe_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."probe_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_health_states" ADD CONSTRAINT "address_health_states_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_health_states" ADD CONSTRAINT "address_health_states_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_health_policy_slot_unique" ON "address_health_policies" USING btree ("slot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "address_health_policy_endpoint_family_unique" ON "address_health_policies" USING btree ("endpoint_id","family");--> statement-breakpoint
CREATE UNIQUE INDEX "address_health_state_slot_unique" ON "address_health_states" USING btree ("slot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "address_health_state_endpoint_family_unique" ON "address_health_states" USING btree ("endpoint_id","family");--> statement-breakpoint
CREATE UNIQUE INDEX "probe_observation_stats_bucket_unique" ON "probe_observation_stats" USING btree ("target_key","probe_id","family","period","bucket_start");