ALTER TABLE "binding_endpoint_health" ADD COLUMN "endpoint_address_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_pools" ADD COLUMN "round_robin_cursors" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "health_check_results" ADD COLUMN "endpoint_address_id" uuid;--> statement-breakpoint
ALTER TABLE "binding_endpoint_health" ADD CONSTRAINT "binding_endpoint_health_endpoint_address_id_endpoint_addresses_id_fk" FOREIGN KEY ("endpoint_address_id") REFERENCES "public"."endpoint_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_check_results" ADD CONSTRAINT "health_check_results_endpoint_address_id_endpoint_addresses_id_fk" FOREIGN KEY ("endpoint_address_id") REFERENCES "public"."endpoint_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_results_address_time_idx" ON "health_check_results" USING btree ("endpoint_address_id","checked_at");