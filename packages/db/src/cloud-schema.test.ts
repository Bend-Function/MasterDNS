import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootUrl = process.env.MASTERDNS_TEST_DATABASE_URL;
const testDatabase = `masterdns_cloud_${process.pid}_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof postgres>;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  if (!rootUrl) throw new Error("MASTERDNS_TEST_DATABASE_URL is required for cloud schema tests");
  const parsed = new URL(rootUrl);
  admin = postgres(rootUrl, { max: 1 });
  await admin.unsafe(`create database ${admin.options.transform.column.to?.(testDatabase) ?? `"${testDatabase}"`}`);
  parsed.pathname = `/${testDatabase}`;
  sql = postgres(parsed.toString(), { max: 1 });
  const { drizzle } = await import("drizzle-orm/postgres-js");
  await migrate(drizzle(sql), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
}, 30_000);

afterAll(async () => {
  await sql?.end();
  if (admin) {
    await admin.unsafe(`drop database if exists "${testDatabase}"`);
    await admin.end();
  }
});

async function seedOwner() {
  const [owner] = await sql<{ id: string }[]>`insert into users (username, password_hash) values (${`cloud-${randomUUID()}`}, 'test') returning id`;
  if (!owner) throw new Error("owner insert failed");
  return owner.id;
}

async function seedCloud() {
  const ownerId = await seedOwner();
  const [account] = await sql<{ id: string }[]>`
    insert into cloud_accounts (owner_user_id, provider, name, credential_ciphertext, credential_iv, credential_tag)
    values (${ownerId}, 'aws', 'test', 'ciphertext', 'iv', 'tag') returning id`;
  if (!account) throw new Error("account insert failed");
  return { ownerId, accountId: account.id };
}

describe("cloud schema constraints", () => {
  it("allows the same instance external id in different regions", async () => {
    const { accountId } = await seedCloud();
    await sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-shared', 1)`;
    await expect(sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'us-east-1', 'i-shared', 1)`).resolves.toBeDefined();
  });

  it("rejects a duplicate complete instance identity", async () => {
    const { accountId } = await seedCloud();
    await sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-duplicate', 1)`;
    await expect(sql`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-duplicate', 2)`).rejects.toMatchObject({ code: "23505" });
  });

  it("leaves instances unauthorized by default", async () => {
    const { accountId } = await seedCloud();
    const [instance] = await sql<{ id: string }[]>`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'lightsail', 'ap-southeast-2', 'ls-1', 1) returning id`;
    expect(await sql`select * from instance_authorizations where instance_id = ${instance!.id}`).toHaveLength(0);
    const [authorization] = await sql<{
      allowIpv4Rotation: boolean;
      allowIpv6Rotation: boolean;
      allowStopStart: boolean;
      allowReleaseAddress: boolean;
    }[]>`insert into instance_authorizations (instance_id) values (${instance!.id}) returning
      allow_ipv4_rotation as "allowIpv4Rotation",
      allow_ipv6_rotation as "allowIpv6Rotation",
      allow_stop_start as "allowStopStart",
      allow_release_address as "allowReleaseAddress"`;
    expect(authorization).toEqual({
      allowIpv4Rotation: false,
      allowIpv6Rotation: false,
      allowStopStart: false,
      allowReleaseAddress: false,
    });
  });

  it("allows only one slot link for an endpoint and address family", async () => {
    const { ownerId, accountId } = await seedCloud();
    const [pool] = await sql<{ id: string }[]>`insert into endpoint_pools (owner_user_id, name, strategy) values (${ownerId}, 'pool', 'primary_backup') returning id`;
    const [endpoint] = await sql<{ id: string }[]>`insert into endpoints (pool_id, name, address_mode) values (${pool!.id}, 'cloud', 'cloud') returning id`;
    const [instance] = await sql<{ id: string }[]>`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-slots', 1) returning id`;
    const [iface] = await sql<{ id: string }[]>`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-1', 1) returning id`;
    const slots = await sql<{ id: string }[]>`insert into managed_address_slots (interface_id, family, name) values (${iface!.id}, '4', 'primary'), (${iface!.id}, '4', 'secondary') returning id`;
    await sql`insert into cloud_endpoint_links (endpoint_id, family, slot_id) values (${endpoint!.id}, '4', ${slots[0]!.id})`;
    await expect(sql`insert into cloud_endpoint_links (endpoint_id, family, slot_id) values (${endpoint!.id}, '4', ${slots[1]!.id})`).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects prefix addresses as slot current addresses", async () => {
    const { accountId } = await seedCloud();
    const [instance] = await sql<{ id: string }[]>`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-prefix', 1) returning id`;
    const [iface] = await sql<{ id: string }[]>`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-prefix', 1) returning id`;
    const [prefix] = await sql<{ id: string }[]>`insert into cloud_addresses (interface_id, kind, family, address, prefix_length, origin, scan_generation) values (${iface!.id}, 'prefix', '6', '2001:db8::', 64, 'system', 1) returning id`;
    await expect(sql`insert into managed_address_slots (interface_id, family, name, current_address_id) values (${iface!.id}, '6', 'prefix', ${prefix!.id})`).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects prefix addresses as slot candidate addresses", async () => {
    const { accountId } = await seedCloud();
    const [instance] = await sql<{ id: string }[]>`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-candidate-prefix', 1) returning id`;
    const [iface] = await sql<{ id: string }[]>`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-candidate-prefix', 1) returning id`;
    const [prefix] = await sql<{ id: string }[]>`insert into cloud_addresses (interface_id, kind, family, address, prefix_length, origin, scan_generation) values (${iface!.id}, 'prefix', '4', '198.51.100.0', 24, 'system', 1) returning id`;
    await expect(sql`insert into managed_address_slots (interface_id, family, name, candidate_address_id) values (${iface!.id}, '4', 'prefix', ${prefix!.id})`).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects duplicate host address identities", async () => {
    const { accountId } = await seedCloud();
    const [instance] = await sql<{ id: string }[]>`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-host-duplicate', 1) returning id`;
    const [iface] = await sql<{ id: string }[]>`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-host-duplicate', 1) returning id`;
    await sql`insert into cloud_addresses (interface_id, kind, family, address, origin, scan_generation) values (${iface!.id}, 'host', '4', '192.0.2.99', 'system', 1)`;
    await expect(sql`insert into cloud_addresses (interface_id, kind, family, address, origin, scan_generation) values (${iface!.id}, 'host', '4', '192.0.2.99', 'system', 2)`).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a cloud slot link for a DDNS endpoint", async () => {
    const { ownerId, accountId } = await seedCloud();
    const [pool] = await sql<{ id: string }[]>`insert into endpoint_pools (owner_user_id, name, strategy) values (${ownerId}, 'ddns-pool', 'primary_backup') returning id`;
    const [endpoint] = await sql<{ id: string }[]>`insert into endpoints (pool_id, name, address_mode) values (${pool!.id}, 'ddns', 'ddns') returning id`;
    const [instance] = await sql<{ id: string }[]>`insert into cloud_instances (account_id, service, region, external_id, scan_generation) values (${accountId}, 'ec2', 'ap-southeast-1', 'i-ddns', 1) returning id`;
    const [iface] = await sql<{ id: string }[]>`insert into cloud_interfaces (instance_id, external_id, scan_generation) values (${instance!.id}, 'eni-ddns', 1) returning id`;
    const [slot] = await sql<{ id: string }[]>`insert into managed_address_slots (interface_id, family, name) values (${iface!.id}, '4', 'primary') returning id`;
    await expect(sql`insert into cloud_endpoint_links (endpoint_id, family, slot_id) values (${endpoint!.id}, '4', ${slot!.id})`).rejects.toMatchObject({ code: "23514" });
  });

  it("preserves one active current or candidate address per endpoint family and state", async () => {
    const ownerId = await seedOwner();
    const [pool] = await sql<{ id: string }[]>`insert into endpoint_pools (owner_user_id, name, strategy) values (${ownerId}, 'address-pool', 'primary_backup') returning id`;
    const [endpoint] = await sql<{ id: string }[]>`insert into endpoints (pool_id, name, address_mode) values (${pool!.id}, 'static', 'static') returning id`;
    await sql`insert into endpoint_addresses (endpoint_id, family, address, state, source) values (${endpoint!.id}, '4', '192.0.2.1', 'current', 'static')`;
    await expect(sql`insert into endpoint_addresses (endpoint_id, family, address, state, source) values (${endpoint!.id}, '4', '192.0.2.2', 'current', 'static')`).rejects.toMatchObject({ code: "23505" });
    await expect(sql`insert into endpoint_addresses (endpoint_id, family, address, state, source) values (${endpoint!.id}, '4', '192.0.2.3', 'candidate', 'static')`).resolves.toBeDefined();
    await expect(sql`insert into endpoint_addresses (endpoint_id, family, address, state, source) values (${endpoint!.id}, '4', '192.0.2.4', 'candidate', 'static')`).rejects.toMatchObject({ code: "23505" });
  });
});
