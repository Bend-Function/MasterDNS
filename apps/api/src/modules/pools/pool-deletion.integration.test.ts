import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as db from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
import { fixture, testDatabase } from "../probes/health-policy-test-utils.js";
import { PoolsService } from "./pools.service.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let service: PoolsService;
beforeAll(async () => {
  connection = await testDatabase();
  service = new PoolsService({ db: connection.db } as never, {} as never);
}, 30000);
afterAll(async () => { await connection?.dispose(); });

async function setup() {
  const f = await fixture(connection.db);
  const actor = f.actor as AuthUser;
  const [provider] = await connection.db.insert(db.providerAccounts).values({ ownerUserId: actor.id, name: "dns", provider: "cloudflare", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
  const [zone] = await connection.db.insert(db.zones).values({ providerAccountId: provider!.id, externalId: randomUUID(), nameAscii: "example.test" }).returning();
  return { ...f, actor, zone: zone! };
}

async function record(f: Awaited<ReturnType<typeof setup>>, deleted: boolean) {
  return (await connection.db.insert(db.dnsRecords).values({ zoneId: f.zone.id, externalId: randomUUID(), type: "A", name: "www.example.test", content: "192.0.2.1", ttl: 60, remoteHash: "test", management: "managed", managedByPoolId: f.pool.id, deletedAt: deleted ? new Date() : null }).returning())[0]!;
}

it("deletes a newly created empty Pool", async () => {
  const f = await setup();
  await connection.db.delete(db.endpoints).where(eq(db.endpoints.id, f.endpoint.id));
  await expect(service.remove(f.actor, f.pool.id)).resolves.toEqual({ deleted: true });
  expect(await connection.db.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pool.id))).toHaveLength(0);
});

it("deletes an empty Pool with a sync-deleted managed record while preserving DNS history", async () => {
  const f = await setup();
  const historical = await record(f, true);
  await connection.db.delete(db.endpoints).where(eq(db.endpoints.id, f.endpoint.id));
  await expect(service.remove(f.actor, f.pool.id)).resolves.toEqual({ deleted: true });
  expect(await connection.db.select().from(db.dnsRecords).where(eq(db.dnsRecords.id, historical.id))).toMatchObject([{ management: "unmanaged", managedByPoolId: null, deletedAt: historical.deletedAt }]);
});

it("returns a conflict for a live managed record even without bindings", async () => {
  const f = await setup();
  const live = await record(f, false);
  await expect(service.remove(f.actor, f.pool.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(db.dnsRecords).where(eq(db.dnsRecords.id, live.id))).toMatchObject([{ management: "managed", managedByPoolId: f.pool.id }]);
});

it("retains Pool bindings and referenced endpoints", async () => {
  const f = await setup();
  await connection.db.insert(db.domainBindings).values({ poolId: f.pool.id, zoneId: f.zone.id, fqdn: "www.example.test", recordType: "A", originalEndpointId: f.endpoint.id });
  await expect(service.remove(f.actor, f.pool.id)).rejects.toMatchObject({ status: 409 });
  await expect(service.deleteEndpoint(f.actor, f.pool.id, f.endpoint.id)).rejects.toMatchObject({ status: 409 });
});

it("rechecks endpoint references after a concurrent Pool mutation completes", async () => {
  const f = await setup();
  let entered!: () => void;
  const transactionEntered = new Promise<void>(resolve => { entered = resolve; });
  const guarded = new PoolsService({ db: {
    select: connection.db.select.bind(connection.db),
    transaction: (...args: Parameters<typeof connection.db.transaction>) => {
      entered();
      return connection.db.transaction(...args);
    },
  } } as never, {} as never);
  let deletion!: Promise<unknown>;
  await connection.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${f.pool.id}))`);
    await tx.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pool.id)).for("update");
    deletion = guarded.deleteEndpoint(f.actor, f.pool.id, f.endpoint.id);
    await transactionEntered;
    await tx.insert(db.domainBindings).values({ poolId: f.pool.id, zoneId: f.zone.id, fqdn: "concurrent.example.test", recordType: "A", originalEndpointId: f.endpoint.id });
  });
  await expect(deletion).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(db.endpoints).where(eq(db.endpoints.id, f.endpoint.id))).toHaveLength(1);
});

it.each(["endpoint", "check"] as const)("rolls back %s deletion when audit persistence fails", async kind => {
  const f = await setup();
  const invalidActor = { ...f.actor, id: randomUUID(), role: "admin" } as AuthUser;
  await expect(kind === "endpoint" ? service.deleteEndpoint(invalidActor, f.pool.id, f.endpoint.id) : service.deleteHealthCheck(invalidActor, f.pool.id, f.config.id)).rejects.toThrow();
  expect(await connection.db.select().from(db.endpoints).where(eq(db.endpoints.id, f.endpoint.id))).toHaveLength(1);
  expect(await connection.db.select().from(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.config.id))).toHaveLength(1);
  expect(await connection.db.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pool.id))).toMatchObject([{ policyRevision: f.pool.policyRevision }]);
});

it.each(["endpoint", "check"] as const)("deletes %s and records the policy change atomically", async kind => {
  const f = await setup();
  await expect(kind === "endpoint" ? service.deleteEndpoint(f.actor, f.pool.id, f.endpoint.id) : service.deleteHealthCheck(f.actor, f.pool.id, f.config.id)).resolves.toEqual({ deleted: true });
  expect(await connection.db.select().from(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.config.id))).toHaveLength(0);
  expect(await connection.db.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pool.id))).toMatchObject([{ policyRevision: f.pool.policyRevision + 1 }]);
});

it.each(["pool", "endpoint", "check"] as const)("rejects another owner's %s deletion", async kind => {
  const f = await setup();
  const stranger = { ...f.actor, id: randomUUID() };
  const deletion = kind === "pool" ? service.remove(stranger, f.pool.id)
    : kind === "endpoint" ? service.deleteEndpoint(stranger, f.pool.id, f.endpoint.id)
      : service.deleteHealthCheck(stranger, f.pool.id, f.config.id);
  await expect(deletion).rejects.toMatchObject({ status: 404 });
  expect(await connection.db.select().from(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.config.id))).toHaveLength(1);
});

it("rolls back historical record cleanup if Pool deletion audit fails", async () => {
  const f = await setup();
  const historical = await record(f, true);
  await expect(service.remove({ ...f.actor, id: randomUUID(), role: "admin" }, f.pool.id)).rejects.toThrow();
  expect(await connection.db.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pool.id))).toHaveLength(1);
  expect(await connection.db.select().from(db.dnsRecords).where(eq(db.dnsRecords.id, historical.id))).toMatchObject([{ management: "managed", managedByPoolId: f.pool.id }]);
});
