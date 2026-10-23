import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../apply-log-limits.sh", import.meta.url));
const fixtures = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Docker is the external boundary; Bash, Python, private backups and Git locks are real.
const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const root = process.env.LOG_TEST_ROOT;
const statePath = root + '/state.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
let config = JSON.parse(fs.readFileSync(root + '/config.json', 'utf8'));
let command = args;
if (args[0] === 'compose') {
  command = args.slice(1);
  while (command[0]?.startsWith('-')) {
    const [flag, value] = command.splice(0, 2);
    if (flag === '-f') config = JSON.parse(fs.readFileSync(value, 'utf8').replace(/\\$\\$/g, '$'));
  }
}
const services = ['postgres', 'redis', 'api', 'worker', 'web'];
let stage = 'other';
if (command[0] === 'stop') stage = 'stop';
if (command.includes('pg_dump')) stage = 'dump';
if (command.includes('pg_restore')) stage = 'check-dump';
if (command[0] === 'up' && !command.includes('--help')) stage = command.includes('postgres') ? 'dependencies' : command.includes('api') ? 'api' : 'apps';
if (command[0] === 'rm') stage = 'remove-migrate';
fs.appendFileSync(root + '/events.jsonl', JSON.stringify({ args, command, stage }) + '\\n');
if (process.env.LOG_TEST_FAIL === stage) {
  if (stage === 'dump') process.stdout.write('incomplete');
  process.stderr.write('injected ' + stage + ' failure\\n');
  process.exit(73);
}
if (args[0] === 'inspect') {
  const service = Object.keys(state).find(name => state[name].Id === args.at(-1));
  if (!service) process.exit(74);
  process.stdout.write(JSON.stringify([state[service]]));
} else if (args[0] !== 'compose') process.exit(75);
else if (command[0] === 'version') process.stdout.write('Docker Compose version v2.39.0\\n');
else if (command.includes('--help')) process.stdout.write('--wait --wait-timeout --pull\\n');
else if (command[0] === 'config') {
  // Real Compose emits dollar-escaped canonical values even with --format json.
  if (!command.includes('--quiet')) process.stdout.write(JSON.stringify(config).replace(/\\$/g, '$$$$'));
} else if (command[0] === 'ps') {
  if (command.includes('-q')) process.stdout.write(state[command.at(-1)]?.Id ?? '');
} else if (command[0] === 'logs') process.stdout.write('recent runtime logs\\n');
else if (stage === 'stop') {
  for (const name of services.filter(name => command.includes(name))) state[name].State.Running = false;
} else if (stage === 'dump') {
  if (!command.includes('-Fc')) process.exit(76);
  if (!process.env.LOG_TEST_EMPTY_DUMP) process.stdout.write('complete database archive');
} else if (stage === 'check-dump') {
  if (!command.includes('--file=/dev/null') || fs.readFileSync(0, 'utf8') !== 'complete database archive') process.exit(77);
} else if (['dependencies', 'api', 'apps'].includes(stage)) {
  for (const flag of ['--no-deps', '--no-build', '--force-recreate', '--wait']) if (!command.includes(flag)) process.exit(78);
  if (command[command.indexOf('--pull') + 1] !== 'never') process.exit(79);
  for (const name of services.filter(name => command.includes(name))) {
    const service = config.services[name];
    state[name].Id = 'new-' + name;
    state[name].Image = service.image;
    state[name].State.Running = true;
    state[name].Config.Env = Object.entries(service.environment ?? {}).map(([key, value]) => key + '=' + value);
    state[name].HostConfig.LogConfig = { Type: service.logging.driver, Config: service.logging.options };
    for (const mount of state[name].Mounts) {
      const source = service.volumes.find(item => item.target === mount.Destination).source;
      if (config.volumes[source].external !== true) process.exit(80);
      mount.Name = config.volumes[source].name;
    }
  }
  if (stage === 'dependencies' && process.env.LOG_TEST_DRIFT === 'volume') state.postgres.Mounts[0].Name = 'wrong-volume';
  if (stage === 'dependencies' && process.env.LOG_TEST_DRIFT === 'image') state.postgres.Image = 'sha256:wrong';
  if (stage === 'apps' && process.env.LOG_TEST_DRIFT === 'logging') state.worker.HostConfig.LogConfig.Config = {};
} else if (stage !== 'remove-migrate') process.exit(81);
fs.writeFileSync(statePath, JSON.stringify(state));
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "masterdns-log-test-"));
  fixtures.push(root);
  const repo = join(root, "deployment with spaces");
  const bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(bin);
  assert.equal(spawnSync("git", ["init", repo]).status, 0);
  copyFileSync(source, join(repo, "apply-log-limits.sh"));
  const secret = "test-only-${DO_NOT_EXPAND}-key";
  writeFileSync(join(repo, ".env"), "MASTER_ENCRYPTION_KEY=" + secret + "\n");
  writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
  const config = { name: "masterdns", services: {}, volumes: {
    "masterdns-postgres": { name: "masterdns_masterdns-postgres" },
    "masterdns-redis": { name: "masterdns_masterdns-redis" },
  } };
  const state = {};
  for (const [index, name] of ["postgres", "redis", "api", "worker", "web", "migrate"].entries()) {
    const environment = name === "postgres" ? { POSTGRES_USER: "masterdns", POSTGRES_DB: "masterdns", POSTGRES_PASSWORD: "test-db-password" }
      : ["api", "worker"].includes(name) ? { MASTER_ENCRYPTION_KEY: secret, PGPASSWORD: "test-db-password" } : {};
    config.services[name] = { image: "tag-that-may-now-point-elsewhere:" + name, environment, logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3", compress: "true" } } };
    if (name === "migrate") continue;
    state[name] = { Id: "old-" + name, Image: "sha256:" + String(index + 1).repeat(64), State: { Running: true },
      Config: { Env: Object.entries(environment).map(([k, v]) => k + "=" + v), Labels: { "com.docker.compose.project": "masterdns", "com.docker.compose.service": name } },
      HostConfig: { LogConfig: { Type: "json-file", Config: {} } }, Mounts: [] };
    if (["postgres", "redis"].includes(name)) {
      const target = name === "postgres" ? "/var/lib/postgresql/data" : "/data";
      config.services[name].volumes = [{ type: "volume", source: "masterdns-" + name, target }];
      state[name].Mounts = [{ Type: "volume", Name: "masterdns_masterdns-" + name, Destination: target, RW: true }];
    }
  }
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  writeFileSync(join(root, "state.json"), JSON.stringify(state));
  writeFileSync(join(bin, "docker"), fakeDocker); chmodSync(join(bin, "docker"), 0o755);
  const backupRoot = join(root, "private backups");
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, LOG_TEST_ROOT: root, MASTERDNS_BACKUP_ROOT: backupRoot };
  const run = extra => spawnSync("bash", [join(repo, "apply-log-limits.sh")], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 });
  const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const backups = () => existsSync(backupRoot) ? readdirSync(backupRoot).map(name => join(backupRoot, name)) : [];
  return { root, repo, config, state, secret, backupRoot, run, events, backups };
}

