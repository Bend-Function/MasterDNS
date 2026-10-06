import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
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
import { OperationProcessor } from "../../worker/src/operations/operation.processor.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
const remote = new Map<string, Map<string, ProviderRecord>>();
const effects: string[] = [];
let loseNextDeleteResponse = false;
vi.spyOn(CloudflareDnsAdapter.prototype, "listRecords").mockImplementation(async zoneId => ({ items: [...(remote.get(zoneId)?.values() ?? [])] }));
vi.spyOn(CloudflareDnsAdapter.prototype, "getRecord").mockImplementation(async (zoneId, recordId) => remote.get(zoneId)?.get(recordId) ?? null);
vi.spyOn(CloudflareDnsAdapter.prototype, "deleteRecord").mockImplementation(async (zoneId, recordId) => {
  if (!remote.get(zoneId)?.has(recordId)) throw new ProviderError("Already absent", "not_found", "cloudflare");
  remote.get(zoneId)!.delete(recordId);
  effects.push(recordId);
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
  vi.restoreAllMocks();
  await redis?.quit();
  await connection?.dispose();
});

async function fixture() {
  const d = connection.db;
  const [owner] = await d.insert(db.users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, role: "user" as const };
  const [pool] = await d.insert(db.endpointPools).values({ ownerUserId: actor.id, name: "Pool", strategy: "healthy_set" }).returning();
  const encrypted = encryptJson({ provider: "cloudflare", apiToken: "readback-test" }, Buffer.alloc(32));
  const [account] = await d.insert(db.providerAccounts).values({ ownerUserId: actor.id, provider: "cloudflare", name: "DNS", credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).returning();
  const [zone] = await d.insert(db.zones).values({ providerAccountId: account!.id, externalId: randomUUID(), nameAscii: "example.test" }).returning();
  const [binding] = await d.insert(db.domainBindings).values({ poolId: pool!.id, zoneId: zone!.id, fqdn: "edge.example.test", recordType: "A" }).returning();
  const record: ProviderRecord = { externalId: randomUUID(), zoneExternalId: zone!.externalId, type: "A", name: binding!.fqdn, content: "192.0.2.10", ttl: 60, providerMetadata: {} };
  remote.set(zone!.externalId, new Map([[record.externalId, record]]));
  const [original] = await d.insert(db.operations).values({ ownerUserId: actor.id, source: "failover", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: pool!.id, policyRevision: pool!.policyRevision, status: "failed" }).returning();
  const [failed] = await d.insert(db.operationSteps).values({ operationId: original!.id, providerAccountId: account!.id, zoneId: zone!.id, sequence: 1, action: "create", status: "failed", attempts: 1, input: { zoneExternalId: zone!.externalId, bindingId: binding!.id, poolId: pool!.id, management: "managed", record } }).returning();
  const jobs: Array<{ data: OperationJob; attemptsMade: number; opts: { attempts: number } }> = [];
  const queues = { redis, withDnsZoneLock: (zoneId: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, zoneId, action),
    operations: { add: async (_name: string, data: OperationJob) => { jobs.push({ data, attemptsMade: 0, opts: { attempts: 1 } }); } },
    notifications: { add: async () => undefined } };
  const database = { db: d } as never;
  const pools = new PoolsService(database, queues as never);
  const operations = new OperationsService(database, queues as never);
  const processor = new OperationProcessor(database, queues as never, { forAccount: async () => ({ adapter: new CloudflareDnsAdapter("readback-test"), account }) } as never);
  const execute = async () => {
    const job = jobs.shift();
    expect(job).toBeDefined();
    await processor["process"](job as never);
  };
  return { d, actor, pool: pool!, account: account!, zone: zone!, binding: binding!, record, original: original!, failed: failed!, pools, operations, execute };
}

it("finishes deleting an adopted remote create with no assignment and keeps original failure history", async () => {
  const f = await fixture();
  const deletion = await f.pools.deleteBinding(f.actor as never, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  const operationId = (deletion as { id: string }).id;
  const [step] = await f.d.select().from(db.operationSteps).where(eq(db.operationSteps.operationId, operationId));
  expect(step!.input.endpointId).toBeUndefined();
  expect(await f.d.select().from(db.bindingAssignments).where(eq(db.bindingAssignments.domainBindingId, f.binding.id))).toEqual([]);
  await f.execute();
  expect(remote.get(f.zone.externalId)!.size).toBe(0);
  expect(await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.id, f.binding.id))).toEqual([]);
  expect((await f.d.select().from(db.operations).where(eq(db.operations.id, operationId)))[0]!.status).toBe("succeeded");
  expect((await f.d.select().from(db.operationSteps).where(eq(db.operationSteps.id, f.failed.id)))[0]).toMatchObject({ status: "failed", attempts: 1 });
  expect((await f.d.select().from(db.dnsRecords).where(eq(db.dnsRecords.id, step!.dnsRecordId!)))[0]).toMatchObject({ management: "unmanaged", managedByPoolId: null, deletedAt: expect.any(Date) });
  expect(await f.d.select().from(db.auditLogs).where(eq(db.auditLogs.operationId, operationId))).toMatchObject([{ action: "dns_record.delete" }, { action: "binding.delete" }]);
  await expect(f.operations.retry(f.actor as never, f.original.id)).rejects.toMatchObject({ status: 409 });
});

it("recovers a lost deletion response through the same operation without a second remote effect", async () => {
  const f = await fixture();
  const deletion = await f.pools.deleteBinding(f.actor as never, f.pool.id, f.binding.id);
  const operationId = (deletion as { id: string }).id;
  loseNextDeleteResponse = true;
  await f.execute();
  expect((await f.d.select().from(db.operations).where(eq(db.operations.id, operationId)))[0]!.status).toBe("failed");
  expect(await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.id, f.binding.id))).toHaveLength(1);
  await f.operations.retry(f.actor as never, operationId);
  await f.execute();
  expect(effects.filter(id => id === f.record.externalId)).toHaveLength(1);
  expect(await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.id, f.binding.id))).toEqual([]);
  expect((await f.d.select().from(db.operations).where(eq(db.operations.id, operationId)))[0]!.status).toBe("succeeded");
});
