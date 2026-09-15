import { isIP } from "node:net";
import { and, desc, eq, isNull } from "drizzle-orm";
import { bindingAssignments, cloudAddresses, cloudEndpointLinks, dnsRecords, domainBindings, endpointPools, endpoints, lockRotationContext, lockRotationHealth, rotationAttempts, rotationIncidents, rotationStepObservations, rotationSteps, type RotationTransaction } from "@masterdns/db";

// Only public address values leave this query. SDK receipts and probe config (which
// can contain authorization headers) never become API display objects.
export async function rotationDisplay(tx: RotationTransaction, slotId: string) {
  const c = await lockRotationContext(tx, slotId); const h = await lockRotationHealth(tx, c);
  const hosts = await tx.select().from(cloudAddresses).where(and(eq(cloudAddresses.interfaceId, c.slot.interfaceId), eq(cloudAddresses.kind, "host"), eq(cloudAddresses.family, c.slot.family)));
  const current = hosts.find(a => a.id === c.slot.currentAddressId);
  const candidate = hosts.find(a => a.id === c.slot.candidateAddressId);
  const inventoryAt = c.iface?.lastSeenAt ?? null;
  let observedCloud: { addresses: string[]; observedAt: Date | null; source: "rotation_observation" | "inventory" } = {
    addresses: hosts.filter(a => a.scanGeneration === c.instance.scanGeneration && !!inventoryAt && a.lastSeenAt >= inventoryAt).map(a => a.address), observedAt: inventoryAt, source: "inventory",
  };
  const observations = await tx.select({ result: rotationStepObservations.result, createdAt: rotationStepObservations.createdAt }).from(rotationStepObservations)
    .innerJoin(rotationSteps, eq(rotationSteps.id, rotationStepObservations.stepId)).innerJoin(rotationAttempts, eq(rotationAttempts.id, rotationSteps.attemptId)).innerJoin(rotationIncidents, eq(rotationIncidents.id, rotationAttempts.incidentId))
    .where(and(eq(rotationIncidents.slotId, slotId), eq(rotationStepObservations.observation, true))).orderBy(desc(rotationStepObservations.createdAt)).limit(20);
  for (const observation of observations) {
    if (inventoryAt && observation.createdAt <= inventoryAt) break;
    const addresses = observedHosts(observation.result.after, Number(c.slot.family));
    if (addresses) { observedCloud = { addresses, observedAt: observation.createdAt, source: "rotation_observation" }; break; }
  }
  const rows = await tx.select({ id: dnsRecords.id, zoneId: dnsRecords.zoneId, fqdn: domainBindings.fqdn, recordType: dnsRecords.type, address: dnsRecords.content, applied: bindingAssignments.applied, lastObservedAt: dnsRecords.lastSyncedAt }).from(cloudEndpointLinks)
    .innerJoin(endpoints, eq(endpoints.id, cloudEndpointLinks.endpointId)).innerJoin(endpointPools, eq(endpointPools.id, endpoints.poolId))
    .innerJoin(domainBindings, eq(domainBindings.poolId, endpoints.poolId))
    .innerJoin(dnsRecords, and(eq(dnsRecords.zoneId, domainBindings.zoneId), eq(dnsRecords.name, domainBindings.fqdn), eq(dnsRecords.type, domainBindings.recordType)))
    .leftJoin(bindingAssignments, and(eq(bindingAssignments.domainBindingId, domainBindings.id), eq(bindingAssignments.dnsRecordId, dnsRecords.id)))
    .where(and(eq(cloudEndpointLinks.slotId, slotId), eq(endpointPools.ownerUserId, c.account.ownerUserId), eq(dnsRecords.type, c.slot.family === "4" ? "A" : "AAAA"), isNull(dnsRecords.deletedAt)));
  const published = new Map<string, { zoneId: string; fqdn: string; recordType: string; address: string; status: "applied" | "observed"; lastObservedAt: Date }>();
  for (const row of rows) {
    const previous = published.get(row.id);
    published.set(row.id, { zoneId: row.zoneId, fqdn: row.fqdn, recordType: row.recordType, address: row.address, status: row.applied || previous?.status === "applied" ? "applied" : "observed", lastObservedAt: row.lastObservedAt });
  }
  return { instanceId: c.instance.id, addresses: {
    observedCloud,
    candidate: candidate ? { id: candidate.id, address: candidate.address, version: c.slot.candidateVersion, verified: h.success } : null,
    lastVerified: current && c.slot.currentVersion > 0 ? { id: current.id, address: current.address, version: c.slot.currentVersion } : null,
    published: [...published.values()],
  } };
}
function observedHosts(after: unknown, family: number): string[] | undefined {
  if (!after || typeof after !== "object") return undefined;
  const snapshot = after as Record<string, unknown>;
  const value = family === 4 ? snapshot.ipv4 : snapshot.ipv6;
  if (typeof value === "string") return isIP(value) === family ? [value] : [];
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(item => {
    if (typeof item === "string") return isIP(item) === family ? [item] : [];
    if (!item || typeof item !== "object") return [];
    const host = family === 4 ? (item as { Association?: { PublicIp?: unknown } }).Association?.PublicIp : (item as { Ipv6Address?: unknown }).Ipv6Address;
    return typeof host === "string" && isIP(host) === family ? [host] : [];
  });
}
