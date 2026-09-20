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

export function createManualRotationSubmission(factory: () => string = () => crypto.randomUUID()) {
  const intent = createRotationIntent(factory);
  let pending = false;
  let completed = false;
  return {
    isPending: () => pending,
    async submit<T>(slotId: string, request: (key: string, payload: { slotId: string }) => Promise<T>): Promise<T | undefined> {
      if (pending || completed) return undefined;
      pending = true;
      const ticket = intent.begin({ slotId });
      try {
        const result = await request(ticket.key, ticket.payload as { slotId: string });
        if (!intent.complete(ticket)) return undefined;
        completed = true;
        return result;
      } catch (error) {
        if (!intent.isCurrent(ticket)) return undefined;
        throw error;
      } finally {
        pending = false;
      }
    },
    cancel() {
      if (pending || completed) return false;
      intent.cancel();
      return true;
    },
  };
}

export function shouldPollRotation(status: string, actionOpen: boolean, actionPending: boolean): boolean {
  return status !== "complete" && !actionOpen && !actionPending;
}

export type RotationLoadToken = { rotationId: string; foreground: boolean; generation: number };

export function createRotationLoadCoordinator() {
  let current: RotationLoadToken | null = null;
  return {
    start(rotationId: string, foreground: boolean, nextGeneration: () => number): RotationLoadToken | null {
      if (current?.rotationId === rotationId && (!foreground || current.foreground)) return null;
      current = { rotationId, foreground, generation: nextGeneration() };
      return current;
    },
    isCurrent(token: RotationLoadToken): boolean {
      return current === token;
    },
    finish(token: RotationLoadToken): boolean {
      if (current !== token) return false;
      current = null;
      return true;
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
