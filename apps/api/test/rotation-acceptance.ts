import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { desc, eq } from 'drizzle-orm';
import { addressHealthPolicies, addressHealthStates, captureCloudPolicyLinks, prepareCloudPolicyRestore, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, cloudEndpointLinks, domainBindings, endpointPools, endpoints, endpointAddresses, bindingAssignments, providerAccounts, zones, healthCheckConfigs, instanceAuthorizations, managedAddressSlots, probeObservations, probeRounds, rotationAttempts, rotationBudgetSegments, rotationIncidents, rotationLeases, rotationPolicies, rotationPublications, rotationResources, operationSteps, operations, dnsRecords, rotationSteps } from '@masterdns/db';
import { createIntegrationHarness, cleanup, until } from './rotation-harness.js';
import { assertRecoveredCloudEffect } from '../../../tests/integration/rotation-recovery.test.js';
import { remoteControlPlane } from './rotation-remote.js';

let harness!: Awaited<ReturnType<typeof createIntegrationHarness>>;
let remote!: Awaited<ReturnType<typeof remoteControlPlane>>;
const activeChildren = new Set<ReturnType<typeof spawn>>();
async function child(action: string, incidentId?: string, turns = 1, crash?: string, extra: Record<string, unknown> = {}) {
  const settings = { ...extra, action, incidentId, turns, databaseUrl: harness.databaseUrl, redisUrl: harness.redisUrl, remoteUrl: remote.url };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TSX_TSCONFIG_PATH: new URL('./tsconfig.integration.json', import.meta.url).pathname, MASTERDNS_INTEGRATION_CHILD: JSON.stringify(settings) };
  const failpoint = crash ? remote.failAt(crash, crash === 'dns.create' ? 2 : 1, crash === 'dns.create') : undefined;
  // Spawn the Node process itself so SIGKILL cannot leave a pnpm/tsx grandchild alive.
  const processChild = spawn(process.execPath, ['--import', 'tsx', 'test/rotation-child.ts'], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChildren.add(processChild);
  let output = ''; processChild.stdout.on('data', chunk => { output += chunk; }); processChild.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { processChild.once('error', reject); processChild.once('close', (code, signal) => { activeChildren.delete(processChild); resolve({ code, signal }); }); });
  const timer = setTimeout(() => processChild.kill('SIGKILL'), 40_000);
  try {
    if (failpoint) { await Promise.race([failpoint, closed.then(() => { throw new Error(`Child exited before ${crash}: ${output}`); })]); processChild.kill('SIGKILL'); }
    const result = await closed;
    for (const secret of [harness.databaseUrl, new URL(harness.databaseUrl).password].filter(Boolean)) assert(!output.includes(secret), 'worker output contains a database credential');
    if (crash) assert.equal(result.signal, 'SIGKILL'); else assert.equal(result.code, 0, output);
  } finally { clearTimeout(timer); }
}
async function fixture(initial = false, release = false) {
  const { db, actor, group } = harness;
  const targets = await harness.fixtureTargets();
  const old = initial ? targets.success : targets.failure, candidate = targets.success;
  const [account] = await db.insert(cloudAccounts).values({ ownerUserId: actor.id, provider: 'aws', name: randomUUID(), externalAccountId: '123456789012', credentialCiphertext: 'test-only', credentialIv: 'test-only', credentialTag: 'test-only' }).returning();
  await db.insert(cloudScanScopes).values({ accountId: account!.id, service: 'ec2', region: 'us-east-1', generation: 1 });
  const [instance] = await db.insert(cloudInstances).values({ accountId: account!.id, service: 'ec2', region: 'us-east-1', externalId: `i-${randomUUID()}`, metadata: { present: true }, scanGeneration: 1 }).returning();
  const [iface] = await db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: `eni-${randomUUID()}`, metadata: { deviceIndex: 0 }, scanGeneration: 1 }).returning();
  const [address] = await db.insert(cloudAddresses).values({ interfaceId: iface!.id, family: '4', kind: 'host', address: old, remoteAllocationId: `old-${instance!.externalId}`, origin: 'user', scanGeneration: 1 }).returning();
  const [slot] = await db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: '4', name: 'primary', currentAddressId: address!.id, currentVersion: initial ? 0 : 1, ...(initial ? { candidateAddressId: address!.id, candidateVersion: 1 } : {}) }).returning();
  await db.insert(instanceAuthorizations).values({ instanceId: instance!.id, managed: true, allowIpv4Rotation: !initial, allowReleaseAddress: release });
  const [config] = await db.insert(healthCheckConfigs).values({ slotId: slot!.id, checkerType: 'tcp', config: { type: 'tcp', port: 18080, timeoutMs: 1000 } }).returning();
  const [policy] = await db.insert(addressHealthPolicies).values({ slotId: slot!.id, family: '4', configId: config!.id, groupId: group.id, checkIntervalSeconds: 3, executionWindowSeconds: 3, resultExpirySeconds: 60, consensus: { mode: 'all', minimumValid: 1 } }).returning();
  await db.insert(rotationPolicies).values({ slotId: slot!.id, enabled: !initial });
  const [pool] = await db.insert(endpointPools).values({ ownerUserId: actor.id, name: randomUUID(), strategy: 'primary_backup' }).returning();
  const [endpoint] = await db.insert(endpoints).values({ poolId: pool!.id, name: 'cloud', addressMode: 'cloud' }).returning();
  await db.insert(cloudEndpointLinks).values({ endpointId: endpoint!.id, slotId: slot!.id, family: '4' });
  const [provider] = await db.insert(providerAccounts).values({ ownerUserId: actor.id, provider: 'cloudflare', name: randomUUID(), credentialCiphertext: 'test-only', credentialIv: 'test-only', credentialTag: 'test-only' }).returning();
  const [zone] = await db.insert(zones).values({ providerAccountId: provider!.id, externalId: randomUUID(), nameAscii: 'isolated.test' }).returning();
  const bindings = await db.insert(domainBindings).values(['one', 'two'].map(name => ({ poolId: pool!.id, zoneId: zone!.id, fqdn: `${name}.isolated.test`, recordType: 'A', ttl: 2 }))).returning();
  remote.add(instance!.externalId, iface!.externalId, old, candidate);
  remote.instances.get(instance!.externalId).slotId = slot!.id;
  return { stopTcp: targets.stopTcp, pool: pool!, endpoint: endpoint!, zone: zone!, bindings, slot: slot!, policy: policy!, config: config!, instance: instance!, old, candidate };
}
async function main() {
  harness = await createIntegrationHarness(); remote = await remoteControlPlane();
  process.env.DATABASE_URL = harness.databaseUrl; process.env.REDIS_URL = harness.redisUrl; process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  const { ProbeHealthService } = await import('../../worker/src/probes/probe-health.service.js');
  const { ProbeSchedulerService } = await import('../../worker/src/probes/probe-scheduler.service.js');
  const { HealthResultService } = await import('../../worker/src/health/health-result.service.js');
  const health = new ProbeHealthService(harness.database, new HealthResultService(harness.database));
  const scheduler = new ProbeSchedulerService(harness.database, health);
  const db = harness.db;
  async function round(f: Awaited<ReturnType<typeof fixture>>, outcome: 'failure' | 'success' | 'unavailable') {
    const r = await until('policy round due', () => scheduler.schedulePolicy(f.policy.id));
    const observation = await until('actual binary result', async () => (await db.select().from(probeObservations).where(eq(probeObservations.roundId, r.id)))[0]);
    assert.equal(observation.outcome, outcome); assert.equal(observation.status, 'accepted');
    await delay(Math.max(0, r.deadline.getTime() - Date.now() + 15));
    assert.equal(await health.closeRound(r.id), outcome === 'unavailable' ? 'unknown' : outcome);
    remote.events.push(`${outcome}_round_v${r.addressVersion}`);
    await child('recover');
    return r;
  }
  const f = await fixture();
  // Missing and expired measurements are never converted to a failure vote.
  await harness.stopAgent();
  const missing = await scheduler.schedulePolicy(f.policy.id); assert(missing);
  const leased = await harness.post('tasks/lease', { protocol: 'probe-agent/v1', capacity: 1 });
  const task = leased.body.tasks[0]; assert.equal(task.roundId, missing.id);
  await delay(Math.max(0, missing.deadline.getTime() - Date.now() + 15));
  const stale = await harness.post('results', { protocol: 'probe-agent/v1', results: [{ protocol: 'probe-agent/v1', taskId: task.taskId, leaseId: task.leaseId, addressVersion: task.addressVersion, configVersion: task.configVersion, outcome: 'failure', latencyMs: 1, measuredAt: new Date().toISOString() }] });
  assert.equal(stale.body.results[0].status, 'stale');
  assert.equal(await health.closeRound(missing.id), 'unknown'); await child('recover');
  assert.equal((await db.select().from(rotationIncidents)).length, 0); assert.equal(remote.events.length, 0);
  await harness.startAgent();
  for (let i = 0; i < 3; i++) { await round(f, 'failure'); if (i < 2) assert.equal((await db.select().from(rotationIncidents)).length, 0); }
  const [incident] = await db.select().from(rotationIncidents).where(eq(rotationIncidents.slotId, f.slot.id)); assert(incident);
  assert.equal(remote.events.filter(e => e.startsWith('cloud_')).length, 0);
  await child('rotate', incident.id, 5);
  const [candidateSlot] = await db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, f.slot.id));
  assert.equal(candidateSlot!.candidateVersion, 2); assert(candidateSlot!.candidateAddressId); assert.equal(candidateSlot!.currentAddressId, f.slot.currentAddressId);
  assert.equal(remote.events.filter(e => e === 'cloud_allocated').length, 1); assert.equal(remote.events.filter(e => e === 'cloud_attached').length, 1);
  await harness.stopAgent();
  const oldVersionRound = await scheduler.schedulePolicy(f.policy.id); assert(oldVersionRound);
  const oldVersionLease = await harness.post('tasks/lease', { protocol: 'probe-agent/v1', capacity: 1 });
  const oldVersionTask = oldVersionLease.body.tasks[0]; assert.equal(oldVersionTask.roundId, oldVersionRound.id);
  const rejectedOld = await harness.post('results', { protocol: 'probe-agent/v1', results: [{ protocol: 'probe-agent/v1', taskId: oldVersionTask.taskId, leaseId: oldVersionTask.leaseId, addressVersion: 1, configVersion: oldVersionTask.configVersion, outcome: 'success', latencyMs: 1, measuredAt: new Date().toISOString() }] });
  assert.equal(rejectedOld.body.results[0].status, 'stale');
  await delay(Math.max(0, oldVersionRound.deadline.getTime() - Date.now() + 15));
  assert.equal(await health.closeRound(oldVersionRound.id), 'unknown'); await child('rotate', incident.id);
  assert.equal((await db.select().from(rotationPublications)).length, 0); assert.equal(remote.events.filter(e => e === 'cloud_allocated').length, 1);
  await harness.startAgent();
  for (let i = 0; i < 3; i++) {
    await round(f, 'success'); await child('rotate', incident.id);
    if (i < 2) assert.equal((await db.select().from(rotationPublications)).length, 0, 'candidate must await three fresh successes');
  }
  const [publication] = await db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, incident.id)); assert(publication);
  assert.equal(publication.addressVersion, 2); remote.events.push('candidate_verified');
  assert.equal((await db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, incident.id)))[0]!.attemptsUsed, 1);
  assert.equal(remote.writesToUnmanaged, 0);
  console.log('PASS: actual Agent → HTTPS ingestion → three failure rounds → one real EC2 adapter allocation/attachment → new version → three success rounds');
  async function publish(f: Awaited<ReturnType<typeof fixture>>, incidentId?: string, crash?: string) {
    const cloudBefore = remote.events.filter(e => e === 'cloud_allocated').length;
    await child('publish', incidentId, 1, crash, { slotId: f.slot.id, beforeCleanup: crash === 'checkpoint.cleanup' });
    if (crash === 'dns.create') {
      assert.equal([...remote.records.values()].filter(r => r.zone_id === f.zone.externalId).length, 1);
      const [op] = await db.select().from(operations).where(eq(operations.resourceId, f.pool.id)); assert(op);
      const steps = await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id));
      assert.equal(steps.filter(s => s.status === 'succeeded').length, 1);
      const [p] = await db.select().from(rotationPublications).where(eq(rotationPublications.slotId, f.slot.id)); assert.notEqual(p!.status, 'applied');
      const redis = new Redis(harness.redisUrl);
      try { for (const key of [`masterdns:operation-lock:${op.id}`, `masterdns:zone-lock:${f.zone.id}`]) await redis.pexpire(key, 1); } finally { await redis.quit(); }
      await delay(5);
      await child('publish', incidentId, 1, undefined, { slotId: f.slot.id });
      assert.equal([...remote.records.values()].filter(r => r.zone_id === f.zone.externalId).length, 2);
      assert.equal(remote.events.filter(e => e === 'cloud_allocated').length, cloudBefore);
      console.log('PASS: SIGKILL after first DNS step retains its success and restarts the remaining step without duplicate create/allocation');
    }
    const [p] = await db.select().from(rotationPublications).where(eq(rotationPublications.slotId, f.slot.id)).orderBy(desc(rotationPublications.addressVersion));
    assert.equal(p!.status, 'applied'); assert(p!.children.every(c => c.operationId));
    const cached = await db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id));
    assert.equal(cached.length, 2); assert(cached.every(r => r.content === f.candidate));
    const remoteRecords = [...remote.records.values()].filter(r => r.zone_id === f.zone.externalId);
    assert.equal(remoteRecords.length, 2); assert(remoteRecords.every(r => r.content === f.candidate));
    remote.events.push('dns_published'); return p!;
  }
  await publish(f, incident.id);
  assert(remote.events.indexOf('candidate_verified') < remote.events.indexOf('dns_published'));
  let cleanupCase: { f: Awaited<ReturnType<typeof fixture>>; incident: typeof incident; publication: typeof publication } | undefined;
  for (const crash of ['AllocateAddressCommand', 'AssociateAddressCommand']) {
    const recovered = await fixture(false, crash === 'AssociateAddressCommand');
    for (let i = 0; i < 3; i++) await round(recovered, 'failure');
    const [recoveryIncident] = await db.select().from(rotationIncidents).where(eq(rotationIncidents.slotId, recovered.slot.id)); assert(recoveryIncident);
    const before = remote.events.filter(e => e === 'cloud_allocated').length;
    await child('rotate', recoveryIncident.id, crash === 'AllocateAddressCommand' ? 1 : 3);
    await child('rotate', recoveryIncident.id, 1, crash);
    const [attempt] = await db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, recoveryIncident.id)); assert(attempt?.charged);
    const [lease] = await db.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, recoveryIncident.physicalKey)); assert(lease?.unresolvedStepId);
    const [intent] = await db.select().from(rotationSteps).where(eq(rotationSteps.id, lease.unresolvedStepId)); assert.equal(intent!.status, 'in_flight'); assert.equal(intent!.receipt, null);
    // Only the expired lease clock is advanced. Keep its incident, revision, unresolved step and attempt evidence.
    await db.update(rotationLeases).set({ expiresAt: new Date(0) }).where(eq(rotationLeases.physicalKey, recoveryIncident.physicalKey));
    await child('rotate', recoveryIncident.id, 5);
    const attempts = await db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, recoveryIncident.id));
    const segments = await db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, recoveryIncident.id));
    assertRecoveredCloudEffect({ originalAttemptId: attempt.id, allocationsBefore: before, allocationsAfter: remote.events.filter(e => e === 'cloud_allocated').length, attempts, budgets: segments, publicationsBeforeVerification: (await db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, recoveryIncident.id))).length });
    for (let i = 0; i < 3; i++) { await round(recovered, 'success'); await child('rotate', recoveryIncident.id); }
    const published = await publish(recovered, recoveryIncident.id, crash === 'AllocateAddressCommand' ? 'dns.create' : 'checkpoint.cleanup');
    if (crash === 'AssociateAddressCommand') cleanupCase = { f: recovered, incident: recoveryIncident, publication: published };
    console.log(`PASS: SIGKILL after ${crash} effect before receipt recovers the same attempt, allocation and charged budget`);
  }
  assert.equal(remote.events.filter(e => e === 'cloud_released').length, 0, 'release remains off by default');
  assert(cleanupCase);
  const [old] = (await db.select().from(rotationResources).where(eq(rotationResources.incidentId, cleanupCase.incident.id))).filter(r => r.role === 'original'); assert(old?.cleanupDueAt);
  assert.equal(old.cleanupStatus, 'pending');
  assert(old.cleanupDueAt.getTime() >= cleanupCase.publication.appliedAt!.getTime() + (cleanupCase.publication.previousMaxTtl + 60) * 1000);
  await child('cleanup'); assert.equal(remote.events.filter(e => e === 'cloud_released').length, 0, 'grace period prevents early cleanup after restart');
  const initial = await fixture(true);
  for (let i = 0; i < 3; i++) await round(initial, 'success');
  await publish(initial);
  assert.equal((await db.select().from(rotationIncidents).where(eq(rotationIncidents.slotId, initial.slot.id))).length, 0);
  assert.equal((await db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, initial.slot.id)))[0]!.currentVersion, 1);
  console.log('PASS: initial verified binding publishes version 1 with automatic rotation disabled and no incident');
  // Verify the P7 current-slot fanout with an actual, independently probed backup.
  const backupAddress = await harness.startBackupTcp();
  const [backup] = await db.insert(endpoints).values({ poolId: initial.pool.id, name: 'backup', priority: 200 }).returning();
  await db.insert(endpointAddresses).values({ endpointId: backup!.id, family: '4', address: backupAddress, state: 'current', source: 'static' });
  const [backupConfig] = await db.insert(healthCheckConfigs).values({ endpointId: backup!.id, checkerType: 'tcp', config: { type: 'tcp', port: 18080, timeoutMs: 1000 } }).returning();
  const [backupPolicy] = await db.insert(addressHealthPolicies).values({ endpointId: backup!.id, family: '4', configId: backupConfig!.id, groupId: harness.group.id, checkIntervalSeconds: 3, executionWindowSeconds: 3, resultExpirySeconds: 60 }).returning();
  for (let i = 0; i < 3; i++) await round({ ...initial, policy: backupPolicy! }, 'success');
  assert.equal((await db.select().from(endpoints).where(eq(endpoints.id, backup!.id)))[0]!.healthState, 'healthy');
  await db.transaction(async tx => prepareCloudPolicyRestore(tx, initial.pool.id, harness.actor.id, await captureCloudPolicyLinks(tx, initial.pool.id)));
  const [revalidating] = await db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, initial.slot.id));
  assert.equal(revalidating!.candidateAddressId, revalidating!.currentAddressId); assert.equal(revalidating!.candidateVersion, 2);
  await initial.stopTcp();
  for (let i = 0; i < 3; i++) await round(initial, 'failure');
  assert.equal((await db.select().from(endpoints).where(eq(endpoints.id, initial.endpoint.id)))[0]!.healthState, 'unhealthy');
  await child('reconcile', undefined, 1, undefined, { zoneId: initial.zone.id, expectedAddress: backupAddress });
  for (const binding of initial.bindings) {
    const assignments = await db.select().from(bindingAssignments).where(eq(bindingAssignments.domainBindingId, binding.id));
    assert(assignments.some(a => a.endpointId === backup!.id && a.applied));
  }
  assert.equal((await db.select().from(rotationIncidents).where(eq(rotationIncidents.slotId, initial.slot.id))).length, 0);
  console.log('PASS: three actual failures during same-address restore revalidation atomically fan out to Pool health and publish the independently verified backup with rotation off');
  console.log('Waiting for the persisted old DNS TTL + 60 second cleanup grace');
  await delay(Math.max(0, old.cleanupDueAt.getTime() - Date.now() + 100));
  await child('cleanup', undefined, 1, 'ReleaseAddressCommand');
  assert.equal(remote.events.filter(e => e === 'cloud_released').length, 1);
  await db.update(rotationLeases).set({ expiresAt: new Date(0) }).where(eq(rotationLeases.physicalKey, cleanupCase.incident.physicalKey));
  await child('cleanup');
  assert.equal((await db.select().from(rotationResources).where(eq(rotationResources.id, old.id)))[0]!.cleanupStatus, 'released');
  assert.equal((await db.select().from(rotationIncidents).where(eq(rotationIncidents.id, cleanupCase.incident.id)))[0]!.status, 'complete');
  assert.equal(remote.events.filter(e => e === 'cloud_released').length, 1);
  assert.equal((await db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, cleanupCase.incident.id)))[0]!.attemptsUsed, 1);
  assert.equal(remote.writesToUnmanaged, 0);
  console.log('PASS: restart before cleanup honors real TTL grace; SIGKILL after release observes its receipt without repeated release or budget reset');
  console.log('P12b full Agent/cloud/DNS closed loop and child crash recovery passed.');
  await harness.assertSecretFree();
}
try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await Promise.all([...activeChildren].map(p => new Promise<void>(resolve => { p.once('close', () => resolve()); p.kill('SIGKILL'); })));
  try { await remote?.close(); } finally { await cleanup(); }
}
