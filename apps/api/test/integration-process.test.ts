import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from './integration-process.js';

test('early exit before a failpoint redacts output and reports secret detection', async () => {
  const secret = 'integration-early-exit-secret';
  const output: string[] = [];
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stderr.write(process.env.TEST_SECRET); process.exit(9)"], { secrets: [secret], output }, {
    env: { TEST_SECRET: secret }, timeoutMs: 2000, failpoint: { label: 'remote effect', reached: new Promise(() => {}) },
  }), error => {
    assert(error instanceof Error);
    assert(!String(error).includes(secret));
    assert.match(error.message, /exited before remote effect/);
    assert.match(error.message, /\[redacted\]/);
    assert.match(error.message, /Secret detected/);
    return true;
  });
  assert(output.join('').includes(secret), 'raw capture remains available for secret detection only');
});

for (const code of [0, 7]) test(`exit ${code} cannot expose a secret outside the failpoint path`, async () => {
  const secret = 'integration-normal-exit-secret';
  await assert.rejects(runProcess(process.execPath, ['-e', `process.stdout.write(process.env.TEST_SECRET); process.exit(${code})`], { secrets: [secret], output: [] }, { env: { TEST_SECRET: secret } }), error => {
    assert(error instanceof Error); assert(!String(error).includes(secret)); assert.match(error.message, /Secret detected/); return true;
  });
});
