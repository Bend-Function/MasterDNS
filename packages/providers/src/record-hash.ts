import { createHash } from "node:crypto";
import type { ProviderRecord } from "@masterdns/contracts";

export function providerRecordHash(record: Pick<ProviderRecord, "type" | "name" | "content" | "ttl" | "priority" | "providerMetadata">): string {
  return createHash("sha256").update(stableJson({
    type: record.type,
    name: record.name.toLowerCase().replace(/\.$/, ""),
    content: record.content,
    ttl: record.ttl,
    priority: record.priority ?? null,
    providerMetadata: record.providerMetadata,
  })).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
