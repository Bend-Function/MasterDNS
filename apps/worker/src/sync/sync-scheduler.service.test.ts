import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");

describe("scheduledSyncJobId", () => {
  it("deduplicates one provider account within a scheduling slot", async () => {
    const { scheduledSyncJobId } = await import("./sync-scheduler.service.js");
    expect(scheduledSyncJobId("account-1", 42)).toBe(scheduledSyncJobId("account-1", 42));
    expect(scheduledSyncJobId("account-1", 42)).not.toBe(scheduledSyncJobId("account-1", 43));
    expect(scheduledSyncJobId("account-1", 42)).not.toBe(scheduledSyncJobId("account-2", 42));
  });
});
