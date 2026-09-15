CREATE TABLE "probe_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrency" integer DEFAULT 16 NOT NULL,
	"reported_concurrency" integer DEFAULT 100 NOT NULL,
	"capabilities" jsonb DEFAULT '{"ipv4":false,"ipv6":false}'::jsonb NOT NULL,
	"agent_version" varchar(64),
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_agents_capacity" CHECK ("probe_agents"."max_concurrency" between 1 and 100 and "probe_agents"."reported_concurrency" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "probe_group_members" (
	"group_id" uuid NOT NULL,
	"probe_id" uuid NOT NULL,
	CONSTRAINT "probe_group_members_group_id_probe_id_pk" PRIMARY KEY("group_id","probe_id")
);
--> statement-breakpoint
CREATE TABLE "probe_groups" (
	"revision" integer DEFAULT 1 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"probe_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"address_version" integer NOT NULL,
	"config_version" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"latency_ms" real NOT NULL,
	"status_code" integer,
	"error_code" varchar(128),
	"measured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_observations_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "probe_observations_status" CHECK ("probe_observations"."status" in ('accepted', 'stale')),
	CONSTRAINT "probe_observations_outcome" CHECK ("probe_observations"."outcome" in ('success', 'failure', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "probe_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid,
	"endpoint_id" uuid,
	"endpoint_address_id" uuid,
	"config_id" uuid NOT NULL,
	"group_id" uuid,
	"group_revision" integer,
	"sequence" integer NOT NULL,
	"address_version" integer NOT NULL,
	"config_version" integer NOT NULL,
	"address" varchar(45) NOT NULL,
	"family" "address_family" NOT NULL,
	"hostname" varchar(255),
	"config" jsonb NOT NULL,
	"network_policy" jsonb,
	"member_ids" jsonb NOT NULL,
	"consensus" jsonb NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"result_expires_at" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"consensus_result" varchar(16),
	"finalized_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_rounds_target" CHECK (("probe_rounds"."slot_id" is not null and "probe_rounds"."endpoint_id" is null and "probe_rounds"."endpoint_address_id" is null) or ("probe_rounds"."slot_id" is null and "probe_rounds"."endpoint_id" is not null and "probe_rounds"."endpoint_address_id" is not null)),
	CONSTRAINT "probe_rounds_versions" CHECK ("probe_rounds"."address_version" > 0 and "probe_rounds"."config_version" > 0 and "probe_rounds"."sequence" > 0),
	CONSTRAINT "probe_rounds_status" CHECK ("probe_rounds"."status" in ('pending', 'completed', 'superseded')),
	CONSTRAINT "probe_rounds_deadlines" CHECK ("probe_rounds"."result_expires_at" >= "probe_rounds"."deadline")
);
--> statement-breakpoint
CREATE TABLE "probe_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"probe_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"lease_id" uuid,
	"lease_deadline" timestamp with time zone,
	"leased_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_tasks_status" CHECK ("probe_tasks"."status" in ('pending', 'leased', 'accepted', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "probe_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"probe_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "probe_tokens_kind" CHECK ("probe_tokens"."kind" in ('install', 'runtime') and ("probe_tokens"."kind" <> 'install' or "probe_tokens"."expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "health_check_configs" DROP CONSTRAINT "health_check_exactly_one_scope";--> statement-breakpoint
ALTER TABLE "health_check_configs" ADD COLUMN "slot_id" uuid;--> statement-breakpoint
ALTER TABLE "probe_agents" ADD CONSTRAINT "probe_agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_group_members" ADD CONSTRAINT "probe_group_members_group_id_probe_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."probe_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_group_members" ADD CONSTRAINT "probe_group_members_probe_id_probe_agents_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."probe_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_groups" ADD CONSTRAINT "probe_groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_observations" ADD CONSTRAINT "probe_observations_task_id_probe_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."probe_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_observations" ADD CONSTRAINT "probe_observations_round_id_probe_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."probe_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_observations" ADD CONSTRAINT "probe_observations_probe_id_probe_agents_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."probe_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD CONSTRAINT "probe_rounds_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD CONSTRAINT "probe_rounds_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD CONSTRAINT "probe_rounds_endpoint_address_id_endpoint_addresses_id_fk" FOREIGN KEY ("endpoint_address_id") REFERENCES "public"."endpoint_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD CONSTRAINT "probe_rounds_config_id_health_check_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."health_check_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_rounds" ADD CONSTRAINT "probe_rounds_group_id_probe_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."probe_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_tasks" ADD CONSTRAINT "probe_tasks_round_id_probe_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."probe_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_tasks" ADD CONSTRAINT "probe_tasks_probe_id_probe_agents_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."probe_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_tokens" ADD CONSTRAINT "probe_tokens_probe_id_probe_agents_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."probe_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "probe_agents_owner_idx" ON "probe_agents" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "probe_groups_owner_idx" ON "probe_groups" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "probe_observations_round_idx" ON "probe_observations" USING btree ("round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "probe_rounds_slot_sequence_unique" ON "probe_rounds" USING btree ("slot_id","sequence") WHERE "probe_rounds"."slot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "probe_rounds_endpoint_sequence_unique" ON "probe_rounds" USING btree ("endpoint_id","family","sequence") WHERE "probe_rounds"."endpoint_id" is not null;--> statement-breakpoint
CREATE INDEX "probe_rounds_pending_idx" ON "probe_rounds" USING btree ("status","deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "probe_tasks_round_probe_unique" ON "probe_tasks" USING btree ("round_id","probe_id");--> statement-breakpoint
CREATE INDEX "probe_tasks_pending_idx" ON "probe_tasks" USING btree ("probe_id","status");--> statement-breakpoint
CREATE INDEX "probe_tokens_probe_idx" ON "probe_tokens" USING btree ("probe_id");--> statement-breakpoint
ALTER TABLE "health_check_configs" ADD CONSTRAINT "health_check_configs_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "health_check_one_active_slot_unique" ON "health_check_configs" USING btree ("slot_id") WHERE "health_check_configs"."slot_id" is not null and "health_check_configs"."enabled" = true;--> statement-breakpoint
ALTER TABLE "health_check_configs" ADD CONSTRAINT "health_check_exactly_one_scope" CHECK (num_nonnulls("health_check_configs"."pool_id", "health_check_configs"."endpoint_id", "health_check_configs"."domain_binding_id", "health_check_configs"."slot_id") = 1);