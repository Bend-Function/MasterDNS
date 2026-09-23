import { describe, expect, it } from "vitest";
import { lifecycleReached, trafficStopUsage } from "./cloud-lifecycle.js";
describe("lifecycle evidence", () => {
  it("requires deallocation and exact terminal states", () => {
    expect(lifecycleReached("stop", "stopped_allocated")).toBe(false);
    expect(lifecycleReached("stop", "stopped")).toBe(true);
    expect(lifecycleReached("start", "running")).toBe(true);
    expect(lifecycleReached("delete", "deleted")).toBe(true);
    expect(lifecycleReached("stop", "unknown")).toBe(false);
  });
  it("never converts absent, invalid or previous-month metrics to evidence", () => {
    const now = new Date("2026-09-24T01:00:00Z");
    expect(trafficStopUsage({ month: "2026-09", totalBytes: 100, outgoingBytes: 60 }, "total", now)).toBe(100);
    expect(trafficStopUsage({ month: "2026-09", totalBytes: null, outgoingBytes: 60 }, "total", now)).toBeNull();
    expect(trafficStopUsage({ month: "2026-08", totalBytes: 100 }, "total", now)).toBeNull();
    expect(trafficStopUsage({ month: "2026-09", totalBytes: NaN }, "total", now)).toBeNull();
  });
});
