import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { ProviderRecord, ProviderZone, ZoneSyncJob } from "@masterdns/contracts";
import { ProviderError, queueNames } from "@masterdns/contracts";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { auditLogs, bindingAssignments, dnsRecords, domainBindings, endpointPools, failoverEvents, providerAccounts, reconcileIntents, zones } from "@masterdns/db";
import { providerRecordHash } from "@masterdns/providers";
import { Job, Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { ProviderRuntimeService } from "../providers/provider-runtime.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
import { isDnsZoneLockError, type DnsZoneLease, withDnsZoneLock } from "./dns-zone-lock.js";

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
    const [account] = await this.database.db.select().from(providerAccounts).where(eq(providerAccounts.id, job.data.providerAccountId)).limit(1);
    if (!account || account.status === "disabled") return;
    try {
      const { adapter } = await this.providers.forAccount(job.data.providerAccountId, { allowError: true });
      if (job.data.zoneId) {
        const [zone] = await this.database.db.select().from(zones).where(and(eq(zones.id, job.data.zoneId), eq(zones.providerAccountId, account.id))).limit(1);
        if (!zone) throw new Error("Zone does not belong to provider account");
        await withDnsZoneLock(this.queues.redis, zone.id, (lease) => this.syncRecords(adapter, zone, account.ownerUserId, lease), {
          onCleanupError: (error) => this.logger.warn(`Failed to release DNS zone lock ${zone.id}: ${safeError(error)}`),
        });
      } else {
        const remoteZones = await collectPages((cursor) => adapter.listZones(cursor));
        for (const remote of remoteZones) {
          const [zone] = await this.database.db.insert(zones).values(toZoneValues(account.id, remote)).onConflictDoUpdate({
            target: [zones.providerAccountId, zones.externalId],
            set: { nameAscii: remote.name, status: remote.status === "error" ? "error" : "active", providerMetadata: remote.providerMetadata, lastSyncedAt: new Date(), updatedAt: new Date() },
          }).returning();
          if (zone) {
            await withDnsZoneLock(this.queues.redis, zone.id, (lease) => this.syncRecords(adapter, zone, account.ownerUserId, lease), {
              onCleanupError: (error) => this.logger.warn(`Failed to release DNS zone lock ${zone.id}: ${safeError(error)}`),
            });
          }
        }
      }
      const [updatedAccount] = await this.database.db.update(providerAccounts)
        .set({ status: "active", errorCode: null, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(providerAccounts.id, account.id), ne(providerAccounts.status, "disabled")))
        .returning({ id: providerAccounts.id });
      if (!updatedAccount) return;
      if (shouldNotifyProviderRecovery(account.status)) {
        const recoveredEventId = `provider-recovered-${account.id}-${Date.now()}`;
        try {
          await this.queues.notifications.add("fanout-event", {
            kind: "fanout",
            event: {
              eventId: recoveredEventId,
              eventType: "provider.account_recovered",
              ownerUserId: account.ownerUserId,
              occurredAt: new Date().toISOString(),
              payload: { summary: `DNS provider account ${account.name} synchronized successfully again.`, providerAccountId: account.id },
            },
          }, { jobId: `fanout-${recoveredEventId}`, attempts: 3, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 5_000, removeOnFail: 5_000 });
        } catch (error) {
          this.logger.error(`Failed to enqueue provider recovery notification ${recoveredEventId}: ${safeError(error)}`);
        }
      }
    } catch (error) {
      if (!shouldUpdateProviderStatusAfterSyncFailure(error)) {
        this.logger.warn(`Zone sync deferred because its lock was not available: ${safeError(error)}`);
        throw error;
      }
      const code = error instanceof ProviderError ? error.code : "sync_failed";
      const [updatedAccount] = await this.database.db.update(providerAccounts)
        .set({ status: "error", errorCode: code, updatedAt: new Date() })
        .where(and(eq(providerAccounts.id, account.id), ne(providerAccounts.status, "disabled")))
        .returning({ id: providerAccounts.id });
      if (!updatedAccount) return;
      if (shouldNotifyProviderError(account.status, account.errorCode, code)) {
        const eventId = `provider-error-${account.id}-${Date.now()}`;
        await this.queues.notifications.add("fanout-event", {
          kind: "fanout",
          event: {
            eventId,
            eventType: "provider.account_error",
            ownerUserId: account.ownerUserId,
            occurredAt: new Date().toISOString(),
            payload: { summary: `DNS provider account ${account.name} failed to sync.`, providerAccountId: account.id, errorCode: code },
          },
        }, { jobId: `fanout-${eventId}`, attempts: 3, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 5_000, removeOnFail: 5_000 });
      }
      if (error instanceof ProviderError && !error.retryable) return;
      throw error;
    }
  }

  private async syncRecords(
    adapter: Awaited<ReturnType<ProviderRuntimeService["forAccount"]>>["adapter"],
    zone: typeof zones.$inferSelect,
    ownerUserId: string,
    lease: DnsZoneLease,
  ): Promise<void> {
    const remoteRecords = await collectPages((cursor) => adapter.listRecords(zone.externalId, cursor));
    lease.assertOwned();
    const seenExternalIds: string[] = [];
    for (const remote of remoteRecords) {
      lease.assertOwned();
      seenExternalIds.push(remote.externalId);
      const [local] = await this.database.db.select().from(dnsRecords).where(and(eq(dnsRecords.zoneId, zone.id), eq(dnsRecords.externalId, remote.externalId))).limit(1);
      const remoteHash = providerRecordHash(remote);
      const contentChanged = local !== undefined && hasSemanticRecordDrift(local, remoteHash);
      if (local?.management === "managed" && local.managedByPoolId && contentChanged) {
        await this.recordDrift(local, "record_changed", remote, ownerUserId, lease);
      } else if (local?.management === "unmanaged" && (contentChanged || local.deletedAt)) {
        await this.database.db.insert(auditLogs).values({
          ownerUserId,
          source: "sync",
          action: local.deletedAt ? "dns_record.external_create" : "dns_record.external_update",
          resourceType: "dns_record",
          resourceId: local.id,
          beforeSnapshot: local,
          afterSnapshot: remote,
        });
      }
      lease.assertOwned();
      const [synced] = await this.database.db.insert(dnsRecords).values(toRecordValues(zone.id, remote)).onConflictDoUpdate({
        target: [dnsRecords.zoneId, dnsRecords.externalId],
        set: {
          type: remote.type,
          name: remote.name,
          content: remote.content,
          ttl: remote.ttl,
          priority: remote.priority ?? null,
          providerMetadata: remote.providerMetadata,
          remoteHash,
          lastSyncedAt: new Date(),
          deletedAt: null,
          updatedAt: new Date(),
        },
      }).returning({ id: dnsRecords.id });
      if (!local && zone.lastSyncedAt && synced) {
        await this.database.db.insert(auditLogs).values({
          ownerUserId,
          source: "sync",
          action: "dns_record.external_create",
          resourceType: "dns_record",
          resourceId: synced.id,
          afterSnapshot: remote,
        });
      }
      lease.assertOwned();
    }
    const local = await this.database.db.select().from(dnsRecords)
      .where(and(eq(dnsRecords.zoneId, zone.id), isNull(dnsRecords.deletedAt)));
    const missingRows = local.filter((record) => !seenExternalIds.includes(record.externalId));
    for (const record of missingRows) {
      lease.assertOwned();
      if (record.management === "managed" && record.managedByPoolId) {
        await this.recordDrift(record, "record_deleted", null, ownerUserId, lease);
      } else if (record.management === "unmanaged") {
        await this.database.db.insert(auditLogs).values({
          ownerUserId,
          source: "sync",
          action: "dns_record.external_delete",
          resourceType: "dns_record",
          resourceId: record.id,
          beforeSnapshot: record,
        });
      }
    }
    lease.assertOwned();
    const missing = missingRows.map((record) => record.id);
    if (missing.length > 0) await this.database.db.update(dnsRecords).set({ deletedAt: new Date(), updatedAt: new Date() }).where(inArray(dnsRecords.id, missing));
    await this.database.db.update(zones).set({ lastSyncedAt: new Date(), status: "active", updatedAt: new Date() }).where(eq(zones.id, zone.id));
    lease.assertOwned();
  }

  private async recordDrift(
    record: typeof dnsRecords.$inferSelect,
    kind: string,
    remote: ProviderRecord | null,
    ownerUserId: string,
    lease: DnsZoneLease,
  ) {
    if (!record.managedByPoolId) return;
    const poolId = record.managedByPoolId;
    const eventId = randomUUID();
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${poolId}))`);
      lease.assertOwned();
      const [pool] = await tx.update(endpointPools).set({
        decisionRevision: sql`${endpointPools.decisionRevision} + 1`,
        updatedAt: new Date(),
      }).where(eq(endpointPools.id, poolId)).returning({
        decisionRevision: endpointPools.decisionRevision,
        policyRevision: endpointPools.policyRevision,
      });
      if (!pool) return;
      const bindingRows = await tx.select({ id: bindingAssignments.domainBindingId }).from(bindingAssignments)
        .where(eq(bindingAssignments.dnsRecordId, record.id));
      if (bindingRows.length > 0) {
        await tx.update(domainBindings).set({ state: "drifted", updatedAt: new Date() })
          .where(inArray(domainBindings.id, bindingRows.map((binding) => binding.id)));
      }
      await tx.insert(failoverEvents).values({
        poolId,
        eventType: `dns_drift.${kind}`,
        evidence: { eventId, recordId: record.id, expectedHash: record.remoteHash, observedHash: remote ? providerRecordHash(remote) : null },
        decision: { action: "reapply_current_policy" },
      });
      await tx.insert(reconcileIntents).values({
        eventId,
        poolId,
        decisionRevision: pool.decisionRevision,
        policyRevision: pool.policyRevision,
        trigger: "repair",
        source: "drift",
      });
    });
    try {
      await this.queues.notifications.add("fanout-event", {
        kind: "fanout",
        event: {
          eventId,
          eventType: `dns_drift.${kind}`,
          ownerUserId,
          poolId,
          occurredAt: new Date().toISOString(),
          payload: {
            summary: kind === "record_deleted" ? "A Pool-managed DNS record was deleted outside MasterDNS." : "A Pool-managed DNS record was changed outside MasterDNS.",
            recordId: record.id,
            action: "reapply_current_policy",
          },
        },
      }, { jobId: `fanout-${eventId}`, attempts: 3, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 5_000, removeOnFail: 5_000 });
    } catch (error) {
      this.logger.error(`Failed to enqueue drift notification ${eventId}: ${safeError(error)}`);
    }
  }
}

export function shouldNotifyProviderRecovery(previousStatus: typeof providerAccounts.$inferSelect["status"]): boolean {
  return previousStatus === "error";
}

export function shouldNotifyProviderError(
  previousStatus: typeof providerAccounts.$inferSelect["status"],
  previousErrorCode: string | null,
  nextErrorCode: string,
): boolean {
  return previousStatus !== "disabled" && (previousStatus !== "error" || previousErrorCode !== nextErrorCode);
}

export function shouldUpdateProviderStatusAfterSyncFailure(error: unknown): boolean {
  return !isDnsZoneLockError(error);
}

export function hasSemanticRecordDrift(local: typeof dnsRecords.$inferSelect, remoteHash: string): boolean {
  return local.remoteHash !== remoteHash && localRecordHash(local) !== remoteHash;
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

function localRecordHash(record: typeof dnsRecords.$inferSelect): string {
  return providerRecordHash({
    type: record.type as ProviderRecord["type"],
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    providerMetadata: record.providerMetadata,
    ...(record.priority !== null ? { priority: record.priority } : {}),
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
