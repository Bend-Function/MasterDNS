import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";

it("adds reusable proxies without changing existing encrypted account credentials", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  const name = `proxy_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "proxy-upgrade-"));
  const migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 29) };
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries) await cp(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await admin.client.unsafe(`create database "${name}"`);
    const url = new URL(root); url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    await migrate(connection.db, { migrationsFolder: folder });
    const sql = connection.client;
    const [owner] = await sql`insert into users(username,password_hash) values (${randomUUID()},'test') returning id`;
    const [account] = await sql`insert into cloud_accounts(owner_user_id,provider,name,credential_ciphertext,credential_iv,credential_tag) values (${owner!.id},'aws','Existing','encrypted-legacy','iv','tag') returning id`;
    await migrate(connection.db, { migrationsFolder: migrations });
    expect((await sql`select credential_ciphertext,proxy_profile_id from cloud_accounts where id=${account!.id}`)[0]).toEqual({ credential_ciphertext: "encrypted-legacy", proxy_profile_id: null });
    const [profile] = await sql`insert into cloud_proxy_profiles(owner_user_id,name,credential_ciphertext,credential_iv,credential_tag) values (${owner!.id},'Reusable','encrypted-url','iv','tag') returning id`;
    await sql`update cloud_accounts set proxy_profile_id=${profile!.id} where id=${account!.id}`;
    await expect(sql`delete from cloud_proxy_profiles where id=${profile!.id}`).rejects.toMatchObject({ code: "23001" });
    await migrate(connection.db, { migrationsFolder: migrations });
  } finally {
    await connection?.close();
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30_000);
