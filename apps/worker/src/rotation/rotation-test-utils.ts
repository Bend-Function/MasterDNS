import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, vi } from "vitest";
import * as db from "@masterdns/db";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { RotationPublicationService } from "./rotation-publication.service.js";
let admin: ReturnType<typeof db.createDatabase>, connection: ReturnType<typeof db.createDatabase>;
const name = `publication_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  admin = db.createDatabase(root);
  await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root);
  url.pathname = `/${name}`;
  connection = db.createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
});
afterAll(async () => {
  await connection?.close();
  if (admin) {
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
  }
});
export async function fixture(family: "4" | "6" = "4") {
  const d = connection.db;
  const [owner] = await d.insert(db.users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [account] = await d
    .insert(db.cloudAccounts)
    .values({
      ownerUserId: owner!.id,
      provider: "aws",
      name: "test",
      externalAccountId: "123456789012",
      credentialCiphertext: "test",
      credentialIv: "iv",
      credentialTag: "tag",
    })
    .returning();
  await d.insert(db.cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  const [instance] = await d
    .insert(db.cloudInstances)
    .values({
      accountId: account!.id,
      service: "ec2",
      region: "us-east-1",
      externalId: `i-${randomUUID()}`,
      metadata: { present: true },
      scanGeneration: 1,
    })
    .returning();
  const [iface] = await d
    .insert(db.cloudInterfaces)
    .values({ instanceId: instance!.id, externalId: `eni-${randomUUID()}`, scanGeneration: 1 })
    .returning();
  const [address] = await d
    .insert(db.cloudAddresses)
    .values({
      interfaceId: iface!.id,
      family,
      kind: "host",
      address: family === "4" ? "192.0.2.10" : "2001:db8::10",
      origin: "user",
      scanGeneration: 1,
    })
    .returning();
  const [slot] = await d
    .insert(db.managedAddressSlots)
    .values({
      interfaceId: iface!.id,
      family,
      name: "initial",
      currentAddressId: address!.id,
      candidateAddressId: address!.id,
      candidateVersion: 1,
    })
    .returning();
  await d.insert(db.instanceAuthorizations).values({ instanceId: instance!.id, managed: true });
  const [config] = await d
    .insert(db.healthCheckConfigs)
    .values({ slotId: slot!.id, checkerType: "tcp", config: { port: 443 } })
    .returning();
  const [group] = await d.insert(db.probeGroups).values({ ownerUserId: owner!.id, name: "test" }).returning();
  const [policy] = await d
    .insert(db.addressHealthPolicies)
    .values({ slotId: slot!.id, family, configId: config!.id, groupId: group!.id })
    .returning();
  await d
    .insert(db.addressHealthStates)
    .values({
      slotId: slot!.id,
      family,
      addressId: address!.id,
      addressVersion: 1,
      configId: config!.id,
      configVersion: 1,
      policyId: policy!.id,
      policyRevision: 1,
      groupRevision: 1,
      latestDecision: "success",
      healthState: "healthy",
      consecutiveSuccesses: 3,
      lastCheckedAt: new Date(),
      evidenceExpiresAt: new Date(Date.now() + 60000),
    });
  const pools = [];
  const endpoints = [];
  for (let n = 0; n < 2; n++) {
    const [pool] = await d
      .insert(db.endpointPools)
      .values({ ownerUserId: owner!.id, name: `pool-${n}`, strategy: "primary_backup" })
      .returning();
    pools.push(pool!);
    const [endpoint] = await d.insert(db.endpoints).values({ poolId: pool!.id, name: "cloud", addressMode: "cloud" }).returning();
    endpoints.push(endpoint!);
    await d.insert(db.cloudEndpointLinks).values({ endpointId: endpoint!.id, slotId: slot!.id, family });
  }
  const live = {
    ref: { accountId: account!.id, service: "ec2" as const, region: "us-east-1", instanceId: instance!.externalId },
    name: "test",
    state: "running",
    interfaces: [
      { id: iface!.externalId, addresses: [{ address: address!.address, family: Number(family) as 4 | 6, primary: family === "4" }] },
    ],
  };
  const service = new RotationPublicationService({ db: d } as never, { adapter: async () => ({ inspect: async () => live }) } as never);
  return { d, account: account!, instance: instance!, slot: slot!, address: address!, policy: policy!, pools, endpoints, live, service };
}
