import { describe, expect, it } from "vitest";
import { isReminderDue } from "./all-down-reminder.service.js";

describe("all-down reminder timing", () => {
  const now = new Date("2026-07-30T06:00:00.000Z");

  it("waits until the configured interval has elapsed", () => {
    expect(isReminderDue(new Date("2026-07-30T05:30:01.000Z"), 1800, now)).toBe(false);
    expect(isReminderDue(new Date("2026-07-30T05:30:00.000Z"), 1800, now)).toBe(true);
  });
});
