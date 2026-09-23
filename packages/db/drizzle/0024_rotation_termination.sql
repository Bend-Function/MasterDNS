CREATE TABLE "cloud_rotation_limit_switches" (
	"identity_key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD COLUMN "terminated_at" timestamp with time zone;