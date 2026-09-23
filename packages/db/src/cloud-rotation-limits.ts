import { cloudRotationLimitPolicySchema, cloudRotationLimitRules, cloudRotationRulesForAction, cloudServiceProvider, type CloudRotationLimitRule, type CloudRotationLimitStatus, type CloudService } from "@masterdns/contracts";
import { eq, sql } from "drizzle-orm";
import { cloudAccounts, cloudRotationBuckets, cloudRotationLimitPolicies, cloudRotationReservations, cloudRotationLimitSwitches } from "./schema/index.js";
import { databaseNow, type RotationTransaction } from "./rotation-context.js";

export type CloudRotationWriteInput = { accountId: string; service: CloudService; region: string; stepId: string; action: string; remainingSteps?: Array<{ id: string; action: string }> };
export type CloudRotationWriteAdmission = { allowed: true } | { allowed: false; retryAt: Date; reason: "rotation_rate_limited"; ruleId: string };
type Bucket = typeof cloudRotationBuckets.$inferSelect;
const bucketKey = (identity: string, rule: string, region: string | null) => JSON.stringify([identity, rule, region]);
const denied = (ruleId: string, retryAt: Date): CloudRotationWriteAdmission => ({ allowed: false, reason: "rotation_rate_limited", retryAt, ruleId });

async function context(tx: RotationTransaction, accountId: string, service: CloudService) {
  const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId));
  if (!account) throw new Error("cloud_account_not_found");
  if (account.provider !== cloudServiceProvider(service)) throw new Error("cloud_service_mismatch");
  if (!account.externalAccountId) throw new Error("cloud_account_identity_missing");
  const identityKey = JSON.stringify([account.provider, account.externalAccountId, service]);
  // Also protects initialization without inserting empty buckets on admission denial.
  // No row locks on other local accounts: rotation callers already hold their own account lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identityKey}, 624713))`);
  const policies = await tx.execute<{ id: string; percent: number }>(sql`
    select a.id, coalesce(p.utilization_percent, 80) as percent from cloud_accounts a
    left join cloud_rotation_limit_policies p on p.account_id=a.id and p.service=${service}
    where a.provider=${account.provider} and a.external_account_id=${account.externalAccountId}`);
  const [setting] = await tx.select().from(cloudRotationLimitSwitches).where(eq(cloudRotationLimitSwitches.identityKey, identityKey));
  return { identityKey, enabled: setting?.enabled ?? true, utilizationPercent: policies.find(p => p.id === accountId)!.percent, effectivePercent: Math.min(...policies.map(p => p.percent)) };
}
async function buckets(tx: RotationTransaction, identityKey: string) {
  return tx.select().from(cloudRotationBuckets).where(eq(cloudRotationBuckets.identityKey, identityKey)).orderBy(cloudRotationBuckets.key).for("update");
}
async function pendingReservations(tx: RotationTransaction, identityKey: string) {
  return tx.execute<{ step_id: string }>(sql`
    select r.step_id from cloud_rotation_reservations r
    join rotation_steps s on s.id=r.step_id join rotation_attempts a on a.id=s.attempt_id
    join rotation_incidents i on i.id=a.incident_id
    where r.identity_key=${identityKey} and r.consumed_at is null
      and i.current_attempt_id=a.id and i.status <> 'complete' and a.status <> 'abandoned'`);
}
function liveState(rule: CloudRotationLimitRule, row: Bucket | undefined, now: Date) {
  const elapsed = Math.max(0, now.getTime() - (row?.updatedAt.getTime() ?? now.getTime())) / 1000;
  const debt = Math.max(0, (row?.debt ?? 0) - elapsed * (rule.refillPerSecond ?? 0));
  const events = rule.windowSeconds === null ? [] : (row?.events ?? []).filter(event => event > now.getTime() - rule.windowSeconds! * 1000);
  return { debt, events };
}
function retryTime(rule: CloudRotationLimitRule, state: ReturnType<typeof liveState>, outstanding: number, required: number, now: Date) {
  if (rule.kind === "token_bucket") return new Date(now.getTime() + Math.ceil(Math.max(0, state.debt + required - rule.capacity) / rule.refillPerSecond! * 1000));
  const expireCount = state.events.length + outstanding + required - rule.capacity;
  const expiry = state.events[expireCount - 1];
  // Pending reservations do not expire. Poll while their incident remains resumable.
  return new Date(expiry === undefined ? now.getTime() + 60000 : expiry + rule.windowSeconds! * 1000);
}

