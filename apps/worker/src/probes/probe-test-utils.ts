import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, users, endpointPools, endpoints, endpointAddresses, healthCheckConfigs, probeAgents, probeGroups, probeGroupMembers } from "@masterdns/db";
export async function testDatabase() {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  const admin = createDatabase(root);
  const name = `health_${randomUUID().replaceAll("-", "")}`;
  await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`;
  const connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
  return { ...connection, dispose: async () => { await connection.close(); await admin.client.unsafe(`drop database "${name}"`); await admin.close(); } };
}
export async function fixture(db: ReturnType<typeof createDatabase>["db"], mode: "static" | "ddns" = "static") {
  const [user] = await db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [pool] = await db.insert(endpointPools).values({ ownerUserId: user!.id, name: "pool", strategy: "primary_backup", successThreshold: 2, failureThreshold: 2 }).returning();
  const [endpoint] = await db.insert(endpoints).values({ poolId: pool!.id, name: "target", addressMode: mode }).returning();
  const [address] = await db.insert(endpointAddresses).values({ endpointId: endpoint!.id, family: "4", address: "192.0.2.1", state: mode === "ddns" ? "candidate" : "current", source: mode }).returning();
  const [config] = await db.insert(healthCheckConfigs).values({ endpointId: endpoint!.id, checkerType: "tcp", config: { type: "tcp", port: 443, timeoutMs: 3000 } }).returning();
  const agents = await db.insert(probeAgents).values([1,2].map(i => ({ ownerUserId: user!.id, name: `probe${i}`, capabilities: { ipv4: true, ipv6: true } }))).returning();
  const [group] = await db.insert(probeGroups).values({ ownerUserId: user!.id, name: "group" }).returning();
  await db.insert(probeGroupMembers).values(agents.map(agent => ({ groupId: group!.id, probeId: agent.id })));
  return { actor: { id: user!.id, role: "user" as const }, pool: pool!, endpoint: endpoint!, address: address!, config: config!, group: group!, agents };
}
