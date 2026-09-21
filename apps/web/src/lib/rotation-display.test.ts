import { describe, expect, it } from "vitest";
import { rotationLimitWait } from "./rotation-display";

describe("rotation rate-limit display", () => {
  it("presents incident deferral as waiting and uses the exact next-run time", () => {
    expect(rotationLimitWait({ errorCode: "rotation_rate_limited", nextRunAt: "2026-09-21T04:05:06.000Z" }, [])).toEqual({
      label: "等待换址额度",
      retryAt: "2026-09-21T04:05:06.000Z",
    });
  });

  it("presents cleanup deferral as waiting and uses cleanupDueAt", () => {
    expect(rotationLimitWait({ errorCode: null, nextRunAt: "2026-09-21T03:00:00.000Z" }, [{ cleanupError: "rotation_rate_limited", cleanupDueAt: "2026-09-21T05:06:07.000Z" }])).toEqual({
      label: "等待换址额度",
      retryAt: "2026-09-21T05:06:07.000Z",
    });
  });

  it("keeps the low-policy guidance visible when the worker pauses the incident", () => {
    expect(rotationLimitWait({ status: "paused", errorCode: "rotation_limit_too_low", nextRunAt: "2026-09-21T05:00:00.000Z" }, [])).toEqual({
      label: "换址额度不足以完成一次换址；请提高云账号使用比例后恢复任务",
      retryAt: "2026-09-21T05:00:00.000Z",
    });
  });

  it("does not relabel unrelated failures", () => {
    expect(rotationLimitWait({ errorCode: "permission_denied", nextRunAt: "2026-09-21T03:00:00.000Z" }, [])).toBeNull();
  });
});
