DO $$
DECLARE
	"conflict_groups" bigint;
BEGIN
	SELECT count(*) INTO "conflict_groups"
	FROM (
		SELECT 1
		FROM "domain_bindings"
		GROUP BY "zone_id", "fqdn", "record_type"
		HAVING count(*) > 1
	) AS "conflicts";

	IF "conflict_groups" > 0 THEN
		RAISE EXCEPTION USING
			ERRCODE = '23505',
			MESSAGE = format('Cannot enforce unique DNS bindings: %s conflicting zone/name/type group(s) exist', "conflict_groups"),
			HINT = 'Run node packages/db/dist/preflight-cli.js, resolve every reported binding conflict, then retry the migration.';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_bindings_zone_fqdn_type_unique" ON "domain_bindings" USING btree ("zone_id","fqdn","record_type");
