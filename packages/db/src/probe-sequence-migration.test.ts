import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase, users, endpointPools, endpoints, endpointAddresses, healthCheckConfigs, probeRounds, probeRoundSequences, cloudAccounts, cloudInstances, cloudInterfaces, managedAddressSlots } from "./index.js";

it("backfills retained endpoint/family and slot sequence maxima when upgrading P5", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  const name = `probe_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "probe-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    await cp(migrations, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 15);
    await writeFile(journalPath, JSON.stringify(journal));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root); url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const db = connection.db;
    const [user] = await db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
    const [pool] = await db.insert(endpointPools).values({ ownerUserId: user!.id, name: "Pool", strategy: "primary_backup" }).returning();
    const [endpoint] = await db.insert(endpoints).values({ poolId: pool!.id, name: "Endpoint" }).returning();
    const [v4] = await db.insert(endpointAddresses).values({ endpointId: endpoint!.id, family: "4", address: "192.0.2.1", state: "current", source: "static" }).returning();
    const [v6] = await db.insert(endpointAddresses).values({ endpointId: endpoint!.id, family: "6", address: "2001:db8::1", state: "current", source: "static" }).returning();
    const config = { type: "tcp" as const, port: 443, timeoutMs: 3000 };
    const [check] = await db.insert(healthCheckConfigs).values({ endpointId: endpoint!.id, checkerType: "tcp", config }).returning();
    const [account] = await db.insert(cloudAccounts).values({ ownerUserId: user!.id, name: "AWS", provider: "aws", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag" }).returning();
    const [instance] = await db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: "i-test", scanGeneration: 1 }).returning();
    const [iface] = await db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-test", scanGeneration: 1 }).returning();
    const [slot] = await db.insert(managedAddressSlots).values({ interfaceId: iface!.id, name: "public", family: "4" }).returning();
    const [slotCheck] = await db.insert(healthCheckConfigs).values({ slotId: slot!.id, checkerType: "tcp", config }).returning();
    const base = { configId: check!.id, addressVersion: 1, configVersion: 1, config, memberIds: [randomUUID()], consensus: { mode: "all" as const, minimumValid: 1 }, deadline: new Date(), resultExpiresAt: new Date(Date.now()+60000) };
    await db.insert(probeRounds).values([
      { ...base, endpointId: endpoint!.id, endpointAddressId: v4!.id, family: "4", address: v4!.address, sequence: 4 },
      { ...base, endpointId: endpoint!.id, endpointAddressId: v4!.id, family: "4", address: v4!.address, sequence: 8 },
      { ...base, endpointId: endpoint!.id, endpointAddressId: v6!.id, family: "6", address: v6!.address, sequence: 3 },
      { ...base, configId: slotCheck!.id, slotId: slot!.id, family: "4", address: "192.0.2.2", sequence: 9 },
    ]);
    await migrate(db, { migrationsFolder: migrations });
    const counters = await db.select().from(probeRoundSequences);
    expect(counters).toHaveLength(3);
    expect(counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpointId: endpoint!.id, slotId: null, family: "4", lastSequence: 8 }),
      expect.objectContaining({ endpointId: endpoint!.id, slotId: null, family: "6", lastSequence: 3 }),
      expect.objectContaining({ endpointId: null, slotId: slot!.id, family: "4", lastSequence: 9 }),
    ]));
    await migrate(db, { migrationsFolder: migrations });
    expect(await db.select().from(probeRoundSequences)).toHaveLength(3);
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