/** Must run in the same transaction that durably marks the step dispatched. */
export async function reserveCloudRotationWrite(tx: RotationTransaction, input: CloudRotationWriteInput): Promise<CloudRotationWriteAdmission> {
  cloudRotationRulesForAction(input.service, input.action); // fail closed before locking or writing
  const c = await context(tx, input.accountId, input.service);
  const rows = await buckets(tx, c.identityKey);
  const now = await databaseNow(tx);
  const cooldown = rows.find(row => row.ruleId === "cooldown")?.cooldownUntil;
  if (cooldown && cooldown > now) return denied("cooldown", cooldown);
  const rules = cloudRotationRulesForAction(input.service, input.action, c.effectivePercent);
  const dynamic = input.service === "lightsail" && input.action.startsWith("lightsail.static-ip.");
  const release = input.action === "lightsail.static-ip.release";
  const pending = dynamic ? await pendingReservations(tx, c.identityKey) : [];
  const ownsReservation = pending.some(row => row.step_id === input.stepId);
  const newReservations: string[] = [];
  if (dynamic && !release) {
    // Read the durable plan, not arbitrary caller-provided ids. Reserve all remaining
    // first dispatches before any destructive detach; retries buy fresh current credit.
    const steps = await tx.execute<{ id: string; action: string; dispatched_at: Date | null; consumed_at: Date | null; reserved: string | null }>(sql`
      select s.id, s.plan->>'action' as action, s.dispatched_at, r.consumed_at, r.step_id as reserved
      from rotation_steps current_step join rotation_steps s on s.attempt_id=current_step.attempt_id
      join rotation_attempts a on a.id=s.attempt_id join rotation_incidents i on i.id=a.incident_id
      left join cloud_rotation_reservations r on r.step_id=s.id and r.identity_key=${c.identityKey}
      where current_step.id=${input.stepId} and s.sequence >= current_step.sequence
        and i.current_attempt_id=a.id and i.status <> 'complete' and a.status <> 'abandoned'
        and s.status in ('prepared','not_applied','rejected_no_effect') order by s.sequence`);
    if (!steps.some(step => step.id === input.stepId && step.action === input.action)) throw new Error("invalid_rotation_reservation_step");
    for (const supplied of input.remainingSteps ?? []) {
      if (!steps.some(step => step.id === supplied.id && step.action === supplied.action)) throw new Error("invalid_rotation_reservation_step");
    }
    for (const step of steps) {
      cloudRotationRulesForAction(input.service, step.action);
      if (step.id !== input.stepId && !step.dispatched_at && !step.reserved && ["lightsail.static-ip.allocate", "lightsail.static-ip.detach", "lightsail.static-ip.attach"].includes(step.action)) newReservations.push(step.id);
    }
  }
  const updates: Array<{ rule: CloudRotationLimitRule; key: string; region: string | null; state: ReturnType<typeof liveState> }> = [];
  let refusal: { ruleId: string; retryAt: Date } | undefined;
  for (const rule of rules) {
    const region = rule.scope === "global" ? null : input.region;
    const key = bucketKey(c.identityKey, rule.id, region);
    const state = liveState(rule, rows.find(row => row.key === key), now);
    const required = rule.kind === "sliding_window" && dynamic ? (ownsReservation ? 0 : 1) + newReservations.length : 1;
    if (c.enabled && dynamic && !release && rule.kind === "sliding_window" && required > rule.capacity) throw new Error("rotation_limit_too_low");
    const used = rule.kind === "token_bucket" ? state.debt : state.events.length + (dynamic ? pending.length : 0);
    const protectedReservation = dynamic && ownsReservation && required === 0;
    if (c.enabled && !(dynamic && rule.kind === "sliding_window" && (release || protectedReservation)) && used + required > rule.capacity + 1e-9) {
      const retryAt = retryTime(rule, state, dynamic ? pending.length : 0, required, now);
      if (!refusal || retryAt > refusal.retryAt) refusal = { ruleId: rule.id, retryAt };
    }
    updates.push({ rule, key, region, state });
  }
  if (refusal) return denied(refusal.ruleId, refusal.retryAt);
  for (const update of updates.sort((a, b) => a.key.localeCompare(b.key))) {
    const values = { key: update.key, identityKey: c.identityKey, ruleId: update.rule.id, region: update.region, debt: update.rule.kind === "token_bucket" ? update.state.debt + 1 : 0, events: update.rule.kind === "sliding_window" ? [...update.state.events, now.getTime()] : [], updatedAt: now };
    await tx.insert(cloudRotationBuckets).values(values).onConflictDoUpdate({ target: cloudRotationBuckets.key, set: values });
  }
  for (const stepId of newReservations) await tx.insert(cloudRotationReservations).values({ stepId, identityKey: c.identityKey, createdAt: now });
  if (ownsReservation) await tx.update(cloudRotationReservations).set({ consumedAt: now }).where(eq(cloudRotationReservations.stepId, input.stepId));
  return { allowed: true };
}

