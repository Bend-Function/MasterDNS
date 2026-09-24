import { describe, expect, it } from "vitest";
import {
  rotationScheduleResumeSchema,
  rotationScheduleSchema,
  rotationScheduleUpdateSchema,
} from "./rotation.js";

const schedule = {
  slotId: "00000000-0000-4000-8000-000000000001",
  enabled: false,
  intervalMinutes: 1440,
  revision: 0,
  nextRunAt: null,
  activeIncidentId: null,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastHandledIncidentId: null,
  pausedReason: null,
  updatedAt: "2026-09-24T00:00:00.000Z",
};

describe("rotation schedule contracts", () => {
  it("accepts an absent-row response and rejects malformed timestamps", () => {
    expect(rotationScheduleSchema.parse(schedule)).toEqual(schedule);
    expect(rotationScheduleSchema.safeParse({ ...schedule, updatedAt: "yesterday" }).success).toBe(false);
  });

  it.each([1, 129600])("accepts interval boundary %i", intervalMinutes => {
    expect(rotationScheduleUpdateSchema.parse({ revision: 0, enabled: true, intervalMinutes })).toEqual({
      revision: 0,
      enabled: true,
      intervalMinutes,
    });
  });

  it.each([0, 129601, 1.5])("rejects interval outside the integer range: %s", intervalMinutes => {
    expect(rotationScheduleUpdateSchema.safeParse({ revision: 0, enabled: true, intervalMinutes }).success).toBe(false);
  });

  it("requires non-negative integer revisions and exact request fields", () => {
    expect(rotationScheduleResumeSchema.parse({ revision: 0 })).toEqual({ revision: 0 });
    for (const input of [{ revision: -1 }, { revision: 1.5 }, {}, { revision: 1, enabled: true }]) {
      expect(rotationScheduleResumeSchema.safeParse(input).success).toBe(false);
    }
    for (const revision of [-1, 1.5]) {
      expect(rotationScheduleUpdateSchema.safeParse({ revision, enabled: true, intervalMinutes: 60 }).success).toBe(false);
    }
    expect(rotationScheduleUpdateSchema.safeParse({ revision: 0, enabled: false, intervalMinutes: 1440, extra: true }).success).toBe(false);
  });
});
