ALTER TYPE "public"."cloud_provider" ADD VALUE 'azure';--> statement-breakpoint
ALTER TYPE "public"."cloud_provider" ADD VALUE 'linode';--> statement-breakpoint
ALTER TYPE "public"."cloud_service" ADD VALUE 'azure_vm';--> statement-breakpoint
ALTER TYPE "public"."cloud_service" ADD VALUE 'linode';--> statement-breakpoint
ALTER TABLE "cloud_accounts" ALTER COLUMN "external_account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cloud_addresses" ALTER COLUMN "remote_allocation_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cloud_instances" ALTER COLUMN "external_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cloud_interfaces" ALTER COLUMN "external_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rotation_resources" ALTER COLUMN "allocation_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cloud_addresses" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;