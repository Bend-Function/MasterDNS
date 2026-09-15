ALTER TABLE "cloud_accounts" ADD COLUMN "regions" jsonb;--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD COLUMN "external_account_id" varchar(32);--> statement-breakpoint
ALTER TABLE "instance_authorizations" ADD COLUMN "managed" boolean DEFAULT false NOT NULL;