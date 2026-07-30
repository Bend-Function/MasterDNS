import { ConflictException } from "@nestjs/common";
import type { DnsRecordInput } from "@masterdns/contracts";

export function normalizeRecordName(record: DnsRecordInput, zoneName: string): DnsRecordInput {
  const name = record.name.replace(/\.$/, "").toLowerCase();
  const zone = zoneName.replace(/\.$/, "").toLowerCase();
  if (name === "@" || name === zone) return { ...record, name: zone };
  if (name.endsWith(`.${zone}`)) return { ...record, name };
  if (!name.includes(".")) return { ...record, name: `${name}.${zone}` };
  throw new ConflictException("主机记录不属于当前域名");
}
