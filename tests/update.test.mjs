import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../update.sh', import.meta.url));
const fixtures = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Update Test', '-c', 'user.email=update@example.test', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Only Docker is replaced. Git operations act on disposable local repositories.
const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.UPDATE_TEST_LOG;
let stage = 'other';
if (args[0] === 'compose') {
  if (args[1] === 'build') stage = 'build';
  if (args[1] === 'stop') stage = 'stop';
  if (args.includes('pg_dump')) stage = 'dump';
  if (args[1] === 'run') {
    const old = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse) : [];
    stage = args.includes('node') ? 'preflight-' + (old.filter(e => e.stage.startsWith('preflight-')).length + 1) : 'migrate';
  }
  if (args[1] === 'up' && !args.includes('--help')) stage = args.includes('api') ? 'start-api' : 'start-apps';
}
fs.appendFileSync(log, JSON.stringify({ stage, args }) + '\\n');
if (process.env.UPDATE_TEST_FAIL === stage) {
  if (stage === 'dump') process.stdout.write('incomplete dump');
  process.stderr.write('injected ' + stage + ' failure\\n');
  process.exit(73);
}
if (process.env.UPDATE_TEST_BLOCK === stage) {
  fs.writeFileSync(process.env.UPDATE_TEST_READY, 'ready');
  const timeout = setTimeout(() => process.exit(74), 15000);
  const poll = setInterval(() => {
    if (fs.existsSync(process.env.UPDATE_TEST_RELEASE)) {
      clearInterval(poll); clearTimeout(timeout); process.exit(0);
    }
  }, 20);
} else if (args[0] === 'inspect') process.stdout.write('sha256:old-' + args.at(-1) + '\\n');
else if (args[0] === 'compose') {
  if (args[1] === 'version') process.stdout.write('Docker Compose version v2.39.0\\n');
  if (args.includes('--help')) process.stdout.write('--wait --wait-timeout\\n');
  if (args[1] === 'ps' && args.includes('-q')) process.stdout.write('container-' + args.at(-1) + '\\n');
  if (args[1] === 'config' && !args.includes('--quiet')) process.stdout.write('services: {}\\n');
  if (stage === 'dump') process.stdout.write('complete database dump\\n');
  if (args.includes('psql')) process.stdout.write('migration 0021\\n');
}
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'masterdns-update-test-'));
  fixtures.push(root);
  const remote = join(root, 'origin');
  const repo = join(root, 'deployment with spaces');
  const bin = join(root, 'bin');
  mkdirSync(remote); mkdirSync(bin);
  git(remote, 'init', '-b', 'master');
  copyFileSync(source, join(remote, 'update.sh'));
  writeFileSync(join(remote, '.gitignore'), '.env\n');
  writeFileSync(join(remote, 'docker-compose.yml'), 'services: {}\n');
  git(remote, 'add', '.'); git(remote, 'commit', '-m', 'deployed');
  git(root, 'clone', remote, repo);
  const oldRevision = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(remote, 'new-version.txt'), 'new version');
  git(remote, 'add', '.'); git(remote, 'commit', '-m', 'update');
  writeFileSync(join(repo, '.env'), 'MASTER_ENCRYPTION_KEY=test-secret-do-not-print\n');
  writeFileSync(join(bin, 'docker'), fakeDocker); chmodSync(join(bin, 'docker'), 0o755);
  const log = join(root, 'docker.jsonl');
  const backupRoot = join(root, 'private backups');
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, MASTERDNS_BACKUP_ROOT: backupRoot, UPDATE_TEST_LOG: log };
  const run = extra => spawnSync('bash', [join(repo, 'update.sh')], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
  const events = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const backups = () => existsSync(backupRoot) ? readdirSync(backupRoot).map(name => join(backupRoot, name)) : [];
  return { root, repo, remote, log, env, run, events, backups, backupRoot, oldRevision };
}

test('updates master and backs up before migration, waiting for API before other apps', () => {
  const f = setup();
  git(f.repo, 'switch', '-c', 'old-feature');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'master');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.remote, 'rev-parse', 'HEAD'));
  const [backup] = f.backups();
  assert.equal(f.backups().length, 1);
  assert.equal(readFileSync(join(backup, '.env'), 'utf8'), readFileSync(join(f.repo, '.env'), 'utf8'));
  assert.equal(statSync(join(backup, '.env')).mode & 0o077, 0);
  assert.equal(readFileSync(join(backup, 'checkout-revision.txt'), 'utf8').trim(), f.oldRevision);
  assert.equal(readFileSync(join(backup, 'masterdns.dump'), 'utf8'), 'complete database dump\n');
  assert(!result.stdout.includes('test-secret-do-not-print'));
  const events = f.events();
  assert.deepEqual(events.filter(e => e.stage !== 'other').map(e => e.stage), ['build', 'preflight-1', 'stop', 'dump', 'preflight-2', 'migrate', 'start-api', 'start-apps']);
  for (const event of events.filter(e => e.stage.startsWith('start-'))) {
    for (const flag of ['--no-deps', '--no-build', '--wait']) assert(event.args.includes(flag));
  }
  assert.equal(events.filter(e => e.args[0] === 'image' && e.args[1] === 'tag').length, 3);
  assert(!events.some(e => e.args.includes('down') || e.args.includes('prune')));
  assert(!existsSync(join(f.repo, '.git/masterdns-update.lock')));
});

