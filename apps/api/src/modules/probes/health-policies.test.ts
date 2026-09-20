import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressHealthStates, addressHealthPolicies, cloudAccounts, cloudInstances, cloudInterfaces, cloudAddresses, managedAddressSlots, healthCheckConfigs, probeAgents, endpointAddresses } from "@masterdns/db";
import { fixture, testDatabase } from "./health-policy-test-utils.js";
import { HealthPoliciesService } from "./health-policies.service.js";
let connection: Awaited<ReturnType<typeof testDatabase>>;
let service: HealthPoliciesService;
beforeAll(async () => { connection = await testDatabase(); service = new HealthPoliciesService({ db: connection.db } as never); }, 30000);
afterAll(async () => { await connection?.dispose(); });
it("saves owner-scoped family policy with full-cohort defaults and idempotent revision", async () => {
 const f = await fixture(connection.db); const actor = f.actor as never;
 const input = { endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode: "external", groupId: f.group.id };
 const first = await service.save(actor, input);
 expect(first).toMatchObject({ revision: 1, checkIntervalSeconds: 15, executionWindowSeconds: 10, resultExpirySeconds: 60, successThreshold: 3, consensus: { mode: "majority", minimumValid: 2 } });
 expect((await service.save(actor, input)).revision).toBe(1);
 const stranger = await fixture(connection.db);
 await expect(service.save(stranger.actor as never, input)).rejects.toMatchObject({ status: 404 });
 await expect(service.save(actor, { ...input, groupId: stranger.group.id })).rejects.toMatchObject({ status: 404 });
 await expect(service.save(actor, { ...input, networkPolicy: { allowedPrivateCIDRs: ["10.0.0.0/8"] } })).rejects.toMatchObject({ status: 403 });
 expect(await service.list(stranger.actor as never)).toHaveLength(0);
});
it("rejects unsupported-family assignment and incompatible external regex while preserving local JS", async () => {
 const f = await fixture(connection.db); const actor = f.actor as never;
 await connection.db.update(probeAgents).set({ capabilities: { ipv4: false, ipv6: true } }).where(eq(probeAgents.id, f.agents[0]!.id));
 const input = { endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode: "external", groupId: f.group.id };
 await expect(service.save(actor, input)).rejects.toMatchObject({ status: 400 });
 await connection.db.update(probeAgents).set({ capabilities: { ipv4: true, ipv6: true } }).where(eq(probeAgents.id, f.agents[0]!.id));
 await connection.db.update(healthCheckConfigs).set({ checkerType: "http", config: { type: "http", bodyPattern: "a(?=b)" } }).where(eq(healthCheckConfigs.id, f.config.id));
 await expect(service.save(actor, input)).rejects.toThrow();
 expect(await service.save(actor, { ...input, mode: "local", groupId: undefined })).toMatchObject({ mode: "local" });
});
it("creates slot config without any linked endpoint and enforces family and ownership", async () => {
 const f = await fixture(connection.db); const actor = f.actor as never;
 const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: f.actor.id, provider: "aws", name: "test", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
 const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "test", externalId: "i-test", scanGeneration: 1 }).returning();
 const [nic] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-test", scanGeneration: 1 }).returning();
 const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: nic!.id, kind: "host", family: "4", address: "192.0.2.20", origin: "user", scanGeneration: 1 }).returning();
 const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: nic!.id, family: "4", name: "primary", currentAddressId: address!.id }).returning();
 expect(await service.slotConfig(actor, slot!.id)).toBeNull();
 const config = await service.saveSlotConfig(actor, slot!.id, { config: { type: "tcp", port: 443 } });
 expect(config.slotId).toBe(slot!.id);
 expect((await service.slotConfig(actor, slot!.id))!.id).toBe(config.id);
 const stranger = await fixture(connection.db);
 await expect(service.slotConfig(stranger.actor as never, slot!.id)).rejects.toMatchObject({ status: 404 });
 const input = { slotId: slot!.id, family: "4", configId: config.id, mode: "external", groupId: f.group.id };
 expect(await service.save(actor, input)).toMatchObject({ slotId: slot!.id, endpointId: null });
 await expect(service.save(actor, { ...input, family: "6" })).rejects.toMatchObject({ status: 400 });
 expect(await connection.db.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.slotId, slot!.id))).toHaveLength(1);
 const http = await service.saveSlotConfig(actor, slot!.id, { config: { type: "http", headers: { "x-long-header": "b", "x-a": "a" } } });
 const expiresAt = new Date(Date.now()+60000);
 const [state] = await connection.db.insert(addressHealthStates).values({ slotId: slot!.id, family: "4", latestDecision: "success", evidenceExpiresAt: expiresAt, consecutiveSuccesses: 3 }).returning();
 const repeated = await service.saveSlotConfig(actor, slot!.id, { config: { type: "http", headers: { "x-a": "a", "x-long-header": "b" } } });
 expect(repeated.revision).toBe(http.revision);
 expect((await service.saveSlotConfig(actor, slot!.id, { config: { type: "http", headers: { "x-long-header": "b", "x-a": "a" } } })).revision).toBe(http.revision);
 expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.id, state!.id)))[0]).toMatchObject({ latestDecision: "success", evidenceExpiresAt: expiresAt });
 const local = await service.save(actor, { ...input, configId: http.id, mode: "local", consensus: { mode: "at_least", minimumValid: 2, failureVotes: 2 } });
 expect(local).toMatchObject({ mode: "local", groupId: null, consensus: { mode: "all", minimumValid: 1 } });
});
it("preserves revision and evidence for reordered JSONB consensus and HTTP headers", async () => {
 const f = await fixture(connection.db); const actor = f.actor as never;
 const input = { endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode: "external", groupId: f.group.id, consensus: { mode: "at_least", minimumValid: 2, failureVotes: 1 } };
 const policy = await service.save(actor, input);
 const expiresAt = new Date(Date.now()+60000);
 const [state] = await connection.db.insert(addressHealthStates).values({ endpointId: f.endpoint.id, family: "4", latestDecision: "success", evidenceExpiresAt: expiresAt, consecutiveSuccesses: 3 }).returning();
 expect((await service.save(actor, { ...input, consensus: { failureVotes: 1, minimumValid: 2, mode: "at_least" } })).revision).toBe(policy.revision);
 expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.id, state!.id)))[0]).toMatchObject({ latestDecision: "success", evidenceExpiresAt: expiresAt });
});

