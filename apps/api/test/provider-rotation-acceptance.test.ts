import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withDnsZoneLock } from "@masterdns/automation";
import { encryptJson } from "@masterdns/crypto";
import type { CloudCredentials } from "@masterdns/cloud-providers";
import type { DnsRecordInput, ProviderRecord } from "@masterdns/contracts";
import * as db from "@masterdns/db";
vi.mock("../src/config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
vi.mock("../../worker/src/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudBindingsService } from "../src/modules/cloud/cloud-bindings.service.js";
import { fixture } from "../../worker/src/rotation/rotation-test-utils.js";
import { CloudSyncService } from "../../worker/src/cloud/cloud-sync.service.js";
import { CloudRuntimeService } from "../../worker/src/cloud/cloud-runtime.service.js";
import { RotationStore } from "../../worker/src/rotation/rotation-store.js";
import { RotationProcessor } from "../../worker/src/rotation/rotation.processor.js";
import { RotationCleanupService } from "../../worker/src/rotation/rotation-cleanup.service.js";
import { RotationPublicationService } from "../../worker/src/rotation/rotation-publication.service.js";
import { ReconcileProcessor } from "../../worker/src/automation/reconcile.processor.js";
import { OperationProcessor } from "../../worker/src/operations/operation.processor.js";
let redis: Redis;
beforeAll(async () => { redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null }); await redis.ping(); });
afterAll(async () => { vi.unstubAllGlobals(); await redis?.quit(); });

