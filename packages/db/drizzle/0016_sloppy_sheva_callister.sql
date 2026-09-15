CREATE TABLE "probe_round_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid,
	"endpoint_id" uuid,
	"family" "address_family" NOT NULL,
	"last_sequence" integer NOT NULL,
	CONSTRAINT "probe_round_sequences_target" CHECK (num_nonnulls("probe_round_sequences"."slot_id", "probe_round_sequences"."endpoint_id") = 1),
	CONSTRAINT "probe_round_sequences_positive" CHECK ("probe_round_sequences"."last_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "probe_round_sequences" ADD CONSTRAINT "probe_round_sequences_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_round_sequences" ADD CONSTRAINT "probe_round_sequences_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "probe_round_sequences_slot_unique" ON "probe_round_sequences" USING btree ("slot_id") WHERE "probe_round_sequences"."slot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "probe_round_sequences_endpoint_family_unique" ON "probe_round_sequences" USING btree ("endpoint_id","family") WHERE "probe_round_sequences"."endpoint_id" is not null;--> statement-breakpoint
INSERT INTO "probe_round_sequences" ("endpoint_id", "family", "last_sequence")
SELECT "endpoint_id", "family", max("sequence")
FROM "probe_rounds" WHERE "endpoint_id" IS NOT NULL
GROUP BY "endpoint_id", "family";
--> statement-breakpoint
INSERT INTO "probe_round_sequences" ("slot_id", "family", "last_sequence")
SELECT rounds."slot_id", slots."family", max(rounds."sequence")
FROM "probe_rounds" rounds JOIN "managed_address_slots" slots ON slots."id" = rounds."slot_id"
GROUP BY rounds."slot_id", slots."family";
