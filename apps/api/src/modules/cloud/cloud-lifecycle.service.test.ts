import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudAccounts, cloudInstances, cloudInterfaces, cloudAddresses, cloudScanScopes, cloudLifecycleOperations, dnsRecords, operations, operationSteps, providerAccounts, zones, createDatabase, instanceAuthorizations, users } from "@masterdns/db";
import { encryptJson } from "@masterdns/crypto";
import type { AuthUser } from "../../auth/auth.types.js";
const hooks = vi.hoisted(() => ({ usage: 100, state: "running", identity: "immutable" }));
vi.mock("@masterdns/cloud-providers", async original => ({ ...await original<typeof import("@masterdns/cloud-providers")>(), createCloudAdapter: () => ({ verifyIdentity: async () => ({ externalAccountId: "123456789012" }), inspectLifecycle: async (ref: unknown) => ({ ref, identity: hooks.identity, state: hooks.state }), monthlyTraffic: async () => ({ month: new Date().toISOString().slice(0,7), totalBytes: hooks.usage, outgoingBytes: hooks.usage }) }) }));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudLifecycleService } from "./cloud-lifecycle.service.js";
const name = `lifecycle_api_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>, connection: ReturnType<typeof createDatabase>, service: CloudLifecycleService;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!; admin = createDatabase(root); await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudLifecycleService({ db: connection.db } as never);
}, 30000);
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
async function fixture() {
  const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const encrypted = encryptJson({ kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" }, Buffer.alloc(32, 1));
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: user!.id, provider: "aws", name: "AWS", externalAccountId: "123456789012", credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: `i-${randomUUID()}`, scanGeneration: 1 }).returning();
  await connection.db.insert(cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  await connection.db.insert(instanceAuthorizations).values({ instanceId: instance!.id, managed: true, allowStopStart: true, allowDelete: true });
  return { actor: { id: user!.id, role: "user" } as AuthUser, account: account!, instance: instance! };
}
describe("durable lifecycle API", () => {
  it("defaults policy off and hides another owner's instance", async () => {
    const f = await fixture(), other = await fixture();
    expect(await service.control(f.actor, f.instance.id)).toMatchObject({ policy: { enabled: false, revision: 0, checkIntervalSeconds: 3600 }, operations: [], powerHold: null });
    await expect(service.control(other.actor, f.instance.id)).rejects.toMatchObject({ status: 404 });
  });
  it("collapses concurrent same-key requests and prevents distinct simultaneous actions", async () => {
    const f = await fixture(), key = randomUUID();
    const result = await Promise.all(Array.from({ length: 4 }, () => service.action(f.actor, f.instance.id, { action: "stop" }, key)));
    expect(new Set(result.map(r => r.id)).size).toBe(1);
    await expect(service.action(f.actor, f.instance.id, { action: "start" }, key)).rejects.toMatchObject({ status: 409 });
    await expect(service.action(f.actor, f.instance.id, { action: "start" }, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect((await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId, f.instance.id)))).toHaveLength(1);
  });
  it("requires exact delete confirmation and snapshots address protection", async () => {
    const f = await fixture();
    await expect(service.action(f.actor, f.instance.id, { action: "delete", confirmation: "wrong" }, randomUUID())).rejects.toMatchObject({ status: 409 });
    const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: f.instance.id, externalId: "eni-test", scanGeneration: 1 }).returning();
    await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: "192.0.2.111", origin: "user", scanGeneration: 1 });
    const op = await service.action(f.actor, f.instance.id, { action: "delete", confirmation: f.instance.externalId }, randomUUID());
    const [row] = await connection.db.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.id, op.id));
    expect(row!.protectedAddresses).toEqual(["192.0.2.111"]);
  });
  it("allows disabling after authorization revoked but prevents enabling and stale revisions", async () => {
    const f = await fixture();
    const body = { revision: 0, enabled: true, thresholdBytes: 100, direction: "total" as const, checkIntervalSeconds: 60 };
    expect(await service.setTrafficPolicy(f.actor, f.instance.id, body)).toMatchObject({ enabled: true, revision: 1 });
    await connection.db.update(instanceAuthorizations).set({ managed: false, allowStopStart: false }).where(eq(instanceAuthorizations.instanceId, f.instance.id));
    await expect(service.setTrafficPolicy(f.actor, f.instance.id, { ...body, revision: 1 })).rejects.toMatchObject({ status: 403 });
    expect(await service.setTrafficPolicy(f.actor, f.instance.id, { ...body, revision: 1, enabled: false })).toMatchObject({ enabled: false, revision: 2 });
    await expect(service.setTrafficPolicy(f.actor, f.instance.id, { ...body, enabled: false })).rejects.toMatchObject({ status: 409 });
  });
  it("rejects manual start at the threshold until policy is disabled", async () => {
    const f = await fixture();
    await service.setTrafficPolicy(f.actor, f.instance.id, { revision: 0, enabled: true, thresholdBytes: 100, direction: "total", checkIntervalSeconds: 3600 });
    await expect(service.action(f.actor, f.instance.id, { action: "start" }, randomUUID())).rejects.toMatchObject({ status: 409 });
    await service.setTrafficPolicy(f.actor, f.instance.id, { revision: 1, enabled: false, thresholdBytes: 100, direction: "total", checkIntervalSeconds: 3600 });
    expect(await service.action(f.actor, f.instance.id, { action: "start" }, randomUUID())).toMatchObject({ status: "queued" });
  });
  it("protects enabled traffic limits and active operations across physical aliases", async () => {
    const f = await fixture(), alias = await fixture();
    await connection.db.update(cloudInstances).set({ externalId: f.instance.externalId }).where(eq(cloudInstances.id, alias.instance.id));
    await service.setTrafficPolicy(f.actor, f.instance.id, { revision: 0, enabled: true, thresholdBytes: 100, direction: "total", checkIntervalSeconds: 3600 });
    await expect(service.action(alias.actor, alias.instance.id, { action: "start" }, randomUUID())).rejects.toMatchObject({ status: 409 });
    const attempts = await Promise.allSettled([service.action(f.actor,f.instance.id,{action:"stop"},randomUUID()),service.action(alias.actor,alias.instance.id,{action:"stop"},randomUUID())]);
    expect(attempts.filter(a=>a.status==="fulfilled")).toHaveLength(1);
  });
  it("rejects IPv6-equivalent DNS and pending DNS publication references before delete", async () => {
    const f = await fixture();
    const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId:f.instance.id,externalId:"nic",scanGeneration:1 }).returning();
    await connection.db.insert(cloudAddresses).values({ interfaceId:iface!.id,kind:"host",family:"6",address:"2001:db8::1",origin:"user",scanGeneration:1 });
    const [provider] = await connection.db.insert(providerAccounts).values({ ownerUserId:f.actor.id,provider:"cloudflare",name:"DNS",credentialCiphertext:"cipher",credentialIv:"iv",credentialTag:"tag" }).returning();
    const [zone] = await connection.db.insert(zones).values({ providerAccountId:provider!.id,externalId:"zone",nameAscii:"example.com" }).returning();
    const [record] = await connection.db.insert(dnsRecords).values({ zoneId:zone!.id,externalId:"record",type:"AAAA",name:"vm.example.com",content:"2001:0db8:0:0:0:0:0:1",ttl:60,remoteHash:"hash" }).returning();
    const request=()=>service.action(f.actor,f.instance.id,{action:"delete",confirmation:f.instance.externalId},randomUUID());
    await expect(request()).rejects.toMatchObject({status:409});
    await connection.db.update(dnsRecords).set({deletedAt:new Date()}).where(eq(dnsRecords.id,record!.id));
    const [operation]=await connection.db.insert(operations).values({ownerUserId:f.actor.id,actorUserId:f.actor.id,source:"user",idempotencyKey:randomUUID(),resourceType:"dns_record"}).returning();
    await connection.db.insert(operationSteps).values({operationId:operation!.id,sequence:1,providerAccountId:provider!.id,zoneId:zone!.id,action:"create",input:{record:{type:"AAAA",content:"2001:db8::1"}}});
    await expect(request()).rejects.toMatchObject({status:409});
  });

});
