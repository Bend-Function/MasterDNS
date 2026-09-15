import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { createDatabase, users, endpointPools, probeAgents } from '@masterdns/db';
import { resultBatchSchema, type ProbeResult } from '@masterdns/contracts';
import { AuthGuard } from '../src/auth/auth.guard.js';
import type { AuthUser } from '../src/auth/auth.types.js';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { ProbeAgentController } from '../src/modules/probes/probe-agent.controller.js';
import { ProbeAgentAuth } from '../src/modules/probes/probe-agent-auth.js';
import { ProbeLeasesService } from '../src/modules/probes/probe-leases.service.js';
import { ProbeResultsService } from '../src/modules/probes/probe-results.service.js';
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

export async function until<T>(label: string, check: () => Promise<T | undefined | false>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

export async function createIntegrationHarness() {
  const binary = process.env.MASTERDNS_TEST_AGENT_BINARY;
  const databaseUrl = process.env.MASTERDNS_TEST_DATABASE_URL;
  assert(binary, 'MASTERDNS_TEST_AGENT_BINARY must identify a prebuilt Linux binary matching the Podman VM architecture');
  assert(databaseUrl, 'MASTERDNS_TEST_DATABASE_URL is required; DATABASE_URL is never used');
  const testUrl = new URL(databaseUrl);
  secrets.push(databaseUrl, testUrl.password);
  await stat(binary);
  await podman('image', 'exists', image);
  await podman('image', 'exists', 'docker.io/library/redis:7-alpine');
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

  await podman('network', 'create', '--subnet', '192.0.2.0/24', id);
  networkCreated = true;
  const target = `${id}_target`;
  await podman('create', '--name', target, '--network', id, image, 'node', '/test/target.cjs');
  containers.push(target);
  await podman('cp', `${directory}/.`, `${target}:/test`);
  await podman('start', target);
  await until('TCP/HTTPS target startup', async () => (await podman('logs', target)).includes('ready'));
  const inspected = JSON.parse(await podman('inspect', target))[0];
  const addresses = inspected.NetworkSettings.Networks[id];
  assert(addresses.IPAddress, 'The owned documentation network must provide IPv4');
  const targets = [{ family: 4 as const, address: addresses.IPAddress as string }, { family: 4 as const, address: '192.0.2.254' }];
  const failedTarget = `${id}_failed`;
  await podman('create', '--name', failedTarget, '--network', id, '--ip', '192.0.2.254', image, 'sleep', 'infinity');
  containers.push(failedTarget);
  await podman('start', failedTarget);
  const redis = `${id}_redis`;
  await podman('create', '--name', redis, '-p', '127.0.0.1::6379', 'docker.io/library/redis:7-alpine');
  containers.push(redis);
  await podman('start', redis);
  const redisPort = (await podman('port', redis, '6379')).split(':').at(-1);
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const cidrs = targets.map(t => `${t.address}/${t.family === 4 ? 32 : 128}`);

  admin = createDatabase(databaseUrl);
  await admin.client.unsafe(`create database "${id}"`);
  databaseCreated = true;
  testUrl.pathname = `/${id}`;
  connection = createDatabase(testUrl.toString());
  const migrations = join(root, 'packages/db/drizzle');
  const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'));
  const older = join(directory, 'before-publication');
  await mkdir(join(older, 'meta'), { recursive: true });
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 19);
  for (const entry of entries) await copyFile(join(migrations, `${entry.tag}.sql`), join(older, `${entry.tag}.sql`));
  await writeFile(join(older, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  await migrate(connection.db, { migrationsFolder: older });
  const [existing] = await connection.db.insert(users).values({ username: `${id}_upgrade`, passwordHash: 'pre-publication-data' }).returning();
  await migrate(connection.db, { migrationsFolder: migrations });
  assert.equal((await connection.db.select().from(users).where(eq(users.id, existing!.id)))[0]!.passwordHash, 'pre-publication-data');
  console.log('PASS: populated pre-publication schema upgrades with existing data intact');
  const db = connection.db;
  const database = { db } as never;
  const management = new ProbesService(database);
  const auth = new ProbeAgentAuth(database);
  const leases = new ProbeLeasesService(database);
  const results = new ProbeResultsService(database);
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
  const config = { serverUrl: `https://host.containers.internal:${port}`, caFile: '/test/ca.crt', tokenFile: '/test/token', stateDir: '/test/state', maxConcurrency: 4, allowIpv4: true, allowIpv6: true, allowedPrivateCidrs: cidrs };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await podman('cp', `${directory}/.`, `${agent}:/test`);
  // Enrollment executes the supplied binary before its persistent run process starts.
  const enroll = `${id}_enroll`;
  await podman('create', '--name', enroll, '--network', id, image, 'sleep', 'infinity');
  containers.push(enroll);
  await podman('cp', `${directory}/.`, `${enroll}:/test`);
  await podman('start', enroll);
  const versionOutput = await podman('exec', enroll, '/test/agent', 'version');
  // A7 prints the product and build commit; heartbeat carries only the version. Accept A6's bare version too.
  const version = /^masterdns-agent (\S+) \([^)]+\)$/.exec(versionOutput)?.[1] ?? versionOutput;
  console.log(`Agent version: ${versionOutput}`);
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

  await podman('start', agent);
  await until('agent heartbeat', async () => (await db.select().from(probeAgents).where(eq(probeAgents.id, probe.id)))[0]?.lastSeenAt);
  let fixtureNumber = 0;
  async function fixtureTargets() {
    if (fixtureNumber++ === 0) return { success: targets[0]!.address, failure: targets[1]!.address, stopTcp: () => podman('kill', '--signal', 'USR1', target) };
    const success = `192.0.2.${10 + fixtureNumber * 2}`, failure = `192.0.2.${11 + fixtureNumber * 2}`;
    const serving = `${id}_target_${fixtureNumber}`, refusing = `${id}_failed_${fixtureNumber}`;
    const assets = join(directory!, `target-assets-${fixtureNumber}`);
    await mkdir(assets);
    for (const file of ['target.cjs', 'server.crt', 'server.key']) await copyFile(join(directory!, file), join(assets, file));
    await podman('create', '--name', serving, '--network', id, '--ip', success, image, 'node', '/test/target.cjs');
    containers.push(serving); await podman('cp', `${assets}/.`, `${serving}:/test`); await podman('start', serving);
    await until('fixture target ready', async () => (await podman('logs', serving)).includes('ready'));
    await podman('create', '--name', refusing, '--network', id, '--ip', failure, image, 'sleep', 'infinity');
    containers.push(refusing); await podman('start', refusing);
    return { success, failure, stopTcp: () => podman('kill', '--signal', 'USR1', serving) };
  }
  return { db, database, actor, probe, group, pool: pool!, databaseUrl: testUrl.toString(), redisUrl, fixtureTargets, post, submitted, podman,
    startBackupTcp: async () => {
      const backup = `${id}_backup`;
      await podman('create', '--name', backup, '--network', id, '--ip', '192.0.2.253', image, 'node', '-e', "require('node:net').createServer(socket => socket.end()).listen(18080, '0.0.0.0')");
      containers.push(backup); await podman('start', backup); return '192.0.2.253';
    },
    stopAgent: () => podman('stop', '--time', '1', agent), startAgent: () => podman('start', agent),
    assertSecretFree: async () => { for (const container of containers) await podman('logs', container); for (const secret of secrets.filter(Boolean)) assert(!output.join('\n').includes(secret), 'subprocess output contains a secret'); },
  };
}
export async function cleanup() {
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
