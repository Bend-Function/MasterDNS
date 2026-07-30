CREATE TABLE "binding_endpoint_health" (
	"domain_binding_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"health_state" "health_state" DEFAULT 'unknown' NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_endpoint_health_domain_binding_id_endpoint_id_pk" PRIMARY KEY("domain_binding_id","endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "binding_endpoint_health" ADD CONSTRAINT "binding_endpoint_health_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding_endpoint_health" ADD CONSTRAINT "binding_endpoint_health_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "binding_endpoint_health_endpoint_idx" ON "binding_endpoint_health" USING btree ("endpoint_id");