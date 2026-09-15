ALTER TABLE "rotation_publications" ADD COLUMN "children" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_publications" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "rotation_publications" ADD COLUMN "previous_max_ttl" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_publications" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotation_publications" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rotation_resources" ADD COLUMN "cleanup_step_id" varchar(180);--> statement-breakpoint
ALTER TABLE "rotation_resources" ADD COLUMN "cleanup_address_version" integer;--> statement-breakpoint
ALTER TABLE "rotation_resources" ADD COLUMN "cleanup_error" varchar(80);--> statement-breakpoint
ALTER TABLE "rotation_resources" ADD CONSTRAINT "rotation_resources_cleanup_step_id_rotation_steps_id_fk" FOREIGN KEY ("cleanup_step_id") REFERENCES "public"."rotation_steps"("id") ON DELETE restrict ON UPDATE no action;