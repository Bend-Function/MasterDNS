import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";

it("keeps existing Linode strategy and restart settings while adding opt-in swap grants", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  const name = `linode_swap_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "linode-swap-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 33) };
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries) await cp(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root); url.pathname = `/${name}`; connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const sql = connection.client;
    const [owner] = await sql`insert into users(username,password_hash) values (${randomUUID()},'test') returning id`;
    const [account] = await sql`insert into cloud_accounts(owner_user_id,provider,name,credential_ciphertext,credential_iv,credential_tag) values (${owner!.id},'linode','Existing','cipher','iv','tag') returning id`;
    const [instance] = await sql`insert into cloud_instances(account_id,service,region,external_id,scan_generation) values (${account!.id},'linode','us-east','42',1) returning id`;
    const [iface] = await sql`insert into cloud_interfaces(instance_id,external_id,scan_generation) values (${instance!.id},'public',1) returning id`;
    const [slot] = await sql`insert into managed_address_slots(interface_id,family,name) values (${iface!.id},'4','public') returning id`;
    await sql`insert into rotation_policies(slot_id,enabled,linode_restart_mode) values (${slot!.id},true,'stop_start')`;
    await migrate(connection.db, { migrationsFolder: migrations });
    expect((await sql`select enabled,linode_restart_mode,linode_ipv4_strategy,linode_swap_plan,linode_allow_temporary_instance from rotation_policies where slot_id=${slot!.id}`)[0])
      .toEqual({ enabled: true, linode_restart_mode: "stop_start", linode_ipv4_strategy: "additional_ipv4", linode_swap_plan: "g6-nanode-1", linode_allow_temporary_instance: false });
    await expect(sql`update rotation_policies set linode_ipv4_strategy='invalid' where slot_id=${slot!.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update rotation_policies set linode_swap_plan='../instances' where slot_id=${slot!.id}`).rejects.toMatchObject({ code: "23514" });
    await sql`update rotation_policies set linode_ipv4_strategy='instance_swap',linode_allow_temporary_instance=true where slot_id=${slot!.id}`;
    await migrate(connection.db, { migrationsFolder: migrations });
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);
