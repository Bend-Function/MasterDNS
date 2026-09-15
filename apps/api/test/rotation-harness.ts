import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { createDatabase, users, probeAgents } from '@masterdns/db';

import { runProcess, redact as redactText, assertSecretFree } from './integration-process.js';
import { until, prepareAgentFiles, bootstrapProbeApi, postProbeJson, enrollAgent, cleanupOwned } from './integration-lifecycle.js';
export { until } from './integration-lifecycle.js';

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
  const { key, cert, ca } = await prepareAgentFiles(directory, binary, root, command);

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
  const api = await bootstrapProbeApi(db, id, { key, cert });
  app = api.app;
  const { database, management, port, submitted, actor, probe, group, pool } = api;

  let runtimeToken = '';
  const post = (path: string, body: unknown, token = runtimeToken) => postProbeJson(port, ca, path, body, token, secrets);

  const enrollment = await enrollAgent({ id, image, directory, port, cidrs: cidrs, containers, secrets, command, management, actor, probeId: probe.id, post });
  const { agent } = enrollment;
  runtimeToken = enrollment.runtimeToken;

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
  return { secrets, output, redact, db, database, actor, probe, group, pool: pool!, databaseUrl: testUrl.toString(), redisUrl, fixtureTargets, post, submitted, podman,
    startBackupTcp: async () => {
      const backup = `${id}_backup`;
      await podman('create', '--name', backup, '--network', id, '--ip', '192.0.2.253', image, 'node', '-e', "require('node:net').createServer(socket => socket.end()).listen(18080, '0.0.0.0')");
      containers.push(backup); await podman('start', backup); return '192.0.2.253';
    },
    stopAgent: () => podman('stop', '--time', '1', agent), startAgent: () => podman('start', agent),
    assertSecretFree: async () => { for (const container of containers) await podman('logs', container); assertSecretFree(output.join('\n'), secrets); },
  };
}
export async function cleanup() {
  await cleanupOwned({ containers, networkCreated, id, app, connection, admin, databaseCreated, directory }, command, secrets);
}
