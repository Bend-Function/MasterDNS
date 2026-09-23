import { sql } from "drizzle-orm";
import type { RotationTransaction } from "./rotation-context.js";

export async function idleIpReleaseInProgress(tx: RotationTransaction, externalAccountId: string, region: string, exceptBatchId?: string) {
  const rows = await tx.execute(sql`select 1 from cloud_idle_ip_cleanups b, jsonb_array_elements(b.items) item
    where b.external_account_id=${externalAccountId} and (${exceptBatchId ?? null}::uuid is null or b.id<>${exceptBatchId ?? null}::uuid)
    and item->>'region'=${region} and item->>'status' in ('in_flight','pending') limit 1`);
  return rows.length > 0;
}

export async function idleIpAddressReleasing(tx: RotationTransaction, address: string) {
  await lockIdleIpAddress(tx, address);
  const rows = await tx.execute(sql`select 1 from cloud_idle_ip_cleanups b, jsonb_array_elements(b.items) item
    where item->>'address'=${address} and item->>'status' in ('in_flight','pending') limit 1`);
  return rows.length > 0;
}

export async function lockIdleIpAddress(tx: RotationTransaction, address: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${address}, 824715))`);
}
