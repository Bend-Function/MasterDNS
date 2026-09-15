import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteControlPlane } from './rotation-remote.js';

test('the parent journal records a rejected release before fake validation', async () => {
  const remote = await remoteControlPlane();
  try {
    remote.add('i-owned', 'eni-owned', '192.0.2.10', '192.0.2.11');
    const response = await fetch(remote.url, { method: 'POST', body: JSON.stringify({ name: 'ReleaseAddressCommand', input: { AllocationId: 'old-i-owned' } }) });
    assert.equal(response.status, 500);
    assert.deepEqual(remote.mutations, [{ name: 'ReleaseAddressCommand', input: { AllocationId: 'old-i-owned' } }]);
    assert.equal(remote.events.length, 0); assert.equal(remote.allocations[0].NetworkInterfaceId, 'eni-owned');
  } finally { await remote.close(); }
});
