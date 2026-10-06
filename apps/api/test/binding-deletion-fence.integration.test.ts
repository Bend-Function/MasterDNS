import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withDnsZoneLock } from "@masterdns/automation";
import { encryptJson } from "@masterdns/crypto";
import { ProviderError, type ProviderRecord, type OperationJob } from "@masterdns/contracts";
import { CloudflareDnsAdapter } from "@masterdns/providers";
import * as db from "@masterdns/db";
import { testDatabase } from "../../worker/src/probes/probe-test-utils.js";
vi.mock("../src/config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } }));
import { PoolsService } from "../src/modules/pools/pools.service.js";
import { OperationsService } from "../src/modules/operations/operations.service.js";
import { ReconcileProcessor } from "../../worker/src/automation/reconcile.processor.js";
import { OperationProcessor } from "../../worker/src/operations/operation.processor.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
const remote = new Map<string, Map<string, ProviderRecord>>();
const cleanups: Array<() => Promise<void>> = [];
let loseNextDeleteResponse = false;
vi.spyOn(CloudflareDnsAdapter.prototype, "createRecord").mockImplementation(async (zoneId, record) => {
  const created = { ...record, externalId: randomUUID(), zoneExternalId: zoneId };
  remote.get(zoneId)!.set(created.externalId, created);
  return created;
});
vi.spyOn(CloudflareDnsAdapter.prototype, "updateRecord").mockImplementation(async (zoneId, recordId, record) => {
  const updated = { ...record, externalId: recordId, zoneExternalId: zoneId };
  remote.get(zoneId)!.set(recordId, updated);
  return updated;
});
vi.spyOn(CloudflareDnsAdapter.prototype, "listRecords").mockImplementation(async zoneId => ({ items: [...(remote.get(zoneId)?.values() ?? [])] }));
vi.spyOn(CloudflareDnsAdapter.prototype, "getRecord").mockImplementation(async (zoneId, recordId) => remote.get(zoneId)?.get(recordId) ?? null);
vi.spyOn(CloudflareDnsAdapter.prototype, "deleteRecord").mockImplementation(async (zoneId, recordId) => {
  if (!remote.get(zoneId)?.has(recordId)) throw new ProviderError("Already absent", "not_found", "cloudflare");
  remote.get(zoneId)!.delete(recordId);
  if (loseNextDeleteResponse) {
    loseNextDeleteResponse = false;
    throw new ProviderError("Simulated lost delete response", "transient_failure", "cloudflare");
  }
});
beforeAll(async () => {
  connection = await testDatabase();
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
}, 30_000);
afterAll(async () => {
  await Promise.all(cleanups.map(cleanup => cleanup()));
  vi.restoreAllMocks();
  await redis?.quit();
  await connection?.dispose();
});

async function fixture() {
  const d = connection.db;
  const [owner] = await d.insert(db.users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, role: "user" as const };
  const [pool] = await d.insert(db.endpointPools).values({ ownerUserId: actor.id, name: "Pool", strategy: "healthy_set" }).returning();
  const [endpoint] = await d.insert(db.endpoints).values({ poolId: pool!.id, name: "healthy", healthState: "healthy" }).returning();
  await d.insert(db.endpointAddresses).values({ endpointId: endpoint!.id, family: "4", address: "192.0.2.10", state: "current", source: "static", healthState: "healthy" });
  const encrypted = encryptJson({ provider: "cloudflare", apiToken: "readback-test" }, Buffer.alloc(32));
  const [account] = await d.insert(db.providerAccounts).values({ ownerUserId: actor.id, provider: "cloudflare", name: "DNS", credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).returning();
  const [zone] = await d.insert(db.zones).values({ providerAccountId: account!.id, externalId: randomUUID(), nameAscii: "example.test" }).returning();
  const [binding] = await d.insert(db.domainBindings).values({ poolId: pool!.id, zoneId: zone!.id, fqdn: "edge.example.test", recordType: "A" }).returning();
  const record: ProviderRecord = { externalId: randomUUID(), zoneExternalId: zone!.externalId, type: "A", name: binding!.fqdn, content: "192.0.2.10", ttl: 60, providerMetadata: {} };
  remote.set(zone!.externalId, new Map([[record.externalId, record]]));
  const [original] = await d.insert(db.operations).values({ ownerUserId: actor.id, source: "failover", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: pool!.id, policyRevision: pool!.policyRevision, status: "failed" }).returning();
  const [failed] = await d.insert(db.operationSteps).values({ operationId: original!.id, providerAccountId: account!.id, zoneId: zone!.id, sequence: 1, action: "create", status: "failed", attempts: 1, input: { zoneExternalId: zone!.externalId, bindingId: binding!.id, poolId: pool!.id, management: "managed", record } }).returning();
  const operationQueue = new Queue<OperationJob>(`fence-operations-${randomUUID()}`, { connection: redis, defaultJobOptions: { delay: 3_600_000 } });
  const reconcileQueue = new Queue(`fence-reconcile-${randomUUID()}`, { connection: redis });
  const notificationQueue = new Queue(`fence-notifications-${randomUUID()}`, { connection: redis });
  const operationEvents = new QueueEvents(operationQueue.name, { connection: redis });
  const reconcileEvents = new QueueEvents(reconcileQueue.name, { connection: redis });
  const queues = { redis, withDnsZoneLock: (zoneId: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, zoneId, action),
    operations: operationQueue, notifications: notificationQueue };
  const database = { db: d } as never;
  const pools = new PoolsService(database, queues as never);
  const operations = new OperationsService(database, queues as never);
  const processor = new OperationProcessor(database, queues as never, { forAccount: async () => ({ adapter: new CloudflareDnsAdapter("readback-test"), account }) } as never);
  const reconcileProcessor = new ReconcileProcessor(database, queues as never);
  const operationWorker = new Worker<OperationJob>(operationQueue.name, job => processor["process"](job), { connection: redis });
  const reconcileWorker = new Worker(reconcileQueue.name, job => reconcileProcessor["process"](job), { connection: redis });
  cleanups.push(async () => {
    await Promise.all([operationWorker.close(), reconcileWorker.close(), operationEvents.close(), reconcileEvents.close()]);
    for (const queue of [operationQueue, reconcileQueue, notificationQueue]) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
  await Promise.all([operationWorker.waitUntilReady(), reconcileWorker.waitUntilReady(), operationEvents.waitUntilReady(), reconcileEvents.waitUntilReady()]);
  // API-created deletion jobs stay delayed so each assertion controls ordering.
  // The dispatched job still runs through BullMQ and the production processors.
  const executeOperation = async (operationId: string) => {
    const job = await operationQueue.add("execute-operation", { operationId }, { delay: 0, attempts: 1, jobId: randomUUID() });
    await job.waitUntilFinished(operationEvents, 10_000);
  };
  const reconcile = async () => {
    const job = await reconcileQueue.add("reconcile", { poolId: pool!.id, eventId: randomUUID(), trigger: "configuration" });
    await job.waitUntilFinished(reconcileEvents, 10_000);
  };
  return { endpoint: endpoint!, reconcile, executeOperation, d, actor, pool: pool!, account: account!, zone: zone!, binding: binding!, record, original: original!, failed: failed!, pools, operations };
}


async function requestDeletion(f: Awaited<ReturnType<typeof fixture>>) {
  return await f.pools.deleteBinding(f.actor as never, f.pool.id, f.binding.id) as { id: string };
}

it.each(["pending", "running", "failed", "partial"] as const)("reconcile excludes a binding with %s deletion while publishing unrelated bindings", async status => {
  const f = await fixture();
  const deletion = await requestDeletion(f);
  await f.d.update(db.operations).set({ status }).where(eq(db.operations.id, deletion.id));
  const [other] = await f.d.insert(db.domainBindings).values({ poolId: f.pool.id, zoneId: f.zone.id, fqdn: "other.example.test", recordType: "A", state: "switching" }).returning();
  await f.reconcile();
  const publishSteps = await f.d.select().from(db.operationSteps).where(and(eq(db.operationSteps.action, "create"), eq(db.operationSteps.zoneId, f.zone.id)));
  expect(publishSteps.filter(step => step.status === "pending").map(step => step.input.bindingId)).toEqual([other!.id]);
  expect(await f.d.select().from(db.bindingAssignments).where(eq(db.bindingAssignments.domainBindingId, f.binding.id))).toEqual([]);
  const operationId = publishSteps.find(step => step.input.bindingId === other!.id)!.operationId;
  await f.executeOperation(operationId);
  expect([...remote.get(f.zone.externalId)!.values()].map(record => record.name).sort()).toEqual(["edge.example.test", "other.example.test"]);
});

it.each([false, true])("rejects historical publication retry with legacy null revision=%s before deletion finishes", async legacy => {
  const f = await fixture();
  await requestDeletion(f);
  if (legacy) await f.d.update(db.operations).set({ policyRevision: null }).where(eq(db.operations.id, f.original.id));
  await expect(f.operations.retry(f.actor as never, f.original.id)).rejects.toMatchObject({ status: 409 });
  expect((await f.d.select().from(db.operationSteps).where(eq(db.operationSteps.id, f.failed.id)))[0]!.status).toBe("failed");
});

it.each([
  { removed: false, action: "create" as const }, { removed: true, action: "create" as const },
  { removed: false, action: "update" as const }, { removed: true, action: "update" as const },
])("blocks admitted legacy $action with binding already removed=$removed and continues unrelated steps", async ({ removed, action }) => {
  const f = await fixture();
  const deletion = await requestDeletion(f);
  if (removed) await f.executeOperation(deletion.id);
  const [other] = await f.d.insert(db.domainBindings).values({ poolId: f.pool.id, zoneId: f.zone.id, fqdn: "other.example.test", recordType: "A" }).returning();
  await f.d.update(db.operations).set({ policyRevision: null, status: "pending" }).where(eq(db.operations.id, f.original.id));
  await f.d.update(db.operationSteps).set({ action, status: "pending", attempts: 0, input: { ...f.failed.input, endpointId: f.endpoint.id, ...(action === "update" ? { recordExternalId: f.record.externalId, record: { ...f.record, content: "192.0.2.20" } } : {}) } }).where(eq(db.operationSteps.id, f.failed.id));
  await f.d.insert(db.operationSteps).values({ operationId: f.original.id, sequence: 2, providerAccountId: f.account.id, zoneId: f.zone.id, action: "create", input: { ...f.failed.input, bindingId: other!.id, endpointId: f.endpoint.id, record: { ...f.record, name: other!.fqdn } } });
  await f.executeOperation(f.original.id);
  expect([...remote.get(f.zone.externalId)!.values()].filter(record => record.name === f.binding.fqdn)).toHaveLength(removed ? 0 : 1);
  expect([...remote.get(f.zone.externalId)!.values()].filter(record => record.name === other!.fqdn)).toHaveLength(1);
  expect((await f.d.select().from(db.operationSteps).where(eq(db.operationSteps.id, f.failed.id)))[0]).toMatchObject({ status: "skipped", errorCode: removed ? "binding_missing" : "binding_deleting" });
  if (!removed) expect((await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.id, f.binding.id)))[0]!.state).toBe("switching");
});

it("rejects retry after binding removal even when the old publication has null revisions", async () => {
  const f = await fixture();
  const deletion = await requestDeletion(f);
  await f.executeOperation(deletion.id);
  await f.d.update(db.operations).set({ policyRevision: null }).where(eq(db.operations.id, f.original.id));
  await expect(f.operations.retry(f.actor as never, f.original.id)).rejects.toMatchObject({ status: 409 });
});

it("keeps the deletion fence after a failed delete and allows retrying deletion itself", async () => {
  const f = await fixture();
  const deletion = await requestDeletion(f);
  loseNextDeleteResponse = true;
  await f.executeOperation(deletion.id);
  await f.reconcile();
  expect((await f.d.select().from(db.operationSteps).where(and(eq(db.operationSteps.action, "create"), eq(db.operationSteps.zoneId, f.zone.id)))).filter(step => step.status === "pending")).toEqual([]);
  await f.operations.retry(f.actor as never, deletion.id);
  await f.executeOperation(deletion.id);
  expect(await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.id, f.binding.id))).toEqual([]);
  expect(remote.get(f.zone.externalId)!.size).toBe(0);
});

it.each(["succeeded", "superseded"] as const)("does not retain a fence for a %s deletion operation", async status => {
  const f = await fixture();
  const deletion = await requestDeletion(f);
  await f.d.update(db.operations).set({ status }).where(eq(db.operations.id, deletion.id));
  expect(await db.getDeletingBindingIds(f.d, [f.binding.id])).toEqual(new Set());
});

it("requires an explicit deleteBinding step before treating a domain_binding operation as deletion", async () => {
  const f = await fixture();
  const [operation] = await f.d.insert(db.operations).values({ ownerUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), resourceType: "domain_binding", resourceId: f.binding.id }).returning();
  await f.d.insert(db.operationSteps).values({ operationId: operation!.id, providerAccountId: f.account.id, zoneId: f.zone.id, sequence: 1, action: "delete", input: { zoneExternalId: f.zone.externalId, bindingId: f.binding.id, deleteBinding: false } });
  expect(await db.getDeletingBindingIds(f.d, [f.binding.id])).toEqual(new Set());
});
