import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { AuthGuard } from '../../auth/auth.guard.js';
import { ApiExceptionFilter } from '../../common/api-exception.filter.js';
import { ProbeAgentController } from './probe-agent.controller.js';
import { ProbesController } from './probes.controller.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, managedAddressSlots, createDatabase, users, endpointPools, endpoints, endpointAddresses, healthCheckConfigs, probeRounds, probeTasks, probeObservations, probeTokens, probeGroups } from '@masterdns/db';
import { hashToken } from '@masterdns/crypto';
import { probeTaskSchema, type ProbeTask, type ProbeResult } from '@masterdns/contracts';
import { ProbeRoundsService } from './probe-rounds.service.js';
import { ProbesService } from './probes.service.js';
import { ProbeAgentAuth } from './probe-agent-auth.js';
import { ProbeLeasesService } from './probe-leases.service.js';
import { ProbeResultsService } from './probe-results.service.js';
import type { AuthUser } from '../../auth/auth.types.js';

const name = `probes_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let management: ProbesService;
let auth: ProbeAgentAuth;
let leases: ProbeLeasesService;
let results: ProbeResultsService;
const now = new Date('2026-09-15T00:00:00Z');
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error('MASTERDNS_TEST_DATABASE_URL is required');
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL('../../../../../packages/db/drizzle', import.meta.url).pathname });
  const database = { db: connection.db } as never;
  management = new ProbesService(database);
  auth = new ProbeAgentAuth(database);
  leases = new ProbeLeasesService(database);
  results = new ProbeResultsService(database);
}, 30000);
afterAll(async () => {
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); }
});
async function fixture() {
  const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: 'test' }).returning();
  const actor = { id: user!.id, role: 'user' } as AuthUser;
  const probe = await management.create(actor, { name: 'Probe', maxConcurrency: 2 });
  const other = await management.create(actor, { name: 'Other', maxConcurrency: 2 });
  const [pool] = await connection.db.insert(endpointPools).values({ ownerUserId: actor.id, name: 'Pool', strategy: 'primary_backup' }).returning();
  const [endpoint] = await connection.db.insert(endpoints).values({ poolId: pool!.id, name: 'Endpoint' }).returning();
  const [address] = await connection.db.insert(endpointAddresses).values({ endpointId: endpoint!.id, family: '4', address: '192.0.2.1', state: 'current', source: 'static' }).returning();
  const config = { type: 'tcp' as const, port: 443, timeoutMs: 3000 };
  const [check] = await connection.db.insert(healthCheckConfigs).values({ endpointId: endpoint!.id, checkerType: 'tcp', config }).returning();
  return { actor, probe, other, endpoint: endpoint!, address: address!, check: check!, config };
}
async function round(f: Awaited<ReturnType<typeof fixture>>, probeIds = [f.probe.id]) {
  const [r] = await connection.db.insert(probeRounds).values({ endpointId: f.endpoint.id, endpointAddressId: f.address.id, configId: f.check.id, sequence: Number((await connection.db.select().from(probeRounds).where(eq(probeRounds.endpointId, f.endpoint.id))).length)+1, addressVersion: 1, configVersion: 1, address: '192.0.2.1', family: '4', config: f.config, memberIds: probeIds, consensus: { mode: 'all', minimumValid: 1 }, deadline: new Date(now.getTime()+10000), resultExpiresAt: new Date(now.getTime()+60000) }).returning();
  await connection.db.insert(probeTasks).values(probeIds.map(probeId => ({ roundId: r!.id, probeId })));
  return r!;
}
function result(task: ProbeTask): ProbeResult {
  return { protocol: 'probe-agent/v1', taskId: task.taskId, leaseId: task.leaseId, addressVersion: task.addressVersion, configVersion: task.configVersion, outcome: 'success', latencyMs: 3, measuredAt: now.toISOString() };
}

describe('probe identity and management', () => {
  it('exchanges an install token once under concurrent requests and stores only hashes', async () => {
    const f = await fixture();
    const install = await management.createInstallToken(f.actor, f.probe.id, now);
    expect(install.expiresAt.getTime()-now.getTime()).toBe(900000);
    const attempts = await Promise.allSettled([auth.exchange(install.installToken, now), auth.exchange(install.installToken, now)]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(x => x.status === 'rejected')).toHaveLength(1);
    const success = attempts.find(x => x.status === 'fulfilled')!;
    if (success.status !== 'fulfilled') throw new Error('no exchange');
    expect(await auth.authenticate(`Bearer ${success.value.runtimeToken}`, now)).toMatchObject({ probeId: f.probe.id });
    const tokens = await connection.db.select().from(probeTokens);
    expect(tokens.map(t => t.tokenHash)).toContain(hashToken(success.value.runtimeToken));
    expect(JSON.stringify(tokens)).not.toContain(success.value.runtimeToken);
    await expect(auth.authenticate(`Bearer ${install.installToken}`, now)).rejects.toMatchObject({ status: 401 });
  });
  it('revocation invalidates runtime tokens and blocks already authenticated requests', async () => {
    const f = await fixture(); await round(f);
    const install = await management.createInstallToken(f.actor, f.probe.id, now);
    const runtime = await auth.exchange(install.installToken, now);
    const identity = await auth.authenticate(`Bearer ${runtime.runtimeToken}`, now);
    const [task] = await leases.lease(f.probe.id, 2, now, identity.tokenHash);
    await management.revoke(f.actor, f.probe.id, now);
    await expect(auth.authenticate(`Bearer ${runtime.runtimeToken}`, now)).rejects.toMatchObject({ status: 401 });
    await expect(results.accept(f.probe.id, result(task!), now, identity.tokenHash)).rejects.toMatchObject({ status: 401 });
    await expect(leases.lease(f.probe.id, 2, now, identity.tokenHash)).rejects.toMatchObject({ status: 401 });
    expect(await connection.db.select().from(probeObservations).where(eq(probeObservations.taskId, task!.taskId))).toHaveLength(0);
  });
  it('enforces ownership, group membership ownership, and token expiration', async () => {
    const f = await fixture(); const stranger = await fixture();
    expect(await management.list(stranger.actor)).not.toContainEqual(expect.objectContaining({ id: f.probe.id }));
    await expect(management.revoke(stranger.actor, f.probe.id)).rejects.toMatchObject({ status: 404 });
    const group = await management.createGroup(f.actor, { name: 'Group' });
    await expect(management.setMembers(f.actor, group.id, [stranger.probe.id])).rejects.toMatchObject({ status: 404 });
    await management.setMembers(f.actor, group.id, [f.probe.id, f.other.id]);
    expect((await management.listGroups(f.actor))[0]?.memberIds).toEqual(expect.arrayContaining([f.probe.id, f.other.id]));
    const install = await management.createInstallToken(f.actor, f.probe.id, now);
    await expect(auth.exchange(install.installToken, install.expiresAt)).rejects.toMatchObject({ status: 401 });
  });
});
describe('transactional probe leases and observations', () => {
  it('never leases a task twice concurrently and enforces total outstanding capacity', async () => {
    const f = await fixture();
    for (let i=0; i<5; i++) await round(f, [f.probe.id, f.other.id]);
    const batches = await Promise.all(Array.from({length: 5}, () => leases.lease(f.probe.id, 100, now)));
    const tasks = batches.flat();
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map(t => t.taskId)).size).toBe(2);
    for (const task of tasks) { expect(task.probeId).toBe(f.probe.id); expect(probeTaskSchema.safeParse(task).success).toBe(true); }
    expect(await leases.lease(f.other.id, 1, now)).toHaveLength(1);
    expect(await leases.lease(f.probe.id, 100, new Date(now.getTime()+11000))).toHaveLength(0);
  });
  it('SKIP LOCKED skips an independently locked pending task', async () => {
    const f = await fixture(); const r = await round(f); await round(f);
    await connection.db.transaction(async tx => {
      await tx.select().from(probeTasks).where(eq(probeTasks.roundId, r.id)).for('update');
      const batch = await leases.lease(f.probe.id, 2, now);
      expect(batch).toHaveLength(1);
      expect(batch[0]?.roundId).not.toBe(r.id);
    });
  });
  it('counts concurrent replay once, never accepts another probe or wrong lease', async () => {
    const f = await fixture(); await round(f);
    const [task] = await leases.lease(f.probe.id, 1, now); const input = result(task!);
    expect(await results.accept(f.other.id, input, now)).toBe('rejected');
    expect(await results.accept(f.probe.id, { ...input, leaseId: randomUUID() }, now)).toBe('rejected');
    const acknowledgements = await Promise.all([results.accept(f.probe.id, input, now), results.accept(f.probe.id, input, now)]);
    expect(acknowledgements.sort()).toEqual(['accepted', 'duplicate']);
    expect(await results.accept(f.probe.id, input, new Date(now.getTime()+70000))).toBe('duplicate');
    expect(await connection.db.select().from(probeObservations).where(eq(probeObservations.taskId, input.taskId))).toHaveLength(1);
    expect((await connection.db.select().from(endpoints).where(eq(endpoints.id, f.endpoint.id)))[0]?.healthState).toBe('unknown');
  });
  it('retains late observations as stale once and rejects wrong revisions without consuming a task', async () => {
    const f = await fixture(); await round(f);
    const [task] = await leases.lease(f.probe.id, 1, now); const input = result(task!);
    expect(await results.accept(f.probe.id, { ...input, addressVersion: 2 }, now)).toBe('stale');
    expect(await results.accept(f.probe.id, input, new Date(now.getTime()+10000))).toBe('stale');
    expect(await results.accept(f.probe.id, input, new Date(now.getTime()+11000))).toBe('stale');
    const observations = await connection.db.select().from(probeObservations).where(eq(probeObservations.taskId, input.taskId));
    expect(observations).toHaveLength(1); expect(observations[0]?.status).toBe('stale');
  });
  it.each(['address', 'config', 'round'] as const)('makes a result historical when %s is superseded', async change => {
    const f = await fixture(); const r = await round(f); const [task] = await leases.lease(f.probe.id, 1, now);
    if (change === 'address') await connection.db.update(endpointAddresses).set({ state: 'previous' }).where(eq(endpointAddresses.id, f.address.id));
    if (change === 'config') await connection.db.update(healthCheckConfigs).set({ revision: 2 }).where(eq(healthCheckConfigs.id, f.check.id));
    if (change === 'round') await connection.db.update(probeRounds).set({ status: 'superseded' }).where(eq(probeRounds.id, r.id));
    expect(await results.accept(f.probe.id, result(task!), now)).toBe('stale');
  });
});

it('creates immutable cohort rounds with ordered sequences and rejects cross-owner targets', async () => {
  const f = await fixture(); const stranger = await fixture();
  const group = await management.createGroup(f.actor, { name: 'Fixed cohort' });
  await management.setMembers(f.actor, group.id, [f.probe.id, f.other.id]);
  const rounds = new ProbeRoundsService({ db: connection.db } as never);
  const input = { endpointAddressId: f.address.id, configId: f.check.id, groupId: group.id, addressVersion: 1, consensus: { mode: 'all' as const, minimumValid: 2 }, deadline: new Date(now.getTime()+10000), resultExpiresAt: new Date(now.getTime()+60000) };
  const created = await Promise.all([rounds.create(f.actor, input, now), rounds.create(f.actor, input, now)]);
  expect(created.map(r => r.sequence).sort()).toEqual([1, 2]);
  expect(created[0]?.memberIds).toEqual(expect.arrayContaining([f.probe.id, f.other.id]));
  await expect(rounds.create(stranger.actor, input, now)).rejects.toMatchObject({ status: 404 });
  await expect(rounds.create(f.actor, { ...input, configId: stranger.check.id }, now)).rejects.toMatchObject({ status: 404 });
  const [task] = await leases.lease(f.probe.id, 1, now);
  await management.setMembers(f.actor, group.id, [f.probe.id]);
  expect(await results.accept(f.probe.id, result(task!), now)).toBe('stale');
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, created[0]!.id)))[0]?.memberIds).toHaveLength(2);
});

it('serves canonical HTTP envelopes, session-only management, and bounded agent input', async () => {
  const f = await fixture(); const clock = new Date();
  const install = await management.createInstallToken(f.actor, f.probe.id, clock);
  const database = { db: connection.db } as never;
  @Module({ controllers: [ProbeAgentController, ProbesController], providers: [
    { provide: ProbesService, useValue: management }, { provide: ProbeAgentAuth, useValue: auth },
    { provide: ProbeLeasesService, useValue: leases }, { provide: ProbeResultsService, useValue: results },
  ] }) class TestModule {}
  const app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
  await app.register(cookie);
  app.setGlobalPrefix('api'); app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalGuards(new AuthGuard(new Reflector(), database));
  await app.init(); await app.getHttpAdapter().getInstance().ready();
  try {
    const exchanged = await app.inject({ method: 'POST', url: '/api/v1/probe-agent/exchange', payload: { installToken: install.installToken } });
    expect(exchanged.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${exchanged.json().runtimeToken}` };
    const beat = await app.inject({ method: 'POST', url: '/api/v1/probe-agent/heartbeat', headers, payload: { protocol: 'probe-agent/v1', agentVersion: '1.0', capabilities: { ipv4: true, ipv6: false }, maxConcurrency: 1 } });
    expect(beat.statusCode).toBe(200); expect(beat.headers['content-type']).toContain('application/json'); expect(beat.json()).toEqual({});
    const leased = await app.inject({ method: 'POST', url: '/api/v1/probe-agent/tasks/lease', headers, payload: { protocol: 'probe-agent/v1', capacity: 1 } });
    expect(leased.statusCode).toBe(200); expect(leased.json()).toMatchObject({ tasks: [], retryAfterMs: 1000 });
    const posted = await app.inject({ method: 'POST', url: '/api/v1/probe-agent/results', headers, payload: { protocol: 'probe-agent/v1', results: [{ protocol: 'probe-agent/v1', taskId: randomUUID(), leaseId: randomUUID(), addressVersion: 1, configVersion: 1, outcome: 'unavailable', latencyMs: 0, measuredAt: clock.toISOString() }] } });
    expect(posted.statusCode).toBe(200); expect(posted.json()).toEqual({ results: [{ taskId: expect.any(String), status: 'rejected' }] });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probes', headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/probe-agent/tasks/lease', headers, payload: { protocol: 'probe-agent/v1', capacity: 101 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/probe-agent/results', headers, payload: { protocol: 'probe-agent/v1', results: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/probe-agent/heartbeat', payload: { protocol: 'probe-agent/v1' } })).statusCode).toBe(401);
  } finally { await app.close(); }
});