it("reports current health separately from failed candidate and excludes previous addresses", async () => {
 const f = await fixture(connection.db, "ddns");
 const input = { endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode: "external", groupId: f.group.id };
 const policy = await service.save(f.actor as never, input);
 const [current, previous] = await connection.db.insert(endpointAddresses).values([
   { endpointId: f.endpoint.id, family: "4", address: "192.0.2.10", state: "current", source: "ddns" },
   { endpointId: f.endpoint.id, family: "4", address: "192.0.2.11", state: "previous", source: "ddns" },
 ]).returning();
 const rows = await connection.db.insert(addressHealthStates).values([
   { endpointId: f.endpoint.id, family: "4", addressId: f.address.id, policyId: policy.id, healthState: "unhealthy" },
   { endpointId: f.endpoint.id, family: "4", addressId: previous!.id, policyId: policy.id, healthState: "healthy" },
   { endpointId: f.endpoint.id, family: "4", addressId: current!.id, policyId: policy.id, healthState: "healthy" },
 ]).returning();
 const [listed] = await service.list(f.actor as never);
 expect(listed!.state).toMatchObject({ addressId: current!.id, healthState: "healthy" });
 expect((listed as any).states).toMatchObject([
   { addressId: current!.id, address: "192.0.2.10", addressRole: "current", healthState: "healthy" },
   { addressId: f.address.id, addressRole: "candidate", healthState: "unhealthy" },
 ]);
 await service.save(f.actor as never, { ...input, successThreshold: 4 });
 for (const row of rows) expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.id, row.id)))[0]!.healthState).toBe("unknown");
});
