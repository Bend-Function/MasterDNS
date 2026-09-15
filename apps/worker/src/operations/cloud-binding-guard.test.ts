import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, dnsRecords, domainBindings, endpointPools, operationSteps, operations, providerAccounts, users, zones } from "@masterdns/db";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") } }));
import { OperationProcessor } from "./operation.processor.js";

const databaseName = `cloud_guard_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let redis: Redis;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
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

async function fixture(action: "create" | "update" | "delete", managedOperation = false) {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [account] = await connection.db.insert(providerAccounts).values({ ownerUserId: owner!.id, provider: "cloudflare", name: "DNS", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag", status: "active" }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: account!.id, externalId: "zone", nameAscii: "example.com" }).returning();
  const [pool] = await connection.db.insert(endpointPools).values({ ownerUserId: owner!.id, name: "pool", strategy: "primary_backup" }).returning();
  const record = { type: "A" as const, name: "www.example.com", content: "192.0.2.1", ttl: 60, providerMetadata: {} };
  const current = action === "create" ? undefined : (await connection.db.insert(dnsRecords).values({ ...record, zoneId: zone!.id, externalId: "record", remoteHash: "existing", management: "managed", managedByPoolId: pool!.id }).returning())[0];
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: owner!.id, actorUserId: owner!.id, source: "user", idempotencyKey: randomUUID(), resourceType: managedOperation ? "endpoint_pool" : "dns_record", ...(managedOperation ? { resourceId: pool!.id } : {}) }).returning();
  await connection.db.insert(operationSteps).values({ operationId: operation!.id, providerAccountId: account!.id, zoneId: zone!.id, sequence: 1, action, dnsRecordId: current?.id ?? null, input: { zoneExternalId: "zone", ...(action !== "delete" ? { record } : {}), ...(current ? { recordExternalId: current.externalId } : {}), ...(managedOperation ? { management: "managed", poolId: pool!.id } : {}) } });
  await connection.db.insert(domainBindings).values({ poolId: pool!.id, zoneId: zone!.id, fqdn: record.name, recordType: "A" });
  const remote = { ...record, externalId: "created" };
  let writes = 0;
  const adapter = { provider: "cloudflare", createRecord: async () => { writes++; return remote; }, updateRecord: async () => { writes++; return remote; }, deleteRecord: async () => { writes++; }, getRecord: async () => remote };
  const processor = new OperationProcessor({ db: connection.db } as never, { redis, notifications: { add: async () => ({}) } } as never, { forAccount: async () => ({ adapter }) } as never);
  return { run: () => (processor as unknown as { process(job: unknown): Promise<void> }).process({ data: { operationId: operation!.id }, attemptsMade: 0, opts: { attempts: 1 } }), operationId: operation!.id, writes: () => writes };
}

describe("final DNS worker ownership guard", () => {
  it.each(["create", "update", "delete"] as const)("supersedes queued manual %s after the RRset becomes managed", async (action) => {
    const f = await fixture(action); await f.run();
    const [operation] = await connection.db.select().from(operations).where(eq(operations.id, f.operationId));
    expect(operation!.status).toBe("superseded");
    expect(f.writes()).toBe(0);
  });
  it("preserves legitimate Pool-generated managed writes", async () => {
    const f = await fixture("create", true); await f.run();
    const [operation] = await connection.db.select().from(operations).where(eq(operations.id, f.operationId));
    expect(operation!.status).toBe("succeeded");
    expect(f.writes()).toBe(1);
  });
});