type HttpCloud = { credentials: CloudCredentials; externalAccountId: string; service: "azure_vm" | "linode"; region: string; instanceId: string; interfaceId: string; oldAddress: string; candidateAddress: string; fetch: typeof fetch; writes: string[]; mutateOwner(): void; advanceCandidate(): void };
async function setup(remote: HttpCloud, trigger: "health" | "scheduled" = "health") {
  const f = await fixture();
  const encrypted = encryptJson(remote.credentials, Buffer.alloc(32, 1));
  await f.d.update(db.cloudAccounts).set({ provider: remote.service === "azure_vm" ? "azure" : "linode", externalAccountId: remote.externalAccountId, credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).where(eq(db.cloudAccounts.id, f.account.id));
  await f.d.insert(db.cloudScanScopes).values({ accountId: f.account.id, service: remote.service, region: remote.region, generation: 1 });
  await f.d.update(db.cloudInstances).set({ service: remote.service, region: remote.region, externalId: remote.instanceId }).where(eq(db.cloudInstances.id, f.instance.id));
  await f.d.update(db.cloudInterfaces).set({ externalId: remote.interfaceId }).where(eq(db.cloudInterfaces.id, f.slot.interfaceId));
  await f.d.update(db.cloudAddresses).set({ address: remote.oldAddress }).where(eq(db.cloudAddresses.id, f.address.id));
  await f.d.update(db.endpointAddresses).set({ address: remote.oldAddress }).where(eq(db.endpointAddresses.address, f.address.address));
  await f.d.update(db.instanceAuthorizations).set({ allowIpv4Rotation: true, allowStopStart: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.insert(db.rotationPolicies).values({ slotId: f.slot.id, enabled: trigger === "health" });
  vi.stubGlobal("fetch", remote.fetch);
  const runtime = new CloudRuntimeService({ db: f.d } as never);
  const adapter = await runtime.adapter(f.account.id, remote.service);
  const inventory = await adapter.inspect({ accountId: f.account.id, service: remote.service, region: remote.region, instanceId: remote.instanceId });
  const selected = inventory.interfaces.find(i => i.id === remote.interfaceId)!.addresses.find(a => a.address === remote.oldAddress)!;
  await f.d.update(db.cloudAddresses).set({ remoteAllocationId: selected.allocationId, metadata: { providerMetadata: selected.metadata ?? {}, ...(selected.resourceId ? { resourceId: selected.resourceId } : {}) } }).where(eq(db.cloudAddresses.id, f.address.id));
  const publication = new RotationPublicationService({ db: f.d } as never, runtime);
  const cleanup = new RotationCleanupService({ db: f.d } as never, runtime);
  const store = new RotationStore({ db: f.d } as never);
  const processor = new RotationProcessor(store, runtime, {} as never, publication, cleanup);
  const [dnsAccount] = await f.d.insert(db.providerAccounts).values({ ownerUserId: f.account.ownerUserId, provider: "cloudflare", name: "DNS", credentialCiphertext: "test", credentialIv: "iv", credentialTag: "tag", status: "active" }).returning();
  const [zone] = await f.d.insert(db.zones).values({ providerAccountId: dnsAccount!.id, externalId: randomUUID(), nameAscii: "rotation.test" }).returning();
  const bindings = new CloudBindingsService({ db: f.d } as never, { withDnsZoneLock: (id: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, id, action) } as never);
  await bindings.bind({ id: f.account.ownerUserId, role: "user" } as never, { zoneId: zone!.id, fqdn: "www", recordType: "A", slotId: f.slot.id, poolId: f.pools[0]!.id, takeoverExisting: false }, randomUUID());
  const records = new Map<string, ProviderRecord>();
  const dnsWrites: string[] = [];
  const queues = { redis, operations: { add: async () => ({}) }, notifications: { add: async () => ({}) } };
  const reconcile = new ReconcileProcessor({ db: f.d } as never, queues as never);
  const operations = new OperationProcessor({ db: f.d } as never, queues as never, { forAccount: async () => ({ adapter: {
    provider: "cloudflare", listRecords: async () => ({ items: [...records.values()] }), getRecord: async (_zone: string, id: string) => records.get(id) ?? null,
    createRecord: async (zone: string, record: DnsRecordInput) => { dnsWrites.push(record.content); const result = { ...record, externalId: randomUUID(), zoneExternalId: zone }; records.set(result.externalId, result); return result; },
    updateRecord: async (zone: string, id: string, record: DnsRecordInput) => { dnsWrites.push(record.content); const result = { ...record, externalId: id, zoneExternalId: zone }; records.set(id, result); return result; },
  } }) } as never, runtime);
  async function reconcilePending(runOperations = true) {
    for (const pool of f.pools) {
      for (const intent of await f.d.select().from(db.reconcileIntents).where(and(eq(db.reconcileIntents.poolId, pool.id), isNull(db.reconcileIntents.completedAt)))) await (reconcile as any).process({ data: intent });
      if (runOperations) for (const operation of await f.d.select().from(db.operations).where(eq(db.operations.resourceId, pool.id))) await (operations as any).process({ data: { operationId: operation.id }, attemptsMade: 0, opts: { attempts: 1 } });
    }
  }
  await publication.publishSlot(f.slot.id);
  await reconcilePending();
  const [initialPublication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id));
  await publication.observe(initialPublication!.id);
  const setHealth = async (decision: "success" | "failure") => {
    const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
    await f.d.update(db.addressHealthStates).set({ addressId: slot!.candidateAddressId ?? slot!.currentAddressId, addressVersion: slot!.candidateAddressId ? slot!.candidateVersion : slot!.currentVersion, healthState: decision === "success" ? "healthy" : "unhealthy", latestDecision: decision, consecutiveSuccesses: decision === "success" ? 3 : 0, consecutiveFailures: decision === "failure" ? 3 : 0, lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000) }).where(eq(db.addressHealthStates.slotId, f.slot.id));
  };
  await setHealth(trigger === "health" ? "failure" : "success");
  if (trigger === "scheduled") await f.d.insert(db.rotationSchedules).values({ slotId: f.slot.id, enabled: true, nextRunAt: new Date(0) });
  const incident = await f.d.transaction(async tx => trigger === "health"
    ? db.createRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), randomUUID())
    : db.createScheduledRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id)));
  const drive = async (turns = 1) => { for (let n = 0; n < turns; n++) await processor.run(incident.id); };
  return { ...f, runtime, inventory, incident, processor, publication, cleanup, drive, setHealth, reconcilePending, dnsWrites };
}

