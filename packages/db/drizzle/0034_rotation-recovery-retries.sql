ALTER TABLE "rotation_incidents" ADD COLUMN "recovery_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD COLUMN "recovery_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD COLUMN "last_recovery_error" varchar(80);--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD COLUMN "max_recovery_retries" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD CONSTRAINT "rotation_recovery_retries_bounds" CHECK ("rotation_incidents"."recovery_retries" between 0 and 20);--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policy_recovery_bounds" CHECK ("rotation_policies"."max_recovery_retries" between 0 and 20);