import { isDeepStrictEqual } from "node:util";

export type DnsOperationStepIdentity = {
  providerAccountId: string;
  zoneId: string;
  dnsRecordId?: string | null | undefined;
  action: "create" | "update" | "delete";
  input: unknown;
};

export function sameDnsOperationRequest(existing: DnsOperationStepIdentity, expected: DnsOperationStepIdentity): boolean {
  return existing.providerAccountId === expected.providerAccountId
    && existing.zoneId === expected.zoneId
    && existing.action === expected.action
    && (expected.action === "create" || (existing.dnsRecordId ?? null) === (expected.dnsRecordId ?? null))
    && isDeepStrictEqual(existing.input, expected.input);
}
