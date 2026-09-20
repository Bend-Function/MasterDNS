import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

describe("durable rotation storage", () => {
  it("exports durable steps, budget history, physical fences and publication boundary", () => {
    for (const name of ["rotationPolicies", "rotationIncidents", "rotationBudgetSegments", "rotationAttempts", "rotationSteps", "rotationResources", "rotationLeases", "rotationPublications"] as const) {
      expect(schema).toHaveProperty(name);
    }
  });
  it("keeps exhausted incidents active and physical uncertainty independent of lease expiry", () => {
    const s = schema as unknown as Record<string, Parameters<typeof getTableConfig>[0]>;
    expect(s.rotationIncidents && getTableConfig(s.rotationIncidents).indexes.map(i => i.config.name)).toContain("rotation_incidents_active_unique");
    expect(s.rotationLeases && getTableConfig(s.rotationLeases).columns.map(c => c.name)).toContain("unresolved_step_id");
  });
  it("stores a trigger and permits absent health epochs for manual incidents", () => {
    const config = getTableConfig(schema.rotationIncidents);
    const columns = new Map(config.columns.map(column => [column.name, column]));
    expect(columns.get("trigger")).toMatchObject({ hasDefault: true, notNull: true });
    for (const name of ["health_policy_id", "health_policy_revision", "config_id", "config_revision", "group_id", "group_revision"]) {
      expect(columns.get(name)?.notNull).toBe(false);
    }
    expect(config.checks.map(item => item.name)).toContain("rotation_incidents_trigger_epoch");
  });
});