function linodeCloud(): HttpCloud {
  const number = ++fixtureNumber;
  const oldAddress = `203.0.113.${100 + number * 2}`, customer = `customer-${randomUUID()}`;
  let candidateAddress = `203.0.113.${101 + number * 2}`;
  const ips = [oldAddress];
  const events: Array<Record<string, unknown>> = [{ id: 10, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished", username: "operator" }];
  const writes: string[] = [];
  let owner = 42;
  const ip = (address: string) => ({ address, type: "ipv4", public: true, linode_id: owner, region: "us-east", reserved: false });
  return { credentials: { kind: "linode_token", token: "secret-token" }, externalAccountId: customer, service: "linode", region: "us-east", instanceId: "42", interfaceId: "public", oldAddress, get candidateAddress() { return candidateAddress; }, advanceCandidate: () => { candidateAddress = `203.0.113.${151 + number * 2}`; }, writes, mutateOwner: () => { owner = 43; }, fetch: async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace("/v4", ""), method = init?.method ?? "GET";
    expect(url.origin).toBe("https://api.linode.com"); expect(init?.redirect).toBe("manual");
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-Customer-UUID": customer, "X-OAuth-Scopes": "linodes:read_write ips:read_only events:read_only" } });
    const page = (data: unknown[]) => response({ data, page: 1, pages: 1, results: data.length });
    if (method !== "GET") {
      writes.push(`${method} ${path}`);
      if (method === "POST" && path.endsWith("/ips")) { ips.push(candidateAddress); return response(ip(candidateAddress)); }
      if (method === "POST" && path.endsWith("/reboot")) { events.push({ id: 10 + events.length, action: "linode_reboot", entity: { type: "linode", id: 42 }, status: "finished", username: "operator" }); return response({}); }
      if (method === "DELETE" && path.startsWith("/linode/instances/42/ips/")) { ips.splice(ips.indexOf(path.split("/").at(-1)!), 1); return response({}); }
      throw new Error(`Unexpected mutation ${method} ${path}`);
    }
    if (path === "/profile") return response({ username: "operator" });
    if (path === "/linode/instances/42") return response({ id: 42, label: "web", region: "us-east", status: "running", interface_generation: "legacy_config" });
    if (path === "/linode/instances/42/configs") return page([{ id: 7, helpers: { network: true }, interfaces: [], run_level: "default" }]);
    if (path === "/linode/instances/42/ips") return response({ ipv4: { public: ips.map(ip), private: [], shared: [], reserved: [] }, ipv6: { slaac: null, global: [] } });
    if (path === "/account/events") return page(events);
    if (path.startsWith("/networking/ips/")) { const address = path.split("/").at(-1)!; return ips.includes(address) ? response(ip(address)) : response({}, 404); }
    throw new Error(`Unexpected request ${method} ${path}`);
  } };
}

import { fixture as azureFixture, credentials as azureCredentials, vmId, nicId, configId, pipId } from "../../../packages/cloud-providers/src/azure-fixtures.js";
let fixtureNumber = 0;
function azureCloud(): HttpCloud & { setNicState(state: string): void; setCandidateGuid(guid: string | undefined): void; refreshDiscovery(): void; setCandidateSupported(supported: boolean): void } {
  const remote = azureFixture();
  const number = ++fixtureNumber;
  const subscription = `subscription-${randomUUID()}`;
  const arm = (value: string) => value.replaceAll("subscription-1", subscription);
  const oldAddress = `20.30.40.${100 + number * 2}`;
  let candidateAddress = `20.30.40.${101 + number * 2}`;
  remote.resources[pipId].properties.ipAddress = oldAddress;
  return { credentials: { ...azureCredentials, subscriptionId: subscription }, externalAccountId: subscription, service: "azure_vm", region: "eastus", instanceId: arm(vmId), interfaceId: arm(configId), oldAddress, get candidateAddress() { return candidateAddress; }, advanceCandidate: () => { candidateAddress = `20.30.40.${151 + number * 2}`; },
    setNicState: state => { remote.resources[nicId].properties.provisioningState = state; },
    setCandidateGuid: guid => { for (const [id, resource] of Object.entries(remote.resources)) if (id.includes('/publicIPAddresses/masterdns-')) resource.properties.resourceGuid = guid; },
    refreshDiscovery: () => remote.setPages([{ value: [remote.resources[vmId]] }]),
    setCandidateSupported: supported => { for (const [id, resource] of Object.entries(remote.resources)) if (id.includes('/publicIPAddresses/masterdns-')) { if (supported) delete resource.properties.dnsSettings; else resource.properties.dnsSettings = { domainNameLabel: 'external-change' }; } },
    get writes() { return remote.writes.map(write => `${write.method} ${write.url}`); },
    mutateOwner: () => { remote.resources[nicId].properties.virtualMachine.id = `${vmId}-foreign`; },
    fetch: async (input, init) => {
      const inputBase = String(input).replaceAll(subscription, "subscription-1");
      const initBase = init?.body ? { ...init, body: String(init.body).replaceAll(subscription, "subscription-1") } : init;
      const result = await remote.fetcher(inputBase, initBase);
      const path = new URL(inputBase).pathname;
      if (init?.method === "PUT" && path.includes("/publicIPAddresses/") && result.ok) {
        remote.resources[path].properties.ipAddress = candidateAddress;
        remote.resources[path].properties.resourceGuid = `candidate-${number}`;
        return new Response(arm(JSON.stringify(remote.resources[path])), { status: result.status, headers: result.headers });
      }
      return new Response(result.status === 204 ? null : arm(await result.text()), { status: result.status, headers: result.headers });
    },
  };
}

it.each(["azure", "linode"] as const)("rotates %s through the real runtime and publishes DNS only after fresh candidate verification", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const f = await setup(remote);
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  await f.drive(5);
  const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  expect(slot).toMatchObject({ currentVersion: 1, candidateVersion: 2 });
  const [candidate] = await f.d.select().from(db.cloudAddresses).where(eq(db.cloudAddresses.id, slot!.candidateAddressId!));
  expect(candidate!.address).toBe(remote.candidateAddress);
  expect(candidate!.metadata.providerMetadata).not.toEqual({});
  expect(remote.writes).toHaveLength(2);
  await f.drive(); await f.reconcilePending();
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  await f.publication.observe(publication!.id);
  expect(f.dnsWrites).toEqual([remote.oldAddress, remote.candidateAddress]);
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, publication!.id)))[0]!.status).toBe("applied");
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.incidentId, f.incident.id)))[0]!.attemptsUsed).toBe(1);
});
it.each(["azure", "linode"] as const)("rotates scheduled %s with the existing cloud steps, budget and publication verification", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const f = await setup(remote, "scheduled");
  expect(f.incident.trigger).toBe("scheduled");
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  await f.drive(5);
  expect(remote.writes).toHaveLength(2);
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.incidentId, f.incident.id)))[0]).toMatchObject({ attemptsUsed: 1, maxAttempts: 3 });
  await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  await f.publication.observe(publication!.id);
  expect(f.dnsWrites).toEqual([remote.oldAddress, remote.candidateAddress]);
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, publication!.id)))[0]!.status).toBe("applied");
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ phase: "cleanup", status: "active" });
});
it.each(["azure", "linode"] as const)("blocks a foreign %s resource before any new cloud effect", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const f = await setup(remote);
  await f.drive(); remote.mutateOwner(); await f.drive();
  expect(remote.writes).toEqual([]);
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
});
it.each(["azure", "linode"] as const)("blocks %s credential changes between adapter creation and durable dispatch", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const f = await setup(remote);
  await f.drive();
  const adapter = f.runtime.adapter.bind(f.runtime);
  vi.spyOn(f.runtime, "adapter").mockImplementation(async (...args) => {
    const result = await adapter(...args);
    await f.d.update(db.cloudAccounts).set({ credentialCiphertext: "changed-after-authentication" }).where(eq(db.cloudAccounts.id, f.account.id));
    return result;
  });
  await f.drive();
  expect(remote.writes).toEqual([]);
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
});

