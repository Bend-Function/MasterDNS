CREATE TABLE "cloud_rotation_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"identity_key" text NOT NULL,
	"rule_id" text NOT NULL,
	"region" text,
	"debt" double precision DEFAULT 0 NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cooldown_until" timestamp with time zone,
	"throttle_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cloud_rotation_bucket_bounds" CHECK ("cloud_rotation_buckets"."debt" >= 0 and "cloud_rotation_buckets"."throttle_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cloud_rotation_limit_policies" (
	"account_id" uuid NOT NULL,
	"service" "cloud_service" NOT NULL,
	"utilization_percent" integer DEFAULT 80 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_rotation_limit_policies_account_id_service_pk" PRIMARY KEY("account_id","service"),
	CONSTRAINT "cloud_rotation_limit_percent" CHECK ("cloud_rotation_limit_policies"."utilization_percent" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "cloud_rotation_reservations" (
	"step_id" varchar(180) PRIMARY KEY NOT NULL,
	"identity_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud_rotation_limit_policies" ADD CONSTRAINT "cloud_rotation_limit_policies_account_id_cloud_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_rotation_reservations" ADD CONSTRAINT "cloud_rotation_reservations_step_id_rotation_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."rotation_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_rotation_buckets_identity_idx" ON "cloud_rotation_buckets" USING btree ("identity_key");--> statement-breakpoint
CREATE INDEX "cloud_rotation_reservations_identity_idx" ON "cloud_rotation_reservations" USING btree ("identity_key");