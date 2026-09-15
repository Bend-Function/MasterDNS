const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

const api = resolve(__dirname, '../apps/api');
const apiRequire = createRequire(resolve(api, 'package.json'));
const focused = process.argv.includes('--closed-loop');
const files = focused ? ['../../tests/integration/probe-rotation.test.ts'] : ['test/probe-binary-integration.ts', '../../tests/integration/probe-rotation.test.ts'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--import', apiRequire.resolve('tsx'), file], {
    cwd: api,
    stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(api, 'test/tsconfig.integration.json') },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