it.each(["azure", "linode"] as const)("recovers a lost %s cleanup DELETE with stable provider identity and no redispatch", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const originalFetch = remote.fetch;
  let loseDelete = true;
  remote.fetch = async (...args) => { const result = await originalFetch(...args); if (args[1]?.method === "DELETE" && loseDelete) { loseDelete = false; throw new Error("lost-delete-response"); } return result; };
  const f = await setup(remote);
  await f.drive(5); await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  await f.publication.observe(publication!.id);
  await f.d.update(db.instanceAuthorizations).set({ allowReleaseAddress: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  const [original] = await f.d.update(db.rotationResources).set({ cleanupStatus: "pending", cleanupDueAt: new Date(0), cleanupAddressVersion: 2 }).where(and(eq(db.rotationResources.incidentId, f.incident.id), eq(db.rotationResources.role, "original"))).returning();
  await f.cleanup.run(original!.id, new Date());
  expect(remote.writes.filter(write => write.startsWith("DELETE"))).toHaveLength(1);
  await f.cleanup.run(original!.id, new Date());
  expect(remote.writes.filter(write => write.startsWith("DELETE"))).toHaveLength(1);
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, original!.id));
  if (provider === "azure") expect(resource!.cleanupStatus).toBe("released");
  else {
    expect(resource!.cleanupStatus).toBe("pending");
    const steps = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, original!.attemptId));
    const release = steps.find(step => step.plan.action === "linode.ipv4.release")!;
    expect(release.receipt).toMatchObject({ before: { eventWatermark: 11 } });
    await f.d.update(db.rotationIncidents).set({ status: "paused", pausedByUserId: f.account.ownerUserId }).where(eq(db.rotationIncidents.id, f.incident.id));
    await f.cleanup.run(original!.id, new Date());
    expect(remote.writes.filter(write => write.includes("/reboot"))).toHaveLength(1);
    await f.d.transaction(async tx => db.resumeRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), f.incident.id, f.account.ownerUserId));
    await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, original!.id));
    await f.cleanup.run(original!.id, new Date()); await f.cleanup.run(original!.id, new Date());
    expect(remote.writes.filter(write => write.includes("/reboot"))).toHaveLength(2);
    expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, original!.id)))[0]!.cleanupStatus).toBe("released");
    await f.cleanup.complete(f.incident.id);
    expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ phase: "cleanup", errorCode: "probe_insufficient" });
  }
});

