import { randomBytes } from "node:crypto";
import { CloudflareDnsAdapter } from "../src/cloudflare.js";

const token = process.env.MASTERDNS_E2E_CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("MASTERDNS_E2E_CLOUDFLARE_API_TOKEN is required");

const adapter = new CloudflareDnsAdapter(token);
const requestedZone = process.env.MASTERDNS_E2E_CLOUDFLARE_ZONE?.trim().toLowerCase();
const zones = await collectPages((cursor) => adapter.listZones(cursor));
const zone = requestedZone
  ? zones.find((item) => item.externalId === requestedZone || item.name.toLowerCase() === requestedZone)
  : zones[0];
if (!zone) throw new Error(requestedZone ? "Requested Cloudflare E2E zone is not visible to the token" : "Cloudflare token has no visible zones");

const label = `masterdns-e2e-${Date.now()}-${randomBytes(3).toString("hex")}`;
const name = `${label}.${zone.name}`;
let recordId: string | undefined;
let testError: unknown;

try {
  await adapter.verifyCredentials();
  const created = await adapter.createRecord(zone.externalId, {
    type: "A",
    name,
    content: "192.0.2.10",
    ttl: 120,
    providerMetadata: { proxied: false, comment: "MasterDNS isolated E2E; safe to delete" },
  });
  recordId = created.externalId;
  assertRecord(await adapter.getRecord(zone.externalId, recordId), "192.0.2.10", "create");

  await adapter.updateRecord(zone.externalId, recordId, {
    type: "A",
    name,
    content: "192.0.2.20",
    ttl: 120,
    providerMetadata: { proxied: false, comment: "MasterDNS isolated E2E; safe to delete" },
  });
  assertRecord(await adapter.getRecord(zone.externalId, recordId), "192.0.2.20", "update");

  await adapter.updateRecord(zone.externalId, recordId, {
    type: "A",
    name,
    content: "192.0.2.10",
    ttl: 120,
    providerMetadata: { proxied: false, comment: "MasterDNS isolated E2E; safe to delete" },
  });
  assertRecord(await adapter.getRecord(zone.externalId, recordId), "192.0.2.10", "rollback");
} catch (error) {
  testError = error;
}

try {
  const records = await collectPages((cursor) => adapter.listRecords(zone.externalId, cursor));
  const cleanupIds = new Set([
    ...(recordId ? [recordId] : []),
    ...records.filter((record) => record.name === name).map((record) => record.externalId),
  ]);
  for (const cleanupId of cleanupIds) {
    await adapter.deleteRecord(zone.externalId, cleanupId);
  }
  const remaining = (await collectPages((cursor) => adapter.listRecords(zone.externalId, cursor)))
    .filter((record) => record.name === name);
  if (remaining.length > 0) {
    throw new Error(`Cloudflare E2E cleanup left ${remaining.length} record(s)`);
  }
} catch (error) {
  throw new Error(`Cloudflare E2E cleanup failed for ${name} in zone ${zone.name}`, { cause: error });
}
if (testError) throw testError;
console.log(JSON.stringify({ success: true, cleanedUp: true, zone: zone.name, record: name, checks: ["create", "read", "update", "rollback", "delete"] }));

function assertRecord(record: Awaited<ReturnType<CloudflareDnsAdapter["getRecord"]>>, expectedContent: string, phase: string) {
  if (!record
    || record.type !== "A"
    || record.name !== name
    || record.content !== expectedContent
    || record.ttl !== 120
    || record.providerMetadata.proxied !== false) {
    throw new Error(`Cloudflare E2E ${phase} verification failed`);
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
