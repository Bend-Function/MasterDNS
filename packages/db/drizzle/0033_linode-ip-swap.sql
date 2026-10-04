ALTER TABLE "rotation_policies" ADD COLUMN "linode_ipv4_strategy" varchar(24) DEFAULT 'additional_ipv4' NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD COLUMN "linode_swap_plan" varchar(128) DEFAULT 'g6-nanode-1' NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD COLUMN "linode_allow_temporary_instance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policy_linode_ipv4_strategy" CHECK ("rotation_policies"."linode_ipv4_strategy" in ('additional_ipv4','instance_swap'));--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policy_linode_swap_plan" CHECK ("rotation_policies"."linode_swap_plan" ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$');