import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { createDatabase, endpoints, endpointAddresses, healthCheckConfigs, probeAgents, probeObservations, probeTasks } from '@masterdns/db';
import { healthCheckConfigSchema, type ProbeResult, type ProbeTask } from '@masterdns/contracts';
import { ProbeRoundsService } from '../src/modules/probes/probe-rounds.service.js';

import { runProcess, redact as redactText, assertSecretFree } from './integration-process.js';
import { until, prepareAgentFiles, bootstrapProbeApi, postProbeJson, enrollAgent, cleanupOwned } from './integration-lifecycle.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'docker.io/library/node:22-alpine';
const id = `mdns_probe_${randomUUID().replaceAll('-', '')}`;
const containers: string[] = [];
const secrets: string[] = [];
const output: string[] = [];
let directory: string | undefined;
let networkCreated = false;
let databaseCreated = false;
let admin: ReturnType<typeof createDatabase> | undefined;
let connection: ReturnType<typeof createDatabase> | undefined;
let app: NestFastifyApplication | undefined;

const redact = (value: string) => redactText(value, secrets);
const command = (program: string, args: string[], input?: string) => runProcess(program, args, { secrets, output }, input === undefined ? {} : { input });
const podman = (...args: string[]) => command('podman', args);

async function main() {
  const binary = process.env.MASTERDNS_TEST_AGENT_BINARY;
  const databaseUrl = process.env.MASTERDNS_TEST_DATABASE_URL;
  assert(binary, 'MASTERDNS_TEST_AGENT_BINARY must identify a prebuilt Linux binary matching the Podman VM architecture');
  assert(databaseUrl, 'MASTERDNS_TEST_DATABASE_URL is required; DATABASE_URL is never used');
  const testUrl = new URL(databaseUrl);
  secrets.push(databaseUrl, testUrl.password);
  await stat(binary);
  await podman('image', 'exists', image);
  directory = await mkdtemp(join(tmpdir(), 'masterdns-probe-'));
  await chmod(directory, 0o700);
  const { key, cert, ca } = await prepareAgentFiles(directory, binary, root, command);

  await podman('network', 'create', '--ipv6', id);
  networkCreated = true;
  const target = `${id}_target`;
  await podman('create', '--name', target, '--network', id, image, 'node', '/test/target.cjs');
  containers.push(target);
  await podman('cp', `${directory}/.`, `${target}:/test`);
  await podman('start', target);
  await until('TCP/HTTPS target startup', async () => (await podman('logs', target)).includes('ready'));
  const inspected = JSON.parse(await podman('inspect', target))[0];
  const addresses = inspected.NetworkSettings.Networks[id];
  assert(addresses.IPAddress && addresses.GlobalIPv6Address, 'The owned Podman network must provide IPv4 and IPv6');
  const targets = [{ family: 4 as const, address: addresses.IPAddress as string }, { family: 6 as const, address: addresses.GlobalIPv6Address as string }];
  const cidrs = targets.map(t => `${t.address}/${t.family === 4 ? 32 : 128}`);

  admin = createDatabase(databaseUrl);
  await admin.client.unsafe(`create database "${id}"`);
  databaseCreated = true;
  testUrl.pathname = `/${id}`;
  connection = createDatabase(testUrl.toString());
  await migrate(connection.db, { migrationsFolder: join(root, 'packages/db/drizzle') });
  const db = connection.db;
  const api = await bootstrapProbeApi(db, id, { key, cert });
  app = api.app;
  const { database, management, port, calls, submitted, actor, probe, group, pool } = api;
  const rounds = new ProbeRoundsService(database);

  async function createRound(family: 4 | 6, address: string, config: ProbeTask['config'], lifetime = 10_000, allow = true) {
    const [endpoint] = await db.insert(endpoints).values({ poolId: pool!.id, name: randomUUID() }).returning();
    const [targetAddress] = await db.insert(endpointAddresses).values({ endpointId: endpoint!.id, family: String(family) as '4' | '6', address, state: 'current', source: 'static' }).returning();
    const [check] = await db.insert(healthCheckConfigs).values({ endpointId: endpoint!.id, checkerType: config.type, config }).returning();
    const now = new Date();
    return rounds.create(actor, { endpointAddressId: targetAddress!.id, configId: check!.id, groupId: group.id, addressVersion: 1, consensus: { mode: 'all', minimumValid: 1 }, deadline: new Date(now.getTime() + lifetime), resultExpiresAt: new Date(now.getTime() + lifetime + 60_000), ...(allow ? { networkPolicy: { allowedPrivateCIDRs: cidrs } } : {}) }, now);
  }
  async function observation(roundId: string) {
    return until('persisted binary observation', async () => (await db.select().from(probeObservations).where(eq(probeObservations.roundId, roundId)))[0]);
  }
  let runtimeToken = '';
  const post = (path: string, body: unknown, token = runtimeToken) => postProbeJson(port, ca, path, body, token, secrets);

  const enrollment = await enrollAgent({ id, image, directory, port, cidrs: [], containers, secrets, command, management, actor, probeId: probe.id, post });
  const { agent, enrolled, version } = enrollment;
  runtimeToken = enrollment.runtimeToken;

  await assert.rejects(createRound(4, targets[0]!.address, { type: 'tcp', port: 18080, timeoutMs: 1000 }, 10_000, false),
    (error: unknown) => error instanceof ZodError && error.issues.some(issue => issue.code === 'custom' && issue.path[0] === 'address' && issue.message.includes('private allowlist')),
    'platform must reject private target without its allowlist');
  const deniedRound = await createRound(4, targets[0]!.address, { type: 'tcp', port: 18080, timeoutMs: 1000 });
  await podman('start', agent);
  const denied = await observation(deniedRound.id);
  assert.equal(denied.outcome, 'unavailable', 'local allowlist must independently deny the private target');
  assert.equal(denied.errorCode, 'target_forbidden');
  console.log('PASS: private target denied without either required allowlist');
  await podman('stop', '--time', '10', agent);
  enrolled.allowedPrivateCidrs = cidrs;
  await writeFile(join(directory, 'config.json'), JSON.stringify(enrolled), { mode: 0o600 });
  await podman('cp', join(directory, 'config.json'), `${agent}:/test/config.json`);
  await podman('start', agent);

  for (const target of targets) {
    for (const config of [
      { type: 'tcp', port: 18080, timeoutMs: 1000 },
      { type: 'http', protocol: 'https', port: 18443, hostname: 'probe-target.test', path: '/health', verifyTls: true, bodyContains: 'masterdns isolated target', timeoutMs: 1500 },
    ]) {
      const round = await createRound(target.family, target.address, healthCheckConfigSchema.parse(config));
      const observed = await observation(round.id);
      assert.equal(observed.outcome, 'success', `IPv${target.family} ${config.type}: ${observed.errorCode}`);
      assert.equal(observed.status, 'accepted');
      if (config.type === 'http') assert.equal(observed.statusCode, 200);
      console.log(`PASS: binary IPv${target.family} ${config.type === 'http' ? 'HTTPS with verified TLS, Host and SNI' : 'TCP'} persisted success`);
    }
    const round = await createRound(target.family, target.address, { type: 'tcp', port: 18081, timeoutMs: 1000 });
    assert.equal((await observation(round.id)).outcome, 'failure', 'connection refused is failure, not unavailable');
    console.log(`PASS: binary IPv${target.family} TCP refused persisted failure`);
  }
  const badCertificate = await createRound(4, targets[0]!.address, healthCheckConfigSchema.parse({
    type: 'http', protocol: 'https', port: 18443, hostname: 'wrong-certificate.test', verifyTls: true, timeoutMs: 1500,
  }));
  const tlsFailure = await observation(badCertificate.id);
  assert.equal(tlsFailure.outcome, 'failure');
  assert.equal(tlsFailure.errorCode, 'tls_failed', 'HTTPS must reject a certificate for the wrong hostname before reading HTTP status');
  console.log('PASS: binary HTTPS rejects certificate hostname mismatch');
  const [reported] = await db.select().from(probeAgents).where(eq(probeAgents.id, probe.id));
  assert.equal(reported!.agentVersion, version);
  assert.deepEqual(reported!.capabilities, { ipv4: true, ipv6: true });
  assert(reported!.lastSeenAt);
  const recorded = submitted.find(r => r.outcome === 'success')!;
  const replay = await post('results', { protocol: 'probe-agent/v1', results: [recorded, recorded] });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.results.map((r: { status: string }) => r.status), ['duplicate', 'duplicate']);
  assert.equal((await db.select().from(probeObservations).where(eq(probeObservations.taskId, recorded.taskId))).length, 1);
  console.log('PASS: replay of actual binary result does not duplicate observation');

  await podman('stop', '--time', '10', agent);
  const lateRound = await createRound(4, targets[0]!.address, { type: 'tcp', port: 18080, timeoutMs: 1000 }, 1000);
  const leased = await post('tasks/lease', { protocol: 'probe-agent/v1', capacity: 1 });
  assert.equal(leased.status, 200);
  const task: ProbeTask = leased.body.tasks[0];
  assert.equal(task.roundId, lateRound.id);
  const late: ProbeResult = { protocol: 'probe-agent/v1', taskId: task.taskId, leaseId: task.leaseId, addressVersion: task.addressVersion, configVersion: task.configVersion, outcome: 'success', latencyMs: 1, measuredAt: new Date().toISOString() };
  const wrong = await post('results', { protocol: 'probe-agent/v1', results: [{ ...late, addressVersion: 2 }] });
  assert.equal(wrong.body.results[0].status, 'stale');
  assert.equal((await db.select().from(probeObservations).where(eq(probeObservations.taskId, task.taskId))).length, 0);
  await delay(Math.max(0, lateRound.deadline.getTime() - Date.now() + 50));
  const expired = await post('results', { protocol: 'probe-agent/v1', results: [late] });
  assert.equal(expired.body.results[0].status, 'stale');
  assert.equal((await observation(lateRound.id)).status, 'stale');
  assert((await db.select().from(endpoints)).every(endpoint => endpoint.healthState === 'unknown'), 'protocol ingestion alone must not publish health decisions');
  console.log('PASS: real HTTPS rejects wrong version and persists expired result only as stale');
  const incompatible = await post('heartbeat', { protocol: 'probe-agent/v99', agentVersion: version, capabilities: { ipv4: true, ipv6: true }, maxConcurrency: 4 });
  assert.equal(incompatible.status, 400);
  assert.match(JSON.stringify(incompatible.body), /protocol/);
  console.log('PASS: incompatible protocol receives an explanatory HTTP 400');

  await podman('start', agent);
  const pollsBefore = calls.filter(p => p.endsWith('/tasks/lease')).length;
  await until('agent resumed polling', async () => calls.filter(p => p.endsWith('/tasks/lease')).length > pollsBefore);
  await management.revoke(actor, probe.id);
  await until('agent exits after revocation', async () => {
    const state = JSON.parse(await podman('inspect', agent))[0].State;
    return !state.Running ? state : undefined;
  }).then(state => assert.equal(state.ExitCode, 3));
  const afterRevoke = calls.length;
  await delay(2200);
  assert.equal(calls.length, afterRevoke, 'revoked process must stop API polling');
  assert.equal((await post('tasks/lease', { protocol: 'probe-agent/v1', capacity: 1 })).status, 401);
  assert.equal((await post('results', { protocol: 'probe-agent/v1', results: [recorded] })).status, 401);
  assert.equal((await db.select().from(probeTasks).where(eq(probeTasks.id, recorded.taskId)))[0]!.status, 'accepted');
  console.log('PASS: revoke rejects lease/results and binary exits 3 without continued polling');
  for (const container of containers) await podman('logs', container);
  assertSecretFree(output.join('\n'), secrets);
  console.log('PASS: subprocess output contains no installation/runtime token or database credential');
  console.log('P12a protocol integration passed. The combined entry runs P12b closed-loop and crash recovery next.');
}

async function cleanup() {
  await cleanupOwned({ containers, networkCreated, id, app, connection, admin, databaseCreated, directory }, command, secrets);
}

try { await main(); }
catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
finally {
  try { await cleanup(); }
  catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
}
