import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { TcpHealthChecker } from "@masterdns/checkers";
import { probeRounds } from "@masterdns/db";
import { eq } from "drizzle-orm";
import { fixture, testDatabase } from "./probe-test-utils.js";
import { ProbeHealthService } from "./probe-health.service.js";
import { HealthResultService } from "../health/health-result.service.js";
let connection: Awaited<ReturnType<typeof testDatabase>>;
let health: ProbeHealthService;
beforeAll(async () => { connection = await testDatabase(); const db = { db: connection.db } as never; health = new ProbeHealthService(db, new HealthResultService(db)); }, 30000);
afterAll(async () => { await connection?.dispose(); });
async function rounds(count: number) {
 const f = await fixture(connection.db);
 return connection.db.insert(probeRounds).values(Array.from({ length: count }, (_, i) => ({ endpointId: f.endpoint.id, endpointAddressId: f.address.id, configId: f.config.id, sequence: i+1, addressVersion: 1, configVersion: 1, address: "10.1.2.3", family: "4" as const, config: { type: "tcp" as const, port: 443, timeoutMs: 3000 }, memberIds: ["local"], consensus: { mode: "all" as const, minimumValid: 1 }, networkPolicy: { allowedPrivateCIDRs: ["10.1.0.0/16"] }, deadline: new Date(Date.now()+60000), resultExpiresAt: new Date(Date.now()+90000) }))).returning();
}
it("requires matching CIDR and worker opt-in before invoking any local checker", async () => {
 const batch = await rounds(3); let dialed = 0;
 const checker = vi.spyOn(TcpHealthChecker.prototype, "check").mockImplementation(async () => { dialed++; return { success: true, latencyMs: 1, checkedAt: new Date() }; });
 const previous = process.env.ALLOW_PRIVATE_HEALTH_TARGETS;
 try {
  process.env.ALLOW_PRIVATE_HEALTH_TARGETS = "true";
  await connection.db.update(probeRounds).set({ address: "172.20.1.1" }).where(eq(probeRounds.id, batch[0]!.id));
  await health.checkLocal(batch[0]!.id);
  expect(dialed).toBe(0);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, batch[0]!.id)))[0]!.localOutcome).toBe("unavailable");
  process.env.ALLOW_PRIVATE_HEALTH_TARGETS = "false";
  await health.checkLocal(batch[1]!.id); expect(dialed).toBe(0);
  process.env.ALLOW_PRIVATE_HEALTH_TARGETS = "true";
  await health.checkLocal(batch[2]!.id); expect(dialed).toBe(1);
 } finally { checker.mockRestore(); if (previous === undefined) delete process.env.ALLOW_PRIVATE_HEALTH_TARGETS; else process.env.ALLOW_PRIVATE_HEALTH_TARGETS = previous; }
});
it("bounds simultaneous local admission at twenty and never starts expired work", async () => {
 const batch = await rounds(26); let active = 0; let peak = 0; let started = 0;
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 const checker = vi.spyOn(TcpHealthChecker.prototype, "check").mockImplementation(async () => { active++; started++; peak = Math.max(peak, active); await gate; active--; return { success: true, latencyMs: 1, checkedAt: new Date() }; });
 const previous = process.env.ALLOW_PRIVATE_HEALTH_TARGETS; process.env.ALLOW_PRIVATE_HEALTH_TARGETS = "true";
 await connection.db.update(probeRounds).set({ deadline: new Date(Date.now()-1000) }).where(eq(probeRounds.id, batch[25]!.id));
 const pending = batch.map(round => health.checkLocal(round.id));
 try {
  await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(20));
  expect(peak).toBe(20);
  await connection.db.update(probeRounds).set({ deadline: new Date(Date.now()-1000) }).where(eq(probeRounds.id, batch[24]!.id));
  release(); await Promise.all(pending); expect(started).toBe(20);
  await health.checkPendingLocal();
  await vi.waitFor(() => expect(started).toBe(24));
  const batchIds = new Set(batch.map(round => round.id));
  await vi.waitFor(async () => expect((await connection.db.select().from(probeRounds)).filter(round => batchIds.has(round.id) && round.localOutcome === "success")).toHaveLength(24));
  expect(peak).toBe(20);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, batch[24]!.id)))[0]!.localOutcome).toBeNull();
  await health.checkLocal(batch[25]!.id);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, batch[25]!.id)))[0]!.localOutcome).toBeNull();
 } finally { release(); await Promise.all(pending); checker.mockRestore(); if (previous === undefined) delete process.env.ALLOW_PRIVATE_HEALTH_TARGETS; else process.env.ALLOW_PRIVATE_HEALTH_TARGETS = previous; }
});
