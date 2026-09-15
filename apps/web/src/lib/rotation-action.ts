import { rotationResumeSchema, type RotationResumeInput } from "@masterdns/contracts/rotation";

export type RotationIntentPayload = { slotId: string } | RotationResumeInput;
export type RotationIntentTicket = { generation: number; key: string; payload: RotationIntentPayload };

export function createRotationIntent(factory: () => string = () => crypto.randomUUID()) {
  let generation = 0;
  let current: RotationIntentTicket | null = null;
  return {
    begin(payload: RotationIntentPayload): RotationIntentTicket {
      current ??= { generation, key: factory(), payload };
      return current;
    },
    isCurrent(ticket: RotationIntentTicket): boolean {
      return current === ticket && ticket.generation === generation;
    },
    complete(ticket: RotationIntentTicket): boolean {
      if (current !== ticket || ticket.generation !== generation) return false;
      current = null;
      generation += 1;
      return true;
    },
    cancel(): void {
      current = null;
      generation += 1;
    },
  };
}

export function rotationResumeScope(
  policy: { revision: number; maxAttempts: number },
  segment: { attemptsUsed: number; maxAttempts: number } | undefined,
  attempt: { charged: boolean; status: string } | undefined,
) {
  return {
    expectedPolicyRevision: policy.revision,
    currentSegmentAttemptsUsed: segment?.attemptsUsed ?? 0,
    currentSegmentMaxAttempts: segment?.maxAttempts ?? 0,
    newSegmentMaxAttempts: policy.maxAttempts,
    finishesChargedAttemptFirst: Boolean(attempt?.charged && !["candidate_failed", "verified", "abandoned"].includes(attempt.status)),
  };
}

export function parseRotationResumeIntent(input: unknown): RotationResumeInput {
  return rotationResumeSchema.parse(input);
}