it.each(["azure", "linode"] as const)("cleans the original and failed %s candidate from attempt one after attempt two publishes", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const f = await setup(remote);
  await f.drive(5);
  const failedAddress = remote.candidateAddress;
  await f.setHealth("failure");
  remote.advanceCandidate();
  await f.d.update(db.rotationIncidents).set({ nextAttemptAt: new Date(0) }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.drive(5);
  const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  expect(slot!.candidateVersion).toBe(3);
  await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  await f.publication.observe(publication!.id);
  expect(f.dnsWrites).toEqual([remote.oldAddress, remote.candidateAddress]);
  await f.d.update(db.instanceAuthorizations).set({ allowReleaseAddress: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  const resources = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.incidentId, f.incident.id));
  const old = resources.find(resource => resource.address === remote.oldAddress)!;
  const failed = resources.find(resource => resource.address === failedAddress && resource.role === "candidate")!;
  for (const resource of [old, failed]) {
    await f.d.update(db.rotationResources).set({ cleanupStatus: "pending", cleanupDueAt: new Date(0), cleanupAddressVersion: 3 }).where(eq(db.rotationResources.id, resource.id));
    for (let n = 0; n < (provider === "linode" ? 4 : 2); n++) await f.cleanup.run(resource.id, new Date());
    expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, resource.id)))[0]!.cleanupStatus).toBe("released");
  }
  const alias = resources.find(resource => resource.address === failedAddress && resource.role === "original")!;
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, alias.id)))[0]).toMatchObject({ cleanupStatus: "released", snapshot: { cleanupCanonicalResourceId: failed.id } });
  await f.cleanup.run(alias.id, new Date());
  expect(remote.writes.filter(write => write.startsWith("DELETE"))).toHaveLength(2);
  if (provider === "linode") expect(remote.writes.filter(write => write.includes("/reboot"))).toHaveLength(4);
});

it.each(["azure", "linode"] as const)("cleans an allocated but never activated %s candidate using its own immutable allocation proof", async provider => {
  const remote = provider === "azure" ? azureCloud() : linodeCloud();
  const f = await setup(remote);
  await f.drive(3);
  expect(remote.writes).toHaveLength(1);
  const [candidate] = await f.d.select().from(db.rotationResources).where(and(eq(db.rotationResources.incidentId, f.incident.id), eq(db.rotationResources.role, "candidate")));
  expect(candidate!.address).toBe(remote.candidateAddress);
  await f.d.update(db.rotationIncidents).set({ phase: "cleanup" }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.update(db.rotationPublications).set({ incidentId: f.incident.id }).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.d.update(db.rotationResources).set({ cleanupStatus: "pending", cleanupDueAt: new Date(0), cleanupAddressVersion: 1 }).where(eq(db.rotationResources.id, candidate!.id));
  for (let n = 0; n < (provider === "linode" ? 4 : 2); n++) await f.cleanup.run(candidate!.id, new Date());
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, candidate!.id)))[0]!.cleanupStatus).toBe("released");
  expect(remote.writes.filter(write => write.startsWith("DELETE"))).toHaveLength(1);
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  const live = await (await f.runtime.adapter(f.account.id, remote.service)).inspect({ ...f.inventory.ref });
  expect(live.interfaces.flatMap(iface => iface.addresses).some(address => address.address === remote.oldAddress)).toBe(true);
});

