import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as db from "@masterdns/db";
import { PoolsService } from "./pools.service.js";
import type { AuthUser } from "../../auth/auth.types.js";

let admin: ReturnType<typeof db.createDatabase>, connection: ReturnType<typeof db.createDatabase>, service: PoolsService;
const name = `cloud_pool_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  admin = db.createDatabase(root); await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`; connection = db.createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new PoolsService({ db: connection.db } as never, {} as never);
});
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });

async function fixture(family: "4" | "6" = "4") {
  const d = connection.db;
  const [owner] = await d.insert(db.users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, role: "user" } as AuthUser;
  const [pool] = await d.insert(db.endpointPools).values({ ownerUserId: actor.id, name: "Shared cloud", strategy: "assignment_pool" }).returning();
  const [account] = await d.insert(db.cloudAccounts).values({ ownerUserId: actor.id, name: "AWS", provider: "aws", externalAccountId: "123456789012", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
  await d.insert(db.cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  const [instance] = await d.insert(db.cloudInstances).values({ accountId: account!.id, name: "Tokyo", externalId: randomUUID(), service: "ec2", region: "us-east-1", scanGeneration: 1 }).returning();
  const [iface] = await d.insert(db.cloudInterfaces).values({ instanceId: instance!.id, externalId: randomUUID(), scanGeneration: 1 }).returning();
  const [address] = await d.insert(db.cloudAddresses).values({ interfaceId: iface!.id, family, kind: "host", address: family === "4" ? "192.0.2.10" : "2001:db8::10", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await d.insert(db.managedAddressSlots).values({ interfaceId: iface!.id, name: "primary", family, currentAddressId: address!.id }).returning();
  await d.insert(db.instanceAuthorizations).values({ instanceId: instance!.id, managed: true });
  return { d, actor, pool: pool!, account: account!, instance: instance!, iface: iface!, address: address!, slot: slot! };
}

it.each(["4", "6"] as const)("adds an IPv%s cloud slot to an existing Pool without publishing its unverified address", async family => {
  const f = await fixture(family), key = randomUUID();
  const result = await service.addCloudEndpoint(f.actor, f.pool.id, f.slot.id, key);
  expect(result).toMatchObject({ endpoint: { poolId: f.pool.id, addressMode: "cloud", name: "AWS - Tokyo" }, awaitingExternalVerification: true });
  expect(await f.d.select().from(db.cloudEndpointLinks).where(eq(db.cloudEndpointLinks.endpointId, result.endpoint.id))).toMatchObject([{ slotId: f.slot.id, family }]);
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, result.endpoint.id))).toEqual([]);
  expect(await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.poolId, f.pool.id))).toEqual([]);
  expect(await f.d.select().from(db.policyVersions).where(eq(db.policyVersions.poolId, f.pool.id))).toMatchObject([{ snapshot: { cloudLinks: [{ slotId: f.slot.id }] } }]);
  expect(await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pool.id))).toHaveLength(1);
  expect(await service.addCloudEndpoint(f.actor, f.pool.id, f.slot.id, key)).toEqual(result);
  await expect(service.addCloudEndpoint(f.actor, f.pool.id, f.slot.id, randomUUID())).rejects.toMatchObject({ status: 409 });
  expect(await f.d.select().from(db.endpoints).where(eq(db.endpoints.poolId, f.pool.id))).toHaveLength(1);
});

it("keeps cloud and Pool ownership aligned even for administrators", async () => {
  const f = await fixture(), other = await fixture();
  await expect(service.addCloudEndpoint(other.actor, f.pool.id, f.slot.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(service.addCloudEndpoint(f.actor, f.pool.id, other.slot.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(service.addCloudEndpoint({ ...f.actor, role: "admin" }, f.pool.id, other.slot.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  expect(await f.d.select().from(db.endpoints).where(eq(db.endpoints.poolId, f.pool.id))).toEqual([]);
});

it("deduplicates concurrent retries and lets the same slot supply another owned Pool", async () => {
  const f = await fixture(), key = randomUUID();
  const [first, retry] = await Promise.all([
    service.addCloudEndpoint(f.actor, f.pool.id, f.slot.id, key),
    service.addCloudEndpoint(f.actor, f.pool.id, f.slot.id, key),
  ]);
  expect(retry).toEqual(first);
  const [otherPool] = await f.d.insert(db.endpointPools).values({ ownerUserId: f.actor.id, name: "Other domains", strategy: "primary_backup" }).returning();
  await expect(service.addCloudEndpoint(f.actor, otherPool!.id, f.slot.id, key)).rejects.toMatchObject({ status: 409 });
  const second = await service.addCloudEndpoint(f.actor, otherPool!.id, f.slot.id, randomUUID());
  expect(second.endpoint.id).not.toBe(first.endpoint.id);
  expect(await f.d.select().from(db.cloudEndpointLinks).where(eq(db.cloudEndpointLinks.slotId, f.slot.id))).toHaveLength(2);
});

it.each(["revoked", "stale", "disabled"] as const)("rejects %s cloud inventory without leaving a node or receipt", async reason => {
  const f = await fixture(), key = randomUUID();
  if (reason === "revoked") await f.d.update(db.instanceAuthorizations).set({ managed: false }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  if (reason === "stale") await f.d.update(db.cloudScanScopes).set({ generation: 2 }).where(eq(db.cloudScanScopes.accountId, f.account.id));
  if (reason === "disabled") await f.d.update(db.cloudAccounts).set({ enabled: false }).where(eq(db.cloudAccounts.id, f.account.id));
  await expect(service.addCloudEndpoint(f.actor, f.pool.id, f.slot.id, key)).rejects.toMatchObject({ status: 409 });
  expect(await f.d.select().from(db.endpoints).where(eq(db.endpoints.poolId, f.pool.id))).toEqual([]);
  expect(await f.d.select().from(db.cloudApiRequests).where(and(eq(db.cloudApiRequests.actorUserId, f.actor.id), eq(db.cloudApiRequests.key, key)))).toEqual([]);
});
