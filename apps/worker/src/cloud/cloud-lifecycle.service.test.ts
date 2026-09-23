import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudAccounts, cloudRotationBuckets, cloudCredentialFingerprint, cloudInstances, cloudInstanceControls, cloudLifecycleOperations, cloudScanScopes, cloudTrafficStopPolicies, createDatabase, instanceAuthorizations, instanceLifecycleBlocksRotation, lockCloudLifecycleContext, rotationLeases, users } from "@masterdns/db";
import { CloudError } from "@masterdns/cloud-providers";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudLifecycleService } from "./cloud-lifecycle.service.js";
const name = `lifecycle_worker_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>, connection: ReturnType<typeof createDatabase>, service: CloudLifecycleService;
let state = "running", usage: number | null = 100, identity = "immutable";
const mutate = vi.fn(async () => ({}));
const monthly = vi.fn(async () => ({ month: new Date().toISOString().slice(0,7), totalBytes: usage, outgoingBytes: usage }));
const inspect = vi.fn(async (ref: unknown) => ({ ref, identity, state }));
const runtime = { adapter: async () => ({ verifyIdentity: async () => ({ externalAccountId: "123456789012" }), inspectLifecycle: inspect, mutateLifecycle: mutate, monthlyTraffic: monthly }) };
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!; admin = createDatabase(root); await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudLifecycleService({ db: connection.db } as never, runtime as never);
}, 30000);
beforeEach(async () => { await connection.db.delete(cloudRotationBuckets); state = "running"; usage = 100; identity = "immutable"; mutate.mockReset().mockResolvedValue({}); monthly.mockReset().mockImplementation(async () => ({ month: new Date().toISOString().slice(0,7), totalBytes: usage, outgoingBytes: usage })); inspect.mockReset().mockImplementation(async ref => ({ ref, identity, state })); await connection.db.update(cloudLifecycleOperations).set({ status: "cancelled" }); await connection.db.update(cloudTrafficStopPolicies).set({ enabled: false }); });
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
async function fixture() {
  const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: user!.id, provider: "aws", name: "AWS", externalAccountId: "123456789012", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag" }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: `i-${randomUUID()}`, scanGeneration: 1 }).returning();
  await connection.db.insert(cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  await connection.db.insert(instanceAuthorizations).values({ instanceId: instance!.id, managed: true, allowStopStart: true, allowDelete: true });
  const c = await connection.db.transaction(tx => lockCloudLifecycleContext(tx, instance!.id));
  return { user: user!, account: account!, instance: instance!, c };
}
async function queue(f: Awaited<ReturnType<typeof fixture>>, action: "start" | "stop" | "delete" = "stop") {
  const [row] = await connection.db.insert(cloudLifecycleOperations).values({ instanceId: f.instance.id, physicalKey: f.c.physicalKey, ownerUserId: f.user.id, actorUserId: f.user.id, action, source: "user", externalAccountId: f.account.externalAccountId!, credentialFingerprint: cloudCredentialFingerprint(f.account), snapshot: { ref: { accountId: f.account.id, service: "ec2", region: "us-east-1", instanceId: f.instance.externalId }, identity: "immutable", state: "running" } }).returning();
  return row!;
}
async function policy(f: Awaited<ReturnType<typeof fixture>>) { await connection.db.insert(cloudTrafficStopPolicies).values({ instanceId: f.instance.id, actorUserId: f.user.id, resourceIdentity: "immutable", enabled: true, thresholdBytes: 100 }); return (await service.claimPolicy())!; }
async function row(id: string) { return (await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.id,id)))[0]!; }
async function processNext() { const job = await service.claimOperation(); expect(job).not.toBeNull(); await service.processOperation(job!); return row(job!.id); }
async function due(id: string) { await connection.db.update(cloudLifecycleOperations).set({ nextRunAt: new Date(0), leaseExpiresAt: null }).where(eq(cloudLifecycleOperations.id,id)); }
describe("durable lifecycle worker", () => {
  it("claims concurrently once and records in-flight before mutation", async () => {
    const f = await fixture(), job = await queue(f);
    const claims = await Promise.all([service.claimOperation(), service.claimOperation()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    mutate.mockImplementationOnce(async () => { expect((await row(job.id)).status).toBe("in_flight"); return {}; });
    await service.processOperation(claims.find(Boolean)!);
    expect(mutate).toHaveBeenCalledTimes(1);
    state = "stopped"; await due(job.id); expect((await processNext()).status).toBe("succeeded");
    expect(await connection.db.transaction(tx => instanceLifecycleBlocksRotation(tx, f.c.physicalKey))).toBe(true);
    expect((await connection.db.select().from(cloudInstanceControls).where(eq(cloudInstanceControls.physicalKey,f.c.physicalKey)))[0]!.powerHold).toBe("manual_stop");
  });
  it("observes an ambiguous write across worker restart without issuing another mutation", async () => {
    const f = await fixture(), job = await queue(f); mutate.mockRejectedValueOnce(new CloudError("temporary_cloud_error", true));
    expect((await processNext()).status).toBe("unknown");
    await due(job.id); service = new CloudLifecycleService({ db: connection.db } as never, runtime as never);
    expect((await processNext()).status).toBe("unknown"); expect(mutate).toHaveBeenCalledTimes(1);
    state = "stopped"; await due(job.id); expect((await processNext()).status).toBe("succeeded"); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("does not mutate an immutable resource identity replacement", async () => {
    const f = await fixture(); await queue(f); identity = "replacement";
    expect((await processNext()).status).toBe("failed"); expect(mutate).not.toHaveBeenCalled();
  });
  it("rechecks revoked authorization and credential continuity", async () => {
    const f = await fixture(); await queue(f); await connection.db.update(instanceAuthorizations).set({ allowStopStart: false }).where(eq(instanceAuthorizations.instanceId,f.instance.id));
    expect((await processNext()).status).toBe("cancelled"); expect(mutate).not.toHaveBeenCalled();
    await connection.db.update(instanceAuthorizations).set({ allowStopStart: true }).where(eq(instanceAuthorizations.instanceId,f.instance.id)); await queue(f);
    await connection.db.update(cloudAccounts).set({ credentialCiphertext: "rotated" }).where(eq(cloudAccounts.id,f.account.id));
    expect((await processNext()).errorCode).toBe("cloud_account_changed"); expect(mutate).not.toHaveBeenCalled();
  });
  it("waits for a physical rotation lease and preserves its unresolved marker", async () => {
    const f = await fixture(); await queue(f);
    const holder = randomUUID(); await connection.db.update(rotationLeases).set({ holder, expiresAt: new Date(Date.now()+60000) }).where(eq(rotationLeases.physicalKey,f.c.physicalKey));
    expect((await processNext()).status).toBe("queued"); expect(mutate).not.toHaveBeenCalled();
    expect((await connection.db.select().from(rotationLeases).where(eq(rotationLeases.physicalKey,f.c.physicalKey)))[0]!.holder).toBe(holder);
  });
  it("triggers at equality, avoids duplicate jobs, and does not stop an already stopped instance", async () => {
    const f = await fixture(); await service.checkPolicy(await policy(f));
    const jobs = await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id)); expect(jobs).toHaveLength(1); expect(jobs[0]!.source).toBe("traffic");
    state = "stopped"; expect((await processNext()).status).toBe("succeeded"); expect(mutate).not.toHaveBeenCalled();
    await connection.db.update(cloudTrafficStopPolicies).set({ nextCheckAt:new Date(0) }).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)); await service.checkPolicy((await service.claimPolicy())!);
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).toHaveLength(1);
  });
  it("does not enqueue when policy is disabled during the remote metric query", async () => {
    const f = await fixture(), p = await policy(f);
    monthly.mockImplementationOnce(async () => { await connection.db.update(cloudTrafficStopPolicies).set({ enabled:false, revision:2 }).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)); return { month:new Date().toISOString().slice(0,7),totalBytes:100,outgoingBytes:100 }; });
    await service.checkPolicy(p);
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).toHaveLength(0);
  });
  it("rechecks policy revision and UTC month before dispatch", async () => {
    const f = await fixture(); await service.checkPolicy(await policy(f));
    await connection.db.update(cloudTrafficStopPolicies).set({ revision:2 }).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)); expect((await processNext()).status).toBe("cancelled"); expect(mutate).not.toHaveBeenCalled();
    await connection.db.update(cloudTrafficStopPolicies).set({ nextCheckAt:new Date(0) }).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)); await service.checkPolicy((await service.claimPolicy())!);
    await connection.db.update(cloudLifecycleOperations).set({ policyMonth:"2000-01" }).where(and(eq(cloudLifecycleOperations.instanceId,f.instance.id),eq(cloudLifecycleOperations.status,"queued"))); expect((await processNext()).status).toBe("cancelled"); expect(mutate).not.toHaveBeenCalled();
  });
  it("records missing metrics without queuing stop", async () => {
    const f = await fixture(); usage = null; await service.checkPolicy(await policy(f));
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).toHaveLength(0);
    expect((await connection.db.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)))[0]).toMatchObject({lastUsageBytes:null,lastError:"traffic_usage_unavailable"});
  });
  it("re-stops an externally restarted instance and never auto-starts on a new month", async () => {
    const f = await fixture(); await service.checkPolicy(await policy(f)); state="stopped"; await processNext(); state="running";
    await connection.db.update(cloudTrafficStopPolicies).set({ nextCheckAt:new Date(0) }).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)); await service.checkPolicy((await service.claimPolicy())!);
    expect((await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).map(j=>j.action)).toEqual(["stop","stop"]);
  });
  it("requeues explicit vendor throttling with shared cooldown, without uncertain repeats", async () => {
    const f=await fixture(), job=await queue(f);
    mutate.mockRejectedValueOnce(new CloudError("rate_limited",true,120000));
    const result=await processNext(); expect(result).toMatchObject({status:"queued",errorCode:"rate_limited"});
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now()+100000);
    await due(job.id); await processNext(); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("clears a stop hold only after observing a successful start", async () => {
    const f=await fixture(); await connection.db.insert(cloudInstanceControls).values({physicalKey:f.c.physicalKey,powerHold:"traffic_limit"});
    state="stopped"; const job=await queue(f,"start"); await processNext();
    expect(await connection.db.transaction(tx=>instanceLifecycleBlocksRotation(tx,f.c.physicalKey))).toBe(true);
    state="running"; await due(job.id); expect((await processNext()).status).toBe("succeeded");
    expect(await connection.db.transaction(tx=>instanceLifecycleBlocksRotation(tx,f.c.physicalKey))).toBe(false);
  });
  it("cancels an auto-stop disabled during its final pre-dispatch traffic query", async () => {
    const f=await fixture(); await service.checkPolicy(await policy(f));
    monthly.mockImplementationOnce(async()=>{ await connection.db.update(cloudTrafficStopPolicies).set({enabled:false,revision:2}).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)); return {month:new Date().toISOString().slice(0,7),totalBytes:100,outgoingBytes:100}; });
    expect((await processNext()).status).toBe("cancelled"); expect(mutate).not.toHaveBeenCalled();
  });
  it("resets old-month trigger evidence and does not queue from old-month metrics", async () => {
    const f=await fixture(), p=await policy(f);
    await connection.db.update(cloudTrafficStopPolicies).set({month:"2000-01",triggeredAt:new Date("2000-01-01")}).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id));
    monthly.mockResolvedValueOnce({month:"2000-01",totalBytes:1000,outgoingBytes:1000});
    await service.checkPolicy(p);
    expect((await connection.db.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)))[0]).toMatchObject({month:new Date().toISOString().slice(0,7),triggeredAt:null,lastUsageBytes:null});
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).toHaveLength(0);
  });

  it("does not apply an enabled policy to a same-name resource replacement", async () => {
    const f=await fixture(), p=await policy(f); identity="replacement";
    await service.checkPolicy(p);
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).toHaveLength(0);
    expect((await connection.db.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id)))[0]!.lastError).toBe("remote_identity_changed");
  });
  it("records a power hold for an already-stopped over-limit instance without a stop request", async () => {
    const f=await fixture(); state="stopped"; await service.checkPolicy(await policy(f));
    expect(await connection.db.transaction(tx=>instanceLifecycleBlocksRotation(tx,f.c.physicalKey))).toBe(true);
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id))).toHaveLength(0); expect(mutate).not.toHaveBeenCalled();
  });
  it("queues deallocation when an over-limit Azure-like VM is stopped but allocated", async () => {
    const f=await fixture(); state="stopped_allocated"; await service.checkPolicy(await policy(f));
    expect((await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,f.instance.id)))[0]!.action).toBe("stop");
    await processNext(); expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("checks due policies even while unresolved operation backlog fills the tick", async () => {
    for (let n = 0; n < 25; n++) {
      const f = await fixture(), job = await queue(f);
      await connection.db.update(cloudLifecycleOperations).set({status:"unknown",dispatchedAt:new Date(),nextRunAt:new Date(0)}).where(eq(cloudLifecycleOperations.id,job.id));
    }
    const target=await fixture(); await policy(target);
    await connection.db.update(cloudTrafficStopPolicies).set({leaseHolder:null,leaseExpiresAt:null}).where(eq(cloudTrafficStopPolicies.instanceId,target.instance.id));
    await service.tick();
    expect((await connection.db.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId,target.instance.id)))[0]!.lastCheckedAt).not.toBeNull();
    expect(await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId,target.instance.id))).toHaveLength(1);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("immediately rechecks a stopped snapshot invalidated by a completed manual start", async () => {
    const f=await fixture(), p=await policy(f); state="stopped";
    monthly.mockImplementationOnce(async()=>{
      state="running"; usage=0;
      await queue(f,"start"); expect((await processNext()).status).toBe("succeeded");
      usage=100;
      return {month:new Date().toISOString().slice(0,7),totalBytes:100,outgoingBytes:100};
    });
    await service.checkPolicy(p);
    const [control]=await connection.db.select().from(cloudInstanceControls).where(eq(cloudInstanceControls.physicalKey,f.c.physicalKey));
    expect(control!.powerHold).toBeNull();
    const [current]=await connection.db.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId,f.instance.id));
    expect(current!.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());
    const next=await service.claimPolicy(); expect(next).not.toBeNull(); await service.checkPolicy(next!);
    expect((await connection.db.select().from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.instanceId,f.instance.id),eq(cloudLifecycleOperations.status,"queued"))))[0]!.action).toBe("stop");
  });

});
