// Opt-in PostgreSQL restore drill. Creates and drops only randomly named test databases.
// Example: RESTORE_TEST_ENABLED=1 RESTORE_TEST_CONTAINER=test-postgres \
// PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=test node scripts/test-database-restore.ts
// For Podman also set RESTORE_TEST_ENGINE=podman and optionally RESTORE_TEST_CONNECTION.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

if (process.env.RESTORE_TEST_ENABLED !== '1' || !process.env.RESTORE_TEST_CONTAINER) {
  console.error('Set RESTORE_TEST_ENABLED=1 and RESTORE_TEST_CONTAINER for an isolated PostgreSQL server.');
  process.exit(1);
}
const dbRequire = createRequire(resolve(__dirname, '../packages/db/package.json'));
const postgres = dbRequire('postgres');
const { drizzle } = dbRequire('drizzle-orm/postgres-js');
const { migrate } = dbRequire('drizzle-orm/postgres-js/migrator');
const engine = process.env.RESTORE_TEST_ENGINE || 'docker';
assert(['docker', 'podman'].includes(engine));
const engineArgs = process.env.RESTORE_TEST_CONNECTION ? ['--connection', process.env.RESTORE_TEST_CONNECTION] : [];
const container = process.env.RESTORE_TEST_CONTAINER;
const user = process.env.PGUSER || 'postgres';
const prefix = `md_restore_${randomBytes(6).toString('hex')}`;
const names = Object.fromEntries(['old', 'live', 'unsafe', 'restored', 'failed', 'preserved'].map(key => [key, `${prefix}_${key}`]));
const created = new Set();
const temp = mkdtempSync(join(tmpdir(), 'masterdns-restore-'));
const migrationCopy = join(temp, 'migrations');
cpSync(resolve(__dirname, '../packages/db/drizzle'), migrationCopy, { recursive: true });
const journalPath = join(migrationCopy, 'meta/_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const oldJournal = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 10) };
assert.equal(oldJournal.entries.length, 11);
const connection = database => postgres({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  username: user, password: process.env.PGPASSWORD, database, max: 1, onnotice: () => {},
});

function command(program, args, input, expectedFailure = false) {
  const result = spawnSync(engine, [...engineArgs, 'exec', '-i', container, program, ...args], {
    input, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (expectedFailure) {
    assert.notEqual(result.status, 0, `${program} unexpectedly succeeded`);
    return result.stderr.toString();
  }
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
function sql(database, query, expectedFailure = false) {
  return command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', user, '-d', database], query, expectedFailure).toString().trim();
}
function create(database) {
  sql('postgres', `CREATE DATABASE "${database}" TEMPLATE template0;`);
  created.add(database);
}
async function applyMigrations(database, old = false) {
  writeFileSync(journalPath, JSON.stringify(old ? oldJournal : journal));
  const client = connection(database);
  try { await migrate(drizzle(client), { migrationsFolder: migrationCopy }); }
  finally { await client.end(); }
}
function restore(database, dump, options = [], expectedFailure = false) {
  return command('pg_restore', ['--exit-on-error', ...options, '-U', user, '-d', database], dump, expectedFailure);
}
function snapshot(database) {
  return sql(database, `SELECT jsonb_build_object(
    'users', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
    'addresses', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM endpoint_addresses t),
    'records', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM dns_records t),
    'credentials', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM provider_accounts t),
    'constraints', (SELECT jsonb_agg(conname ORDER BY conname) FROM pg_constraint WHERE connamespace='public'::regnamespace),
    'migrations', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM drizzle.__drizzle_migrations t));`);
}
function switchSql(checkClients = true) {
  return `BEGIN;
    SET LOCAL lock_timeout = '10s';
    SET LOCAL statement_timeout = '30s';
    ${checkClients ? `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname IN ('${names.live}', '${names.restored}')) THEN
        RAISE EXCEPTION 'Stop all clients before switching';
      END IF;
    END $$;` : ''}
    ALTER DATABASE "${names.live}" RENAME TO "${names.preserved}";
    ALTER DATABASE "${names.restored}" RENAME TO "${names.live}";
    COMMIT;`;
}

async function main() {
  // Ensure container CLI and TCP migrator address the same server before creating fixtures.
  const admin = connection('postgres');
  try {
    const [identity] = await admin`SELECT system_identifier::text AS id FROM pg_control_system()`;
    assert.equal(identity.id, sql('postgres', 'SELECT system_identifier FROM pg_control_system();'));
  } finally { await admin.end(); }
  console.log(sql('postgres', 'SELECT version();'));
  create(names.old);
  await applyMigrations(names.old, true);
  sql(names.old, `
    INSERT INTO users (id, username, password_hash) VALUES ('00000000-0000-4000-8000-000000000001', 'restore-original', 'fixture-hash');
    INSERT INTO endpoint_pools (id, owner_user_id, name, strategy) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'restore-pool', 'primary_backup');
    INSERT INTO endpoints (id, pool_id, name) VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'restore-endpoint');
    INSERT INTO endpoint_addresses (endpoint_id, family, address, state, source) VALUES ('00000000-0000-4000-8000-000000000003', '4', '192.0.2.31', 'current', 'static');
    INSERT INTO provider_accounts (id, owner_user_id, provider, name, credential_ciphertext, credential_iv, credential_tag) VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'cloudflare', 'restore-provider', 'fixture-ciphertext', 'fixture-iv', 'fixture-tag');
    INSERT INTO zones (id, provider_account_id, external_id, name_ascii) VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000004', 'restore-zone', 'restore.example');
    INSERT INTO dns_records (zone_id, external_id, type, name, content, ttl, remote_hash) VALUES ('00000000-0000-4000-8000-000000000005', 'restore-record', 'A', 'restore.example', '192.0.2.31', 60, 'fixture-hash');`);
  const oldSnapshot = snapshot(names.old);
  const dump = command('pg_dump', ['-U', user, '-d', names.old, '-Fc']);
  for (const database of [names.live, names.unsafe]) {
    create(database);
    restore(database, dump, ['--single-transaction']);
    await applyMigrations(database);
  }
  sql(names.live, "UPDATE users SET username='post-upgrade-preserved';");
  const liveSnapshot = snapshot(names.live);
  const beforeUnsafe = snapshot(names.unsafe);
  restore(names.unsafe, dump, ['--clean', '--if-exists', '--single-transaction'], true);
  assert.equal(snapshot(names.unsafe), beforeUnsafe);
  console.log('PASS: --single-transaction prevents partial cleanup but still cannot restore over newer dependencies.');
  const unsafeError = restore(names.unsafe, dump, ['--clean', '--if-exists'], true);
  assert.match(unsafeError, /other objects depend on it/);
  assert.notEqual(snapshot(names.unsafe), beforeUnsafe);
  console.log('PASS: legacy in-place --clean restore fails on new dependencies and leaves partial schema cleanup.');
  console.log(unsafeError.trim());

  create(names.failed);
  restore(names.failed, dump.subarray(0, Math.floor(dump.length * 0.8)), ['--single-transaction'], true);
  assert.equal(sql(names.failed, "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle');"), '0');
  assert.equal(snapshot(names.live), liveSnapshot);
  console.log('PASS: truncated archive restore fails atomically in fresh database; original remains unchanged.');

  create(names.restored);
  restore(names.restored, dump, ['--single-transaction']);
  assert.equal(snapshot(names.restored), oldSnapshot);
  assert.equal(sql(names.restored, 'SELECT count(*) FROM drizzle.__drizzle_migrations;'), '11');
  assert.equal(sql(names.restored, "SELECT to_regclass('public.cloud_accounts') IS NULL;"), 't');
  assert.equal(snapshot(names.live), liveSnapshot);
  console.log('PASS: fresh restore exactly preserves old users, addresses, DNS records, encrypted fields, constraints and migration journal.');

  // A live connection must prevent switching, without forced termination.
  const active = connection(names.restored);
  try {
    await active`SELECT 1`;
    assert.match(sql('postgres', switchSql(), true), /Stop all clients before switching/);
    // Also test the rename's protection if a connection arrives after the precheck.
    const error = sql('postgres', switchSql(false), true);
    assert.match(error, /being accessed by other users/);
    assert.equal(sql('postgres', `SELECT count(*) FROM pg_database WHERE datname='${names.preserved}';`), '0');
    assert.equal(snapshot(names.live), liveSnapshot);
  } finally { await active.end(); }
  console.log('PASS: active restore client rejects second rename and rolls back first rename.');

  const liveOid = sql('postgres', `SELECT oid FROM pg_database WHERE datname='${names.live}';`);
  const restoredOid = sql('postgres', `SELECT oid FROM pg_database WHERE datname='${names.restored}';`);
  sql('postgres', switchSql());
  created.delete(names.restored);
  created.add(names.preserved);
  assert.equal(sql('postgres', `SELECT oid FROM pg_database WHERE datname='${names.preserved}';`), liveOid);
  assert.equal(sql('postgres', `SELECT oid FROM pg_database WHERE datname='${names.live}';`), restoredOid);
  assert.equal(snapshot(names.preserved), liveSnapshot);
  assert.equal(snapshot(names.live), oldSnapshot);
  console.log('PASS: transactional rename switches restored old schema into service name and preserves original database OID/data.');

  sql('postgres', `BEGIN; ALTER DATABASE "${names.live}" RENAME TO "${names.restored}"; ALTER DATABASE "${names.preserved}" RENAME TO "${names.live}"; COMMIT;`);
  created.delete(names.preserved);
  created.add(names.restored);
  assert.equal(snapshot(names.live), liveSnapshot);
  assert.equal(snapshot(names.restored), oldSnapshot);
  console.log('PASS: reverse switch preserves both databases. No application or cloud services were started.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  let cleanupFailed = false;
  for (const database of created) {
    try { sql('postgres', `DROP DATABASE "${database}";`); }
    catch (error) { console.error(`Cleanup failed for owned test database ${database}:`, error); process.exitCode = 1; cleanupFailed = true; }
  }
  rmSync(temp, { recursive: true, force: true });
  if (!cleanupFailed) console.log('Owned test database and temporary migration cleanup complete.');
});
