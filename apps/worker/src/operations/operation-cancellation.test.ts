import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase, dnsRecords, domainBindings, endpointPools, operationSteps, operations, providerAccounts, users, zones } from "@masterdns/db";
import { ProviderError } from "@masterdns/contracts";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") } }));
import { OperationProcessor } from "./operation.processor.js";

const databaseName = `operation_cancel_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>, connection: ReturnType<typeof createDatabase>, redis: Redis;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  admin = createDatabase(root); await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL ?? "redis://127.0.0.1:56379", { maxRetriesPerRequest: null });
  await redis.ping();
}, 30000);
afterAll(async () => {
  await redis?.quit(); await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [account] = await connection.db.insert(providerAccounts).values({ ownerUserId: owner!.id, provider: "cloudflare", name: "DNS", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag", status: "active" }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: account!.id, externalId: "zone", nameAscii: "example.com" }).returning();
  const [pool] = await connection.db.insert(endpointPools).values({ ownerUserId: owner!.id, name: "pool", strategy: "primary_backup" }).returning();
  const desired = { type: "A" as const, name: "www.example.com", content: "192.0.2.2", ttl: 60, providerMetadata: {} };
  const [record] = await connection.db.insert(dnsRecords).values({ ...desired, content: "192.0.2.1", zoneId: zone!.id, externalId: "record", remoteHash: "existing", management: "managed", managedByPoolId: pool!.id }).returning();
  const [binding] = await connection.db.insert(domainBindings).values({ poolId: pool!.id, zoneId: zone!.id, fqdn: desired.name, recordType: "A", state: "switching" }).returning();
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: owner!.id, actorUserId: owner!.id, source: "user", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: pool!.id, policyRevision: pool!.policyRevision, decisionRevision: pool!.decisionRevision }).returning();
  const [step] = await connection.db.insert(operationSteps).values({ operationId: operation!.id, providerAccountId: account!.id, zoneId: zone!.id, sequence: 1, action: "update", dnsRecordId: record!.id, input: { zoneExternalId: "zone", recordExternalId: "record", record: desired, management: "managed", poolId: pool!.id, bindingId: binding!.id } }).returning();
  const hooks = { beforeAdapter: undefined as (() => Promise<void>) | undefined, beforeRead: undefined as (() => Promise<void>) | undefined };
  let writes = 0;
  let remote = { ...desired, externalId: "record", content: "192.0.2.1" };
  const adapter = { provider: "cloudflare", getRecord: async () => { await hooks.beforeRead?.(); return remote; }, updateRecord: async () => { writes++; remote = { ...desired, externalId: "record" }; return remote; } };
  const processor = new OperationProcessor({ db: connection.db } as never, { redis, notifications: { add: async () => ({}) } } as never, { forAccount: async () => { await hooks.beforeAdapter?.(); return { adapter }; } } as never);
  const job = { data: { operationId: operation!.id }, attemptsMade: 0, opts: { attempts: 1 } };
  const cancel = async (skipRunning = false) => connection.db.transaction(async tx => {
    await tx.update(operations).set({ status: "superseded" }).where(eq(operations.id, operation!.id));
    const [latest] = await tx.select().from(operationSteps).where(eq(operationSteps.id, step!.id));
    if (latest!.status !== "running" || skipRunning) await tx.update(operationSteps).set({ status: "skipped" }).where(eq(operationSteps.id, step!.id));
  });
  return { processor: processor as any, operation: operation!, step: step!, account: account!, record: record!, binding: binding!, hooks, job, cancel, run: () => (processor as any).process(job), writes: () => writes };
}

it("does not reclaim an operation cancelled after its initial snapshot", async () => {
  const f = await fixture(), read = deferred();
  let pending!: Promise<void>;
  await connection.db.transaction(async tx => {
    await tx.select().from(operations).where(eq(operations.id, f.operation.id)).for("update");
    pending = f.processor.processLocked(f.job, { assertOwned: () => read.resolve() });
    await read.promise;
    await tx.update(operations).set({ status: "superseded" }).where(eq(operations.id, f.operation.id));
    await tx.update(operationSteps).set({ status: "skipped" }).where(eq(operationSteps.id, f.step.id));
  });
  await pending;
  expect((await connection.db.select().from(operations).where(eq(operations.id, f.operation.id)))[0]!.status).toBe("superseded");
  expect(f.writes()).toBe(0);
});

it("refuses to prepare a cancelled step using a stale operation snapshot", async () => {
  const f = await fixture(); await f.cancel();
  expect(await f.processor.prepareStep(f.operation, f.step)).toBe(false);
  expect((await connection.db.select().from(operationSteps).where(eq(operationSteps.id, f.step.id)))[0]!.status).toBe("skipped");
});

it("does not publish DNS when cancellation happens during the pre-change read", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.hooks.beforeRead = async () => { entered.resolve(); await release.promise; };
  const pending = f.run(); await entered.promise; await f.cancel(); release.resolve(); await pending;
  expect(f.writes()).toBe(0);
  expect((await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, f.record.id)))[0]!.content).toBe("192.0.2.1");
  expect((await connection.db.select().from(operations).where(eq(operations.id, f.operation.id)))[0]!.status).toBe("superseded");
});

it("ignores a late provider error after cancellation instead of restoring pending work", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.hooks.beforeAdapter = async () => { entered.resolve(); await release.promise; throw new ProviderError("Denied", "permission_denied", "cloudflare"); };
  const pending = f.run(); await entered.promise; await f.cancel(); release.resolve(); await pending;
  expect((await connection.db.select().from(operations).where(eq(operations.id, f.operation.id)))[0]!.status).toBe("superseded");
  expect((await connection.db.select().from(operationSteps).where(eq(operationSteps.id, f.step.id)))[0]!.status).toBe("skipped");
  expect((await connection.db.select().from(providerAccounts).where(eq(providerAccounts.id, f.account.id)))[0]!.status).toBe("active");
});

it("does not finalize a cancelled operation or rewrite its binding state", async () => {
  const f = await fixture(); await f.cancel();
  expect(await f.processor.finalizeOperation(f.operation)).toMatchObject({ superseded: true });
  expect((await connection.db.select().from(operations).where(eq(operations.id, f.operation.id)))[0]!.status).toBe("superseded");
  expect((await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id)))[0]!.state).toBe("switching");
});
