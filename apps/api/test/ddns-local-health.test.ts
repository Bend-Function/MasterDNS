import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { HealthCheckJob } from "@masterdns/contracts";
import { hashToken } from "@masterdns/crypto";
import * as db from "@masterdns/db";
import { DdnsService } from "../src/modules/ddns/ddns.service.js";
import { fixture, testDatabase } from "../../worker/src/probes/probe-test-utils.js";
import { HealthResultService } from "../../worker/src/health/health-result.service.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
beforeAll(async () => {
  connection = await testDatabase();
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
}, 30_000);
afterAll(async () => {
  await redis?.quit();
  await connection?.dispose();
});

async function setup() {
  const d = connection.db;
  const f = await fixture(d, "ddns");
  await d.update(db.endpointAddresses).set({ state: "current" }).where(eq(db.endpointAddresses.id, f.address.id));
  const [poolConfig] = await d.insert(db.healthCheckConfigs).values({ poolId: f.pool.id, checkerType: "tcp", config: f.config.config }).returning();
  const token = randomUUID();
  await d.insert(db.ddnsAgents).values({ endpointId: f.endpoint.id, runtimeTokenHash: hashToken(token), status: "active" });
  const health = new Queue<HealthCheckJob>("health", { connection: redis, prefix: `ddns-local-test-${randomUUID()}` });
  const database = { db: d } as never;
  const service = new DdnsService(database, { health } as never);
  const results = new HealthResultService(database);
  return {
    ...f, poolConfig: poolConfig!, health, service, authorization: `Bearer ${token}`,
    async applyQueuedSuccesses() {
      for (const job of await health.getWaiting()) {
        const [config] = await d.select().from(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, job.data.configId));
        await results.apply({ addressId: job.data.addressId!, addressVersion: 1, configId: config!.id, configVersion: config!.revision, decision: "success", checkedAt: new Date() });
        await job.remove();
      }
    },
    async dispose() {
      await health.obliterate({ force: true });
      await health.close();
    },
  };
}

it.each(["4", "6"] as const)("promotes a family %s candidate using the explicitly selected pool check despite an endpoint check", async family => {
  const f = await setup();
  const address = family === "4" ? "192.0.2.10" : "2001:db8::10";
  await connection.db.insert(db.addressHealthPolicies).values({ endpointId: f.endpoint.id, family, mode: "local", configId: f.poolConfig.id, successThreshold: 2 });
  try {
    for (let i = 0; i < 2; i++) {
      await f.service.heartbeat(f.authorization, family === "4" ? { ipv4: address } : { ipv6: address }, address);
      await f.applyQueuedSuccesses();
    }
    const [candidate] = await connection.db.select().from(db.endpointAddresses).where(and(eq(db.endpointAddresses.endpointId, f.endpoint.id), eq(db.endpointAddresses.address, address)));
    expect(candidate).toMatchObject({ state: "current", healthState: "healthy", consecutiveSuccesses: 2 });
    expect(await connection.db.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.addressId, candidate!.id))).toMatchObject([{ configId: f.poolConfig.id, consecutiveSuccesses: 2 }]);
    expect(await connection.db.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.endpointId, f.endpoint.id))).toMatchObject([{ source: "ddns", trigger: "repair" }]);
  } finally {
    await f.dispose();
  }
});

it.each([true, false])("retains no-policy fallback and promotion with endpoint check enabled=%s", async endpointEnabled => {
  const f = await setup();
  await connection.db.update(db.healthCheckConfigs).set({ enabled: endpointEnabled }).where(eq(db.healthCheckConfigs.id, f.config.id));
  try {
    for (let i = 0; i < 2; i++) {
      expect(await f.service.heartbeat(f.authorization, { ipv4: "192.0.2.10" }, "192.0.2.10")).toMatchObject({ queuedChecks: 1 });
      expect((await f.health.getWaiting()).map(job => job.data.configId)).toEqual([endpointEnabled ? f.config.id : f.poolConfig.id]);
      await f.applyQueuedSuccesses();
    }
    expect(await connection.db.select().from(db.endpointAddresses).where(and(eq(db.endpointAddresses.endpointId, f.endpoint.id), eq(db.endpointAddresses.state, "current")))).toMatchObject([{ address: "192.0.2.10", healthState: "healthy" }]);
  } finally {
    await f.dispose();
  }
});

it.each(["external", "mixed"] as const)("leaves %s candidates to probe consensus while checking the other local family", async mode => {
  const f = await setup();
  await connection.db.insert(db.addressHealthPolicies).values([
    { endpointId: f.endpoint.id, family: "4", mode, groupId: f.group.id, configId: f.config.id },
    { endpointId: f.endpoint.id, family: "6", mode: "local", configId: f.poolConfig.id, successThreshold: 1 },
  ]);
  try {
    const response = await f.service.heartbeat(f.authorization, { ipv4: "192.0.2.10", ipv6: "2001:db8::10" }, "192.0.2.10");
    expect(response).toMatchObject({ accepted: true, queuedChecks: 1 });
    const jobs = await f.health.getWaiting();
    expect(jobs.map(job => job.data.configId)).toEqual([f.poolConfig.id]);
    await f.applyQueuedSuccesses();
    const addresses = await connection.db.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, f.endpoint.id));
    expect(addresses.find(address => address.address === "192.0.2.10")).toMatchObject({ state: "candidate", consecutiveSuccesses: 0 });
    expect(addresses.find(address => address.address === "2001:db8::10")).toMatchObject({ state: "current", healthState: "healthy" });
  } finally {
    await f.dispose();
  }
});

it("does not fall back to an endpoint check when the selected local pool check is disabled", async () => {
  const f = await setup();
  await connection.db.insert(db.addressHealthPolicies).values({ endpointId: f.endpoint.id, family: "4", mode: "local", configId: f.poolConfig.id });
  await connection.db.update(db.healthCheckConfigs).set({ enabled: false }).where(eq(db.healthCheckConfigs.id, f.poolConfig.id));
  try {
    await expect(f.service.heartbeat(f.authorization, { ipv4: "192.0.2.10" }, "192.0.2.10")).rejects.toThrow("DDNS 候选地址没有可用的节点或 Pool 健康检查");
    expect(await f.health.getWaiting()).toEqual([]);
  } finally {
    await f.dispose();
  }
});
