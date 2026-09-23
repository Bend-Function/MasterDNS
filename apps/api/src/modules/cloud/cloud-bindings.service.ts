import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { captureCloudPolicyLinks, auditLogs, bindingAssignments, cloudAccounts, cloudAddresses, cloudEndpointLinks, cloudInstances, cloudInterfaces, cloudScanScopes, dnsRecords, domainBindings, endpointAddresses, endpointPools, endpoints, healthCheckConfigs, instanceAuthorizations, managedAddressSlots, operationSteps, policyVersions, reconcileIntents, providerAccounts, zones } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { idleIpAddressReleasing } from "@masterdns/db";
import { QueueService } from "../../infrastructure/queue.module.js";
import { normalizeRecordName } from "../dns/dns-name.js";
import { cloudRequestKey, withCloudRequest } from "./cloud-idempotency.js";
import type { CloudBindingInput } from "./cloud.schemas.js";

@Injectable()
export class CloudBindingsService {
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async bind(actor: AuthUser, input: CloudBindingInput, idempotencyKey: string) {
    const key = cloudRequestKey(idempotencyKey);
    try {
      return await this.queues.withDnsZoneLock(input.zoneId, (lease) => this.database.db.transaction(async (tx) => {
        lease.assertOwned();
        const [selected] = await tx.select({ accountId: cloudAccounts.id, ownerUserId: cloudAccounts.ownerUserId }).from(managedAddressSlots)
          .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
          .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
          .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
          .where(and(eq(managedAddressSlots.id, input.slotId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).limit(1);
        if (!selected) throw new NotFoundException("Cloud slot not found");
        const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, selected.accountId)).for("update");
        if (!account || (actor.role !== "admin" && account.ownerUserId !== actor.id)) throw new NotFoundException("Cloud account not found");
        const ownerUserId = account.ownerUserId;
        const [zone] = await tx.select({ zone: zones, ownerUserId: providerAccounts.ownerUserId }).from(zones)
          .innerJoin(providerAccounts, eq(providerAccounts.id, zones.providerAccountId)).where(eq(zones.id, input.zoneId)).for("update");
        if (!zone || zone.ownerUserId !== ownerUserId) throw new NotFoundException("Zone and cloud slot must belong to the same owner");
        const fqdn = normalizeRecordName({ name: input.fqdn, type: input.recordType, content: "", ttl: 60, providerMetadata: {} }, zone.zone.nameAscii).name;
        if (input.poolId) {
          const [ownedPool] = await tx.select({ id: endpointPools.id }).from(endpointPools).where(and(eq(endpointPools.id, input.poolId), eq(endpointPools.ownerUserId, ownerUserId))).limit(1);
          if (!ownedPool) throw new NotFoundException("Pool not found for cloud account owner");
        }
        const result = await withCloudRequest(tx, {
          key, actorUserId: actor.id, ownerUserId: ownerUserId, action: "slot.bind",
          request: { zoneId: input.zoneId, fqdn, recordType: input.recordType, slotId: input.slotId, takeoverExisting: input.takeoverExisting ?? false, poolId: input.poolId ?? null },
        }, async () => {
          if (!account?.enabled) throw new ConflictException("Cloud account is disabled");
          const [source] = await tx.select({ slot: managedAddressSlots, address: cloudAddresses, instance: cloudInstances, iface: cloudInterfaces, generation: cloudScanScopes.generation })
            .from(managedAddressSlots).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
            .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
            .innerJoin(cloudScanScopes, and(eq(cloudScanScopes.accountId, cloudInstances.accountId), eq(cloudScanScopes.service, cloudInstances.service), eq(cloudScanScopes.region, cloudInstances.region)))
            .innerJoin(cloudAddresses, eq(cloudAddresses.id, managedAddressSlots.currentAddressId))
            .where(eq(managedAddressSlots.id, input.slotId)).for("update");
          if (!source) throw new ConflictException("Cloud slot has no observed host address");
          if (await idleIpAddressReleasing(tx, source.address.address)) throw new ConflictException("Address cleanup is in progress");
          const [authorization] = await tx.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, source.instance.id)).for("share");
          if (!authorization?.managed) throw new ConflictException("Cloud instance is not managed");
          if ((account.regions !== null && !account.regions.includes(source.instance.region)) || source.instance.metadata.present === false || !source.address.inventoryPresent || source.iface.scanGeneration !== source.generation || source.address.scanGeneration !== source.generation) throw new ConflictException("Cloud slot address is no longer present in current inventory");
          if (source.slot.family !== (input.recordType === "A" ? "4" : "6")) throw new BadRequestException("Record type does not match slot family");
          const [existingBinding] = await tx.select({ id: domainBindings.id }).from(domainBindings).where(and(eq(domainBindings.zoneId, input.zoneId), eq(domainBindings.fqdn, fqdn), eq(domainBindings.recordType, input.recordType))).limit(1);
          if (existingBinding) throw new ConflictException("DNS record already has a manager");
          const records = await tx.select().from(dnsRecords).where(and(eq(dnsRecords.zoneId, input.zoneId), sql`lower(rtrim(${dnsRecords.name}, '.')) = ${fqdn}`, eq(dnsRecords.type, input.recordType), isNull(dnsRecords.deletedAt))).for("update");
          const [pendingWrite] = await tx.select({ id: operationSteps.id }).from(operationSteps).where(and(
            eq(operationSteps.zoneId, input.zoneId), inArray(operationSteps.status, ["pending", "running"]),
            or(inArray(operationSteps.dnsRecordId, records.map((record) => record.id)), and(sql`lower(rtrim(${operationSteps.input}->'record'->>'name', '.')) = ${fqdn}`, sql`${operationSteps.input}->'record'->>'type' = ${input.recordType}`)),
          )).limit(1);
          if (pendingWrite) throw new ConflictException("DNS record has a pending write; wait for it to complete before binding");
          if (records.length && !input.takeoverExisting) throw new ConflictException("DNS record exists; explicit takeover is required");
          const record = records[0];
          if (input.takeoverExisting && (records.length !== 1 || record?.management !== "unmanaged" || !sameIpAddress(record.content, source.address.address))) throw new ConflictException("Takeover requires one unmanaged record matching the selected address");
          let pool: typeof endpointPools.$inferSelect;
          if (input.poolId) {
            const [existing] = await tx.select().from(endpointPools).where(and(eq(endpointPools.id, input.poolId), eq(endpointPools.ownerUserId, ownerUserId))).for("update");
            if (!existing) throw new NotFoundException("Pool not found for cloud account owner");
            pool = existing;
          } else {
            [pool] = await tx.insert(endpointPools).values({ ownerUserId: ownerUserId, name: fqdn.slice(0, 120), strategy: "primary_backup" }).returning() as [typeof endpointPools.$inferSelect];
          }
          const [linked] = await tx.select({ endpoint: endpoints }).from(endpoints).innerJoin(cloudEndpointLinks, eq(cloudEndpointLinks.endpointId, endpoints.id))
            .where(and(eq(endpoints.poolId, pool.id), eq(cloudEndpointLinks.slotId, input.slotId))).limit(1);
          let endpoint = linked?.endpoint;
          if (!endpoint) {
            [endpoint] = await tx.insert(endpoints).values({ poolId: pool.id, name: `cloud-${input.slotId}`, addressMode: "cloud" }).returning();
            if (!endpoint) throw new Error("Cloud endpoint insert returned no row");
            await tx.insert(cloudEndpointLinks).values({ endpointId: endpoint.id, slotId: source.slot.id, family: source.slot.family });
          }
          const [binding] = await tx.insert(domainBindings).values({ poolId: pool.id, zoneId: input.zoneId, fqdn, recordType: input.recordType, originalEndpointId: endpoint.id, ttl: record?.ttl ?? 60, providerMetadata: record?.providerMetadata ?? {} }).returning();
          if (!binding) throw new Error("Cloud binding insert returned no row");
          if (record) {
            await tx.update(dnsRecords).set({ management: "managed", managedByPoolId: pool.id, updatedAt: new Date() }).where(eq(dnsRecords.id, record.id));
            await tx.insert(bindingAssignments).values({ domainBindingId: binding.id, endpointId: endpoint.id, dnsRecordId: record.id, desired: true, applied: true, reason: "cloud_takeover" });
          }
          // Observed addresses are not endpoint current/candidate addresses. Only the external
          // versioned verification path may promote one, including after an explicit takeover.
          const [updatedPool] = await tx.update(endpointPools).set({ policyRevision: sql`${endpointPools.policyRevision} + 1`, decisionRevision: sql`${endpointPools.decisionRevision} + 1`, updatedAt: new Date() }).where(eq(endpointPools.id, pool.id)).returning();
          const [endpointRows, addresses, bindingRows, checks] = await Promise.all([
            tx.select().from(endpoints).where(eq(endpoints.poolId, pool.id)),
            tx.select({ address: endpointAddresses }).from(endpointAddresses).innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id)).where(eq(endpoints.poolId, pool.id)),
            tx.select().from(domainBindings).where(eq(domainBindings.poolId, pool.id)),
            tx.select().from(healthCheckConfigs).where(or(eq(healthCheckConfigs.poolId, pool.id), inArray(healthCheckConfigs.endpointId, tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.poolId, pool.id))), inArray(healthCheckConfigs.domainBindingId, tx.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, pool.id))))),
          ]);
          await tx.insert(policyVersions).values({ poolId: pool.id, version: updatedPool!.policyRevision, actorUserId: actor.id, reason: "cloud_binding.create", snapshot: { cloudLinks: await captureCloudPolicyLinks(tx, pool.id), pool: updatedPool, endpoints: endpointRows, addresses: addresses.map((row) => row.address), bindings: bindingRows, healthChecks: checks } });
          await tx.insert(reconcileIntents).values({ eventId: randomUUID(), poolId: pool.id, policyRevision: updatedPool!.policyRevision, decisionRevision: updatedPool!.decisionRevision, trigger: "configuration", source: "user", force: false });
          await tx.insert(auditLogs).values({ ownerUserId: ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_binding.create", resourceType: "domain_binding", resourceId: binding.id, afterSnapshot: { binding, endpoint, slotId: source.slot.id } });
          lease.assertOwned();
          return { pool: updatedPool!, endpoint, binding, awaitingExternalVerification: true };
        });
        const [ownedResult] = await tx.select({ id: endpointPools.id }).from(endpointPools).where(and(eq(endpointPools.id, result.pool.id), eq(endpointPools.ownerUserId, ownerUserId))).limit(1);
        if (!ownedResult) throw new NotFoundException("Pool not found for cloud account owner");
        lease.assertOwned();
        return result;
      }));
    } catch (error) {
      if (postgresCode(error) === "23505") throw new ConflictException("Cloud endpoint or DNS record already has a manager");
      throw error;
    }
  }
}

function postgresCode(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error) return error.code;
  return "cause" in error ? postgresCode(error.cause) : undefined;
}


export function sameIpAddress(left: string, right: string): boolean {
  const family = isIP(left);
  if (family === 0 || isIP(right) !== family) return false;
  if (family === 4) return left === right;
  try {
    // The WHATWG URL parser serializes IPv6 in canonical compressed notation.
    return new URL(`http://[${left}]/`).hostname === new URL(`http://[${right}]/`).hostname;
  } catch {
    return false;
  }
}
