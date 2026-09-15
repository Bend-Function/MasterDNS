CREATE TABLE "rotation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"charged" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'prepared' NOT NULL,
	"before_inventory" jsonb NOT NULL,
	"candidate_address_id" uuid,
	"candidate_version" integer,
	"candidate_repeated" boolean DEFAULT false NOT NULL,
	"charged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_budget_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"max_attempts" integer NOT NULL,
	"attempts_used" integer DEFAULT 0 NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_budget_bounds" CHECK ("rotation_budget_segments"."max_attempts" between 1 and 20 and "rotation_budget_segments"."attempts_used" between 0 and "rotation_budget_segments"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "rotation_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"family" "address_family" NOT NULL,
	"physical_key" text NOT NULL,
	"source_event_id" varchar(255) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"phase" varchar(16) DEFAULT 'cloud' NOT NULL,
	"current_segment_id" uuid NOT NULL,
	"current_attempt_id" uuid,
	"pending_segment_id" uuid,
	"authorization_revision" integer NOT NULL,
	"policy_revision" integer NOT NULL,
	"address_version" integer NOT NULL,
	"health_policy_id" uuid NOT NULL,
	"health_policy_revision" integer NOT NULL,
	"config_id" uuid NOT NULL,
	"config_revision" integer NOT NULL,
	"group_id" uuid NOT NULL,
	"group_revision" integer NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_deadline" timestamp with time zone,
	"error_code" varchar(80),
	"paused_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "rotation_incidents_status" CHECK ("rotation_incidents"."status" in ('active','paused','exhausted','complete') and "rotation_incidents"."phase" in ('cloud','candidate','publish','cleanup','complete'))
);
--> statement-breakpoint
CREATE TABLE "rotation_leases" (
	"physical_key" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"holder" uuid,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"incident_id" uuid,
	"unresolved_step_id" varchar(180),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_policies" (
	"slot_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"min_interval_seconds" integer DEFAULT 60 NOT NULL,
	"cloud_wait_seconds" integer DEFAULT 120 NOT NULL,
	"candidate_window_seconds" integer DEFAULT 180 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_policy_bounds" CHECK ("rotation_policies"."revision" > 0 and "rotation_policies"."max_attempts" between 1 and 20 and "rotation_policies"."min_interval_seconds" between 60 and 86400 and "rotation_policies"."cloud_wait_seconds" between 10 and 3600 and "rotation_policies"."candidate_window_seconds" between 15 and 86400)
);
--> statement-breakpoint
CREATE TABLE "rotation_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"address_version" integer NOT NULL,
	"address_id" uuid NOT NULL,
	"incident_id" uuid,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"operation_id" uuid,
	"error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"address_id" uuid,
	"address" varchar(45) NOT NULL,
	"allocation_id" varchar(255),
	"resource_id" text,
	"origin" varchar(16) NOT NULL,
	"ownership_attempt_id" uuid,
	"role" varchar(16) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"attached" boolean DEFAULT true NOT NULL,
	"referenced" boolean DEFAULT true NOT NULL,
	"cleanup_due_at" timestamp with time zone,
	"cleanup_status" varchar(20) DEFAULT 'retained' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_step_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" varchar(180) NOT NULL,
	"observation" boolean NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_steps" (
	"id" varchar(180) PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'prepared' NOT NULL,
	"receipt" jsonb,
	"fence" integer,
	"dispatched_at" timestamp with time zone,
	"observe_deadline" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"error_code" varchar(80),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_step_state" CHECK ("rotation_steps"."status" in ('prepared','in_flight','pending','applied','not_applied','ambiguous','rejected_no_effect'))
);
--> statement-breakpoint
ALTER TABLE "rotation_attempts" ADD CONSTRAINT "rotation_attempts_incident_id_rotation_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."rotation_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_attempts" ADD CONSTRAINT "rotation_attempts_segment_id_rotation_budget_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."rotation_budget_segments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_budget_segments" ADD CONSTRAINT "rotation_budget_segments_incident_id_rotation_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."rotation_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD CONSTRAINT "rotation_incidents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD CONSTRAINT "rotation_incidents_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_leases" ADD CONSTRAINT "rotation_leases_incident_id_rotation_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."rotation_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_leases" ADD CONSTRAINT "rotation_leases_unresolved_step_id_rotation_steps_id_fk" FOREIGN KEY ("unresolved_step_id") REFERENCES "public"."rotation_steps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policies_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_publications" ADD CONSTRAINT "rotation_publications_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_publications" ADD CONSTRAINT "rotation_publications_incident_id_rotation_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."rotation_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_resources" ADD CONSTRAINT "rotation_resources_incident_id_rotation_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."rotation_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_resources" ADD CONSTRAINT "rotation_resources_attempt_id_rotation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."rotation_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_step_observations" ADD CONSTRAINT "rotation_step_observations_step_id_rotation_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."rotation_steps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_steps" ADD CONSTRAINT "rotation_steps_attempt_id_rotation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."rotation_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_attempt_sequence_unique" ON "rotation_attempts" USING btree ("incident_id","sequence");--> statement-breakpoint
CREATE INDEX "rotation_budget_incident_idx" ON "rotation_budget_segments" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_incidents_active_unique" ON "rotation_incidents" USING btree ("slot_id","family") WHERE "rotation_incidents"."status" <> 'complete';--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_incidents_source_unique" ON "rotation_incidents" USING btree ("slot_id","source_event_id");--> statement-breakpoint
CREATE INDEX "rotation_incidents_due_idx" ON "rotation_incidents" USING btree ("next_run_at") WHERE "rotation_incidents"."status" <> 'complete';--> statement-breakpoint
CREATE INDEX "rotation_incidents_owner_idx" ON "rotation_incidents" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_publication_version_unique" ON "rotation_publications" USING btree ("slot_id","address_version");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_resource_attempt_role_unique" ON "rotation_resources" USING btree ("attempt_id","role");--> statement-breakpoint
CREATE INDEX "rotation_step_observations_step_idx" ON "rotation_step_observations" USING btree ("step_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_step_sequence_unique" ON "rotation_steps" USING btree ("attempt_id","sequence");