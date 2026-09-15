import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withDnsZoneLock } from "@masterdns/automation";
import type { DnsRecordInput, ProviderRecord } from "@masterdns/contracts";
import * as db from "@masterdns/db";
vi.mock("../src/config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudBindingsService } from "../src/modules/cloud/cloud-bindings.service.js";
import { fixture } from "../../worker/src/rotation/rotation-test-utils.js";
import { ReconcileProcessor } from "../../worker/src/automation/reconcile.processor.js";
import { OperationProcessor } from "../../worker/src/operations/operation.processor.js";

let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
});
afterAll(async () => { await redis?.quit(); });

it("reconciles a new hostname on a current cloud endpoint without another health transition, while initial binding waits for verification", async () => {
  const f = await fixture();
  const [account] = await f.d.insert(db.providerAccounts).values({ ownerUserId: f.account.ownerUserId, provider: "cloudflare", name: "DNS", credentialCiphertext: "test", credentialIv: "iv", credentialTag: "tag", status: "active" }).returning();
  const [zone] = await f.d.insert(db.zones).values({ providerAccountId: account!.id, externalId: randomUUID(), nameAscii: "binding.test" }).returning();
  const bindings = new CloudBindingsService({ db: f.d } as never, {
    withDnsZoneLock: (id: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, id, action),
  } as never);
  const bind = (fqdn: string) => bindings.bind({ id: f.account.ownerUserId, role: "user" } as never, { zoneId: zone!.id, fqdn, recordType: "A", slotId: f.slot.id, poolId: f.pools[0]!.id, takeoverExisting: false }, randomUUID());
  const remote = new Map<string, ProviderRecord>();
  const writes: string[] = [];
  const queues = { redis, operations: { add: async () => ({}) }, notifications: { add: async () => ({}) } };
  const reconcile = new ReconcileProcessor({ db: f.d } as never, queues as never);
  const operations = new OperationProcessor({ db: f.d } as never, queues as never, {
    forAccount: async () => ({ adapter: {
      provider: "cloudflare",
      listRecords: async () => ({ items: [...remote.values()] }),
      getRecord: async (_zone: string, id: string) => remote.get(id) ?? null,
      createRecord: async (_zone: string, record: DnsRecordInput) => {
        writes.push(record.name);
        const result = { ...record, externalId: randomUUID(), zoneExternalId: _zone };
        remote.set(result.externalId, result);
        return result;
      },
    } }),
  } as never, { adapter: async () => ({ inspect: async () => f.live }) } as never);
  const reconcilePending = async () => {
    for (const pool of f.pools) {
      for (const intent of await f.d.select().from(db.reconcileIntents).where(and(eq(db.reconcileIntents.poolId, pool.id), isNull(db.reconcileIntents.completedAt)))) {
        await (reconcile as any).process({ data: intent });
      }
      for (const operation of await f.d.select().from(db.operations).where(eq(db.operations.resourceId, pool.id))) {
        await (operations as any).process({ data: { operationId: operation.id }, attemptsMade: 0, opts: { attempts: 1 } });
      }
    }
  };

  const first = await bind("first");
  await reconcilePending();
  expect(await f.d.select().from(db.operations).where(eq(db.operations.resourceId, first.pool.id))).toEqual([]);
  expect(writes).toEqual([]);
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, first.endpoint.id))).toEqual([]);

  await f.service.publishSlot(f.slot.id);
  await reconcilePending();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.service.observe(publication!.id);
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, publication!.id)))[0]!.status).toBe("applied");
  expect(writes).toEqual(["first.binding.test"]);
  const current = await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, first.endpoint.id));
  const health = await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));

  const second = await bind("second");
  expect(second.endpoint.id).toBe(first.endpoint.id);
  await reconcilePending();
  expect(writes).toEqual(["first.binding.test", "second.binding.test"]);
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, first.endpoint.id))).toEqual(current);
  expect(await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id))).toEqual(health);
  expect(await f.d.select().from(db.dnsRecords).where(and(eq(db.dnsRecords.zoneId, zone!.id), eq(db.dnsRecords.name, "second.binding.test")))).toMatchObject([{ content: f.address.address, management: "managed" }]);
  expect(await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.slotId, f.slot.id))).toEqual([]);
});
