import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { cloudApiRequests, type MasterDnsDatabase } from "@masterdns/db";
import { and, eq } from "drizzle-orm";
import { parseIdempotencyKey } from "../../common/idempotency.js";

type Transaction = Parameters<Parameters<MasterDnsDatabase["transaction"]>[0]>[0];
type JsonResult<T> = T extends Date ? string : T extends object ? { [K in keyof T]: JsonResult<T[K]> } : T;

export function cloudRequestKey(value: string | undefined): string {
  const key = parseIdempotencyKey(value);
  if (!key) throw new BadRequestException("Idempotency-Key is required");
  return key;
}

// A small receipt for these two transactional API mutations, not a queued operation.
// Only a fingerprint and the public response are persisted; credentials never enter it.
export async function withCloudRequest<T extends object>(
  tx: Transaction,
  identity: { key: string; actorUserId: string; ownerUserId: string; action: "account.create" | "slot.bind"; request: unknown },
  apply: () => Promise<T>,
): Promise<JsonResult<T>> {
  const requestHash = createHash("sha256").update(JSON.stringify(identity.request, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
    }
    return value;
  })).digest("hex");
  const { request: _request, ...fields } = identity;
  const [claimed] = await tx.insert(cloudApiRequests).values({ ...fields, requestHash }).onConflictDoNothing({ target: [cloudApiRequests.actorUserId, cloudApiRequests.key] }).returning({ key: cloudApiRequests.key });
  if (!claimed) {
    const [existing] = await tx.select().from(cloudApiRequests).where(and(eq(cloudApiRequests.actorUserId, identity.actorUserId), eq(cloudApiRequests.key, identity.key))).limit(1);
    if (!existing || existing.actorUserId !== identity.actorUserId || existing.ownerUserId !== identity.ownerUserId || existing.action !== identity.action || existing.requestHash !== requestHash || existing.response === null) {
      throw new ConflictException("Idempotency-Key has already been used for another request");
    }
    return existing.response as JsonResult<T>;
  }
  const response = JSON.parse(JSON.stringify(await apply())) as JsonResult<T>;
  await tx.update(cloudApiRequests).set({ response }).where(and(eq(cloudApiRequests.actorUserId, identity.actorUserId), eq(cloudApiRequests.key, identity.key)));
  return response;
}