export async function recordCloudRotationThrottle(tx: RotationTransaction, input: Omit<CloudRotationWriteInput, "remainingSteps"> & { retryAfterMs?: number }): Promise<Date> {
  cloudRotationRulesForAction(input.service, input.action);
  const c = await context(tx, input.accountId, input.service);
  const rows = await buckets(tx, c.identityKey);
  const now = await databaseNow(tx);
  const previous = rows.find(row => row.ruleId === "cooldown");
  // A quiet hour resets escalation; repeated throttles rise from 60s to 1h.
  const count = previous && now.getTime() - previous.updatedAt.getTime() < 3600000 ? Math.min(previous.throttleCount + 1, 7) : 1;
  const retryAfter = Number.isFinite(input.retryAfterMs) ? Math.min(86400000, Math.max(0, input.retryAfterMs!)) : 0;
  const until = new Date(Math.max(previous?.cooldownUntil?.getTime() ?? 0, now.getTime() + Math.max(Math.min(3600000, 60000 * 2 ** (count - 1)), retryAfter)));
  const values = { key: bucketKey(c.identityKey, "cooldown", null), identityKey: c.identityKey, ruleId: "cooldown", region: null, updatedAt: now, cooldownUntil: until, throttleCount: count };
  await tx.insert(cloudRotationBuckets).values(values).onConflictDoUpdate({ target: cloudRotationBuckets.key, set: values });
  return until;
}

