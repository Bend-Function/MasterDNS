import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

export function redact(value: string, secrets: string[]) {
  return secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
}
export function assertSecretFree(text: string, secrets: string[]) {
  assert(!secrets.filter(Boolean).some(secret => text.includes(secret)), 'Secret detected in subprocess output');
}
export function transportEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'DOCKER_HOST', 'SSH_AUTH_SOCK']
    .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}
export async function runProcess(program: string, args: string[], capture: { secrets: string[]; output: string[] }, options: {
  env?: NodeJS.ProcessEnv; cwd?: URL; input?: string; timeoutMs?: number;
  failpoint?: { label: string; reached: Promise<void> };
} = {}) {
  const child = spawn(program, args, { env: options.env ?? transportEnvironment(), ...(options.cwd ? { cwd: options.cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', error => reject(new Error(redact(String(error), capture.secrets))));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', () => {}); child.stdin.end(options.input);
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
  try {
    if (options.failpoint) {
      await Promise.race([options.failpoint.reached, closed.then(() => { throw new Error(redact(`Child exited before ${options.failpoint!.label}: ${output}`, capture.secrets)); })]);
      child.kill('SIGKILL');
    }
    const result = await closed;
    if (options.failpoint) assert.equal(result.signal, 'SIGKILL');
    else assert.equal(result.code, 0, redact(output, capture.secrets));
    assertSecretFree(output, capture.secrets);
    return output.trim();
  } catch (error) {
    const detected = capture.secrets.filter(Boolean).some(secret => output.includes(secret));
    throw new Error(redact(String(error), capture.secrets) + (detected ? '\nSecret detected in subprocess output' : ''));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed.catch(() => {}); }
    capture.output.push(output);
  }
}
