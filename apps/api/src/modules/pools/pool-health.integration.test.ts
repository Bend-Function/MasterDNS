import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as db from "@masterdns/db";
import { fixture, testDatabase } from "../probes/health-policy-test-utils.js";
import { PoolsService } from "./pools.service.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let service: PoolsService;
beforeAll(async () => { connection = await testDatabase(); service = new PoolsService({ db: connection.db } as never, {} as never); }, 30000);
afterAll(async () => { await connection?.dispose(); });

it("projects current address health instead of a stale cached Pool failure", async () => {
  const f = await fixture(connection.db);
  await connection.db.update(db.endpointPools).set({ state: "unhealthy" }).where(eq(db.endpointPools.id, f.pool.id));
  await connection.db.update(db.endpointAddresses).set({ healthState: "healthy" }).where(eq(db.endpointAddresses.id, f.address.id));
  expect((await service.list(f.actor as never))[0]).toMatchObject({ state: "healthy", healthyEndpointCount: 1 });
  expect((await service.get(f.actor as never, f.pool.id)).pool.state).toBe("healthy");
});

it("returns inherited cloud probe policy, identity and pending verification without fabricating local results", async () => {
  const f = await fixture(connection.db);
  await connection.db.update(db.endpoints).set({ addressMode: "cloud" }).where(eq(db.endpoints.id, f.endpoint.id));
  await connection.db.delete(db.endpointAddresses).where(eq(db.endpointAddresses.id, f.address.id));
  const [account] = await connection.db.insert(db.cloudAccounts).values({ ownerUserId: f.actor.id, provider: "aws", name: "production", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
  const [instance] = await connection.db.insert(db.cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: "i-edge", name: "edge-us", scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(db.cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-edge", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(db.cloudAddresses).values({ interfaceId: iface!.id, family: "4", kind: "host", address: "192.0.2.40", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(db.managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "public", currentAddressId: address!.id, candidateAddressId: address!.id, candidateVersion: 1 }).returning();
  await connection.db.insert(db.cloudEndpointLinks).values({ slotId: slot!.id, endpointId: f.endpoint.id, family: "4" });
  const [config] = await connection.db.insert(db.healthCheckConfigs).values({ slotId: slot!.id, checkerType: "tcp", config: { type: "tcp", port: 443 } }).returning();
  const [policy] = await connection.db.insert(db.addressHealthPolicies).values({ slotId: slot!.id, family: "4", configId: config!.id, groupId: f.group.id, mode: "external" }).returning();
  const [state] = await connection.db.insert(db.addressHealthStates).values({ slotId: slot!.id, family: "4", addressId: address!.id, addressVersion: 1, policyId: policy!.id, policyRevision: 1, configId: config!.id, configVersion: 1, groupRevision: 1, healthState: "healthy", latestDecision: "success", consecutiveSuccesses: 3, evidenceExpiresAt: new Date(Date.now() + 60000) }).returning();
  const [provider] = await connection.db.insert(db.providerAccounts).values({ ownerUserId: f.actor.id, name: "dns", provider: "cloudflare", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
  const [zone] = await connection.db.insert(db.zones).values({ providerAccountId: provider!.id, externalId: "test", nameAscii: "example.test" }).returning();
  await connection.db.insert(db.domainBindings).values({ poolId: f.pool.id, zoneId: zone!.id, fqdn: "www.example.test", recordType: "A", state: "failed" });
  const detail = await service.get(f.actor as never, f.pool.id);
  expect(detail.pool.state).toBe("unknown");
  expect(detail.bindings[0]).toMatchObject({ awaitingVerification: true, healthState: "unknown" });
  expect(detail.endpoints[0]!.cloudTargets[0]).toMatchObject({ account: { name: "production" }, instance: { name: "edge-us" }, currentAddress: { address: "192.0.2.40" } });
  expect(detail.addressHealthPolicies[0]).toMatchObject({ id: policy!.id, mode: "external", group: { name: "group" }, config: { id: config!.id }, evidenceStatus: "current", state: { healthState: "healthy" } });
  expect(detail.healthResults).toEqual([]);
  await connection.db.update(db.addressHealthStates).set({ evidenceExpiresAt: new Date(Date.now() - 1000) }).where(eq(db.addressHealthStates.id, state!.id));
  expect((await service.get(f.actor as never, f.pool.id)).addressHealthPolicies[0]!.evidenceStatus).toBe("expired");
  await connection.db.update(db.addressHealthStates).set({ consecutiveSuccesses: 1, evidenceExpiresAt: new Date(Date.now() + 60000) }).where(eq(db.addressHealthStates.id, state!.id));
  expect((await service.get(f.actor as never, f.pool.id)).addressHealthPolicies[0]!.evidenceStatus).toBe("waiting");
  const stranger = await fixture(connection.db);
  await expect(service.get(stranger.actor as never, f.pool.id)).rejects.toMatchObject({ status: 404 });
});
