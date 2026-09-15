import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import {
  addressHealthStates,
  resetHealthEvidence,
  cloudEndpointLinks,
  managedAddressSlots,
  endpointPools,
  endpointAddresses,
  endpoints,
  domainBindings,
  dnsRecords,
  zones,
  providerAccounts,
  reconcileIntents,
  operations,
  operationSteps,
  rotationIncidents,
  rotationPublications,
  rotationResources,
  lockRotationContext,
  lockRotationHealth,
  healthRevisions,
  healthRevisionMatches,
  rotationAuthorizationError,
  type RotationContext,
  type RotationTransaction,
} from "@masterdns/db";
import type { CloudInventory } from "@masterdns/cloud-providers";
import { DatabaseService } from "../database.service.js";
import { CloudRuntimeService } from "../cloud/cloud-runtime.service.js";
import { acquireRotationLease, releaseRotationLease, verifyRotationLease } from "./rotation-lock.js";

type Publication = typeof rotationPublications.$inferSelect;
// Cloudflare API TTL=1 is Auto (300s), not one second. Unknown sentinels
// retain one day: https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/
export function effectiveOldTtl(ttl: number, provider: string) {
  return ttl > 1 ? ttl : provider === "cloudflare" ? 300 : 86400;
}
export function publicationAuthorizationError(c: RotationContext) {
  if (!c.account.enabled || !c.account.externalAccountId || !c.authorization?.managed) return "authorization_revoked";
  if (!c.scope || (c.account.regions !== null && !c.account.regions.includes(c.instance.region))) return "region_excluded";
  if (!c.iface || !c.address || c.instance.metadata.present === false || c.iface.scanGeneration !== c.instance.scanGeneration)
    return "resource_not_found";
  if (c.conflictingManager) return "conflicting_manager";
}
export function livePublicationMatches(c: RotationContext, live: CloudInventory) {
  const metadata = c.address?.metadata;
  const providerMetadata = metadata?.providerMetadata as Record<string, unknown> | undefined;
  return (
    live.ref.accountId === c.account.id &&
    live.ref.instanceId === c.instance.externalId &&
    live.ref.region === c.instance.region &&
    live.ref.service === c.instance.service &&
    live.interfaces.some(
      (i) =>
        i.id === c.iface?.externalId &&
        i.addresses.some(
          (a) =>
            a.family === Number(c.slot.family) &&
            a.address === c.address?.address &&
            (!c.address.remoteAllocationId || a.allocationId === c.address.remoteAllocationId) &&
            (!metadata?.resourceId || a.resourceId === metadata.resourceId) &&
            (!providerMetadata?.resourceGuid || a.metadata?.resourceGuid === providerMetadata.resourceGuid),
        ),
    )
  );
}
export async function assertPublicationContext(tx: RotationTransaction, c: RotationContext, publication?: Publication) {
  const error = publicationAuthorizationError(c);
  if (error) throw new Error(error);
  const h = await lockRotationHealth(tx, c);
  if (!h.success) throw new Error("fresh_external_success_required");
  if (publication && (publication.addressId !== c.address?.id || publication.addressVersion !== c.addressVersion))
    throw new Error("publication_version_changed");
  if (
    publication?.context &&
    (publication.context.physicalKey !== c.physicalKey ||
      publication.context.authorizationRevision !== c.authorization!.revision ||
      !healthRevisionMatches(publication.context as never, h))
  )
    throw new Error("publication_authorization_changed");
  if (publication?.incidentId) {
    const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, publication.incidentId)).for("update");
    const rotationError = rotationAuthorizationError(c);
    if (rotationError) throw new Error(rotationError);
    if (
      !incident ||
      incident.pausedByUserId ||
      incident.status !== "active" ||
      incident.addressVersion !== c.addressVersion ||
      incident.authorizationRevision !== c.authorization!.revision ||
      incident.policyRevision !== c.policy!.revision ||
      !healthRevisionMatches(incident, h)
    )
      throw new Error("publication_incident_changed");
  }
  return h;
}
@Injectable()
export class RotationPublicationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(RotationPublicationService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: CloudRuntimeService,
  ) {}
  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.recover();
    } catch (e) {
      this.logger.error(e instanceof Error ? e.message : "publication_failed");
    } finally {
      this.running = false;
    }
  }
  async recover() {
    const missing = await this.database.db
      .select({ slotId: cloudEndpointLinks.slotId })
      .from(cloudEndpointLinks)
      .innerJoin(managedAddressSlots, eq(managedAddressSlots.id, cloudEndpointLinks.slotId))
      .where(
        and(
          sql`${managedAddressSlots.currentVersion} > 0`,
          isNull(managedAddressSlots.candidateAddressId),
          notExists(
            this.database.db
              .select({ id: endpointAddresses.id })
              .from(endpointAddresses)
              .where(
                and(
                  eq(endpointAddresses.endpointId, cloudEndpointLinks.endpointId),
                  eq(endpointAddresses.family, cloudEndpointLinks.family),
                  eq(endpointAddresses.state, "current"),
                ),
              ),
          ),
        ),
      )
      .limit(200);
    for (const slotId of new Set(missing.map((row) => row.slotId)))
      await this.database.db.transaction(async (tx) => {
        const c = await lockRotationContext(tx, slotId);
        if (c.slot.candidateAddressId || !c.slot.currentAddressId) return;
        const [active] = await tx
          .select({ id: rotationIncidents.id })
          .from(rotationIncidents)
          .where(and(eq(rotationIncidents.slotId, slotId), ne(rotationIncidents.status, "complete")));
        if (active) return;
        await tx
          .update(managedAddressSlots)
          .set({
            candidateAddressId: c.slot.currentAddressId,
            candidateVersion: Math.max(c.slot.currentVersion, c.slot.candidateVersion) + 1,
            updatedAt: new Date(),
          })
          .where(eq(managedAddressSlots.id, slotId));
        await tx
          .update(addressHealthStates)
          .set({ ...resetHealthEvidence, updatedAt: new Date() })
          .where(eq(addressHealthStates.slotId, slotId));
      });
    const candidates = await this.database.db
      .select({ id: managedAddressSlots.id })
      .from(managedAddressSlots)
      .where(sql`${managedAddressSlots.candidateAddressId} is not null`)
      .orderBy(asc(managedAddressSlots.updatedAt), asc(managedAddressSlots.id))
      .limit(200);
    for (const slot of candidates) {
      try {
        await this.publishSlot(slot.id);
      } catch (e) {
        this.logger.debug(e instanceof Error ? e.message : "publication_failed");
      } finally {
        await this.database.db.update(managedAddressSlots).set({ updatedAt: new Date() }).where(eq(managedAddressSlots.id, slot.id));
      }
    }
    const pending = await this.database.db
      .select()
      .from(rotationPublications)
      .where(and(ne(rotationPublications.status, "applied"), sql`${rotationPublications.promotedAt} is not null`))
      .orderBy(asc(rotationPublications.updatedAt), asc(rotationPublications.id))
      .limit(200);
    for (const p of pending) {
      try {
        await this.observe(p.id);
      } catch (e) {
        await this.database.db
          .update(rotationPublications)
          .set({ errorCode: e instanceof Error ? e.message.slice(0, 80) : "publication_failed", updatedAt: new Date() })
          .where(eq(rotationPublications.id, p.id));
      }
    }
  }
  async publish(incidentId: string): Promise<{ operationIds: string[] }> {
    const [incident] = await this.database.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, incidentId));
    if (!incident) throw new Error("rotation_not_found");
    const p = await this.publishSlot(incident.slotId, incidentId);
    if (p?.promotedAt) await this.observe(p.id);
    const [latest] = p ? await this.database.db.select().from(rotationPublications).where(eq(rotationPublications.id, p.id)) : [];
    return { operationIds: latest?.children.flatMap((c) => (c.operationId ? [c.operationId] : [])) ?? [] };
  }
  async publishSlot(slotId: string, incidentId?: string) {
    const admission = await this.database.db.transaction(async (tx) => {
      const c = await lockRotationContext(tx, slotId);
      const [existing] = await tx
        .select()
        .from(rotationPublications)
        .where(and(eq(rotationPublications.slotId, slotId), eq(rotationPublications.addressVersion, c.addressVersion)));
      if (existing?.promotedAt) return { publication: existing };
      if (!c.slot.candidateAddressId) return {};
      const [active] = await tx
        .select()
        .from(rotationIncidents)
        .where(and(eq(rotationIncidents.slotId, slotId), ne(rotationIncidents.status, "complete")));
      // An initial binding has no incident. Do not steal a paused/incomplete rotation.
      if (active && (!existing || (incidentId && active.id !== incidentId))) throw new Error("rotation_publication_not_ready");
      const h = await assertPublicationContext(tx, c, existing);
      const lease = await acquireRotationLease(tx, c.physicalKey, randomUUID());
      if (!lease) return {};
      const physical = await verifyRotationLease(tx, lease);
      if (physical?.unresolvedStepId || (physical?.incidentId && physical.incidentId !== existing?.incidentId)) {
        await releaseRotationLease(tx, lease);
        return {};
      }
      return { c, h, lease, publication: existing };
    });
    if (!admission.c || !admission.lease) return admission.publication;
    const { c, lease } = admission;
    try {
      const adapter = await this.runtime.adapter(c.account.id, c.instance.service, { observation: true });
      const live = await adapter.inspect({
        accountId: c.account.id,
        service: c.instance.service,
        region: c.instance.region,
        instanceId: c.instance.externalId,
      });
      return await this.database.db.transaction(async (tx) => {
        const current = await lockRotationContext(tx, slotId);
        const physical = await verifyRotationLease(tx, lease);
        if (
          !physical ||
          physical.unresolvedStepId ||
          current.account.credentialCiphertext !== c.account.credentialCiphertext ||
          current.physicalKey !== c.physicalKey ||
          current.addressVersion !== c.addressVersion ||
          current.address?.id !== c.address?.id ||
          !livePublicationMatches(current, live)
        )
          throw new Error("live_cloud_address_changed");
        const [existing] = await tx
          .select()
          .from(rotationPublications)
          .where(and(eq(rotationPublications.slotId, slotId), eq(rotationPublications.addressVersion, c.addressVersion)))
          .for("update");
        if (existing?.promotedAt) return existing;
        const h = await assertPublicationContext(tx, current, existing);
        const links = await tx
          .select({ link: cloudEndpointLinks, endpoint: endpoints, pool: endpointPools })
          .from(cloudEndpointLinks)
          .innerJoin(endpoints, eq(endpoints.id, cloudEndpointLinks.endpointId))
          .innerJoin(endpointPools, eq(endpointPools.id, endpoints.poolId))
          .where(eq(cloudEndpointLinks.slotId, slotId));
        if (!links.length) throw new Error("publication_has_no_links");
        if (links.some((r) => r.endpoint.addressMode !== "cloud" || r.pool.ownerUserId !== c.account.ownerUserId))
          throw new Error("publication_owner_changed");
        const poolIds = [...new Set(links.map((r) => r.pool.id))].sort();
        for (const id of poolIds) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
        const oldRecords = await tx
          .select({ ttl: dnsRecords.ttl, provider: providerAccounts.provider })
          .from(dnsRecords)
          .innerJoin(zones, eq(zones.id, dnsRecords.zoneId))
          .innerJoin(providerAccounts, eq(providerAccounts.id, zones.providerAccountId))
          .where(and(inArray(dnsRecords.managedByPoolId, poolIds), isNull(dnsRecords.deletedAt)));
        let maxTtl = Math.max(0, ...oldRecords.map((r) => effectiveOldTtl(r.ttl, r.provider)));
        const bindings = await tx
          .select({ ttl: domainBindings.ttl, provider: providerAccounts.provider })
          .from(domainBindings)
          .innerJoin(zones, eq(zones.id, domainBindings.zoneId))
          .innerJoin(providerAccounts, eq(providerAccounts.id, zones.providerAccountId))
          .where(inArray(domainBindings.poolId, poolIds));
        maxTtl = Math.max(maxTtl, ...bindings.map((b) => effectiveOldTtl(b.ttl, b.provider)));
        for (const { endpoint } of links) {
          await tx
            .update(endpointAddresses)
            .set({ state: "previous", replacedAt: h.now })
            .where(
              and(
                eq(endpointAddresses.endpointId, endpoint.id),
                eq(endpointAddresses.family, c.slot.family),
                inArray(endpointAddresses.state, ["current", "candidate"]),
              ),
            );
          await tx.insert(endpointAddresses).values({
            endpointId: endpoint.id,
            family: c.slot.family,
            address: current.address!.address,
            source: "cloud",
            state: "current",
            healthState: "healthy",
            consecutiveSuccesses: h.state!.consecutiveSuccesses,
            lastCheckedAt: h.state!.lastCheckedAt,
            promotedAt: h.now,
          });
          await tx
            .update(endpoints)
            .set({
              healthState: "healthy",
              consecutiveSuccesses: h.state!.consecutiveSuccesses,
              consecutiveFailures: 0,
              lastCheckedAt: h.state!.lastCheckedAt,
              updatedAt: h.now,
            })
            .where(eq(endpoints.id, endpoint.id));
        }
        await tx
          .update(managedAddressSlots)
          .set({ currentAddressId: current.address!.id, currentVersion: c.addressVersion, candidateAddressId: null, updatedAt: h.now })
          .where(eq(managedAddressSlots.id, slotId));
        const children: Publication["children"] = [];
        for (const id of poolIds) children.push(await this.intent(tx, id, h.now));
        const values = {
          status: "in_flight" as const,
          children,
          context: { physicalKey: c.physicalKey, authorizationRevision: c.authorization!.revision, ...healthRevisions(h) },
          previousMaxTtl: maxTtl,
          promotedAt: h.now,
          updatedAt: h.now,
          errorCode: null,
        };
        const [publication] = existing
          ? await tx.update(rotationPublications).set(values).where(eq(rotationPublications.id, existing.id)).returning()
          : await tx
              .insert(rotationPublications)
              .values({ slotId, addressVersion: c.addressVersion, addressId: current.address!.id, ...values })
              .returning();
        return publication;
      });
    } finally {
      await this.database.db.transaction((tx) => releaseRotationLease(tx, lease));
    }
  }
  private async intent(tx: RotationTransaction, poolId: string, now: Date) {
    const [pool] = await tx
      .update(endpointPools)
      .set({ decisionRevision: sql`${endpointPools.decisionRevision}+1`, updatedAt: now })
      .where(eq(endpointPools.id, poolId))
      .returning();
    if (!pool) throw new Error("pool_not_found");
    const eventId = randomUUID();
    await tx.insert(reconcileIntents).values({
      poolId,
      eventId,
      policyRevision: pool.policyRevision,
      decisionRevision: pool.decisionRevision,
      trigger: "repair",
      source: "failover",
      availableAt: now,
    });
    return { poolId, eventId, policyRevision: pool.policyRevision, decisionRevision: pool.decisionRevision };
  }
  async observe(id: string) {
    await this.database.db.transaction(async (tx) => {
      const [identity] = await tx.select().from(rotationPublications).where(eq(rotationPublications.id, id));
      if (!identity || identity.status === "applied") return;
      const c = await lockRotationContext(tx, identity.slotId);
      const [p] = await tx.select().from(rotationPublications).where(eq(rotationPublications.id, id)).for("update");
      if (!p?.promotedAt) return;
      if (c.addressVersion !== p.addressVersion || c.address?.id !== p.addressId) throw new Error("publication_version_changed");
      let done = true,
        failed = p.errorCode === "dns_partial",
        maxTtl = p.previousMaxTtl;
      const children: Publication["children"] = [];
      for (const child of p.children) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${child.poolId}))`);
        const [pool] = await tx.select().from(endpointPools).where(eq(endpointPools.id, child.poolId));
        if (!pool) {
          failed = true;
          done = false;
          children.push(child);
          continue;
        }
        const [op] = await tx
          .select()
          .from(operations)
          .where(eq(operations.idempotencyKey, `pool:${child.poolId}:revision:${child.policyRevision}:event:${child.eventId}`));
        if (pool.policyRevision !== child.policyRevision || pool.decisionRevision !== child.decisionRevision) {
          children.push(await this.intent(tx, pool.id, new Date()));
          done = false;
          continue;
        }
        children.push({ ...child, ...(op ? { operationId: op.id } : {}) });
        const [intent] = await tx.select().from(reconcileIntents).where(eq(reconcileIntents.eventId, child.eventId));
        if (!pool.enabled || !intent?.completedAt) {
          done = false;
          continue;
        }
        if (op) {
          const steps = await tx.select({ input: operationSteps.input }).from(operationSteps).where(eq(operationSteps.operationId, op.id));
          maxTtl = Math.max(maxTtl, ...steps.map((s) => (typeof s.input.cleanupOldTtl === "number" ? s.input.cleanupOldTtl : 0)));
        }
        if (op && op.status !== "succeeded") {
          done = false;
          if (["partial", "failed"].includes(op.status)) {
            failed = true;
            // Preserve successful steps. Each retry first reads DNS remote state in OperationProcessor.
            await tx
              .update(operationSteps)
              .set({ status: "pending", nextRetryAt: new Date(), finishedAt: null })
              .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.status, "failed")));
            await tx
              .update(operations)
              .set({ status: "pending", finishedAt: null, errorCode: null, updatedAt: new Date() })
              .where(eq(operations.id, op.id));
          }
        }
        const bad = await tx
          .select({ id: domainBindings.id })
          .from(domainBindings)
          .where(and(eq(domainBindings.poolId, pool.id), ne(domainBindings.state, "healthy")));
        if (bad.length) done = false;
      }
      const now = new Date();
      await tx
        .update(rotationPublications)
        .set({
          children,
          previousMaxTtl: maxTtl,
          status: done ? "applied" : failed ? "failed" : "in_flight",
          operationId: children.find((ch) => ch.operationId)?.operationId ?? null,
          errorCode: !done && failed ? "dns_partial" : null,
          appliedAt: done ? now : null,
          updatedAt: now,
        })
        .where(eq(rotationPublications.id, id));
      if (p.incidentId) {
        await tx
          .update(rotationIncidents)
          .set({ phase: done ? "cleanup" : "publish", errorCode: !done && failed ? "dns_partial" : null, nextRunAt: now, updatedAt: now })
          .where(eq(rotationIncidents.id, p.incidentId));
        if (done) {
          const resources = await tx.select().from(rotationResources).where(eq(rotationResources.incidentId, p.incidentId));
          for (const resource of resources) {
            const releasable =
              resource.address !== c.address!.address &&
              (resource.origin === "system" || c.authorization?.allowReleaseAddress) &&
              (resource.allocationId || (c.instance.service === "ec2" && c.slot.family === "6"));
            if (releasable && resource.cleanupStatus !== "released")
              await tx
                .update(rotationResources)
                .set({
                  cleanupStatus: "pending",
                  cleanupDueAt: new Date(now.getTime() + (maxTtl + 60) * 1000),
                  cleanupAddressVersion: p.addressVersion,
                  referenced: false,
                })
                .where(eq(rotationResources.id, resource.id));
          }
        }
      }
    });
  }
}
