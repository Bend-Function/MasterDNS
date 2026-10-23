import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";

it("upgrades existing policies and incidents with durable bounded failure retries", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  const name = `recovery_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "recovery-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 33) };
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries) await cp(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root);
    url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const sql = connection.client;
    const [owner] = await sql`insert into users (username, password_hash) values (${randomUUID()}, 'test') returning id`;
    const [account] = await sql`insert into cloud_accounts (owner_user_id, provider, name, external_account_id, credential_ciphertext, credential_iv, credential_tag) values (${owner!.id}, 'aws', 'AWS', '123456789012', 'cipher', 'iv', 'tag') returning id`;
    const [instance] = await sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${account!.id}, 'ec2', 'us-east-1', ${`i-${randomUUID()}`}, 1) returning id`;
    const [iface] = await sql`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-test', 1) returning id`;
    const [address] = await sql`insert into cloud_addresses (interface_id, kind, family, address, origin, scan_generation) values (${iface!.id}, 'host', '4', '192.0.2.1', 'user', 1) returning id`;
    const [slot] = await sql`insert into managed_address_slots (interface_id, family, name, current_address_id, current_version) values (${iface!.id}, '4', 'primary', ${address!.id}, 1) returning id`;
    const epoch = [randomUUID(), 1, randomUUID(), 1, randomUUID(), 1] as const;
    const [health] = await sql`insert into rotation_incidents (owner_user_id, slot_id, family, physical_key, source_event_id, current_segment_id, authorization_revision, policy_revision, address_version, health_policy_id, health_policy_revision, config_id, config_revision, group_id, group_revision) values (${owner!.id}, ${slot!.id}, '4', 'physical', 'health-event', ${randomUUID()}, 1, 1, 1, ${epoch[0]}, ${epoch[1]}, ${epoch[2]}, ${epoch[3]}, ${epoch[4]}, ${epoch[5]}) returning id`;
    await sql`update rotation_incidents set status='complete' where id=${health!.id}`;
    const [manual] = await sql`insert into rotation_incidents (owner_user_id, slot_id, family, physical_key, source_event_id, trigger, current_segment_id, authorization_revision, policy_revision, address_version) values (${owner!.id}, ${slot!.id}, '4', 'physical', 'manual-event', 'manual', ${randomUUID()}, 1, 1, 1) returning id`;
    await sql`update rotation_incidents set status='complete' where id=${manual!.id}`;

    await sql`insert into rotation_policies (slot_id, enabled, max_attempts) values (${slot!.id}, true, 7)`;
    await migrate(connection.db, { migrationsFolder: migrations });
    expect(await sql`select enabled, max_attempts, max_recovery_retries from rotation_policies where slot_id=${slot!.id}`)
      .toEqual([{ enabled: true, max_attempts: 7, max_recovery_retries: 5 }]);
    expect(await sql`select recovery_retries, recovery_retry_at, last_recovery_error from rotation_incidents where id=${health!.id}`)
      .toEqual([{ recovery_retries: 0, recovery_retry_at: null, last_recovery_error: null }]);
    for (const limit of [0, 20]) await sql`update rotation_policies set max_recovery_retries=${limit} where slot_id=${slot!.id}`;
    for (const limit of [-1, 21]) await expect(sql`update rotation_policies set max_recovery_retries=${limit} where slot_id=${slot!.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update rotation_incidents set recovery_retries=-1 where id=${health!.id}`).rejects.toMatchObject({ code: "23514" });
    await migrate(connection.db, { migrationsFolder: migrations });
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
