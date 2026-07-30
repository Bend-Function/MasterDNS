CREATE TABLE "reconcile_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"endpoint_id" uuid,
	"decision_revision" integer NOT NULL,
	"policy_revision" integer NOT NULL,
	"trigger" varchar(32) NOT NULL,
	"source" "operation_source" NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconcile_intents_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "endpoint_pools" ADD COLUMN "decision_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "decision_revision" integer;--> statement-breakpoint
ALTER TABLE "reconcile_intents" ADD CONSTRAINT "reconcile_intents_pool_id_endpoint_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."endpoint_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconcile_intents" ADD CONSTRAINT "reconcile_intents_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconcile_intents_pool_revision_unique" ON "reconcile_intents" USING btree ("pool_id","decision_revision");--> statement-breakpoint
CREATE INDEX "reconcile_intents_pending_idx" ON "reconcile_intents" USING btree ("completed_at","available_at");