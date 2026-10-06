import { and, eq, inArray, sql } from "drizzle-orm";
import { operationSteps, operations } from "./schema/index.js";
import type { MasterDnsDatabase } from "./index.js";

/** A failed or partial deletion remains intent to delete until explicitly resolved.
 * Binding state cannot serve as this fence: normal publication also uses switching.
 */
export async function getDeletingBindingIds(reader: Pick<MasterDnsDatabase, "select">, bindingIds: string[]): Promise<Set<string>> {
  if (bindingIds.length === 0) return new Set();
  const rows = await reader.select({ bindingId: operations.resourceId }).from(operations)
    .innerJoin(operationSteps, eq(operationSteps.operationId, operations.id))
    .where(and(
      eq(operations.resourceType, "domain_binding"),
      inArray(operations.resourceId, bindingIds),
      inArray(operations.status, ["pending", "running", "failed", "partial"]),
      eq(operationSteps.action, "delete"),
      sql`${operationSteps.input}->>'deleteBinding' = 'true'`,
      sql`${operationSteps.input}->>'bindingId' = ${operations.resourceId}::text`,
    ));
  return new Set(rows.flatMap(row => row.bindingId ? [row.bindingId] : []));
}