it('probes shared slots without anchor endpoints and rejects version zero, wrong owner, and replaced candidates', async () => {
  const f = await fixture(); const stranger = await fixture();
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: f.actor.id, name: 'AWS', provider: 'aws', credentialCiphertext: 'cipher', credentialIv: 'iv', credentialTag: 'tag' }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: 'ec2', region: 'us-east-1', externalId: 'i-test', scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: 'eni-test', scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: 'host', family: '4', address: '192.0.2.11', origin: 'user', scanGeneration: 1 }).returning();
  const [candidate] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: 'host', family: '4', address: '192.0.2.12', origin: 'user', scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, name: 'public', family: '4', currentAddressId: address!.id }).returning();
  const [config] = await connection.db.insert(healthCheckConfigs).values({ slotId: slot!.id, checkerType: 'tcp', config: f.config }).returning();
  const group = await management.createGroup(f.actor, { name: 'Slot probes' });
  await management.setMembers(f.actor, group.id, [f.probe.id]);
  const rounds = new ProbeRoundsService({ db: connection.db } as never);
  const input = { slotId: slot!.id, configId: config!.id, groupId: group.id, addressVersion: 1, consensus: { mode: 'all' as const, minimumValid: 1 }, deadline: new Date(now.getTime()+10000), resultExpiresAt: new Date(now.getTime()+60000) };
  await expect(rounds.create(f.actor, input, now)).rejects.toMatchObject({ status: 400 });
  await connection.db.update(managedAddressSlots).set({ currentVersion: 1 }).where(eq(managedAddressSlots.id, slot!.id));
  await expect(rounds.create(stranger.actor, input, now)).rejects.toMatchObject({ status: 404 });
  await expect(rounds.create(f.actor, { ...input, configId: f.check.id }, now)).rejects.toMatchObject({ status: 404 });
  const current = await rounds.create(f.actor, input, now);
  expect(current).toMatchObject({ slotId: slot!.id, endpointId: null, endpointAddressId: null, sequence: 1 });
  const [task] = await leases.lease(f.probe.id, 1, now);
  expect(task?.address).toBe('192.0.2.11');
  await connection.db.update(managedAddressSlots).set({ candidateAddressId: candidate!.id, candidateVersion: 2 }).where(eq(managedAddressSlots.id, slot!.id));
  expect(await results.accept(f.probe.id, result(task!), now)).toBe('stale');
  await rounds.create(f.actor, { ...input, addressVersion: 2 }, now);
  const [replacement] = await leases.lease(f.probe.id, 1, now);
  expect(replacement).toMatchObject({ address: '192.0.2.12', addressVersion: 2 });
  expect(await results.accept(f.probe.id, result(replacement!), now)).toBe('accepted');
});