for (const stage of ['build', 'preflight-1', 'stop', 'dump', 'preflight-2', 'migrate', 'start-api']) {
  test(`${stage} failure stops later unsafe work and preserves backup evidence`, () => {
    const f = setup();
    const result = f.run({ UPDATE_TEST_FAIL: stage });
    assert.equal(result.status, 73, result.stderr);
    const events = f.events();
    assert(!events.some(e => e.stage === 'start-apps'));
    if (stage !== 'start-api') assert(!events.some(e => e.stage === 'start-api'));
    if (['build', 'preflight-1'].includes(stage)) assert(!events.some(e => e.stage === 'stop'));
    if (['build', 'preflight-1', 'stop', 'dump', 'preflight-2'].includes(stage)) assert(!events.some(e => e.stage === 'migrate'));
    const [backup] = f.backups();
    assert(existsSync(join(backup, '.env')));
    if (stage === 'dump') {
      assert(existsSync(join(backup, 'masterdns.dump.partial')));
      assert(!existsSync(join(backup, 'masterdns.dump')));
    }
    assert(!existsSync(join(f.repo, '.git/masterdns-update.lock')));
  });
}

test('rejects tracked local changes without changing Git or stopping services', () => {
  const f = setup();
  writeFileSync(join(f.repo, 'docker-compose.yml'), 'local configuration');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(f.repo, 'docker-compose.yml'), 'utf8'), 'local configuration');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.oldRevision);
  assert(!f.events().some(e => e.stage === 'stop'));
});

test('does not deploy local master commits absent from origin/master', () => {
  const f = setup();
  writeFileSync(join(f.repo, 'local.txt'), 'unpublished');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'local work');
  const localRevision = git(f.repo, 'rev-parse', 'HEAD');
  assert.notEqual(f.run().status, 0);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), localRevision);
  assert(!f.events().some(e => ['build', 'stop', 'migrate'].includes(e.stage)));
});

test('refuses a remote tracked .env before it can overwrite deployment credentials', () => {
  const f = setup();
  writeFileSync(join(f.remote, '.env'), 'wrong deployment credentials\n');
  git(f.remote, 'add', '--force', '.env'); git(f.remote, 'commit', '-m', 'bad tracked environment');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(f.repo, '.env'), 'utf8'), 'MASTER_ENCRYPTION_KEY=test-secret-do-not-print\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.oldRevision);
  assert(!f.events().some(e => ['build', 'stop'].includes(e.stage)));
});

test('refuses local master tracking .env before switching from a deployment branch', () => {
  const f = setup();
  writeFileSync(join(f.repo, '.env'), 'old branch credentials\n');
  git(f.repo, 'add', '--force', '.env'); git(f.repo, 'commit', '-m', 'old tracked environment');
  git(f.repo, 'switch', '-c', 'deployment');
  git(f.repo, 'rm', '--cached', '.env'); git(f.repo, 'commit', '-m', 'untrack credentials');
  writeFileSync(join(f.repo, '.env'), 'current deployment credentials\n');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(f.repo, '.env'), 'utf8'), 'current deployment credentials\n');
  assert.equal(git(f.repo, 'branch', '--show-current'), 'deployment');
});

test('rejects backup directories inside the build context, including symlinks', () => {
  const f = setup();
  const result = f.run({ MASTERDNS_BACKUP_ROOT: join(f.repo, 'backups') });
  assert.notEqual(result.status, 0);
  assert(!f.events().some(e => ['build', 'stop'].includes(e.stage)));
  const link = join(f.root, 'backup-link');
  symlinkSync(join(f.repo, 'backups'), link);
  assert.notEqual(f.run({ MASTERDNS_BACKUP_ROOT: link }).status, 0);
  assert(!f.events().some(e => ['build', 'stop'].includes(e.stage)));
});

test('retains a previous interrupted update lock instead of stealing it', () => {
  const f = setup();
  const lock = join(f.repo, '.git/masterdns-update.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), 'previous owner');
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), 'previous owner');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.oldRevision);
  assert.equal(f.events().length, 0);
});

test('a source update replacing update.sh cannot interrupt the already parsed workflow', () => {
  const f = setup();
  writeFileSync(join(f.remote, 'update.sh'), '#!/usr/bin/env bash\nexit 91\n');
  git(f.remote, 'add', '.'); git(f.remote, 'commit', '-m', 'replace updater');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.repo, 'update.sh'), 'utf8'), '#!/usr/bin/env bash\nexit 91\n');
  assert(f.events().some(e => e.stage === 'start-apps'));
});

test('concurrent invocation cannot enter the update workflow', async () => {
  const f = setup();
  const ready = join(f.root, 'ready');
  const release = join(f.root, 'release');
  const child = spawn('bash', [join(f.repo, 'update.sh')], { env: { ...f.env, UPDATE_TEST_BLOCK: 'build', UPDATE_TEST_READY: ready, UPDATE_TEST_RELEASE: release }, stdio: 'ignore' });
  const completed = new Promise(resolveExit => child.on('close', resolveExit));
  try {
    for (let i = 0; i < 150 && !existsSync(ready); i++) await delay(20);
    assert(existsSync(ready), 'first updater did not reach build');
    const second = f.run();
    assert.notEqual(second.status, 0);
    assert.equal(f.events().filter(e => e.stage === 'build').length, 1);
  } finally {
    writeFileSync(release, 'continue');
    assert.equal(await completed, 0);
  }
});
