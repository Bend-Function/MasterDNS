import assert from 'node:assert/strict';

/** Assert persistent evidence across an actual worker SIGKILL and fresh process. */
export function assertRecoveredCloudEffect(input: {
  originalAttemptId: string;
  allocationsBefore: number;
  allocationsAfter: number;
  attempts: Array<{ id: string; charged: boolean }>;
  budgets: Array<{ attemptsUsed: number }>;
  publicationsBeforeVerification: number;
}) {
  assert.equal(input.attempts.length, 1, 'restart cannot create another attempt');
  assert.equal(input.attempts[0]!.id, input.originalAttemptId, 'the original attempt survives');
  assert.equal(input.attempts[0]!.charged, true, 'the actual mutation stays charged');
  assert.equal(input.budgets.length, 1, 'restart cannot create a fresh budget segment');
  assert.equal(input.budgets[0]!.attemptsUsed, 1);
  assert.equal(input.allocationsAfter - input.allocationsBefore, 1, 'observe the remote allocation, never allocate twice');
  assert.equal(input.publicationsBeforeVerification, 0, 'recovery does not certify an unverified candidate');
}
