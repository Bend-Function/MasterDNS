import type { DnsRecordInput } from "@masterdns/contracts";
import { normalizeAliyunStatusForComparison } from "./record-hash.js";

export type ComparableDnsRecord = {
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number | null | undefined;
  providerMetadata: Record<string, unknown>;
};

export function dnsRecordMatches(actual: ComparableDnsRecord, expected: DnsRecordInput): boolean {
  const expectedTtl = expected.providerMetadata.proxied === true ? 1 : expected.ttl;
  if (actual.type !== expected.type
    || normalizeName(actual.name) !== normalizeName(expected.name)
    || actual.content !== expected.content
    || actual.ttl !== expectedTtl
    || (actual.priority ?? null) !== (expected.priority ?? null)) return false;
  return Object.entries(expected.providerMetadata)
    .every(([key, value]) => value === undefined || providerMetadataEqual(key, actual.providerMetadata[key], value));
}

function providerMetadataEqual(key: string, actual: unknown, expected: unknown): boolean {
  if (key === "status" && typeof actual === "string" && typeof expected === "string") {
    const normalizedActual = normalizeAliyunStatusForComparison(actual);
    const normalizedExpected = normalizeAliyunStatusForComparison(expected);
    if (normalizedActual !== undefined || normalizedExpected !== undefined) return normalizedActual === normalizedExpected;
  }
  return deepEqual(actual, expected);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightEntries = Object.entries(right as Record<string, unknown>);
    return leftEntries.length === rightEntries.length
      && leftEntries.every(([key, value]) => deepEqual(value, (right as Record<string, unknown>)[key]));
  }
  return false;
}
