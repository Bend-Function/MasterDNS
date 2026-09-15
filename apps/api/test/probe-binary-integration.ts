import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { createDatabase, users, endpointPools, endpoints, endpointAddresses, healthCheckConfigs, probeAgents, probeObservations, probeTasks } from '@masterdns/db';
import { healthCheckConfigSchema, resultBatchSchema, type ProbeResult, type ProbeTask } from '@masterdns/contracts';
import { AuthGuard } from '../src/auth/auth.guard.js';
import type { AuthUser } from '../src/auth/auth.types.js';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { ProbeAgentController } from '../src/modules/probes/probe-agent.controller.js';
import { ProbeAgentAuth } from '../src/modules/probes/probe-agent-auth.js';
import { ProbeLeasesService } from '../src/modules/probes/probe-leases.service.js';
import { ProbeResultsService } from '../src/modules/probes/probe-results.service.js';
import { ProbeRoundsService } from '../src/modules/probes/probe-rounds.service.js';
import { ProbesService } from '../src/modules/probes/probes.service.js';

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

function redact(value: string) {
  return secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
}

// Podman inherits only transport/runtime settings. No cloud, database or caller auth environment
// enters either container. Tokens are supplied to enroll through stdin, never command arguments.
async function command(program: string, args: string[], input?: string) {
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'DOCKER_HOST', 'SSH_AUTH_SOCK']
    .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      output.push(text);
      if (code === 0) resolve(text.trim());
      else reject(new Error(`${program} ${args[0]} exited ${code}: ${redact(text)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const podman = (...args: string[]) => command('podman', args);

async function until<T>(label: string, check: () => Promise<T | undefined | false>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

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
  await copyFile(resolve(binary), join(directory, 'agent'));
  await chmod(join(directory, 'agent'), 0o700);
  await copyFile(join(root, 'tests/integration/probe-target.cjs'), join(directory, 'target.cjs'));
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=MasterDNS integration CA', '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.crt')]);
  await command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=probe-target.test', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')]);
  await writeFile(join(directory, 'extensions'), 'subjectAltName=DNS:host.containers.internal,DNS:probe-target.test,DNS:localhost\nextendedKeyUsage=serverAuth\n');
  await command('openssl', ['x509', '-req', '-days', '1', '-in', join(directory, 'server.csr'), '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-extfile', join(directory, 'extensions'), '-out', join(directory, 'server.crt')]);
  for (const name of ['ca.key', 'server.key']) await chmod(join(directory, name), 0o600);
  const key = await readFile(join(directory, 'server.key'));
  const cert = await readFile(join(directory, 'server.crt'));
  const ca = await readFile(join(directory, 'ca.crt'));
  // The CA signing key stays on the host and is no longer needed after issuing this test certificate.
  await rm(join(directory, 'ca.key'));

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
  const database = { db } as never;
  const management = new ProbesService(database);
  const auth = new ProbeAgentAuth(database);
  const leases = new ProbeLeasesService(database);
  const results = new ProbeResultsService(database);
  const rounds = new ProbeRoundsService(database);
  @Module({ controllers: [ProbeAgentController], providers: [
    { provide: ProbeAgentAuth, useValue: auth }, { provide: ProbesService, useValue: management },
    { provide: ProbeLeasesService, useValue: leases }, { provide: ProbeResultsService, useValue: results },
  ] }) class IntegrationModule {}
  app = await NestFactory.create<NestFastifyApplication>(IntegrationModule, new FastifyAdapter({ https: { key, cert } }), { logger: false });
  await app.register(cookie);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalGuards(new AuthGuard(new Reflector(), database));
  const calls: string[] = [];
  const submitted: ProbeResult[] = [];
  app.getHttpAdapter().getInstance().addHook('preHandler', async req => {
    calls.push(req.url);
    if (req.url.endsWith('/results')) {
      const batch = resultBatchSchema.safeParse(req.body);
      if (batch.success) submitted.push(...batch.data.results);
    }
  });
  await app.listen(0, '0.0.0.0');
  const bound = app.getHttpServer().address();
  assert(bound && typeof bound !== 'string');
  const port = bound.port;
  const [user] = await db.insert(users).values({ username: id, passwordHash: 'integration-only', role: 'admin' }).returning();
  const actor = { id: user!.id, role: 'admin' } as AuthUser;
  const probe = await management.create(actor, { name: id, maxConcurrency: 4 });
  const group = await management.createGroup(actor, { name: id });
  await management.setMembers(actor, group.id, [probe.id]);
  const [pool] = await db.insert(endpointPools).values({ ownerUserId: actor.id, name: id, strategy: 'primary_backup' }).returning();

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
  async function post(path: string, body: unknown, token = runtimeToken) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method: 'POST', path: `/api/v1/probe-agent/${path}`, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('HTTPS request timeout')));
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  const agent = `${id}_agent`;
  await podman('create', '--name', agent, '--network', id, '--env', 'SSL_CERT_FILE=/test/ca.crt', image, '/test/agent', 'run', '--config', '/test/config.json');
  containers.push(agent);
  const config = { serverUrl: `https://host.containers.internal:${port}`, caFile: '/test/ca.crt', tokenFile: '/test/token', stateDir: '/test/state', maxConcurrency: 4, allowIpv4: true, allowIpv6: true, allowedPrivateCidrs: [] as string[] };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await podman('cp', `${directory}/.`, `${agent}:/test`);
  // Enrollment executes the supplied binary before its persistent run process starts.
  const enroll = `${id}_enroll`;
  await podman('create', '--name', enroll, '--network', id, image, 'sleep', 'infinity');
  containers.push(enroll);
  await podman('cp', `${directory}/.`, `${enroll}:/test`);
  await podman('start', enroll);
  const version = await podman('exec', enroll, '/test/agent', 'version');
  console.log(`Agent version: ${version}`);
  const install = await management.createInstallToken(actor, probe.id);
  secrets.push(install.installToken);
  await command('podman', ['exec', '-i', enroll, '/test/agent', 'enroll', '--config', '/test/config.json'], `${install.installToken}\n`);
  await podman('cp', `${enroll}:/test/config.json`, join(directory, 'config.json'));
  await podman('cp', `${enroll}:/test/token`, join(directory, 'token'));
  runtimeToken = (await readFile(join(directory, 'token'), 'utf8')).trim();
  secrets.push(runtimeToken);
  assert.equal((await stat(join(directory, 'token'))).mode & 0o077, 0, 'enrollment token permissions');
  const enrolled = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  assert.equal(enrolled.probeId, probe.id);
  assert.equal((await post('exchange', { installToken: install.installToken }, '')).status, 401, 'install token is single use');
  await podman('cp', join(directory, 'config.json'), `${agent}:/test/config.json`);
  await podman('cp', join(directory, 'token'), `${agent}:/test/token`);

  await assert.rejects(createRound(4, targets[0]!.address, { type: 'tcp', port: 18080, timeoutMs: 1000 }, 10_000, false),
    (error: unknown) => error instanceof ZodError && error.issues.some(issue => issue.path[0] === 'address' && issue.message.includes('not explicitly allowed')),
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
  for (const secret of secrets.filter(Boolean)) assert(!output.join('\n').includes(secret), 'subprocess output contains a secret');
  console.log('PASS: subprocess output contains no installation/runtime token or database credential');
  console.log('P12a protocol integration passed. Full scheduler, rotation, cloud writes and DNS recovery remain P12b.');
}

async function cleanup() {
  const failures: unknown[] = [];
  async function attempt(run: () => Promise<unknown>) { try { await run(); } catch (error) { failures.push(error); } }
  for (const name of containers.toReversed()) await attempt(() => podman('rm', '--force', '--time', '1', name));
  if (networkCreated) await attempt(() => podman('network', 'rm', id));
  if (app) await attempt(() => app!.close());
  if (connection) await attempt(() => connection!.close());
  if (databaseCreated && admin) await attempt(() => admin!.client.unsafe(`drop database "${id}"`));
  if (admin) await attempt(() => admin!.close());
  if (directory) await attempt(() => rm(directory!, { recursive: true, force: true }));
  if (failures.length) throw new Error(`Cleanup failed for owned resources ${id}: ${failures.map(String).join('; ')}`);
  console.log('Cleanup: owned containers, network, database and temporary files removed');
}

try { await main(); }
catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
finally {
  try { await cleanup(); }
  catch (error) { console.error(redact(String(error))); process.exitCode = 1; }
}
