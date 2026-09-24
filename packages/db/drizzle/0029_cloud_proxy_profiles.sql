CREATE TABLE "cloud_proxy_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_iv" varchar(64) NOT NULL,
	"credential_tag" varchar(64) NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD COLUMN "proxy_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_proxy_profiles" ADD CONSTRAINT "cloud_proxy_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_proxy_profiles_owner_idx" ON "cloud_proxy_profiles" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_proxy_profile_id_cloud_proxy_profiles_id_fk" FOREIGN KEY ("proxy_profile_id") REFERENCES "public"."cloud_proxy_profiles"("id") ON DELETE restrict ON UPDATE no action;