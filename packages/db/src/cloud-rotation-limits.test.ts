import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./index.js";
import { terminateRotationIncident } from "./rotation-termination.js";
import { getCloudRotationLimitStatus, recordCloudRotationThrottle, reserveCloudRotationWrite, setCloudRotationLimitPolicy } from "./cloud-rotation-limits.js";

let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
const name = `rotation_limits_${randomUUID().replaceAll("-", "")}`;
let ownerId: string;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  const [owner] = await connection.client`insert into users (username,password_hash) values (${randomUUID()},'test') returning id`;
  ownerId = owner!.id;
}, 30000);
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
async function account(provider = "aws", externalId = randomUUID()) {
  const [row] = await connection.client`insert into cloud_accounts(owner_user_id,provider,name,external_account_id,credential_ciphertext,credential_iv,credential_tag) values (${ownerId},${provider},'test',${externalId},'c','i','t') returning id`;
  return row!.id as string;
}
const reserve = (accountId: string, action = "ec2.eip.allocate", service: "ec2" | "lightsail" | "linode" | "azure_vm" = "ec2", region = "us-east-1", stepId: string = randomUUID(), remainingSteps?: Array<{ id: string; action: string }>) => connection.db.transaction(tx => reserveCloudRotationWrite(tx, { accountId, action, service, region, stepId, ...(remainingSteps ? { remainingSteps } : {}) }));
it("disables local limits across account aliases without resetting usage or bypassing vendor cooldown", async () => {
  const external = randomUUID();
  const a = await account("linode", external), b = await account("linode", external);
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, a, "linode", 1, false));
  for (let index = 0; index < 20; index++) expect(await reserve(b, "linode.ipv4.allocate", "linode")).toEqual({ allowed: true });
  expect(await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, b, "linode"))).toMatchObject({ enabled: false, usage: [expect.objectContaining({ used: 20, retryAt: null })] });
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, a, "linode", 1, true));
  expect(await reserve(b, "linode.ipv4.allocate", "linode")).toMatchObject({ allowed: false });
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, a, "linode", 1, false));
  await connection.db.transaction(tx => recordCloudRotationThrottle(tx, { accountId: a, service: "linode", region: "us-east", action: "linode.ipv4.allocate", stepId: randomUUID() }));
  expect(await reserve(b, "linode.ipv4.allocate", "linode")).toMatchObject({ allowed: false, ruleId: "cooldown" });
});
it("allows Lightsail chains with limits off and termination releases only unused reservations", async () => {
  const id = await account();
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "lightsail", 1, false));
  const plan = await lightsailPlan(id);
  expect(await plan.dispatch()).toEqual({ allowed: true });
  expect((await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "lightsail"))).usage.find(row => row.ruleId === "lightsail.static-ip.hour")).toMatchObject({ used: 3 });
  await connection.db.transaction(tx => terminateRotationIncident(tx, plan.incidentId, ownerId));
  expect((await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "lightsail"))).usage.find(row => row.ruleId === "lightsail.static-ip.hour")).toMatchObject({ used: 1 });
  expect(await connection.client`select step_id from cloud_rotation_reservations where step_id in (${plan.steps[1]!.id},${plan.steps[2]!.id})`).toHaveLength(0);
});
it("serializes concurrent requests and shares real account budgets across local copies and regions for global windows", async () => {
  const external = randomUUID(); const a = await account("linode", external); const b = await account("linode", external);
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, a, "linode", 1));
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => reserve(i % 2 ? a : b, "linode.ipv4.allocate", "linode", i % 2 ? "us-east" : "us-west")));
  expect(results.filter(result => result.allowed)).toHaveLength(16);
  const status = await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, b, "linode"));
  expect(status).toMatchObject({ utilizationPercent: 80, effectivePercent: 1, usage: [expect.objectContaining({ used: 16, remaining: 0, region: null })] });
});
it("enforces independent per-action region buckets and fails closed on unknown writes", async () => {
  const id = await account();
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "ec2", 1));
  expect(await reserve(id)).toEqual({ allowed: true });
  expect(await reserve(id)).toMatchObject({ allowed: false, reason: "rotation_rate_limited" });
  expect(await reserve(id, "ec2.eip.associate")).toEqual({ allowed: true });
  expect(await reserve(id, "ec2.eip.allocate", "ec2", "eu-west-1")).toEqual({ allowed: true });
  await expect(reserve(id, "unknown")).rejects.toThrow("unsupported_rotation_action");
});
it("uses exact sliding windows and preserves used credits on policy changes", async () => {
  const id = await account("linode");
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "linode", 1));
  for (let i = 0; i < 16; i++) await reserve(id, "linode.ipv4.allocate", "linode");
  expect(await reserve(id, "linode.instance.reboot", "linode")).toMatchObject({ allowed: false });
  await connection.client`update cloud_rotation_buckets set events = jsonb_build_array(extract(epoch from clock_timestamp() - interval '60 seconds') * 1000) where identity_key = ${JSON.stringify(["linode", (await connection.client`select external_account_id from cloud_accounts where id=${id}`)[0]!.external_account_id, "linode"])}`;
  const status = await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "linode", 2));
  expect(status.usage[0]).toMatchObject({ used: 0, remaining: 32 });
  await reserve(id, "linode.ipv4.allocate", "linode");
  expect((await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "linode", 1))).usage[0]).toMatchObject({ used: 1, remaining: 15 });
});
it("persists shared cooldowns, respects Retry-After and denies without debiting", async () => {
  const external = randomUUID(); const a = await account("aws", external); const b = await account("aws", external);
  await connection.db.transaction(tx => recordCloudRotationThrottle(tx, { accountId: a, service: "ec2", region: "us-east-1", action: "ec2.eip.allocate", stepId: "throttled", retryAfterMs: 180000 }));
  const before = Date.now(); const result = await reserve(b, "ec2.eip.associate", "ec2", "eu-west-1");
  expect(result).toMatchObject({ allowed: false, ruleId: "cooldown" });
  if (!result.allowed) expect(result.retryAt.getTime()).toBeGreaterThan(before + 170000);
  expect(await connection.client`select * from cloud_rotation_buckets where rule_id <> 'cooldown' and identity_key=${JSON.stringify(["aws", external, "ec2"])}`).toHaveLength(0);
});

