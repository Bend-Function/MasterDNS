import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CloudLifecycleAction, CloudLifecycleOperation, CloudPowerState, CloudTrafficStopPolicy } from "@masterdns/contracts";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInstanceControls, cloudInterfaces, cloudLifecycleOperations, cloudScanScopes, cloudTrafficStopPolicies, instanceAuthorizations, managedAddressSlots, rotationLeases, users } from "./schema/index.js";
import { lockIdleIpAddress } from "./idle-ip-guards.js";
import type { RotationTransaction } from "./rotation-context.js";
export const lifecycleActiveStatuses = ["queued", "in_flight", "unknown"] as const;
export type LifecycleOperationRow = typeof cloudLifecycleOperations.$inferSelect;
export function lifecycleReached(action: CloudLifecycleAction, state: CloudPowerState) { return state === (action === "start" ? "running" : action === "stop" ? "stopped" : "deleted"); }
export function trafficStopUsage(traffic: { month?: string; totalBytes?: number | null; outgoingBytes?: number | null }, direction: "total" | "outgoing", now: Date): number | null {
  const value = direction === "total" ? traffic.totalBytes : traffic.outgoingBytes;
  return traffic.month === now.toISOString().slice(0, 7) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function cloudCredentialFingerprint(account: typeof cloudAccounts.$inferSelect) { return createHash("sha256").update(JSON.stringify([account.credentialCiphertext, account.credentialIv, account.credentialTag, account.credentialKeyVersion])).digest("hex"); }
export function publicLifecycleOperation(row: LifecycleOperationRow): CloudLifecycleOperation {
  return { id: row.id, instanceId: row.instanceId, action: row.action, source: row.source, status: row.status, errorCode: row.errorCode, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), dispatchedAt: row.dispatchedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null, nextRunAt: row.nextRunAt.toISOString() };
}
export function publicTrafficPolicy(instanceId: string, row?: typeof cloudTrafficStopPolicies.$inferSelect): CloudTrafficStopPolicy {
  return { instanceId, revision: row?.revision ?? 0, enabled: row?.enabled ?? false, thresholdBytes: row?.thresholdBytes ?? null, direction: row?.direction ?? "total", checkIntervalSeconds: row?.checkIntervalSeconds ?? 3600, month: row?.month ?? null, lastUsageBytes: row?.lastUsageBytes ?? null, lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null, lastError: row?.lastError ?? null, triggeredAt: row?.triggeredAt?.toISOString() ?? null };
}
/** Shared physical serialization. Lock account -> instance -> slots -> physical lease. */
export async function lockCloudLifecycleContext(tx: RotationTransaction, instanceId: string) {
  const [identity] = await tx.select({ accountId: cloudInstances.accountId }).from(cloudInstances).where(eq(cloudInstances.id, instanceId));
  if (!identity) throw new Error("resource_not_found");
  const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, identity.accountId)).for("update");
  const [instance] = await tx.select().from(cloudInstances).where(eq(cloudInstances.id, instanceId)).for("update");
  if (!account || !instance) throw new Error("resource_not_found");
  const slots = await tx.select({ slot: managedAddressSlots }).from(managedAddressSlots).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId)).where(eq(cloudInterfaces.instanceId, instanceId)).orderBy(managedAddressSlots.id).for("update", { of: managedAddressSlots });
  const [authorization] = await tx.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, instanceId)).for("share");
  const [scope] = await tx.select().from(cloudScanScopes).where(and(eq(cloudScanScopes.accountId, account.id), eq(cloudScanScopes.service, instance.service), eq(cloudScanScopes.region, instance.region)));
  const physicalKey = JSON.stringify([account.provider, account.externalAccountId, instance.service, instance.region, instance.externalId]);
  await tx.insert(rotationLeases).values({ physicalKey }).onConflictDoNothing();
  const [lease] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, physicalKey)).for("update");
  return { account, instance, authorization, scope, slots: slots.map(s => s.slot), physicalKey, lease: lease! };
}
export type CloudLifecycleContext = Awaited<ReturnType<typeof lockCloudLifecycleContext>>;
export function lifecycleAuthorizationError(c: CloudLifecycleContext, action: CloudLifecycleAction): string | null {
  if (!c.account.enabled || !c.account.externalAccountId || !c.authorization?.managed || !(action === "delete" ? c.authorization.allowDelete : c.authorization.allowStopStart)) return "authorization_revoked";
  if (!c.scope || (c.account.regions !== null && !c.account.regions.includes(c.instance.region))) return "region_excluded";
  if (c.instance.metadata.present === false) return "resource_not_found";
  return null;
}
export async function lifecycleActorAuthorized(tx: RotationTransaction, actorUserId: string, ownerUserId: string) {
  const [actor] = await tx.select().from(users).where(eq(users.id, actorUserId));
  return !!actor && actor.status === "active" && (actor.role === "admin" || actor.id === ownerUserId);
}
export async function instanceLifecycleBlocksRotation(tx: RotationTransaction, physicalKey: string): Promise<boolean> {
  const [control] = await tx.select().from(cloudInstanceControls).where(eq(cloudInstanceControls.physicalKey, physicalKey));
  if (control?.powerHold) return true;
  const [active] = await tx.select({ id: cloudLifecycleOperations.id }).from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.physicalKey, physicalKey), inArray(cloudLifecycleOperations.status, [...lifecycleActiveStatuses]))).limit(1);
  return !!active;
}
export async function instanceLifecycleAddressDeleting(tx: RotationTransaction, address: string): Promise<boolean> {
  await lockIdleIpAddress(tx, address);
  const rows = await tx.execute(sql`select 1 from cloud_lifecycle_operations o, jsonb_array_elements_text(o.protected_addresses) a where o.action='delete' and o.status in ('queued','in_flight','unknown') and a::inet=${address}::inet limit 1`);
  return rows.length > 0;
}
/** Includes account aliases and all known references, not only this local inventory. */
export async function lifecycleDeleteProtection(tx: RotationTransaction, c: CloudLifecycleContext): Promise<{ addresses: string[]; reason: string | null }> {
  const aliases = await tx.select({ id: cloudInstances.id }).from(cloudInstances).innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId)).where(and(eq(cloudAccounts.provider, c.account.provider), eq(cloudAccounts.externalAccountId, c.account.externalAccountId!), eq(cloudInstances.service, c.instance.service), eq(cloudInstances.region, c.instance.region), eq(cloudInstances.externalId, c.instance.externalId)));
  const ids = aliases.map(a => a.id);
  const rows = await tx.select({ address: cloudAddresses.address }).from(cloudAddresses).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, cloudAddresses.interfaceId)).where(and(inArray(cloudInterfaces.instanceId, ids), eq(cloudAddresses.kind, "host")));
  const addresses = [...new Set(rows.map(a => a.address))].sort();
  for (const address of addresses) await lockIdleIpAddress(tx, address);
  const linked = await tx.execute(sql`select 1 from cloud_endpoint_links l join managed_address_slots s on s.id=l.slot_id join cloud_interfaces i on i.id=s.interface_id where i.instance_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) limit 1`);
  if (linked.length) return { addresses, reason: "instance_has_bindings" };
  const active = await tx.execute(sql`select 1 from rotation_incidents where physical_key=${c.physicalKey} and status<>'complete' limit 1`);
  if (active.length || c.lease.unresolvedStepId || (c.lease.holder && c.lease.expiresAt > new Date())) return { addresses, reason: "rotation_in_progress" };
  for (const address of addresses) {
    const refs = await tx.execute(sql`select 1 from endpoint_addresses where address::inet=${address}::inet and state in ('current','candidate') union all select 1 from dns_records where deleted_at is null and type in ('A','AAAA') and case when pg_input_is_valid(content, 'inet') then content::inet=${address}::inet else false end union all select 1 from operation_steps where status in ('pending','running') and action in ('create','update') and case when pg_input_is_valid(input->'record'->>'content', 'inet') then (input->'record'->>'content')::inet=${address}::inet else false end limit 1`);
    if (refs.length) return { addresses, reason: "address_has_references" };
    const cleanup = await tx.execute(sql`select 1 from cloud_idle_ip_cleanups b, jsonb_array_elements(b.items) item where item->>'address'=${address} and item->>'status' in ('pending','in_flight') union all select 1 from rotation_resources r left join rotation_steps s on s.id=r.cleanup_step_id where r.address::inet=${address}::inet and (r.cleanup_status in ('pending','failed') or s.status in ('in_flight','pending','ambiguous')) limit 1`);
    if (cleanup.length) return { addresses, reason: "address_cleanup_pending" };
  }
  return { addresses, reason: null };
}
/** Every local alias contributes an enabled policy; another account entry cannot bypass a stop limit. */
export async function lifecycleTrafficPolicies(tx: RotationTransaction, c: Pick<CloudLifecycleContext, "account" | "instance">) {
  const rows = await tx.select({ policy: cloudTrafficStopPolicies }).from(cloudTrafficStopPolicies).innerJoin(cloudInstances, eq(cloudInstances.id, cloudTrafficStopPolicies.instanceId)).innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId)).where(and(eq(cloudTrafficStopPolicies.enabled, true), eq(cloudAccounts.provider, c.account.provider), eq(cloudAccounts.externalAccountId, c.account.externalAccountId!), eq(cloudInstances.service, c.instance.service), eq(cloudInstances.region, c.instance.region), eq(cloudInstances.externalId, c.instance.externalId))).orderBy(cloudTrafficStopPolicies.instanceId);
  return rows.map(r => r.policy);
}
