import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { ChatApplication } from '../src/application.js';
import { createChatServer } from '../src/http.js';
import { PiRuntimeFactory } from '../src/runtime/pi.js';
import { config } from './helpers.js';
import { fixtureProvider } from './fixtures/provider.js';

const aliceToken = 'cli-alice-token-123456789012345';
const bobToken = 'cli-bob-token-12345678901234567';

function client(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/chat.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
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
  return {
    child,
    exit,
    output: () => ({ stdout, stderr }),
    async waitFor(text: string) {
      const deadline = Date.now() + 5000;
      while (!stdout.includes(text)) {
        assert.ok(
          child.exitCode === null && Date.now() < deadline,
          `Missing ${text}; stdout=${stdout}; stderr=${stderr}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async quit() {
      child.stdin.write('/quit\n');
      assert.equal((await exit)[0], 0, stderr);
    },
  };
}

test('primary chat joins a shared room, exchanges multiple messages and leaves the room alive on exit', async (t) => {
  const fixture = await fixtureProvider();
  const app = new ChatApplication(
    new PiRuntimeFactory({
      cwd: fixture.directory,
      agentDir: fixture.directory,
      modelsPath: fixture.modelsPath,
    }),
    { roomDebounceMs: 0 },
  );
  app.agents.registerAgent(config('a', { model: { provider: 'fixture', id: 'fixture-model' } }));
  await app.agents.startAgent('a');
  const room = app.rooms.create(['user:alice', 'user:bob', 'agent:a']);
  const server = createChatServer(app, {
    token: 'cli-admin-token-123456789012345',
    userTokens: { 'user:alice': aliceToken, 'user:bob': bobToken },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  });
  const alice = client([room.id], { ENGINE_URL: base, ENGINE_TOKEN: aliceToken });
  const bob = client([room.id], { ENGINE_URL: base, ENGINE_TOKEN: bobToken });
  t.after(() => {
    alice.child.kill();
    bob.child.kill();
  });
  await Promise.all([alice.waitFor('Connected.'), bob.waitFor('Connected.')]);
  alice.child.stdin.write('@a first message\n');
  await Promise.all([
    alice.waitFor('agent:a: room fixture reply'),
    bob.waitFor('user:alice: @a first message'),
  ]);
  bob.child.stdin.write('second message\n');
  await alice.waitFor('user:bob: second message');
  await alice.quit();
  assert.equal(app.agents.getAgent('a').status, 'running');
  bob.child.stdin.write('after alice left\n');
  await bob.waitFor('user:bob: after alice left');
  const rejoined = client([room.id], { ENGINE_URL: base, ENGINE_TOKEN: aliceToken });
  t.after(() => rejoined.child.kill());
  await rejoined.waitFor('user:bob: after alice left');
  await rejoined.waitFor('Connected.');
  assert.equal(app.rooms.get(room.id, 'user:alice').messages[0]?.text, '@a first message');
  assert.ok(fixture.requests[0]?.tools?.some((tool) => tool.function.name === 'room_action'));
  await Promise.all([rejoined.quit(), bob.quit()]);
});

test('primary chat validates room arguments instead of creating a one-shot engine', async (t) => {
  for (const args of [[], ['invalid/room']]) {
    const process = client(args, { ENGINE_TOKEN: aliceToken });
    t.after(() => process.child.kill());
    assert.equal((await process.exit)[0], 1);
    assert.match(process.output().stderr, /npm run chat/);
    assert.doesNotMatch(process.output().stderr, /ENOENT|stack|node:internal/);
  }
});
