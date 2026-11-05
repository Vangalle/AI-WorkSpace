import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

async function start(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: { ...process.env, PORT: '0', ENGINE_TOKEN: 'server-main-admin-123456789012', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = once(child, 'exit');
  const url = async () => {
    const deadline = Date.now() + 4000;
    while (!stdout.includes('http://127.0.0.1:')) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Server failed: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return stdout.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
  };
  return {
    child,
    url,
    exit,
    stderr: () => stderr,
    close: async () => {
      child.kill('SIGTERM');
      await exit;
    },
  };
}

test('server entry configures independent user credentials from ENGINE_USER_TOKENS', async (t) => {
  const token = 'server-main-alice-123456789012';
  const server = await start({ ENGINE_USER_TOKENS: JSON.stringify({ 'user:alice': token }) });
  t.after(server.close);
  const base = await server.url();
  const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { principal: string }).principal, 'user:alice');
});

test('invalid user credential configuration fails before listening without echoing secrets', async (t) => {
  const server = await start({ ENGINE_USER_TOKENS: '{super-secret-invalid-json' });
  t.after(() => server.child.kill());
  const [code] = await Promise.race([
    server.exit,
    new Promise<['still-running']>((resolve) => setTimeout(() => resolve(['still-running']), 1500)),
  ]);
  assert.notEqual(
    code,
    'still-running',
    'Server must reject invalid user configuration before listening',
  );
  assert.notEqual(code, 0);
  assert.doesNotMatch(server.stderr(), /super-secret-invalid-json/);
  assert.match(server.stderr(), /ENGINE_USER_TOKENS/);
});
