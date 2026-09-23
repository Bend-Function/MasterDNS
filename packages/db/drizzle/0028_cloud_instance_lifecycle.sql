CREATE TABLE "cloud_instance_controls" (
	"physical_key" text PRIMARY KEY NOT NULL,
	"power_hold" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_instance_controls_hold" CHECK ("cloud_instance_controls"."power_hold" is null or "cloud_instance_controls"."power_hold" in ('manual_stop','traffic_limit','deleted'))
);
--> statement-breakpoint
CREATE TABLE "cloud_lifecycle_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"physical_key" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"external_account_id" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"snapshot" jsonb,
	"protected_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_revision" integer,
	"policy_month" text,
	"error_code" text,
	"lease_holder" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_lifecycle_state" CHECK ("cloud_lifecycle_operations"."action" in ('start','stop','delete') and "cloud_lifecycle_operations"."source" in ('user','traffic') and "cloud_lifecycle_operations"."status" in ('queued','in_flight','succeeded','failed','unknown','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "cloud_traffic_stop_policies" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"resource_identity" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"threshold_bytes" bigint,
	"direction" text DEFAULT 'total' NOT NULL,
	"check_interval_seconds" integer DEFAULT 3600 NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"month" text,
	"last_usage_bytes" bigint,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"triggered_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_holder" uuid,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_traffic_policy_bounds" CHECK ("cloud_traffic_stop_policies"."revision">0 and "cloud_traffic_stop_policies"."check_interval_seconds" between 60 and 86400 and "cloud_traffic_stop_policies"."direction" in ('total','outgoing') and ("cloud_traffic_stop_policies"."threshold_bytes" is null or "cloud_traffic_stop_policies"."threshold_bytes" between 1 and 9007199254740991) and (not "cloud_traffic_stop_policies"."enabled" or "cloud_traffic_stop_policies"."threshold_bytes" is not null))
);
--> statement-breakpoint
ALTER TABLE "instance_authorizations" ADD COLUMN "allow_delete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_lifecycle_operations" ADD CONSTRAINT "cloud_lifecycle_operations_instance_id_cloud_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cloud_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_lifecycle_operations" ADD CONSTRAINT "cloud_lifecycle_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_lifecycle_operations" ADD CONSTRAINT "cloud_lifecycle_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_traffic_stop_policies" ADD CONSTRAINT "cloud_traffic_stop_policies_instance_id_cloud_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cloud_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_traffic_stop_policies" ADD CONSTRAINT "cloud_traffic_stop_policies_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_lifecycle_active_physical_unique" ON "cloud_lifecycle_operations" USING btree ("physical_key") WHERE "cloud_lifecycle_operations"."status" in ('queued','in_flight','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_lifecycle_idempotency_unique" ON "cloud_lifecycle_operations" USING btree ("actor_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "cloud_lifecycle_due_idx" ON "cloud_lifecycle_operations" USING btree ("next_run_at") WHERE "cloud_lifecycle_operations"."status" in ('queued','in_flight','unknown');--> statement-breakpoint
CREATE INDEX "cloud_traffic_policy_due_idx" ON "cloud_traffic_stop_policies" USING btree ("next_check_at") WHERE "cloud_traffic_stop_policies"."enabled";