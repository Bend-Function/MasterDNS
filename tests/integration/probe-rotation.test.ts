// The API package owns the runtime dependencies and decorator configuration.
// Keep the acceptance entry at the repository test boundary.
void import('../../apps/api/test/rotation-acceptance.js').catch(error => {
  console.error(error);
  process.exitCode = 1;
});
