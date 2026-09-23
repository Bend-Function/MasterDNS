import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { createDatabase } from "./index.js";
it("upgrades grants with delete denied and preserves existing cloud inventory", async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  const name = `lifecycle_upgrade_${randomUUID().replaceAll("-", "")}`, admin = createDatabase(root);
  const folder = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-")), migrations = new URL("../drizzle", import.meta.url).pathname;
  let connection: ReturnType<typeof createDatabase> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(migrations,"meta/_journal.json"),"utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx:number }) => entry.idx < 28) };
    await mkdir(join(folder,"meta")); await writeFile(join(folder,"meta/_journal.json"),JSON.stringify(previous));
    for (const entry of previous.entries) await cp(join(migrations,`${entry.tag}.sql`),join(folder,`${entry.tag}.sql`));
    await admin.client.unsafe(`create database "${name}"`); const url = new URL(root); url.pathname=`/${name}`; connection=createDatabase(url.toString());
    await migrate(connection.db,{migrationsFolder:folder}); const sql=connection.client;
    const [user]=await sql`insert into users(username,password_hash) values (${randomUUID()},'test') returning id`;
    const [account]=await sql`insert into cloud_accounts(owner_user_id,provider,name,external_account_id,credential_ciphertext,credential_iv,credential_tag) values (${user!.id},'aws','AWS','123456789012','cipher','iv','tag') returning id`;
    const [instance]=await sql`insert into cloud_instances(account_id,service,region,external_id,scan_generation) values (${account!.id},'ec2','us-east-1','i-existing',1) returning id`;
    await sql`insert into instance_authorizations(instance_id,managed,allow_stop_start) values (${instance!.id},true,true)`;
    await migrate(connection.db,{migrationsFolder:migrations});
    expect((await sql`select managed,allow_stop_start,allow_delete from instance_authorizations where instance_id=${instance!.id}`)[0]).toEqual({managed:true,allow_stop_start:true,allow_delete:false});
    expect((await sql`select external_id from cloud_instances where id=${instance!.id}`)[0]!.external_id).toBe('i-existing');
    await sql`insert into cloud_traffic_stop_policies(instance_id,actor_user_id) values (${instance!.id},${user!.id})`;
    expect((await sql`select enabled,check_interval_seconds from cloud_traffic_stop_policies`)[0]).toEqual({enabled:false,check_interval_seconds:3600});
    await expect(sql`update cloud_traffic_stop_policies set enabled=true`).rejects.toMatchObject({code:'23514'});
    await migrate(connection.db,{migrationsFolder:migrations});
  } finally { await connection?.close(); await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); await rm(folder,{recursive:true,force:true}); }
},30000);