test("backs up before recreation and preserves active images, data volumes and literal secrets", () => {
  const f = setup();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.backups().length, 1);
  const [backup] = f.backups();
  assert.equal(readFileSync(join(backup, ".env"), "utf8"), readFileSync(join(f.repo, ".env"), "utf8"));
  assert.equal(readFileSync(join(backup, "masterdns.dump"), "utf8"), "complete database archive");
  for (const path of [backup, join(backup, ".env"), join(backup, "runtime.compose.json"), join(backup, "masterdns.dump")]) assert.equal(statSync(path).mode & 0o077, 0);
  const after = JSON.parse(readFileSync(join(f.root, "state.json"), "utf8"));
  for (const name of Object.keys(f.state)) {
    assert.equal(after[name].Image, f.state[name].Image);
    assert.deepEqual(after[name].Mounts, f.state[name].Mounts);
    assert.deepEqual(after[name].Config.Env, f.state[name].Config.Env);
  }
  assert(!result.stdout.includes(f.secret) && !result.stderr.includes(f.secret));
  assert.deepEqual(f.events().filter(e => e.stage !== "other").map(e => e.stage), ["stop", "dump", "check-dump", "dependencies", "api", "apps", "remove-migrate"]);
  assert(!f.events().some(e => e.command.some(arg => ["down", "prune", "run", "build", "pull", "--volumes", "-v"].includes(arg))));
  assert(!existsSync(join(f.repo, ".git/masterdns-update.lock")));
});

