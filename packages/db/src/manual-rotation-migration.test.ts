import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";

it("upgrades existing health incidents and enforces trigger-specific epochs", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  const name = `manual_rotation_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "manual-rotation-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 21) };
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries) await cp(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root); url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const sql = connection.client;
    const [owner] = await sql`insert into users (username, password_hash) values (${randomUUID()}, 'test') returning id`;
    const [account] = await sql`insert into cloud_accounts (owner_user_id, provider, name, external_account_id, credential_ciphertext, credential_iv, credential_tag) values (${owner!.id}, 'aws', 'AWS', '123456789012', 'cipher', 'iv', 'tag') returning id`;
    const [instance] = await sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${account!.id}, 'ec2', 'us-east-1', ${`i-${randomUUID()}`}, 1) returning id`;
    const [iface] = await sql`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-test', 1) returning id`;
    const [address] = await sql`insert into cloud_addresses (interface_id, kind, family, address, origin, scan_generation) values (${iface!.id}, 'host', '4', '192.0.2.1', 'user', 1) returning id`;
    const [slot] = await sql`insert into managed_address_slots (interface_id, family, name, current_address_id, current_version) values (${iface!.id}, '4', 'primary', ${address!.id}, 1) returning id`;
    const incidentId = randomUUID();
    const segmentId = randomUUID();
    const healthPolicyId = randomUUID();
    const configId = randomUUID();
    const groupId = randomUUID();
    await sql`insert into rotation_incidents (id, owner_user_id, slot_id, family, physical_key, source_event_id, current_segment_id, authorization_revision, policy_revision, address_version, health_policy_id, health_policy_revision, config_id, config_revision, group_id, group_revision) values (${incidentId}, ${owner!.id}, ${slot!.id}, '4', 'physical', 'health-event', ${segmentId}, 1, 1, 1, ${healthPolicyId}, 1, ${configId}, 1, ${groupId}, 1)`;

    await migrate(connection.db, { migrationsFolder: migrations });
    expect((await sql`select trigger, health_policy_id from rotation_incidents where id=${incidentId}`)[0]).toMatchObject({ trigger: "health", health_policy_id: healthPolicyId });
    await sql`update rotation_incidents set status='complete' where id=${incidentId}`;
    const [manual] = await sql`insert into rotation_incidents (owner_user_id, slot_id, family, physical_key, source_event_id, trigger, current_segment_id, authorization_revision, policy_revision, address_version) values (${owner!.id}, ${slot!.id}, '4', 'physical', 'manual-event', 'manual', ${randomUUID()}, 1, 1, 1) returning id`;
    await sql`update rotation_incidents set status='complete' where id=${manual!.id}`;
    await expect(sql`insert into rotation_incidents (owner_user_id, slot_id, family, physical_key, source_event_id, trigger, current_segment_id, authorization_revision, policy_revision, address_version, health_policy_id) values (${owner!.id}, ${slot!.id}, '4', 'other', 'invalid-manual', 'manual', ${randomUUID()}, 1, 1, 1, ${randomUUID()})`).rejects.toMatchObject({ code: "23514" });
    await migrate(connection.db, { migrationsFolder: migrations });
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