export async function getCloudRotationLimitStatus(tx: RotationTransaction, accountId: string, service: CloudService): Promise<CloudRotationLimitStatus> {
  const c = await context(tx, accountId, service);
  const rows = await buckets(tx, c.identityKey);
  const now = await databaseNow(tx);
  const rules = cloudRotationLimitRules(service, c.effectivePercent);
  const pending = service === "lightsail" ? (await pendingReservations(tx, c.identityKey)).length : 0;
  const cooldown = rows.find(row => row.ruleId === "cooldown")?.cooldownUntil;
  const usage: CloudRotationLimitStatus["usage"] = [];
  for (const rule of rules) {
    const matching = rows.filter(row => row.ruleId === rule.id);
    const entries: Array<Bucket | undefined> = matching.length ? matching : rule.scope === "global" ? [undefined] : [];
    for (const row of entries) {
      const state = liveState(rule, row, now);
      const outstanding = rule.id.startsWith("lightsail.static-ip.") ? pending : 0;
      const used = rule.kind === "token_bucket" ? state.debt : state.events.length + outstanding;
      let retryAt = c.enabled && used + 1 > rule.capacity ? retryTime(rule, state, outstanding, 1, now) : null;
      if (cooldown && cooldown > now && (!retryAt || cooldown > retryAt)) retryAt = cooldown;
      usage.push({ ruleId: rule.id, region: row?.region ?? null, used, remaining: Math.max(0, rule.capacity - used), retryAt: retryAt?.toISOString() ?? null });
    }
  }
  return { enabled: c.enabled, service, utilizationPercent: c.utilizationPercent, effectivePercent: c.effectivePercent, rules, usage };
}
export async function setCloudRotationLimitPolicy(tx: RotationTransaction, accountId: string, service: CloudService, utilizationPercent: number, enabled?: boolean): Promise<CloudRotationLimitStatus> {
  cloudRotationLimitPolicySchema.parse({ utilizationPercent });
  // Match the existing account-before-budget lock order used by rotation dispatch.
  await tx.select({ id: cloudAccounts.id }).from(cloudAccounts).where(eq(cloudAccounts.id, accountId)).for("update");
  const previous = await context(tx, accountId, service);
  const rows = await buckets(tx, previous.identityKey);
  const now = await databaseNow(tx);
  const previousRules = cloudRotationLimitRules(service, previous.effectivePercent);
  // Policy changes cannot retroactively apply a faster refill rate to past time.
  for (const row of rows) {
    const rule = previousRules.find(candidate => candidate.id === row.ruleId && candidate.kind === "token_bucket");
    if (rule) await tx.update(cloudRotationBuckets).set({ debt: liveState(rule, row, now).debt, updatedAt: now }).where(eq(cloudRotationBuckets.key, row.key));
  }
  await tx.insert(cloudRotationLimitPolicies).values({ accountId, service, utilizationPercent }).onConflictDoUpdate({ target: [cloudRotationLimitPolicies.accountId, cloudRotationLimitPolicies.service], set: { utilizationPercent, updatedAt: sql`clock_timestamp()` } });
  if (enabled !== undefined) await tx.insert(cloudRotationLimitSwitches).values({ identityKey: previous.identityKey, enabled }).onConflictDoUpdate({ target: cloudRotationLimitSwitches.identityKey, set: { enabled, updatedAt: now } });
  return getCloudRotationLimitStatus(tx, accountId, service);
}

// Run after the policy transaction commits: never acquire incident locks while
// holding the shared budget lock (dispatch takes those locks in the other order).
export async function wakeCloudRotationLimitWaits(tx: RotationTransaction, accountId: string, service: CloudService) {
  const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, accountId));
  if (!account) return;
  const identityKey = JSON.stringify([account.provider, account.externalAccountId, service]);
  {
    // Wake local-budget waits only. The admission path still enforces vendor cooldowns.
    await tx.execute(sql`update rotation_incidents i set next_run_at=clock_timestamp()
      from managed_address_slots s, cloud_interfaces f, cloud_instances v, cloud_accounts a
      where i.slot_id=s.id and s.interface_id=f.id and f.instance_id=v.id and v.account_id=a.id
      and jsonb_build_array(a.provider, a.external_account_id, v.service) = ${identityKey}::jsonb
      and i.status='active' and i.error_code='rotation_rate_limited'`);
    await tx.execute(sql`update rotation_resources r set cleanup_due_at=clock_timestamp()
      from rotation_incidents i, managed_address_slots s, cloud_interfaces f, cloud_instances v, cloud_accounts a
      where r.incident_id=i.id and i.slot_id=s.id and s.interface_id=f.id and f.instance_id=v.id and v.account_id=a.id
      and jsonb_build_array(a.provider, a.external_account_id, v.service) = ${identityKey}::jsonb
      and i.status='active' and r.cleanup_error='rotation_rate_limited'`);
  }
}