it.each(["missing", "wrong"] as const)("observes a cleanup reboot whose successful response has a %s customer header without redispatch", async fault => {
  const remote = linodeCloud();
  const fetch = remote.fetch;
  let corrupt = false;
  remote.fetch = async (...args) => {
    const result = await fetch(...args);
    if (!corrupt || args[1]?.method !== "POST" || !String(args[0]).endsWith("/reboot")) return result;
    const headers = new Headers(result.headers);
    if (fault === "missing") headers.delete("X-Customer-UUID"); else headers.set("X-Customer-UUID", "wrong-customer");
    return new Response(await result.text(), { status: result.status, headers });
  };
  const f = await setup(remote);
  await f.drive(5); await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  await f.publication.observe(publication!.id);
  await f.d.update(db.instanceAuthorizations).set({ allowReleaseAddress: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  const [old] = await f.d.update(db.rotationResources).set({ cleanupStatus: "pending", cleanupDueAt: new Date(0), cleanupAddressVersion: 2 }).where(and(eq(db.rotationResources.incidentId, f.incident.id), eq(db.rotationResources.role, "original"))).returning();
  await f.cleanup.run(old!.id, new Date()); await f.cleanup.run(old!.id, new Date());
  corrupt = true;
  await f.cleanup.run(old!.id, new Date());
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, old!.id));
  const [step] = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!));
  expect(step).toMatchObject({ status: "in_flight", plan: { action: "linode.instance.reboot" } });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe(step!.id);
  await f.cleanup.run(old!.id, new Date()); await f.cleanup.run(old!.id, new Date());
  expect(remote.writes.filter(write => write.includes("/reboot"))).toHaveLength(2);
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, step!.id)))[0]).toMatchObject({ status: "applied", receipt: { operationId: "12" } });
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.id, f.incident.currentSegmentId)))[0]!.attemptsUsed).toBe(1);
});
it.each(["missing", "wrong"] as const)("retains a charged unknown allocation after a successful POST with a %s customer header", async fault => {
  const remote = linodeCloud();
  const fetch = remote.fetch;
  remote.fetch = async (...args) => {
    const result = await fetch(...args);
    if (args[1]?.method !== "POST" || !String(args[0]).endsWith("/ips")) return result;
    const headers = new Headers(result.headers);
    if (fault === "missing") headers.delete("X-Customer-UUID"); else headers.set("X-Customer-UUID", "wrong-customer");
    return new Response(await result.text(), { status: result.status, headers });
  };
  const f = await setup(remote);
  await f.drive(2);
  const [attempt] = await f.d.select().from(db.rotationAttempts).where(eq(db.rotationAttempts.incidentId, f.incident.id));
  const [step] = await f.d.select().from(db.rotationSteps).where(and(eq(db.rotationSteps.attemptId, attempt!.id), eq(db.rotationSteps.sequence, 0)));
  expect(step!.status).toBe("in_flight");
  expect(attempt!.charged).toBe(true);
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe(step!.id);
  await f.drive(3);
  expect(remote.writes).toHaveLength(1);
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, step!.id)))[0]!.status).toBe("ambiguous");
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.id, f.incident.currentSegmentId)))[0]!.attemptsUsed).toBe(1);
});

