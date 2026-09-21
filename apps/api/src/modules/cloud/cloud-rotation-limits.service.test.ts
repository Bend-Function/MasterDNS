import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLogs, cloudAccounts, createDatabase, users } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";

vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));

import { CloudService } from "./cloud.service.js";

const databaseName = `cloud_rotation_limits_api_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let service: CloudService;

beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root);
  url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudService({ db: connection.db } as never, { cloudSync: { add: async () => undefined } } as never);
}, 30_000);

afterAll(async () => {
  await connection?.close();
  if (admin) {
    await admin.client.unsafe(`drop database if exists "${databaseName}"`);
    await admin.close();
  }
});

async function fixture(provider: "aws" | "azure" | "linode" = "aws") {
  const [owner, other, administrator] = await connection.db.insert(users).values([
    { username: randomUUID(), passwordHash: "test", role: "user" },
    { username: randomUUID(), passwordHash: "test", role: "user" },
    { username: randomUUID(), passwordHash: "test", role: "admin" },
  ]).returning();
  const [account] = await connection.db.insert(cloudAccounts).values({
    ownerUserId: owner!.id,
    provider,
    name: `${provider} rotation limits`,
    externalAccountId: provider === "aws" ? "123456789012" : randomUUID(),
    credentialCiphertext: "ciphertext",
    credentialIv: "iv",
    credentialTag: "tag",
  }).returning();
  const actor = (user: typeof owner) => ({ id: user!.id, role: user!.role } as AuthUser);
  return { account: account!, owner: actor(owner), other: actor(other), admin: actor(administrator) };
}

describe("cloud account rotation-limit API service", () => {
  it("returns the default policy to the owner and administrator but hides it from another user", async () => {
    const f = await fixture();

    await expect(service.rotationLimits(f.owner, f.account.id, "ec2")).resolves.toMatchObject({ service: "ec2", utilizationPercent: 80, effectivePercent: 80 });
    await expect(service.rotationLimits(f.admin, f.account.id, "lightsail")).resolves.toMatchObject({ service: "lightsail", utilizationPercent: 80, effectivePercent: 80 });
    await expect(service.rotationLimits(f.other, f.account.id, "ec2")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a service that does not belong to the account provider", async () => {
    const f = await fixture("azure");

    await expect(service.rotationLimits(f.owner, f.account.id, "ec2")).rejects.toMatchObject({ status: 400 });
    await expect(service.setRotationLimits(f.owner, f.account.id, "linode", { utilizationPercent: 50 })).rejects.toMatchObject({ status: 400 });
  });

  it("persists an independent service percentage and writes a sanitized audit snapshot", async () => {
    const f = await fixture();

    const updated = await service.setRotationLimits(f.owner, f.account.id, "ec2", { utilizationPercent: 65 });

    expect(updated).toMatchObject({ service: "ec2", utilizationPercent: 65, effectivePercent: 65 });
    await expect(service.rotationLimits(f.owner, f.account.id, "lightsail")).resolves.toMatchObject({ utilizationPercent: 80 });
    const rows = await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerUserId: f.owner.id,
      actorUserId: f.owner.id,
      action: "cloud_account.rotation_limit_policy",
      resourceType: "cloud_account",
      beforeSnapshot: { service: "ec2", utilizationPercent: 80, effectivePercent: 80 },
      afterSnapshot: { service: "ec2", utilizationPercent: 65, effectivePercent: 65 },
    });
    expect(JSON.stringify(rows[0])).not.toContain("ciphertext");
  });

  it("rejects an out-of-range percentage even when the service method is called directly", async () => {
    const f = await fixture();

    await expect(service.setRotationLimits(f.owner, f.account.id, "ec2", { utilizationPercent: 0 })).rejects.toThrow();
    await expect(service.rotationLimits(f.owner, f.account.id, "ec2")).resolves.toMatchObject({ utilizationPercent: 80 });
  });
});
