import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressHealthPolicies, endpoints, endpointAddresses, reconcileIntents } from "@masterdns/db";
import { fixture, testDatabase } from "../probes/probe-test-utils.js";
import { HealthResultService } from "./health-result.service.js";
let connection: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { connection = await testDatabase(); }, 30000);
afterAll(async () => { await connection?.dispose(); });
it("keeps local DDNS threshold promotion and rejects a replaced candidate", async () => {
  const f = await fixture(connection.db, "ddns");
  const service = new HealthResultService({ db: connection.db } as never);
  const input = { addressId: f.address.id, addressVersion: 1, configId: f.config.id, configVersion: 1, decision: "success" as const, checkedAt: new Date() };
  await service.apply(input);
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, f.address.id)))[0]).toMatchObject({ state: "candidate", consecutiveSuccesses: 1 });
  await service.apply({ ...input, checkedAt: new Date(Date.now()+1) });
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, f.address.id)))[0]).toMatchObject({ state: "current", healthState: "healthy" });
  expect(await connection.db.select().from(reconcileIntents).where(eq(reconcileIntents.endpointId, f.endpoint.id))).toHaveLength(1);
  await connection.db.update(endpointAddresses).set({ state: "previous" }).where(eq(endpointAddresses.id, f.address.id));
  await service.apply(input);
  expect(await connection.db.select().from(reconcileIntents).where(eq(reconcileIntents.endpointId, f.endpoint.id))).toHaveLength(1);
});
it("never applies a base local result to a cloud endpoint", async () => {
  const f = await fixture(connection.db);
  await connection.db.update(endpoints).set({ addressMode: "cloud" }).where(eq(endpoints.id, f.endpoint.id));
  await connection.db.update(endpointAddresses).set({ source: "cloud" }).where(eq(endpointAddresses.id, f.address.id));
  const service = new HealthResultService({ db: connection.db } as never);
  await service.apply({ addressId: f.address.id, addressVersion: 1, configId: f.config.id, configVersion: 1, decision: "success", checkedAt: new Date() });
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, f.address.id)))[0]).toMatchObject({ healthState: "unknown", consecutiveSuccesses: 0 });
});
it("uses an explicit local policy threshold while keeping pool defaults for unassigned addresses", async () => {
  const f = await fixture(connection.db);
  await connection.db.insert(addressHealthPolicies).values({ endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode: "local", successThreshold: 1 });
  const service = new HealthResultService({ db: connection.db } as never);
  await service.apply({ addressId: f.address.id, addressVersion: 1, configId: f.config.id, configVersion: 1, decision: "success", checkedAt: new Date() });
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, f.address.id)))[0]).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 1 });
});
