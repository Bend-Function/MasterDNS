import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { ProviderRecord, ProviderZone, ZoneSyncJob } from "@masterdns/contracts";
import { ProviderError, queueNames } from "@masterdns/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { dnsRecords, providerAccounts, zones } from "@masterdns/db";
import { providerRecordHash } from "@masterdns/providers";
import { Job, Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { ProviderRuntimeService } from "../providers/provider-runtime.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

@Injectable()
export class SyncProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncProcessor.name);
  private worker?: Worker<ZoneSyncJob>;

  constructor(private readonly database: DatabaseService, private readonly providers: ProviderRuntimeService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    this.worker = new Worker<ZoneSyncJob>(queueNames.sync, (job) => this.process(job), { connection: this.queues.redis, concurrency: 2, lockDuration: 120_000 });
    this.worker.on("failed", (job, error) => this.logger.error(`Sync job ${job?.id ?? "unknown"} failed: ${error instanceof ProviderError ? error.code : error instanceof Error ? error.name : "unknown"}`));
  }

  async onModuleDestroy() { await this.worker?.close(); }

  private async process(job: Job<ZoneSyncJob>) {
    const { adapter, account } = await this.providers.forAccount(job.data.providerAccountId);
    try {
      if (job.data.zoneId) {
        const [zone] = await this.database.db.select().from(zones).where(and(eq(zones.id, job.data.zoneId), eq(zones.providerAccountId, account.id))).limit(1);
        if (!zone) throw new Error("Zone does not belong to provider account");
        await this.syncRecords(adapter, zone);
      } else {
        const remoteZones = await collectPages((cursor) => adapter.listZones(cursor));
        for (const remote of remoteZones) {
          const [zone] = await this.database.db.insert(zones).values(toZoneValues(account.id, remote)).onConflictDoUpdate({
            target: [zones.providerAccountId, zones.externalId],
            set: { nameAscii: remote.name, status: remote.status === "error" ? "error" : "active", providerMetadata: remote.providerMetadata, lastSyncedAt: new Date(), updatedAt: new Date() },
          }).returning();
          if (zone) await this.syncRecords(adapter, zone);
        }
      }
      await this.database.db.update(providerAccounts).set({ status: "active", errorCode: null, lastSyncedAt: new Date(), updatedAt: new Date() }).where(eq(providerAccounts.id, account.id));
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : "sync_failed";
      await this.database.db.update(providerAccounts).set({ status: "error", errorCode: code, updatedAt: new Date() }).where(eq(providerAccounts.id, account.id));
      throw error;
    }
  }

  private async syncRecords(adapter: Awaited<ReturnType<ProviderRuntimeService["forAccount"]>>["adapter"], zone: typeof zones.$inferSelect) {
    const remoteRecords = await collectPages((cursor) => adapter.listRecords(zone.externalId, cursor));
    const seenExternalIds: string[] = [];
    for (const remote of remoteRecords) {
      seenExternalIds.push(remote.externalId);
      await this.database.db.insert(dnsRecords).values(toRecordValues(zone.id, remote)).onConflictDoUpdate({
        target: [dnsRecords.zoneId, dnsRecords.externalId],
        set: {
          type: remote.type,
          name: remote.name,
          content: remote.content,
          ttl: remote.ttl,
          priority: remote.priority ?? null,
          providerMetadata: remote.providerMetadata,
          remoteHash: providerRecordHash(remote),
          lastSyncedAt: new Date(),
          deletedAt: null,
          updatedAt: new Date(),
        },
      });
    }
    const local = await this.database.db.select({ id: dnsRecords.id, externalId: dnsRecords.externalId, management: dnsRecords.management }).from(dnsRecords)
      .where(and(eq(dnsRecords.zoneId, zone.id), eq(dnsRecords.management, "unmanaged")));
    const missing = local.filter((record) => !seenExternalIds.includes(record.externalId)).map((record) => record.id);
    if (missing.length > 0) await this.database.db.update(dnsRecords).set({ deletedAt: new Date(), updatedAt: new Date() }).where(inArray(dnsRecords.id, missing));
    await this.database.db.update(zones).set({ lastSyncedAt: new Date(), status: "active", updatedAt: new Date() }).where(eq(zones.id, zone.id));
  }
}

async function collectPages<T>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function toZoneValues(accountId: string, zone: ProviderZone): typeof zones.$inferInsert {
  return { providerAccountId: accountId, externalId: zone.externalId, nameAscii: zone.name, status: zone.status === "error" ? "error" : "active", providerMetadata: zone.providerMetadata, lastSyncedAt: new Date() };
}

function toRecordValues(zoneId: string, record: ProviderRecord): typeof dnsRecords.$inferInsert {
  return { zoneId, externalId: record.externalId, type: record.type, name: record.name, content: record.content, ttl: record.ttl, priority: record.priority ?? null, providerMetadata: record.providerMetadata, remoteHash: providerRecordHash(record), lastSyncedAt: new Date() };
}
