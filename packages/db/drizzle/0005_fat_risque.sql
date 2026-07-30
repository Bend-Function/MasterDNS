CREATE TYPE "public"."health_stat_period" AS ENUM('hour', 'day');--> statement-breakpoint
CREATE TABLE "health_check_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"domain_binding_id" uuid,
	"scope_key" varchar(64) NOT NULL,
	"period" "health_stat_period" NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"success_count" integer NOT NULL,
	"average_latency_ms" real NOT NULL,
	"minimum_latency_ms" real NOT NULL,
	"maximum_latency_ms" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_check_stats" ADD CONSTRAINT "health_check_stats_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_stats" ADD CONSTRAINT "health_check_stats_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "health_stats_scope_period_bucket_unique" ON "health_check_stats" USING btree ("endpoint_id","scope_key","period","bucket_start");--> statement-breakpoint
CREATE INDEX "health_stats_endpoint_time_idx" ON "health_check_stats" USING btree ("endpoint_id","period","bucket_start");