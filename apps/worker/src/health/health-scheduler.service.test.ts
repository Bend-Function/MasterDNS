import { describe, expect, it } from "vitest";
import { buildScheduledHealthJobs } from "./health-scheduler.service.js";

describe("health scheduler address fan-out", () => {
  const targets = [
    { endpointId: "endpoint-1", poolId: "pool-1", intervalSeconds: 15, addressId: "address-v4", family: "4" as const },
    { endpointId: "endpoint-1", poolId: "pool-1", intervalSeconds: 15, addressId: "address-v6", family: "6" as const },
  ];
  const configs = [
    { id: "pool-check", poolId: "pool-1", endpointId: null, domainBindingId: null },
    { id: "a-check", poolId: null, endpointId: null, domainBindingId: "binding-a" },
    { id: "aaaa-check", poolId: null, endpointId: null, domainBindingId: "binding-aaaa" },
  ];
  const bindings = [
    { id: "binding-a", poolId: "pool-1", recordType: "A" as const },
    { id: "binding-aaaa", poolId: "pool-1", recordType: "AAAA" as const },
  ];

  it("checks every current address for a pool-level config", () => {
    const jobs = buildScheduledHealthJobs(targets, configs, bindings).map((item) => item.data);
    expect(jobs.filter((job) => job.configId === "pool-check")).toEqual([
      { endpointId: "endpoint-1", configId: "pool-check", addressId: "address-v4" },
      { endpointId: "endpoint-1", configId: "pool-check", addressId: "address-v6" },
    ]);
  });

  it("runs binding checks only against the matching DNS address family", () => {
    const jobs = buildScheduledHealthJobs(targets, configs, bindings).map((item) => item.data);
    expect(jobs.find((job) => job.configId === "a-check")).toMatchObject({ bindingId: "binding-a", addressId: "address-v4" });
    expect(jobs.find((job) => job.configId === "aaaa-check")).toMatchObject({ bindingId: "binding-aaaa", addressId: "address-v6" });
    expect(jobs.filter((job) => job.configId === "a-check" || job.configId === "aaaa-check")).toHaveLength(2);
  });
});
it("suppresses external and mixed base jobs while retaining local family and binding checks", () => {
  const targets = ["4", "6"].map(family => ({ endpointId: "e", poolId: "p", addressId: `a${family}`, family: family as "4" | "6", intervalSeconds: 15 }));
  const configs = [{ id: "base", poolId: "p", endpointId: null, domainBindingId: null }, { id: "binding", poolId: null, endpointId: null, domainBindingId: "b" }];
  const jobs = buildScheduledHealthJobs(targets, configs, [{ id: "b", poolId: "p", recordType: "A" }], [{ endpointId: "e", family: "4", mode: "mixed" }]);
  expect(jobs.map(j => j.data.configId)).toEqual(["binding", "base"]);
});
it("uses the selected local policy config and interval", () => {
  const jobs = buildScheduledHealthJobs([{ endpointId: "e", poolId: "p", addressId: "a", family: "4", intervalSeconds: 15 }], [{ id: "pool", poolId: "p", endpointId: null, domainBindingId: null }, { id: "endpoint", poolId: null, endpointId: "e", domainBindingId: null }], [], [{ endpointId: "e", family: "4", mode: "local", configId: "pool", checkIntervalSeconds: 30 }]);
  expect(jobs).toEqual([{ data: { endpointId: "e", configId: "pool", addressId: "a" }, intervalSeconds: 30 }]);
});
