import { and, eq, sql } from "drizzle-orm";
import { databaseNow, rotationLeases, type RotationTransaction } from "@masterdns/db";
export type RotationLease = { physicalKey: string; holder: string; revision: number };

export async function acquireRotationLease(tx: RotationTransaction, physicalKey: string, holder: string): Promise<RotationLease | undefined> {
  const now = await databaseNow(tx);
  await tx.insert(rotationLeases).values({ physicalKey }).onConflictDoNothing();
  const [row] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, physicalKey)).for("update");
  if (!row || (row.holder !== null && row.expiresAt > now)) return undefined;
  const [claimed] = await tx.update(rotationLeases).set({ holder, revision: row.revision + 1, expiresAt: new Date(now.getTime() + 45000), updatedAt: now }).where(eq(rotationLeases.physicalKey, physicalKey)).returning();
  return { physicalKey, holder, revision: claimed!.revision };
}
export async function verifyRotationLease(tx: RotationTransaction, lease: RotationLease) {
  const [row] = await tx.select().from(rotationLeases).where(and(eq(rotationLeases.physicalKey, lease.physicalKey), eq(rotationLeases.holder, lease.holder), eq(rotationLeases.revision, lease.revision), sql`${rotationLeases.expiresAt} > clock_timestamp()`)).for("update");
  return row;
}
export async function releaseRotationLease(tx: RotationTransaction, lease: RotationLease) {
  await tx.update(rotationLeases).set({ holder: null, expiresAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(and(eq(rotationLeases.physicalKey, lease.physicalKey), eq(rotationLeases.holder, lease.holder), eq(rotationLeases.revision, lease.revision)));
}
