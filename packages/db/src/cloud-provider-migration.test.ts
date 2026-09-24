import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";

it("upgrades populated AWS schema without changing rows and stores complete Azure/Linode identities", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  const name = `cloud_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "cloud-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    await cp(migrations, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 19);
    await writeFile(journalPath, JSON.stringify(journal));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root); url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const sql = connection.client;
    const [owner] = await sql`insert into users (username, password_hash) values (${randomUUID()}, 'test') returning id`;
    const [account] = await sql`insert into cloud_accounts (owner_user_id, provider, name, external_account_id, credential_ciphertext, credential_iv, credential_tag) values (${owner!.id}, 'aws', 'AWS', '123456789012', 'cipher', 'iv', 'tag') returning *`;
    const [instance] = await sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${account!.id}, 'ec2', 'us-east-1', 'i-retained', 7) returning *`;
    const [iface] = await sql`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-retained', 7) returning *`;
    const [address] = await sql`insert into cloud_addresses (interface_id, kind, family, address, remote_allocation_id, origin, scan_generation) values (${iface!.id}, 'host', '4', '192.0.2.1', 'eipalloc-retained', 'user', 7) returning *`;
    await migrate(connection.db, { migrationsFolder: migrations });
    expect((await sql`select * from cloud_accounts where id=${account!.id}`)[0]).toEqual({ ...account, proxy_profile_id: null });
    expect((await sql`select * from cloud_instances where id=${instance!.id}`)[0]).toEqual(instance);
    expect((await sql`select * from cloud_interfaces where id=${iface!.id}`)[0]).toEqual(iface);
    expect((await sql`select * from cloud_addresses where id=${address!.id}`)[0]).toEqual({ ...address, metadata: {}, inventory_present: true });
    const longId = "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/" + "r".repeat(90) + "/providers/Microsoft.Network/networkInterfaces/" + "n".repeat(90) + "/ipConfigurations/exact-config";
    for (const [provider, service, region] of [["azure", "azure_vm", "australiaeast"], ["linode", "linode", "ap-south"]]) {
      const [added] = await sql`insert into cloud_accounts (owner_user_id, provider, name, external_account_id, credential_ciphertext, credential_iv, credential_tag) values (${owner!.id}, ${provider!}, 'new', ${longId}, 'cipher', 'iv', 'tag') returning id`;
      const [vm] = await sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${added!.id}, ${service!}, ${region!}, ${longId}, 1) returning id`;
      const [network] = await sql`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${vm!.id}, ${longId}, 1) returning id`;
      const [ip] = await sql`insert into cloud_addresses (interface_id, kind, family, address, remote_allocation_id, origin, scan_generation, metadata) values (${network!.id}, 'host', '4', '192.0.2.2', ${longId}, 'user', 1, '{"providerMetadata":{"ipConfigurationId":"exact"},"privateAddress":"10.0.0.4"}') returning *`;
      expect(ip!.remote_allocation_id).toBe(longId);
      expect(ip!.metadata).toEqual({ providerMetadata: { ipConfigurationId: "exact" }, privateAddress: "10.0.0.4" });
    }
    const columns = await sql`select table_name, column_name, data_type from information_schema.columns where table_name='rotation_resources' and column_name in ('allocation_id','resource_id')`;
    expect(columns).toHaveLength(2);
    expect(columns.every(column => column.data_type === "text")).toBe(true);
    await migrate(connection.db, { migrationsFolder: migrations });
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
