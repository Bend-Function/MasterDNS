import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";

it("preserves existing endpoint evidence and sequence fences while allowing separate candidate health", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  const name = `health_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "health-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 20);
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) await cp(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root); url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const sql = connection.client;
    const [owner] = await sql`insert into users (username, password_hash) values (${randomUUID()}, 'test') returning id`;
    const [pool] = await sql`insert into endpoint_pools (owner_user_id, name, strategy) values (${owner!.id}, 'pool', 'primary_backup') returning id`;
    const [endpoint] = await sql`insert into endpoints (pool_id, name, address_mode) values (${pool!.id}, 'DDNS', 'ddns') returning id`;
    const [current] = await sql`insert into endpoint_addresses (endpoint_id, family, address, state, source) values (${endpoint!.id}, '4', '192.0.2.1', 'current', 'ddns') returning id`;
    const [candidate] = await sql`insert into endpoint_addresses (endpoint_id, family, address, state, source) values (${endpoint!.id}, '4', '192.0.2.2', 'candidate', 'ddns') returning id`;
    const [state] = await sql`insert into address_health_states (endpoint_id, family, address_id, address_version, health_state, consecutive_successes, last_applied_sequence) values (${endpoint!.id}, '4', ${current!.id}, 1, 'healthy', 3, 42) returning *`;
    const [sequence] = await sql`insert into probe_round_sequences (endpoint_id, family, last_sequence) values (${endpoint!.id}, '4', 44) returning *`;
    await expect(sql`insert into address_health_states (endpoint_id, family, address_id) values (${endpoint!.id}, '4', ${candidate!.id})`).rejects.toMatchObject({ code: "23505" });

    await migrate(connection.db, { migrationsFolder: migrations });
    expect((await sql`select * from address_health_states where id=${state!.id}`)[0]).toEqual(state);
    expect((await sql`select * from probe_round_sequences where id=${sequence!.id}`)[0]).toEqual(sequence);
    await sql`insert into address_health_states (endpoint_id, family, address_id, health_state) values (${endpoint!.id}, '4', ${candidate!.id}, 'unhealthy')`;
    expect(await sql`select id from address_health_states where endpoint_id=${endpoint!.id}`).toHaveLength(2);
    await expect(sql`insert into address_health_states (endpoint_id, family, address_id) values (${endpoint!.id}, '4', ${candidate!.id})`).rejects.toMatchObject({ code: "23505" });
    await migrate(connection.db, { migrationsFolder: migrations });
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
