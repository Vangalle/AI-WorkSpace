import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from './helpers.js';
import { fixtureProvider } from './fixtures/provider.js';

function runChat(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/chat.ts', ...args], {
      cwd: process.cwd(), env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('cli loads config files and completes real SDK delegation against a local fixture', async (t) => {
  const fixture = await fixtureProvider();
  t.after(() => fixture.close());
  const files: string[] = [];
  for (const id of ['a', 'b']) {
    const file = join(fixture.directory, `${id}.json`);
    await writeFile(file, JSON.stringify(config(id, { model: { provider: 'fixture', id: 'fixture-model' } })));
    files.push(file);
  }
  const result = await runChat(['delegate', ...files], { ENGINE_MODELS_PATH: fixture.modelsPath, ENGINE_AUTH_PATH: join(fixture.directory, 'auth.json') });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'A concludes: fixture answer');
  assert.equal(fixture.requests.length, 3);
});

test('cli gives usage without a message and safely rejects unreadable config files', async () => {
  const usage = await runChat([]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /npm run chat/);
  const missing = await runChat(['hello', 'nonexistent-config.json']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /CONFIG_ERROR/);
  assert.doesNotMatch(missing.stderr, /ENOENT|stack|node:internal/);
});