it.each([{ provider: "linode", fault: "missing" }, { provider: "linode", fault: "wrong" }, { provider: "azure", fault: "operation URL" }] as const)("observes $provider cleanup DELETE after invalid successful $fault response evidence", async ({ provider, fault }) => {
  const remote = provider === "linode" ? linodeCloud() : azureCloud();
  const fetch = remote.fetch;
  const destinations: string[] = [];
  remote.fetch = async (...args) => {
    destinations.push(new URL(String(args[0])).hostname);
    const result = await fetch(...args);
    if (args[1]?.method !== "DELETE") return result;
    const headers = new Headers(result.headers);
    if (fault === "missing") headers.delete("X-Customer-UUID");
    else if (fault === "wrong") headers.set("X-Customer-UUID", "wrong-customer");
    else headers.set("Azure-AsyncOperation", "https://foreign.test/operation");
    return new Response(result.status === 204 ? null : await result.text(), { status: result.status, headers });
  };
  const f = await setup(remote);
  await f.drive(5); await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  await f.publication.observe(publication!.id);
  await f.d.update(db.instanceAuthorizations).set({ allowReleaseAddress: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  const [old] = await f.d.update(db.rotationResources).set({ cleanupStatus: "pending", cleanupDueAt: new Date(0), cleanupAddressVersion: 2 }).where(and(eq(db.rotationResources.incidentId, f.incident.id), eq(db.rotationResources.role, "original"))).returning();
  await f.cleanup.run(old!.id, new Date());
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, old!.id));
  const [step] = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!));
  expect(step!.status).toBe("in_flight");
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe(step!.id);
  await f.cleanup.run(old!.id, new Date());
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, step!.id)))[0]!.status).toBe("applied");
  expect(remote.writes.filter(write => write.startsWith("DELETE"))).toHaveLength(1);
  expect(destinations).not.toContain("foreign.test");
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.id, f.incident.currentSegmentId)))[0]!.attemptsUsed).toBe(1);
});
it("still rejects a confirmed pre-write Linode identity mismatch without charging or writing", async () => {
  const remote = linodeCloud();
  const fetch = remote.fetch;
  let corrupt = false;
  remote.fetch = async (...args) => {
    const result = await fetch(...args);
    if (!corrupt || !String(args[0]).endsWith("/linode/instances/42") || args[1]?.method !== "GET") return result;
    const headers = new Headers(result.headers); headers.set("X-Customer-UUID", "wrong-customer");
    return new Response(await result.text(), { status: result.status, headers });
  };
  const f = await setup(remote);
  await f.drive(); corrupt = true; await f.drive();
  const [attempt] = await f.d.select().from(db.rotationAttempts).where(eq(db.rotationAttempts.incidentId, f.incident.id));
  const [step] = await f.d.select().from(db.rotationSteps).where(and(eq(db.rotationSteps.attemptId, attempt!.id), eq(db.rotationSteps.sequence, 0)));
  expect(step).toMatchObject({ status: "rejected_no_effect", errorCode: "remote_identity_changed" });
  expect(attempt!.charged).toBe(false);
  expect(remote.writes).toEqual([]);
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.id, f.incident.currentSegmentId)))[0]!.attemptsUsed).toBe(0);
});

it.each(["Updating", "original binding"] as const)("recovers a lost Azure association through %s without sticky ambiguity or another NIC PUT", async visibility => {
  const remote = azureCloud(), fetch = remote.fetch;
  let nicPuts = 0;
  let completeAssociation = async () => { remote.setNicState("Succeeded"); };
  remote.fetch = async (...args) => {
    if (args[1]?.method === "PUT" && String(args[0]).includes("/networkInterfaces/")) {
      nicPuts++;
      if (visibility === "original binding") {
        completeAssociation = async () => { await fetch(...args); };
        throw new Error("lost-associate-response");
      }
    }
    const response = await fetch(...args);
    if (args[1]?.method === "PUT" && String(args[0]).includes("/networkInterfaces/")) { remote.setNicState("Updating"); throw new Error("lost-associate-response"); }
    return response;
  };
  const f = await setup(remote);
  await f.drive(4);
  const [attempt] = await f.d.select().from(db.rotationAttempts).where(eq(db.rotationAttempts.incidentId, f.incident.id));
  const getStep = async () => (await f.d.select().from(db.rotationSteps).where(and(eq(db.rotationSteps.attemptId, attempt!.id), eq(db.rotationSteps.sequence, 1))))[0]!;
  expect((await getStep()).status).toBe("in_flight");
  await f.drive(2);
  expect((await getStep()).status).toBe("pending");
  expect((await getStep()).receipt).toMatchObject({ status: "pending" });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe((await getStep()).id);
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.candidateAddressId).toBeNull();
  await completeAssociation(); await f.drive(2);
  expect((await getStep()).status).toBe("applied");
  const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  expect(slot).toMatchObject({ currentVersion: 1, candidateVersion: 2 });
  expect(slot!.candidateAddressId).not.toBeNull();
  expect((await f.d.select().from(db.rotationAttempts).where(eq(db.rotationAttempts.incidentId, f.incident.id))).map(a => a.id)).toEqual([attempt!.id]);
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.id, f.incident.currentSegmentId)))[0]!.attemptsUsed).toBe(1);
  expect(remote.writes.filter(w => w.includes("/networkInterfaces/"))).toHaveLength(1);
  expect(nicPuts).toBe(1);
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
  await f.setHealth("success"); await f.drive(2); await f.reconcilePending();
  expect(f.dnsWrites).toEqual([remote.oldAddress, remote.candidateAddress]);
});