it('rolls back observation insertion when the terminal task write fails', async () => {
  const f = await fixture(); await round(f); const [task] = await leases.lease(f.probe.id, 1, now);
  await connection.client.unsafe(`create function probe_test_fail() returns trigger language plpgsql as $$ begin if new.id = '${task!.taskId}'::uuid then raise exception 'simulated write failure'; end if; return new; end $$`);
  await connection.client.unsafe('create trigger probe_test_fail before update on probe_tasks for each row execute function probe_test_fail()');
  try {
    await expect(results.accept(f.probe.id, result(task!), now)).rejects.toThrow();
    expect(await connection.db.select().from(probeObservations).where(eq(probeObservations.taskId, task!.taskId))).toHaveLength(0);
    expect((await connection.db.select().from(probeTasks).where(eq(probeTasks.id, task!.taskId)))[0]?.status).toBe('leased');
  } finally { await connection.client.unsafe('drop trigger probe_test_fail on probe_tasks'); await connection.client.unsafe('drop function probe_test_fail()'); }
  expect(await results.accept(f.probe.id, result(task!), now)).toBe('accepted');
});

it('retires obsolete pending tasks so they cannot keep blocking a newer config round', async () => {
  const f = await fixture(); const old = await round(f);
  await connection.db.update(probeRounds).set({ createdAt: new Date(now.getTime()-1000) }).where(eq(probeRounds.id, old.id));
  await connection.db.update(healthCheckConfigs).set({ revision: 2 }).where(eq(healthCheckConfigs.id, f.check.id));
  const replacement = await round(f);
  await connection.db.update(probeRounds).set({ configVersion: 2 }).where(eq(probeRounds.id, replacement.id));
  expect(await leases.lease(f.probe.id, 1, now)).toHaveLength(0);
  const next = await leases.lease(f.probe.id, 1, now);
  expect(next).toHaveLength(1); expect(next[0]?.roundId).toBe(replacement.id);
});

it('does not revive the fixed cohort after its group is deleted', async () => {
  const f = await fixture(); const group = await management.createGroup(f.actor, { name: 'Deleted cohort' });
  await management.setMembers(f.actor, group.id, [f.probe.id]);
  const rounds = new ProbeRoundsService({ db: connection.db } as never);
  await rounds.create(f.actor, { endpointAddressId: f.address.id, configId: f.check.id, groupId: group.id, addressVersion: 1, consensus: { mode: 'all', minimumValid: 1 }, deadline: new Date(now.getTime()+10000), resultExpiresAt: new Date(now.getTime()+60000) }, now);
  const [task] = await leases.lease(f.probe.id, 1, now);
  await connection.db.delete(probeGroups).where(eq(probeGroups.id, group.id));
  expect(await results.accept(f.probe.id, result(task!), now)).toBe('stale');
});
