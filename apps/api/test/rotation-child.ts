import 'reflect-metadata';
import assert from 'node:assert/strict';
import { desc, eq } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudflareDnsAdapter } from '@masterdns/providers';
import { createDatabase, providerAccounts, rotationPublications, dnsRecords } from '@masterdns/db';
import { Ec2CloudAdapter } from '@masterdns/cloud-providers';
const settings = JSON.parse(process.env.MASTERDNS_INTEGRATION_CHILD!);
assert(new URL(settings.remoteUrl).hostname === '127.0.0.1');
process.env.DATABASE_URL = settings.databaseUrl;
process.env.REDIS_URL = settings.redisUrl;
process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
const { RotationStore } = await import('../../worker/src/rotation/rotation-store.js');
const { RotationProcessor } = await import('../../worker/src/rotation/rotation.processor.js');
const { RotationRecoveryService } = await import('../../worker/src/rotation/rotation-recovery.service.js');
const { RotationPublicationService } = await import('../../worker/src/rotation/rotation-publication.service.js');
const { RotationCleanupService } = await import('../../worker/src/rotation/rotation-cleanup.service.js');
const { ReconcileProcessor } = await import('../../worker/src/automation/reconcile.processor.js');
const { ReconcileOutboxService } = await import('../../worker/src/automation/reconcile-outbox.service.js');
const { OperationProcessor } = await import('../../worker/src/operations/operation.processor.js');
const { QueueRuntimeService } = await import('../../worker/src/queue-runtime.service.js');
const connection = createDatabase(settings.databaseUrl);
const database = { db: connection.db } as never;
const queues = new QueueRuntimeService();
const remote = async (name: string, input: unknown): Promise<any> => {
  const response = await fetch(settings.remoteUrl, { method: 'POST', body: JSON.stringify({ name, input }), signal: AbortSignal.timeout(30_000) });
  assert(response.ok, await response.clone().text()); return response.json();
};
const send = (command: any) => remote(command.constructor.name, command.input);
const runtime = { adapter: async (accountId: string) => new Ec2CloudAdapter(accountId, { kind: 'access_key', accessKeyId: 'isolated-fake', secretAccessKey: 'isolated-fake' }, { ec2Send: send, stsSend: send }) };
const publication = new RotationPublicationService(database, runtime as never);
const cleanup = new RotationCleanupService(database, runtime as never);
const dns = new CloudflareDnsAdapter('isolated-fake', { dns: { records: {
  list: async (input: unknown) => ({ ...await remote('dns.list', input), hasNextPage: () => false }),
  get: (id: string, input: object) => remote('dns.get', { ...input, id }),
  create: (input: unknown) => remote('dns.create', input),
  update: (id: string, input: object) => remote('dns.update', { ...input, id }),
  delete: (id: string, input: object) => remote('dns.delete', { ...input, id }),
} } } as never);
const providers = { forAccount: async (id: string) => {
  const [account] = await connection.db.select().from(providerAccounts).where(eq(providerAccounts.id, id));
  assert.equal(account?.status, 'active'); return { account, adapter: dns };
} };
const operations = new OperationProcessor(database, queues, providers as never, runtime as never);
const reconcile = new ReconcileProcessor(database, queues);
const outbox = new ReconcileOutboxService(database, queues);
let dnsStarted = false;
try {
  if (settings.action === 'publish') {
    if (settings.incidentId) await publication.publish(settings.incidentId);
    else await publication.publishSlot(settings.slotId);
    reconcile.onModuleInit(); await operations.onModuleInit(); await outbox.onModuleInit(); dnsStarted = true;
    const deadline = Date.now() + 25_000;
    while (true) {
      const [p] = await connection.db.select().from(rotationPublications).where(eq(rotationPublications.slotId, settings.slotId)).orderBy(desc(rotationPublications.addressVersion));
      assert(p, 'publication must exist'); await publication.observe(p.id);
      const [observed] = await connection.db.select().from(rotationPublications).where(eq(rotationPublications.id, p.id));
      if (observed?.status === 'applied') break;
      assert(Date.now() < deadline, `DNS publication timed out: ${observed?.status}/${observed?.errorCode}`); await delay(100);
    }
    if (settings.beforeCleanup) await remote('checkpoint.cleanup', {});
  } else if (settings.action === 'reconcile') {
    reconcile.onModuleInit(); await operations.onModuleInit(); await outbox.onModuleInit(); dnsStarted = true;
    const deadline = Date.now() + 25_000;
    while (true) {
      const records = await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, settings.zoneId));
      if (records.length === 2 && records.every(r => r.content === settings.expectedAddress)) break;
      assert(Date.now() < deadline, 'Pool failover DNS did not settle'); await delay(100);
    }
  } else if (settings.action === 'cleanup') {
    await cleanup.recover();
  } else if (settings.action === 'recover') await new RotationRecoveryService(database, queues).recover();
  else {
    const processor = new RotationProcessor(new RotationStore(database), runtime as never, queues);
    for (let i = 0; i < (settings.turns ?? 1); i++) await processor.run(settings.incidentId);
  }
} finally { if (dnsStarted) { outbox.onModuleDestroy(); await reconcile.onModuleDestroy(); await operations.onModuleDestroy(); } await queues.onModuleDestroy(); await connection.close(); }
