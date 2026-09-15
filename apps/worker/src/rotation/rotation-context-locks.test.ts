import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import * as db from "@masterdns/db";
import { fixture } from "./rotation-test-utils.js";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Pause after a real account row lock. Other queries run unchanged against PostgreSQL.
function pauseAfterFirstAccount(
  tx: db.RotationTransaction,
  held: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): db.RotationTransaction {
  let paused = false;
  const wrap = (query: any, table?: unknown): any =>
    new Proxy(query, {
      get(target, key) {
        if (key === "then") return target.then.bind(target);
        const value = target[key];
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          const next = value.apply(target, args);
          if (key === "for" && table === db.cloudAccounts && args[0] === "update" && !paused) {
            paused = true;
            return next.then(async (rows: unknown) => {
              held.resolve();
              await release.promise;
              return rows;
            });
          }
          return key === "from" ? wrap(next, args[0]) : key === "where" || key === "orderBy" || key === "limit" ? wrap(next, table) : next;
        };
      },
    });
  return new Proxy(tx, {
    get(target, key) {
      const value = (target as any)[key];
      return key === "select"
        ? (...args: any[]) => wrap(value.apply(target, args))
        : typeof value === "function"
          ? value.bind(target)
          : value;
    },
  });
}
it("locks interleaved multi-account slot sets in one hierarchy without account inversion", async () => {
  const fixtures = [await fixture(), await fixture()].sort((a, b) => a.account.id.localeCompare(b.account.id));
  const [a, b] = fixtures;
  const prefix = randomUUID().slice(0, 24);
  const ids = [1, 2, 3, 4].map((n) => `${prefix}${String(n).padStart(12, "0")}`);
  for (const [index, f] of [a, b, b, a].entries())
    await f!.d
      .insert(db.managedAddressSlots)
      .values({
        id: ids[index]!,
        interfaceId: f!.slot.interfaceId,
        family: "4",
        name: `ordered-${index}`,
        currentAddressId: f!.address.id,
        currentVersion: 1,
      });
  const held = deferred(),
    release = deferred(),
    secondStarted = deferred();
  let firstPid = 0,
    secondPid = 0;
  const first = a!.d.transaction(async (tx) => {
    firstPid = Number((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
    await tx.execute(sql`set local lock_timeout = '5s'`);
    const contexts = await db.lockRotationContexts(pauseAfterFirstAccount(tx, held, release), [ids[0]!, ids[2]!]);
    expect(contexts.size).toBe(2);
  });
  await held.promise;
  const second = b!.d.transaction(async (tx) => {
    secondPid = Number((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
    secondStarted.resolve();
    await tx.execute(sql`set local lock_timeout = '5s'`);
    const contexts = await db.lockRotationContexts(tx, [ids[1]!, ids[3]!]);
    expect(contexts.size).toBe(2);
  });
  await secondStarted.promise;
  let blocked = false;
  try {
    for (let i = 0; i < 200; i++) {
      const [row] = await a!.d.execute<{ blocked: boolean }>(sql`select ${firstPid} = any(pg_blocking_pids(${secondPid})) as blocked`);
      if (row!.blocked) {
        blocked = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
  } finally {
    release.resolve();
  }
  const results = await Promise.allSettled([first, second]);
  expect(blocked).toBe(true);
  expect(
    results.map((result) => result.status),
    results.map((result) => (result.status === "rejected" ? String(result.reason?.cause?.code ?? result.reason) : "")).join(","),
  ).toEqual(["fulfilled", "fulfilled"]);
}, 15000);
