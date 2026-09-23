import { sql } from "drizzle-orm";
import type { RotationTransaction } from "./rotation-context.js";
import { instanceLifecycleAddressDeleting } from "./cloud-lifecycle.js";

export async function idleIpReleaseInProgress(tx: RotationTransaction, externalAccountId: string, region: string, exceptBatchId?: string) {
  const rows = await tx.execute(sql`select 1 from cloud_idle_ip_cleanups b, jsonb_array_elements(b.items) item
    where b.external_account_id=${externalAccountId} and (${exceptBatchId ?? null}::uuid is null or b.id<>${exceptBatchId ?? null}::uuid)
    and item->>'region'=${region} and item->>'status' in ('in_flight','pending') limit 1`);
  return rows.length > 0;
}

export async function idleIpAddressReleasing(tx: RotationTransaction, address: string) {
  await lockIdleIpAddress(tx, address);
  if (await instanceLifecycleAddressDeleting(tx, address)) return true;
  const rows = await tx.execute(sql`select 1 from cloud_idle_ip_cleanups b, jsonb_array_elements(b.items) item
    where item->>'address'=${address} and item->>'status' in ('in_flight','pending') limit 1`);
  if (rows.length) return true;
  const rotations = await tx.execute(sql`select 1 from rotation_resources r
    join rotation_steps s on s.id=r.cleanup_step_id
    where r.address::inet=${address}::inet and s.status in ('in_flight','pending','ambiguous') limit 1`);
  return rotations.length > 0;
}

export async function lockIdleIpAddress(tx: RotationTransaction, address: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(host(${address}::inet), 824715))`);
}