it.each(["before association", "after lost association"] as const)("pins Azure allocation GUID %s", async when => {
  const remote = azureCloud(), fetch = remote.fetch;
  if (when === "after lost association") remote.fetch = async (...args) => {
    const response = await fetch(...args);
    if (args[1]?.method === "PUT" && String(args[0]).includes("/networkInterfaces/")) { remote.setCandidateGuid("recreated-generation"); throw new Error("lost-associate-response"); }
    return response;
  };
  const f = await setup(remote); await f.drive(3);
  const [attempt] = await f.d.select().from(db.rotationAttempts).where(eq(db.rotationAttempts.incidentId, f.incident.id));
  const [allocated] = await f.d.select().from(db.rotationSteps).where(and(eq(db.rotationSteps.attemptId, attempt!.id), eq(db.rotationSteps.sequence, 0)));
  expect(allocated!.status).toBe("applied");
  if (when === "before association") remote.setCandidateGuid("recreated-generation");
  await f.drive(3);
  const [associate] = await f.d.select().from(db.rotationSteps).where(and(eq(db.rotationSteps.attemptId, attempt!.id), eq(db.rotationSteps.sequence, 1)));
  expect(associate!.status).toBe("ambiguous");
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, allocated!.id)))[0]!.receipt).toEqual(allocated!.receipt);
  expect(remote.writes.filter(w => w.includes("/networkInterfaces/"))).toHaveLength(when === "before association" ? 0 : 1);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.candidateAddressId).toBeNull();
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  expect((await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.id, f.incident.currentSegmentId)))[0]!.attemptsUsed).toBe(1);
});

it.each(["new receipt", "legacy metadata", "scan-created row"] as const)("keeps Azure generation proof through scan and queued DNS with %s", async proof => {
  const remote = azureCloud(), f = await setup(remote);
  await f.drive(4);
  const sync = new CloudSyncService({ db: f.d } as never, f.runtime, {} as never);
  const scan = async () => { remote.refreshDiscovery(); expect(await sync.scanScope(f.account.id, "azure_vm", "eastus", await f.runtime.adapter(f.account.id, "azure_vm"))).toMatchObject({ scopeStatus: "complete" }); };
  if (proof === "scan-created row") await scan();
  await f.drive();
  const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  const getAddress = async () => (await f.d.select().from(db.cloudAddresses).where(eq(db.cloudAddresses.id, slot!.candidateAddressId!)))[0]!;
  const installed = await getAddress();
  const guid = (installed.metadata.providerMetadata as Record<string, unknown>).resourceGuid;
  if (proof === "legacy metadata") {
    const { allocationIdentity: _anchor, ...metadata } = installed.metadata;
    await f.d.update(db.cloudAddresses).set({ metadata }).where(eq(db.cloudAddresses.id, installed.id));
  }
  if (proof === "scan-created row") expect(installed.origin).toBe("user");
  await f.setHealth("success");
  await scan();
  expect((await getAddress()).metadata.providerMetadata).toMatchObject({ resourceGuid: guid, supported: true });
  remote.setCandidateSupported(false); await scan();
  expect((await getAddress()).metadata.providerMetadata).toMatchObject({ supported: false });
  remote.setCandidateSupported(true); await scan();
  expect((await getAddress()).metadata.providerMetadata).toMatchObject({ supported: true });
  await f.drive();
  remote.setCandidateGuid("recreated-generation");
  if (proof === "legacy metadata") {
    const { allocationIdentity: _anchor, ...metadata } = (await getAddress()).metadata;
    await f.d.update(db.cloudAddresses).set({ metadata }).where(eq(db.cloudAddresses.id, installed.id));
  }
  await scan();
  await expect(f.publication.publishSlot(f.slot.id, f.incident.id)).rejects.toThrow("live_cloud_address_changed");
  remote.setCandidateGuid(String(guid)); await scan();
  await f.drive(); // Queue the healthy, unchanged generation for DNS publication.
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.incident.id));
  expect(publication).toBeDefined();
  await f.reconcilePending(false);
  const queued = await f.d.select({ step: db.operationSteps }).from(db.operationSteps).innerJoin(db.operations, eq(db.operations.id, db.operationSteps.operationId)).where(eq(db.operations.resourceId, f.pools[0]!.id));
  expect(queued.some(({ step }) => step.status === "pending" && (step.input.record as { content?: string } | undefined)?.content === remote.candidateAddress)).toBe(true);
  remote.setCandidateGuid("recreated-generation"); await scan();
  expect((await getAddress()).metadata.providerMetadata).toMatchObject({ resourceGuid: "recreated-generation" });
  await f.reconcilePending();
  expect(f.dnsWrites).toEqual([remote.oldAddress]);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ candidateVersion: 2, currentVersion: 2 });
});
