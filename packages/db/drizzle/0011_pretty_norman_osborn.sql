CREATE TYPE "public"."cloud_address_kind" AS ENUM('host', 'prefix');--> statement-breakpoint
CREATE TYPE "public"."cloud_address_origin" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TYPE "public"."cloud_provider" AS ENUM('aws');--> statement-breakpoint
CREATE TYPE "public"."cloud_service" AS ENUM('ec2', 'lightsail');--> statement-breakpoint
ALTER TYPE "public"."endpoint_address_mode" ADD VALUE 'cloud';--> statement-breakpoint
CREATE TABLE "cloud_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"name" varchar(120) NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_iv" varchar(64) NOT NULL,
	"credential_tag" varchar(64) NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"credential_hint" varchar(120),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interface_id" uuid NOT NULL,
	"kind" "cloud_address_kind" NOT NULL,
	"family" "address_family" NOT NULL,
	"address" varchar(45) NOT NULL,
	"prefix_length" integer,
	"remote_allocation_id" varchar(255),
	"origin" "cloud_address_origin" NOT NULL,
	"attempt_id" uuid,
	"scan_generation" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_addresses_family_valid" CHECK ("cloud_addresses"."family" in ('4', '6')),
	CONSTRAINT "cloud_addresses_prefix_shape" CHECK (("cloud_addresses"."kind" = 'host' and "cloud_addresses"."prefix_length" is null) or ("cloud_addresses"."kind" = 'prefix' and "cloud_addresses"."prefix_length" is not null)),
	CONSTRAINT "cloud_addresses_prefix_length_valid" CHECK ("cloud_addresses"."prefix_length" is null or ("cloud_addresses"."family" = '4' and "cloud_addresses"."prefix_length" between 0 and 32) or ("cloud_addresses"."family" = '6' and "cloud_addresses"."prefix_length" between 0 and 128)),
	CONSTRAINT "cloud_addresses_scan_generation_positive" CHECK ("cloud_addresses"."scan_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "cloud_endpoint_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"family" "address_family" NOT NULL,
	"slot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_endpoint_links_family_valid" CHECK ("cloud_endpoint_links"."family" in ('4', '6'))
);
--> statement-breakpoint
CREATE TABLE "cloud_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"service" "cloud_service" NOT NULL,
	"region" varchar(80) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"state" varchar(80),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan_generation" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_instances_scan_generation_positive" CHECK ("cloud_instances"."scan_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "cloud_interfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan_generation" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_interfaces_scan_generation_positive" CHECK ("cloud_interfaces"."scan_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "cloud_scan_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"service" "cloud_service" NOT NULL,
	"region" varchar(80) NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_scan_scopes_generation_nonnegative" CHECK ("cloud_scan_scopes"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "instance_authorizations" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"allow_ipv4_rotation" boolean DEFAULT false NOT NULL,
	"allow_ipv6_rotation" boolean DEFAULT false NOT NULL,
	"allow_stop_start" boolean DEFAULT false NOT NULL,
	"allow_release_address" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_authorizations_revision_positive" CHECK ("instance_authorizations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "managed_address_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interface_id" uuid NOT NULL,
	"family" "address_family" NOT NULL,
	"name" varchar(120) NOT NULL,
	"current_address_id" uuid,
	"current_address_kind" "cloud_address_kind" DEFAULT 'host' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"candidate_address_id" uuid,
	"candidate_address_kind" "cloud_address_kind" DEFAULT 'host' NOT NULL,
	"candidate_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_address_slots_family_valid" CHECK ("managed_address_slots"."family" in ('4', '6')),
	CONSTRAINT "managed_address_slots_host_only" CHECK ("managed_address_slots"."current_address_kind" = 'host' and "managed_address_slots"."candidate_address_kind" = 'host'),
	CONSTRAINT "managed_address_slots_versions_nonnegative" CHECK ("managed_address_slots"."current_version" >= 0 and "managed_address_slots"."candidate_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_addresses" ADD CONSTRAINT "cloud_addresses_interface_id_cloud_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."cloud_interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_addresses_slot_reference_unique" ON "cloud_addresses" USING btree ("id","interface_id","family","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_address_slots_id_family_unique" ON "managed_address_slots" USING btree ("id","family");--> statement-breakpoint
ALTER TABLE "cloud_endpoint_links" ADD CONSTRAINT "cloud_endpoint_links_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_endpoint_links" ADD CONSTRAINT "cloud_endpoint_links_slot_family_fk" FOREIGN KEY ("slot_id","family") REFERENCES "public"."managed_address_slots"("id","family") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_instances" ADD CONSTRAINT "cloud_instances_account_id_cloud_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_interfaces" ADD CONSTRAINT "cloud_interfaces_instance_id_cloud_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cloud_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_scan_scopes" ADD CONSTRAINT "cloud_scan_scopes_account_id_cloud_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_authorizations" ADD CONSTRAINT "instance_authorizations_instance_id_cloud_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."cloud_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_authorizations" ADD CONSTRAINT "instance_authorizations_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_address_slots" ADD CONSTRAINT "managed_address_slots_interface_id_cloud_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."cloud_interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_address_slots" ADD CONSTRAINT "managed_slots_current_host_fk" FOREIGN KEY ("current_address_id","interface_id","family","current_address_kind") REFERENCES "public"."cloud_addresses"("id","interface_id","family","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_address_slots" ADD CONSTRAINT "managed_slots_candidate_host_fk" FOREIGN KEY ("candidate_address_id","interface_id","family","candidate_address_kind") REFERENCES "public"."cloud_addresses"("id","interface_id","family","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_accounts_owner_idx" ON "cloud_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_addresses_host_identity_unique" ON "cloud_addresses" USING btree ("interface_id","family","address") WHERE "cloud_addresses"."kind" = 'host';--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_addresses_prefix_identity_unique" ON "cloud_addresses" USING btree ("interface_id","family","address","prefix_length") WHERE "cloud_addresses"."kind" = 'prefix';--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_endpoint_links_endpoint_family_unique" ON "cloud_endpoint_links" USING btree ("endpoint_id","family");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_instances_identity_unique" ON "cloud_instances" USING btree ("account_id","service","region","external_id");--> statement-breakpoint
CREATE INDEX "cloud_instances_scan_idx" ON "cloud_instances" USING btree ("account_id","service","region","scan_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_interfaces_identity_unique" ON "cloud_interfaces" USING btree ("instance_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_scan_scopes_identity_unique" ON "cloud_scan_scopes" USING btree ("account_id","service","region");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_address_slots_name_unique" ON "managed_address_slots" USING btree ("interface_id","family","name");
--> statement-breakpoint
CREATE FUNCTION enforce_cloud_endpoint_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM endpoints WHERE id = NEW.endpoint_id AND address_mode::text = 'cloud') THEN
    RAISE EXCEPTION 'cloud endpoint link requires cloud address mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cloud_endpoint_links_mode_check
BEFORE INSERT OR UPDATE OF endpoint_id ON cloud_endpoint_links
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_endpoint_link();
--> statement-breakpoint
CREATE FUNCTION prevent_linked_endpoint_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.address_mode::text <> 'cloud' AND EXISTS (SELECT 1 FROM cloud_endpoint_links WHERE endpoint_id = NEW.id) THEN
    RAISE EXCEPTION 'linked cloud endpoint must retain cloud address mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER endpoints_cloud_mode_check
BEFORE UPDATE OF address_mode ON endpoints
FOR EACH ROW EXECUTE FUNCTION prevent_linked_endpoint_mode_change();
