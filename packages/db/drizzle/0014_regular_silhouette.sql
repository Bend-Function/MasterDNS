ALTER TABLE "cloud_api_requests" DROP CONSTRAINT "cloud_api_requests_pkey";--> statement-breakpoint
ALTER TABLE "cloud_api_requests" ADD CONSTRAINT "cloud_api_requests_actor_user_id_key_pk" PRIMARY KEY("actor_user_id","key");
