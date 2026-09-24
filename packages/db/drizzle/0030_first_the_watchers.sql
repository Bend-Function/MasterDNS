CREATE TABLE "rotation_schedules" (
	"slot_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer DEFAULT 1440 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"active_incident_id" uuid,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_handled_incident_id" uuid,
	"paused_reason" varchar(80),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_schedule_bounds" CHECK ("rotation_schedules"."interval_minutes" between 1 and 129600 and "rotation_schedules"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "rotation_incidents" DROP CONSTRAINT "rotation_incidents_trigger_epoch";--> statement-breakpoint
ALTER TABLE "rotation_schedules" ADD CONSTRAINT "rotation_schedules_slot_id_managed_address_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."managed_address_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_schedules" ADD CONSTRAINT "rotation_schedules_active_incident_id_rotation_incidents_id_fk" FOREIGN KEY ("active_incident_id") REFERENCES "public"."rotation_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rotation_schedules_due_idx" ON "rotation_schedules" USING btree ("next_run_at","slot_id") WHERE "rotation_schedules"."enabled" = true and "rotation_schedules"."paused_reason" is null and "rotation_schedules"."next_run_at" is not null;--> statement-breakpoint
ALTER TABLE "rotation_incidents" ADD CONSTRAINT "rotation_incidents_trigger_epoch" CHECK (("rotation_incidents"."trigger" in ('health','scheduled') and "rotation_incidents"."health_policy_id" is not null and "rotation_incidents"."health_policy_revision" is not null and "rotation_incidents"."config_id" is not null and "rotation_incidents"."config_revision" is not null and "rotation_incidents"."group_id" is not null and "rotation_incidents"."group_revision" is not null) or ("rotation_incidents"."trigger" = 'manual' and "rotation_incidents"."health_policy_id" is null and "rotation_incidents"."health_policy_revision" is null and "rotation_incidents"."config_id" is null and "rotation_incidents"."config_revision" is null and "rotation_incidents"."group_id" is null and "rotation_incidents"."group_revision" is null));