import { describe, expect, it } from "vitest";
import { formatDomainBindingConflicts, type DomainBindingConflict } from "./preflight.js";

const conflicts: DomainBindingConflict[] = [
  {
    zoneId: "zone-1",
    zoneName: "example.com",
    fqdn: "www.example.com",
    recordType: "A",
    bindingId: "binding-1",
    poolId: "pool-1",
    poolName: "Primary",
  },
  {
    zoneId: "zone-1",
    zoneName: "example.com",
    fqdn: "www.example.com",
    recordType: "A",
    bindingId: "binding-2",
    poolId: "pool-2",
    poolName: "Secondary",
  },
];

describe("migration preflight report", () => {
  it("passes when there are no conflicts", () => {
    expect(formatDomainBindingConflicts([])).toContain("preflight passed");
  });

  it("reports every conflicting binding without choosing one to delete", () => {
    const report = formatDomainBindingConflicts(conflicts);
    expect(report).toContain("1 conflicting zone/name/type group(s)");
    expect(report).toContain("binding=binding-1");
    expect(report).toContain("binding=binding-2");
    expect(report).toContain("pool=Primary (pool-1)");
    expect(report).toContain("Keep exactly one binding");
  });
});
