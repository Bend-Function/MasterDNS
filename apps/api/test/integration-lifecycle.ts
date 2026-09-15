import 'reflect-metadata';
import assert from 'node:assert/strict';
import { chmod, copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { createDatabase, users, endpointPools } from '@masterdns/db';
import { resultBatchSchema, type ProbeResult } from '@masterdns/contracts';
import { AuthGuard } from '../src/auth/auth.guard.js';
import type { AuthUser } from '../src/auth/auth.types.js';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { ProbeAgentController } from '../src/modules/probes/probe-agent.controller.js';
import { ProbeAgentAuth } from '../src/modules/probes/probe-agent-auth.js';
import { ProbeLeasesService } from '../src/modules/probes/probe-leases.service.js';
import { ProbeResultsService } from '../src/modules/probes/probe-results.service.js';
import { ProbesService } from '../src/modules/probes/probes.service.js';

import { redact } from './integration-process.js';

type Command = (program: string, args: string[], input?: string) => Promise<string>;
export async function until<T>(label: string, check: () => Promise<T | undefined | false>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

export async function prepareAgentFiles(directory: string, binary: string, root: string, command: Command) {
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

  return { key, cert, ca };
}
export async function bootstrapProbeApi(db: ReturnType<typeof createDatabase>['db'], id: string, tls: { key: Buffer; cert: Buffer }) {
  const database = { db } as never;
  const { key, cert } = tls;
  const management = new ProbesService(database);
  const auth = new ProbeAgentAuth(database);
  const leases = new ProbeLeasesService(database);
  const results = new ProbeResultsService(database);
  @Module({ controllers: [ProbeAgentController], providers: [
    { provide: ProbeAgentAuth, useValue: auth }, { provide: ProbesService, useValue: management },
    { provide: ProbeLeasesService, useValue: leases }, { provide: ProbeResultsService, useValue: results },
  ] }) class IntegrationModule {}
  const app = await NestFactory.create<NestFastifyApplication>(IntegrationModule, new FastifyAdapter({ https: { key, cert } }), { logger: false });
  try {
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

    return { app, database, management, port, calls, submitted, actor, probe, group, pool: pool! };
  } catch (error) { await app.close(); throw error; }
}
export async function postProbeJson(port: number, ca: Buffer, path: string, body: unknown, token: string, secrets: string[]) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method: 'POST', path: `/api/v1/probe-agent/${path}`, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
      try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
      catch (error) { reject(new Error(redact(String(error), secrets))); }
    });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS request timeout')));
    req.on('error', error => reject(new Error(redact(String(error), secrets))));
    req.end(JSON.stringify(body));
  });
}
export async function enrollAgent(options: { id: string; image: string; directory: string; port: number; cidrs: string[]; containers: string[]; secrets: string[]; command: Command; management: ProbesService; actor: AuthUser; probeId: string; post: (path: string, body: unknown, token?: string) => Promise<{ status: number; body: any }> }) {
  const { id, image, directory, port, cidrs, containers, secrets, command, management, actor, probeId, post } = options;
  const podman = (...args: string[]) => command('podman', args);
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
  const install = await management.createInstallToken(actor, probeId);
  secrets.push(install.installToken);
  await command('podman', ['exec', '-i', enroll, '/test/agent', 'enroll', '--config', '/test/config.json'], `${install.installToken}\n`);
  await podman('cp', `${enroll}:/test/config.json`, join(directory, 'config.json'));
  await podman('cp', `${enroll}:/test/token`, join(directory, 'token'));
  const runtimeToken = (await readFile(join(directory, 'token'), 'utf8')).trim();
  secrets.push(runtimeToken);
  assert.equal((await stat(join(directory, 'token'))).mode & 0o077, 0, 'enrollment token permissions');
  const enrolled = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  assert.equal(enrolled.probeId, probeId);
  assert.equal((await post('exchange', { installToken: install.installToken }, '')).status, 401, 'install token is single use');
  await podman('cp', join(directory, 'config.json'), `${agent}:/test/config.json`);
  await podman('cp', join(directory, 'token'), `${agent}:/test/token`);

  return { agent, enrolled, runtimeToken, version };
}
export async function cleanupOwned(state: { containers: string[]; networkCreated: boolean; id: string; app: NestFastifyApplication | undefined; connection: ReturnType<typeof createDatabase> | undefined; admin: ReturnType<typeof createDatabase> | undefined; databaseCreated: boolean; directory: string | undefined }, command: Command, secrets: string[]) {
  const { containers, networkCreated, id, app, connection, admin, databaseCreated, directory } = state;
  const podman = (...args: string[]) => command('podman', args);
  const failures: unknown[] = [];
  async function attempt(run: () => Promise<unknown>) { try { await run(); } catch (error) { failures.push(error); } }
  for (const name of containers.toReversed()) await attempt(() => podman('rm', '--force', '--time', '1', name));
  if (networkCreated) await attempt(() => podman('network', 'rm', id));
  if (app) await attempt(() => app!.close());
  if (connection) await attempt(() => connection!.close());
  if (databaseCreated && admin) await attempt(() => admin!.client.unsafe(`drop database "${id}"`));
  if (admin) await attempt(() => admin!.close());
  if (directory) await attempt(() => rm(directory!, { recursive: true, force: true }));
  if (failures.length) throw new Error(`Cleanup failed for owned resources ${id}: ${failures.map(error => redact(String(error), secrets)).join('; ')}`);
  console.log('Cleanup: owned containers, network, database and temporary files removed');
}
