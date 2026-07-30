WITH "ranked_active_checks" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY
				CASE
					WHEN "pool_id" IS NOT NULL THEN 'pool'
					WHEN "endpoint_id" IS NOT NULL THEN 'endpoint'
					ELSE 'binding'
				END,
				coalesce("pool_id", "endpoint_id", "domain_binding_id")
			ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS "position"
	FROM "health_check_configs"
	WHERE "enabled" = true
)
UPDATE "health_check_configs" AS "config"
SET "enabled" = false, "updated_at" = now()
FROM "ranked_active_checks" AS "ranked"
WHERE "config"."id" = "ranked"."id" AND "ranked"."position" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "health_check_one_active_pool_unique" ON "health_check_configs" USING btree ("pool_id") WHERE "health_check_configs"."pool_id" is not null and "health_check_configs"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "health_check_one_active_endpoint_unique" ON "health_check_configs" USING btree ("endpoint_id") WHERE "health_check_configs"."endpoint_id" is not null and "health_check_configs"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "health_check_one_active_binding_unique" ON "health_check_configs" USING btree ("domain_binding_id") WHERE "health_check_configs"."domain_binding_id" is not null and "health_check_configs"."enabled" = true;
