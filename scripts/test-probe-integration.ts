const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

// Run beside the API's dependencies and decorator configuration, without a sibling Go checkout.
const result = spawnSync('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.json', 'test/probe-binary-integration.ts'], {
  cwd: resolve(__dirname, '../apps/api'),
  stdio: 'inherit',
  env: process.env,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