async function lightsailPlan(accountId: string, region = "us-east-1") {
  const q = connection.client;
  const [instance] = await q`insert into cloud_instances(account_id,service,region,external_id,scan_generation) values (${accountId},'lightsail',${region},${randomUUID()},1) returning id`;
  const [iface] = await q`insert into cloud_interfaces(instance_id,external_id,scan_generation) values (${instance!.id},'primary',1) returning id`;
  const [slot] = await q`insert into managed_address_slots(interface_id,family,name) values (${iface!.id},'4','primary') returning id`;
  const incidentId = randomUUID(); const segmentId = randomUUID(); const attemptId = randomUUID();
  await q`insert into rotation_incidents(id,owner_user_id,slot_id,family,physical_key,source_event_id,trigger,current_segment_id,current_attempt_id,authorization_revision,policy_revision,address_version) values (${incidentId},${ownerId},${slot!.id},'4',${randomUUID()},${randomUUID()},'manual',${segmentId},${attemptId},1,1,1)`;
  await q`insert into rotation_budget_segments(id,incident_id,max_attempts) values (${segmentId},${incidentId},3)`;
  await q`insert into rotation_attempts(id,incident_id,segment_id,sequence,before_inventory) values (${attemptId},${incidentId},${segmentId},1,'{}')`;
  const steps = ["allocate", "detach", "attach"].map((action, sequence) => ({ id: `${attemptId}:${sequence}`, action: `lightsail.static-ip.${action}` }));
  for (const [sequence, step] of steps.entries()) await q`insert into rotation_steps(id,attempt_id,sequence,plan) values (${step.id},${attemptId},${sequence},${JSON.stringify(step)}::jsonb)`;
  return { incidentId, attemptId, steps, dispatch: (index = 0) => reserve(accountId, steps[index]!.action, "lightsail", region, steps[index]!.id, steps.slice(index)) };
}
it("reserves the complete Lightsail chain before dispatch and retains paused reservations beyond a day", async () => {
  const id = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "lightsail", 6));
  const first = await lightsailPlan(id); const competitor = await lightsailPlan(id, "eu-west-1");
  expect(await first.dispatch()).toEqual({ allowed: true });
  expect(await competitor.dispatch()).toMatchObject({ allowed: false });
  expect(await connection.client`select * from cloud_rotation_reservations where step_id in (${first.steps[1]!.id},${first.steps[2]!.id}) and consumed_at is null`).toHaveLength(2);
  expect(await connection.client`select * from cloud_rotation_reservations where step_id=${competitor.steps[1]!.id}`).toHaveLength(0);
  await connection.client`update rotation_incidents set status='paused' where id=${first.incidentId}`;
  await connection.client`update cloud_rotation_reservations set created_at=clock_timestamp()-interval '2 days' where step_id in (${first.steps[1]!.id},${first.steps[2]!.id})`;
  await connection.client`update cloud_rotation_buckets set events='[]',updated_at=clock_timestamp()-interval '2 days' where identity_key=${JSON.stringify(["aws", (await connection.client`select external_account_id from cloud_accounts where id=${id}`)[0]!.external_account_id, "lightsail"])}`;
  expect(await competitor.dispatch()).toMatchObject({ allowed: false });
  expect(await first.dispatch(1)).toEqual({ allowed: true });
  expect((await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "lightsail"))).usage.find(u => u.ruleId === "lightsail.static-ip.hour")).toMatchObject({ used: 2, remaining: 1 });
  await connection.client`update rotation_incidents set status='complete' where id=${first.incidentId}`;
  await connection.client`update cloud_rotation_buckets set events='[]',updated_at=clock_timestamp()-interval '2 days'`;
  expect(await competitor.dispatch()).toEqual({ allowed: true });
});
it("charges retried dispatched steps again and lets Release exceed dynamic windows but not its static bucket", async () => {
  const id = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "lightsail", 6));
  const plan = await lightsailPlan(id); expect(await plan.dispatch()).toEqual({ allowed: true });
  await connection.client`update rotation_steps set dispatched_at=clock_timestamp() where id=${plan.steps[0]!.id}`;
  await connection.client`update cloud_rotation_buckets set updated_at=clock_timestamp()-interval '5 minutes' where rule_id='lightsail.AllocateStaticIp'`;
  expect(await plan.dispatch()).toMatchObject({ allowed: false, ruleId: "lightsail.static-ip.hour" });
  expect(await reserve(id, "lightsail.static-ip.release", "lightsail")).toEqual({ allowed: true });
  expect(await reserve(id, "lightsail.static-ip.release", "lightsail")).toMatchObject({ allowed: false, ruleId: "lightsail.ReleaseStaticIp" });
  expect((await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "lightsail"))).usage.find(u => u.ruleId === "lightsail.static-ip.hour")).toMatchObject({ used: 4, remaining: 0 });
  // Already protected future steps remain available even when Release increased the window usage.
  expect(await plan.dispatch(1)).toEqual({ allowed: true });
  expect(await plan.dispatch(2)).toEqual({ allowed: true });
});
it("ignores reservations from abandoned/noncurrent attempts and rolls back credits with failed dispatch persistence", async () => {
  const id = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "lightsail", 6));
  const old = await lightsailPlan(id); const next = await lightsailPlan(id, "eu-west-1");
  expect(await old.dispatch()).toEqual({ allowed: true });
  await connection.client`update rotation_attempts set status='abandoned' where id=${old.attemptId}`;
  await connection.client`update cloud_rotation_buckets set events='[]' where rule_id like 'lightsail.static-ip.%'`;
  expect(await next.dispatch()).toEqual({ allowed: true });
  const ec2 = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, ec2, "ec2", 1));
  await expect(connection.db.transaction(async tx => {
    expect(await reserveCloudRotationWrite(tx, { accountId: ec2, service: "ec2", region: "us-east-1", action: "ec2.eip.allocate", stepId: "rollback" })).toEqual({ allowed: true });
    throw new Error("dispatch write failed");
  })).rejects.toThrow("dispatch write failed");
  expect(await reserve(ec2)).toEqual({ allowed: true });
});
it("materializes refill at the old policy rate before increasing policy", async () => {
  const id = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "ec2", 1));
  expect(await reserve(id)).toEqual({ allowed: true });
  const external = (await connection.client`select external_account_id from cloud_accounts where id=${id}`)[0]!.external_account_id;
  await connection.client`update cloud_rotation_buckets set updated_at=clock_timestamp()-interval '1 second' where identity_key=${JSON.stringify(["aws", external, "ec2"])}`;
  const status = await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "ec2", 100));
  const usage = status.usage.find(u => u.ruleId === "ec2.AllocateAddress")!;
  expect(usage.used).toBeGreaterThan(0.8);
  expect(usage.used).toBeLessThanOrEqual(0.95);
});
it("rejects a Lightsail policy too small for a safe chain without consuming any credits", async () => {
  const id = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "lightsail", 1));
  const plan = await lightsailPlan(id);
  await expect(plan.dispatch()).rejects.toThrow("rotation_limit_too_low");
  expect((await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "lightsail"))).usage.every(u => u.used === 0)).toBe(true);
});
it("does not reuse a consumed step reservation on a subsequent dispatch", async () => {
  const id = await account(); await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "lightsail", 6));
  const plan = await lightsailPlan(id); expect(await plan.dispatch()).toEqual({ allowed: true });
  expect(await plan.dispatch(1)).toEqual({ allowed: true });
  await connection.client`update rotation_steps set dispatched_at=clock_timestamp() where id=${plan.steps[1]!.id}`;
  await connection.client`update cloud_rotation_buckets set updated_at=clock_timestamp()-interval '5 minutes' where rule_id='lightsail.DetachStaticIp'`;
  expect(await plan.dispatch(1)).toMatchObject({ allowed: false, ruleId: "lightsail.static-ip.hour" });
  expect(await plan.dispatch(2)).toEqual({ allowed: true });
});
it("persists budget across reconnects, credential updates and deletion/recreation of local accounts", async () => {
  const external = randomUUID(); const id = await account("aws", external);
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "ec2", 1));
  expect(await reserve(id)).toEqual({ allowed: true });
  await connection.client`update cloud_accounts set credential_ciphertext='replacement' where id=${id}`;
  const root = new URL(process.env.MASTERDNS_TEST_DATABASE_URL!); root.pathname = `/${name}`;
  const restarted = createDatabase(root.toString());
  try { expect(await restarted.db.transaction(tx => reserveCloudRotationWrite(tx, { accountId: id, service: "ec2", region: "us-east-1", stepId: "restart", action: "ec2.eip.allocate" }))).toMatchObject({ allowed: false }); }
  finally { await restarted.close(); }
  await connection.client`delete from cloud_accounts where id=${id}`;
  const replacement = await account("aws", external);
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, replacement, "ec2", 1));
  expect(await reserve(replacement)).toMatchObject({ allowed: false });
});
it("bounds exponential cooldown and Retry-After and enforces service identity", async () => {
  const id = await account();
  const input = { accountId: id, service: "ec2" as const, region: "us-east-1", stepId: "cooldown", action: "ec2.eip.allocate" };
  const start = Date.now();
  let until: Date = new Date();
  for (let i = 0; i < 8; i++) until = await connection.db.transaction(tx => recordCloudRotationThrottle(tx, input));
  expect(until.getTime() - start).toBeGreaterThanOrEqual(3600000);
  expect(until.getTime() - start).toBeLessThan(3605000);
  until = await connection.db.transaction(tx => recordCloudRotationThrottle(tx, { ...input, retryAfterMs: 1e15 }));
  expect(until.getTime() - start).toBeLessThan(86405000);
  expect(until.getTime() - start).toBeGreaterThanOrEqual(86400000);
  await expect(connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "linode"))).rejects.toThrow("cloud_service_mismatch");
});
it("keeps Azure ARM writes/deletes separate and shares the network window between both", async () => {
  const id = await account("azure");
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, id, "azure_vm", 1));
  expect(await reserve(id, "azure.public-ip.allocate", "azure_vm", "eastus")).toEqual({ allowed: true });
  expect(await reserve(id, "azure.public-ip.associate", "azure_vm", "eastus")).toEqual({ allowed: true });
  expect(await reserve(id, "azure.public-ip.allocate", "azure_vm", "eastus")).toMatchObject({ allowed: false, ruleId: "azure.arm.writes" });
  expect(await reserve(id, "azure.public-ip.delete", "azure_vm", "eastus")).toEqual({ allowed: true });
  const status = await connection.db.transaction(tx => getCloudRotationLimitStatus(tx, id, "azure_vm"));
  expect(status.usage.find(u => u.ruleId === "azure.network.mutations")).toMatchObject({ used: 3, remaining: 7 });
});