for (const stage of ["stop", "dump", "check-dump", "dependencies", "api", "apps"]) {
  test(`${stage} failure stops later changes and reports retained backup`, () => {
    const f = setup();
    const result = f.run({ LOG_TEST_FAIL: stage });
    assert.equal(result.status, 73, result.stderr);
    const stages = f.events().filter(e => e.stage !== "other").map(e => e.stage);
    assert.equal(stages.at(-1), stage);
    assert(result.stderr.includes(f.backups()[0]));
    if (["dump", "check-dump"].includes(stage)) {
      assert(existsSync(join(f.backups()[0], "masterdns.dump.partial")));
      assert(!existsSync(join(f.backups()[0], "masterdns.dump")));
    }
    assert(!existsSync(join(f.repo, ".git/masterdns-update.lock")));
  });
}

test("empty dump cannot proceed to container recreation", () => {
  const f = setup();
  assert.notEqual(f.run({ LOG_TEST_EMPTY_DUMP: "1" }).status, 0);
  assert(!f.events().some(e => e.stage === "dependencies"));
});

for (const mismatch of ["key", "volume", "logging", "stopped", "database", "migration"]) {
  test(`rejects ${mismatch} preflight mismatch before stopping any service`, () => {
    const f = setup();
    if (mismatch === "key") f.config.services.api.environment.MASTER_ENCRYPTION_KEY = "wrong-key";
    if (mismatch === "volume") f.config.volumes["masterdns-postgres"].name = "empty-new-volume";
    if (mismatch === "logging") f.config.services.worker.logging.options["max-size"] = "-1";
    if (mismatch === "stopped") f.state.api.State.Running = false;
    if (mismatch === "database") {
      f.config.services.postgres.environment.POSTGRES_DB = "different-db";
      f.state.postgres.Config.Env = f.state.postgres.Config.Env.map(value => value.startsWith("POSTGRES_DB=") ? "POSTGRES_DB=different-db" : value);
    }
    if (mismatch === "migration") f.state.migrate = { Id: "old-migrate", State: { Running: true } };
    writeFileSync(join(f.root, "config.json"), JSON.stringify(f.config));
    writeFileSync(join(f.root, "state.json"), JSON.stringify(f.state));
    assert.notEqual(f.run().status, 0);
    assert(!f.events().some(e => e.stage === "stop"));
  });
}

for (const drift of ["volume", "image", "logging"]) {
  test(`detects ${drift} drift after recreation instead of reporting success`, () => {
    const f = setup();
    assert.notEqual(f.run({ LOG_TEST_DRIFT: drift }).status, 0);
    assert(!f.events().some(e => e.stage === "remove-migrate"));
    if (drift !== "logging") assert(!f.events().some(e => e.stage === "api"));
  });
}

test("shares the update lock and never removes a lock belonging to another operation", () => {
  const f = setup();
  const lock = join(f.repo, ".git/masterdns-update.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), "existing updater");
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), "existing updater");
  assert.equal(f.events().length, 0);
});

test("rejects a backup directory inside the project before stopping services", () => {
  const f = setup();
  assert.notEqual(f.run({ MASTERDNS_BACKUP_ROOT: join(f.repo, "backups") }).status, 0);
  assert(!f.events().some(e => e.stage === "stop"));
});

test("frozen configuration survives a real Compose parse without double escaping credentials", { skip: !process.env.MASTERDNS_TEST_COMPOSE_BINARY }, () => {
  const f = setup();
  assert.equal(f.run().status, 0);
  const result = spawnSync(process.env.MASTERDNS_TEST_COMPOSE_BINARY, ["--env-file", "/dev/null", "-f", join(f.backups()[0], "runtime.compose.json"), "config", "--format", "json"], {
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.services.api.environment.MASTER_ENCRYPTION_KEY, "test-only-$${DO_NOT_EXPAND}-key");
  assert.equal(config.services.api.image, f.state.api.Image);
  assert.equal(config.volumes["masterdns-postgres"].external, true);
  assert.equal(config.volumes["masterdns-postgres"].name, "masterdns_masterdns-postgres");
});
