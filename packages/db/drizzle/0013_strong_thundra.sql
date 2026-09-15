CREATE TABLE "cloud_api_requests" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"action" varchar(40) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_api_requests" ADD CONSTRAINT "cloud_api_requests_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_api_requests" ADD CONSTRAINT "cloud_api_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;