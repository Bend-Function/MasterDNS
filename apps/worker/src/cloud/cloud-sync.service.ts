import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { addressHealthStates, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, getCloudTargetsForSlots, managedAddressSlots, resetHealthEvidence, rotationAttempts, rotationIncidents, rotationSteps } from "@masterdns/db";
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
            // Health scheduling locks slot before address. Match that order before
            // refreshing observations so a concurrent scheduler cannot deadlock.
            await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots).where(eq(managedAddressSlots.interfaceId, iface.id)).orderBy(asc(managedAddressSlots.id)).for("update");
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
                // Discovery can stage verification but never publishes an address.
                const [existingSlot] = await tx.select().from(managedAddressSlots).where(and(
                  eq(managedAddressSlots.interfaceId, iface.id), eq(managedAddressSlots.family, family),
                  or(eq(managedAddressSlots.currentAddressId, address.id), eq(managedAddressSlots.candidateAddressId, address.id)),
                )).limit(1);
                if (existingSlot && (!observed.primary || (existingSlot.candidateAddressId ?? existingSlot.currentAddressId) === address.id)) continue;
                let name = existingSlot?.name ?? (observed.primary ? "primary" : observed.address);
                if (!existingSlot && observed.primary && family === "4" && (service === "ec2" || service === "lightsail")) {
                  const roleSlots = await tx.select({ name: managedAddressSlots.name, metadata: cloudAddresses.metadata, address: cloudAddresses.address }).from(managedAddressSlots)
                    .leftJoin(cloudAddresses, eq(managedAddressSlots.currentAddressId, cloudAddresses.id))
                    .where(and(eq(managedAddressSlots.interfaceId, iface.id), eq(managedAddressSlots.family, family)));
                  // AWS reports both private and public IPv4 as primary. Keep legacy
                  // bindings intact, including when public observations arrive first
                  // and the previous scan did not persist role metadata.
                  const role = (row: typeof roleSlots[number]) => {
                    const currentObservation = remote.addresses.find(item => item.address === row.address);
                    const metadata = row.metadata?.providerMetadata;
                    return currentObservation?.metadata?.awsAddressScope ?? (metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).awsAddressScope : undefined);
                  };
                  const observedScope = observed.metadata?.awsAddressScope;
                  if (observedScope === "private" || observedScope === "public") {
                    const matchingRole = roleSlots.find(row => (row.name === "primary" || row.name.startsWith(`primary-${observedScope}`)) && role(row) === observedScope);
                    if (matchingRole) name = matchingRole.name;
                    else if (roleSlots.some(row => row.name === "primary")) {
                      name = `primary-${observedScope}`;
                      if (roleSlots.some(row => row.name === name)) name = `${name}-${address.id.slice(0, 8)}`;
                    }
                  }
                }
                await tx.insert(managedAddressSlots).values({ interfaceId: iface.id, family, name, currentAddressId: address.id })
                  .onConflictDoNothing({ target: [managedAddressSlots.interfaceId, managedAddressSlots.family, managedAddressSlots.name] });
                if (observed.primary) {
                  const [slot] = await tx.select().from(managedAddressSlots).where(and(eq(managedAddressSlots.interfaceId, iface.id), eq(managedAddressSlots.family, family), eq(managedAddressSlots.name, name))).for("update");
                  if (!slot || (slot.candidateAddressId ?? slot.currentAddressId) === address.id) continue;
                  // A scan may discover an out-of-band change, but never takes over
                  // from an unfinished or uncertain cloud operation.
                  const [busy] = await tx.select({ id: rotationIncidents.id }).from(rotationIncidents)
                    .innerJoin(managedAddressSlots, eq(managedAddressSlots.id, rotationIncidents.slotId))
                    .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
                    .where(and(eq(cloudInterfaces.instanceId, instance.id), or(ne(rotationIncidents.status, "complete"), sql`exists (select 1 from ${rotationAttempts} inner join ${rotationSteps} on ${rotationSteps.attemptId} = ${rotationAttempts.id} where ${rotationAttempts.incidentId} = ${rotationIncidents.id} and ${rotationSteps.status} in ('in_flight', 'pending', 'ambiguous'))`))).limit(1);
                  if (busy) continue;
                  await tx.update(managedAddressSlots).set({ candidateAddressId: address.id, candidateVersion: Math.max(slot.currentVersion, slot.candidateVersion) + 1, updatedAt: now }).where(eq(managedAddressSlots.id, slot.id));
                  await tx.update(addressHealthStates).set({ ...resetHealthEvidence, stateChangedAt: now, updatedAt: now }).where(eq(addressHealthStates.slotId, slot.id));
                }
              }
            }
          }
        }
        const absent = await tx.update(cloudInstances).set({ metadata: sql`${cloudInstances.metadata} || '{"present":false}'::jsonb`, updatedAt: now })
          .where(and(eq(cloudInstances.accountId, accountId), eq(cloudInstances.service, service), eq(cloudInstances.region, region), ne(cloudInstances.scanGeneration, generation), sql`${cloudInstances.metadata}->>'present' is distinct from 'false'`)).returning({ id: cloudInstances.id });
        await tx.update(cloudScanScopes).set({ generation, lastCompletedAt: now, lastError: null, updatedAt: now }).where(eq(cloudScanScopes.id, scope.id));
        // Invalidate authority atomically with the new inventory, including slots
        // on missing interfaces/instances. Keep every address and binding for history.
        const scopeSlots = await tx.select({ id: managedAddressSlots.id }).from(managedAddressSlots)
          .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
          .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
          .where(and(eq(cloudInstances.accountId, accountId), eq(cloudInstances.service, service), eq(cloudInstances.region, region)))
          .orderBy(asc(managedAddressSlots.id)).for("update", { of: managedAddressSlots });
        const targets = await getCloudTargetsForSlots(tx, scopeSlots.map(slot => slot.id));
        const historical = [...targets.values()].filter(target => !target.available).map(target => target.slot.id);
        if (historical.length) await tx.update(addressHealthStates).set({ ...resetHealthEvidence, stateChangedAt: now, updatedAt: now }).where(inArray(addressHealthStates.slotId, historical));
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
