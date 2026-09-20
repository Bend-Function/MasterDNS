import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, managedAddressSlots } from "@masterdns/db";
import { CloudError, type CloudAdapter, type CloudInventory } from "@masterdns/cloud-providers";
import { queueNames, cloudProviderServices, cloudServiceProvider, validCloudRegion, type CloudService, type CloudSyncJob } from "@masterdns/contracts";
import { Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
import { env } from "../env.js";
import { CloudRuntimeService } from "./cloud-runtime.service.js";

type Service = CloudService;
type ScanResult = { scopeStatus: "complete" | "failed"; removedInstances: number; errorCode?: string };

@Injectable()
export class CloudSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudSyncService.name);
  private timer?: NodeJS.Timeout;
  private worker?: Worker<CloudSyncJob>;
  constructor(private readonly database: DatabaseService, private readonly runtime: CloudRuntimeService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    this.worker = new Worker<CloudSyncJob>(queueNames.cloudSync, (job) => this.sync(job.data.accountId), { connection: this.queues.redis, concurrency: 2 });
    this.worker.on("failed", () => this.logger.error("Cloud sync job failed"));
    this.timer = setInterval(() => void this.enqueueEnabled().catch(() => this.logger.error("Cloud sync scheduling failed")), env.CLOUD_SYNC_INTERVAL_SECONDS * 1000);
    this.timer.unref();
    void this.enqueueEnabled().catch(() => this.logger.error("Cloud sync scheduling failed"));
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); }

  async enqueueEnabled() {
    const accounts = await this.database.db.select({ id: cloudAccounts.id }).from(cloudAccounts).where(eq(cloudAccounts.enabled, true));
    for (const account of accounts) await this.queues.cloudSync.add("sync-cloud-account", { accountId: account.id }, { jobId: `cloud-sync-${account.id}`, removeOnComplete: true, removeOnFail: true });
  }

  async sync(accountId: string) {
    const [account] = await this.database.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId));
    if (!account?.enabled) return [];
    const results: Array<ScanResult & { service: Service; region: string }> = [];
    for (const service of cloudProviderServices[account.provider]) {
      try {
        const adapter = await this.runtime.adapter(accountId, service);
        const regions = await adapter.listScopes();
        for (const region of new Set(regions.filter((region) => account.regions === null || account.regions.includes(region)))) {
          results.push({ service, region, ...await this.scanScope(accountId, service, region, adapter, account) });
        }
        await this.database.db.delete(cloudScanScopes).where(and(eq(cloudScanScopes.accountId, accountId), eq(cloudScanScopes.service, service), eq(cloudScanScopes.region, "*")));
      } catch (error) {
        // '*' is a service-level discovery error, never an inventory scan generation.
        const code = safeCloudError(error);
        await this.database.db.insert(cloudScanScopes).values({ accountId, service, region: "*", lastError: code }).onConflictDoUpdate({ target: [cloudScanScopes.accountId, cloudScanScopes.service, cloudScanScopes.region], set: { lastError: code, updatedAt: new Date() } });
        results.push({ service, region: "*", scopeStatus: "failed", removedInstances: 0, errorCode: code });
      }
    }
    return results;
  }

  async scanScope(accountId: string, service: Service, region: string, adapter: CloudAdapter, expectedAccount?: typeof cloudAccounts.$inferSelect): Promise<ScanResult> {
    const [account] = await this.database.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId));
    if (!account?.enabled) return { scopeStatus: "failed", removedInstances: 0, errorCode: "account_unavailable" };
    if (cloudServiceProvider(service) !== account.provider || !validCloudRegion(account.provider, region)) return { scopeStatus: "failed", removedInstances: 0, errorCode: "invalid_scope" };
    if (account.regions !== null && !account.regions.includes(region)) return { scopeStatus: "failed", removedInstances: 0, errorCode: "region_excluded" };
    const [scope] = await this.database.db.insert(cloudScanScopes).values({ accountId, service, region, lastStartedAt: new Date() })
      .onConflictDoUpdate({ target: [cloudScanScopes.accountId, cloudScanScopes.service, cloudScanScopes.region], set: { lastStartedAt: new Date(), updatedAt: new Date() } }).returning();
    if (!scope) throw new Error("Cloud scope insert returned no row");
    try {
      const items: CloudInventory[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await adapter.discover(region, cursor);
        for (const item of page.items) {
          if (item.ref.accountId !== accountId || item.ref.service !== service || item.ref.region !== region) throw new Error("Invalid inventory scope");
          items.push(item);
        }
        cursor = page.cursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor) || cursors.size >= 10_000) throw new Error("Invalid cloud pagination");
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return await this.database.db.transaction(async (tx) => {
        const [currentAccount] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId)).for("update");
        const expected = expectedAccount ?? account;
        if (!currentAccount?.enabled || currentAccount.updatedAt.getTime() !== expected.updatedAt.getTime() || currentAccount.credentialCiphertext !== expected.credentialCiphertext || (currentAccount.regions !== null && !currentAccount.regions.includes(region))) throw new Error("Cloud account changed during scan");
        const [currentScope] = await tx.select().from(cloudScanScopes).where(eq(cloudScanScopes.id, scope.id)).for("update");
        if (currentScope?.generation !== scope.generation) throw new Error("Cloud scope already advanced");
        const generation = scope.generation + 1;
        const now = new Date();
        for (const item of items) {
          const metadata = { present: true, providerMetadata: item.metadata ?? {}, ...(item.nativeName !== undefined ? { nativeName: item.nativeName } : {}), ...(item.ipv6Only !== undefined ? { ipv6Only: item.ipv6Only } : {}) };
          const [instance] = await tx.insert(cloudInstances).values({ accountId, service, region, externalId: item.ref.instanceId, name: item.name, state: item.state, metadata, scanGeneration: generation, lastSeenAt: now })
            .onConflictDoUpdate({ target: [cloudInstances.accountId, cloudInstances.service, cloudInstances.region, cloudInstances.externalId], set: { name: item.name, state: item.state, metadata, scanGeneration: generation, lastSeenAt: now, updatedAt: now } }).returning();
          if (!instance) throw new Error("Cloud instance insert returned no row");
          for (const remote of item.interfaces) {
            const interfaceMetadata = { providerMetadata: remote.metadata ?? {}, ...(remote.deviceIndex === undefined ? {} : { deviceIndex: remote.deviceIndex }), primaryAddresses: remote.addresses.filter((address) => address.primary).map((address) => address.address) };
            const [iface] = await tx.insert(cloudInterfaces).values({ instanceId: instance.id, externalId: remote.id, name: remote.deviceIndex === undefined ? null : `eth${remote.deviceIndex}`, metadata: interfaceMetadata, scanGeneration: generation, lastSeenAt: now })
              .onConflictDoUpdate({ target: [cloudInterfaces.instanceId, cloudInterfaces.externalId], set: { name: remote.deviceIndex === undefined ? null : `eth${remote.deviceIndex}`, metadata: interfaceMetadata, scanGeneration: generation, lastSeenAt: now, updatedAt: now } }).returning();
            if (!iface) throw new Error("Cloud interface insert returned no row");
            for (const observed of remote.addresses) {
              const kind = observed.prefixLength === undefined ? "host" : "prefix";
              const family = observed.family === 4 ? "4" : "6";
              const addressMetadata = { providerMetadata: observed.metadata ?? {}, ...(observed.privateAddress === undefined ? {} : { privateAddress: observed.privateAddress }), ...(observed.resourceId === undefined ? {} : { resourceId: observed.resourceId }) };
              const values = { metadata: addressMetadata, interfaceId: iface.id, kind, family, address: observed.address, prefixLength: observed.prefixLength ?? null, remoteAllocationId: observed.allocationId ?? null, origin: "user", scanGeneration: generation, lastSeenAt: now } as const;
              // Refresh observations, but preserve the existing allocation proof atomically.
              // Legacy GUIDs must be anchored BEFORE the first scan can overwrite them.
              // Receipt-backed UPSERT rows may still have origin=user, so origin alone
              // cannot identify trusted proof. Never derive it from incoming inventory.
              const refreshedMetadata = service === "azure_vm" ? sql`${JSON.stringify(addressMetadata)}::jsonb || case
                when ${cloudAddresses.metadata} ? 'allocationIdentity' then jsonb_build_object('allocationIdentity', ${cloudAddresses.metadata}->'allocationIdentity')
                when ${cloudAddresses.origin} = 'system' or nullif(${cloudAddresses.metadata}->'providerMetadata'->>'resourceGuid', '') is not null
                  then jsonb_build_object('allocationIdentity', jsonb_build_object('allocationId', ${cloudAddresses.remoteAllocationId}, 'resourceId', ${cloudAddresses.metadata}->'resourceId', 'resourceGuid', ${cloudAddresses.metadata}->'providerMetadata'->'resourceGuid'))
                else '{}'::jsonb end` : addressMetadata;
              // Preserve known origin/attempt ownership; a scan never establishes system ownership.
              const [address] = await tx.insert(cloudAddresses).values(values).onConflictDoUpdate({
                target: kind === "host" ? [cloudAddresses.interfaceId, cloudAddresses.family, cloudAddresses.address] : [cloudAddresses.interfaceId, cloudAddresses.family, cloudAddresses.address, cloudAddresses.prefixLength],
                targetWhere: kind === "host" ? sql`${cloudAddresses.kind} = 'host'` : sql`${cloudAddresses.kind} = 'prefix'`,
                set: { metadata: refreshedMetadata, remoteAllocationId: sql`case when ${cloudAddresses.origin} = 'system' then ${cloudAddresses.remoteAllocationId} else ${observed.allocationId ?? null} end`, scanGeneration: generation, lastSeenAt: now, updatedAt: now },
              }).returning();
              if (kind === "host" && address) {
                // Existing slot pointers and versions are exclusively managed by the verified
                // rotation path. First discovery creates an observed, unverified version 0 slot.
                const [existingSlot] = await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots).where(and(
                  eq(managedAddressSlots.interfaceId, iface.id), eq(managedAddressSlots.family, family),
                  or(eq(managedAddressSlots.currentAddressId, address.id), eq(managedAddressSlots.candidateAddressId, address.id)),
                )).limit(1);
                if (existingSlot) continue;
                let name = observed.primary ? "primary" : observed.address;
                if (observed.primary && family === "4" && (service === "ec2" || service === "lightsail")) {
                  const [primary] = await tx.select({ metadata: cloudAddresses.metadata }).from(managedAddressSlots)
                    .leftJoin(cloudAddresses, eq(managedAddressSlots.currentAddressId, cloudAddresses.id))
                    .where(and(eq(managedAddressSlots.interfaceId, iface.id), eq(managedAddressSlots.family, family), eq(managedAddressSlots.name, "primary"))).limit(1);
                  // AWS reports both private and public IPv4 as primary. Keep legacy
                  // slots and their bindings intact, adding only the missing role.
                  const metadata = primary?.metadata?.providerMetadata;
                  const primaryScope = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).awsAddressScope : undefined;
                  const observedScope = observed.metadata?.awsAddressScope;
                  if ((primaryScope === "private" || primaryScope === "public") && (observedScope === "private" || observedScope === "public") && primaryScope !== observedScope) {
                    name = `primary-${observedScope}`;
                  }
                }
                await tx.insert(managedAddressSlots).values({ interfaceId: iface.id, family, name, currentAddressId: address.id })
                  .onConflictDoNothing({ target: [managedAddressSlots.interfaceId, managedAddressSlots.family, managedAddressSlots.name] });
              }
            }
          }
        }
        const absent = await tx.update(cloudInstances).set({ metadata: sql`${cloudInstances.metadata} || '{"present":false}'::jsonb`, updatedAt: now })
          .where(and(eq(cloudInstances.accountId, accountId), eq(cloudInstances.service, service), eq(cloudInstances.region, region), ne(cloudInstances.scanGeneration, generation), sql`${cloudInstances.metadata}->>'present' is distinct from 'false'`)).returning({ id: cloudInstances.id });
        await tx.update(cloudScanScopes).set({ generation, lastCompletedAt: now, lastError: null, updatedAt: now }).where(eq(cloudScanScopes.id, scope.id));
        return { scopeStatus: "complete", removedInstances: absent.length };
      });
    } catch (error) {
      const code = safeCloudError(error);
      await this.database.db.update(cloudScanScopes).set({ lastError: code, updatedAt: new Date() }).where(and(eq(cloudScanScopes.id, scope.id), eq(cloudScanScopes.generation, scope.generation)));
      return { scopeStatus: "failed", removedInstances: 0, errorCode: code };
    }
  }
}

function safeCloudError(error: unknown): string { return error instanceof CloudError ? error.code : "sync_failed"; }
