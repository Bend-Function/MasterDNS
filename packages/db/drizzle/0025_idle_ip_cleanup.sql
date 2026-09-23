CREATE TABLE "cloud_idle_ip_cleanups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"external_account_id" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"regions" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"scan_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_idle_ip_cleanups" ADD CONSTRAINT "cloud_idle_ip_cleanups_account_id_cloud_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cloud_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_idle_ip_cleanups" ADD CONSTRAINT "cloud_idle_ip_cleanups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_idle_ip_cleanups" ADD CONSTRAINT "cloud_idle_ip_cleanups_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_idle_ip_account_idx" ON "cloud_idle_ip_cleanups" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_idle_ip_identity_idx" ON "cloud_idle_ip_cleanups" USING btree ("external_account_id");