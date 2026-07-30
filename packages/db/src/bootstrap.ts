import { count } from "drizzle-orm";
import { hashPassword } from "@masterdns/crypto";
import type { MasterDnsDatabase } from "./index.js";
import { users } from "./schema/index.js";

export async function bootstrapAdmin(db: MasterDnsDatabase): Promise<boolean> {
  const result = await db.select({ value: count() }).from(users);
  if ((result[0]?.value ?? 0) > 0) return false;
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) throw new Error("BOOTSTRAP_ADMIN_PASSWORD is required when the database has no users");
  await db.insert(users).values({
    username,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || null,
    passwordHash: await hashPassword(password),
    role: "admin",
  });
  return true;
}
