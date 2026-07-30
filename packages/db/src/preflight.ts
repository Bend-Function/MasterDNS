import type { createDatabase } from "./index.js";

export type DomainBindingConflict = {
  zoneId: string;
  zoneName: string;
  fqdn: string;
  recordType: string;
  bindingId: string;
  poolId: string;
  poolName: string;
};

type DatabaseClient = ReturnType<typeof createDatabase>["client"];

export async function findDomainBindingConflicts(client: DatabaseClient): Promise<DomainBindingConflict[]> {
  const [table] = await client<{ exists: boolean }[]>`
    select to_regclass('public.domain_bindings') is not null as exists
  `;
  if (!table?.exists) return [];

  const rows = await client<DomainBindingConflict[]>`
    select
      "conflicts"."zone_id"::text as "zoneId",
      "conflicts"."zone_name" as "zoneName",
      "conflicts"."fqdn",
      "conflicts"."record_type" as "recordType",
      "conflicts"."binding_id"::text as "bindingId",
      "conflicts"."pool_id"::text as "poolId",
      "conflicts"."pool_name" as "poolName"
    from (
      select
        "binding"."zone_id",
        "zone"."name_ascii" as "zone_name",
        "binding"."fqdn",
        "binding"."record_type",
        "binding"."id" as "binding_id",
        "binding"."pool_id",
        "pool"."name" as "pool_name",
        count(*) over (partition by "binding"."zone_id", "binding"."fqdn", "binding"."record_type") as "conflict_size"
      from "domain_bindings" as "binding"
      inner join "zones" as "zone" on "zone"."id" = "binding"."zone_id"
      inner join "endpoint_pools" as "pool" on "pool"."id" = "binding"."pool_id"
    ) as "conflicts"
    where "conflicts"."conflict_size" > 1
    order by "conflicts"."zone_name", "conflicts"."fqdn", "conflicts"."record_type", "conflicts"."pool_name", "conflicts"."binding_id"
  `;
  return [...rows];
}

export function formatDomainBindingConflicts(conflicts: DomainBindingConflict[]): string {
  if (conflicts.length === 0) return "Migration preflight passed: no cross-Pool DNS binding conflicts found.";
  const groups = new Set(conflicts.map((conflict) => `${conflict.zoneId}\u0000${conflict.fqdn}\u0000${conflict.recordType}`));
  return [
    `Migration preflight failed: ${groups.size} conflicting zone/name/type group(s) found.`,
    ...conflicts.map((conflict) => [
      `- zone=${conflict.zoneName} (${conflict.zoneId})`,
      `record=${conflict.fqdn} ${conflict.recordType}`,
      `binding=${conflict.bindingId}`,
      `pool=${conflict.poolName} (${conflict.poolId})`,
    ].join("; ")),
    "Keep exactly one binding for each zone/name/type combination, then run the preflight again.",
  ].join("\n");
}
