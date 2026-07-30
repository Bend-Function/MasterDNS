ALTER TABLE "endpoint_addresses" ADD COLUMN "health_state" "health_state" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoint_addresses" ADD COLUMN "consecutive_successes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoint_addresses" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoint_addresses" ADD COLUMN "last_checked_at" timestamp with time zone;