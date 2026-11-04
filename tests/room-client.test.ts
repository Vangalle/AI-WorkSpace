import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AgentEngine } from '../src/engine.js';
import { createEngineServer } from '../src/http.js';
import { config } from './helpers.js';
import type { Room } from '../src/rooms/types.js';

const token = 'terminal-recovery-token-123456789';

function client(base: string, roomId: string) {
  const child = spawn(process.execPath, ['examples/room-chat.mjs', roomId], { env: { ...process.env, ENGINE_URL: base, ENGINE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const wait = async (check: (output: { stdout: string; stderr: string }) => boolean) => {
    const deadline = Date.now() + 4000;
    while (!check({ stdout, stderr })) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Expected client output missing: stdout=${stdout}; stderr=${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { child, wait, output: () => ({ stdout, stderr }), async quit() { const exit = once(child, 'exit'); child.stdin.write('/quit\n'); const [code] = await exit; assert.equal(code, 0); } };
}

test('terminal startup shows historical failed @ commands rather than skipping their activity', async (t) => {
  const engine = new AgentEngine({ load: async () => ({ receive: async () => 'direct', observe: async () => ({ action: 'silent' }), dispose: () => {} }) }, { roomDebounceMs: 0 });
  engine.registerAgent(config('a'));
  await engine.startAgent('a');
  const room = engine.rooms.create(['user:alice', 'agent:a']);
  engine.rooms.post(room.id, 'user:alice', { text: '@a old command' });
  while (!engine.rooms.get(room.id, 'user:alice').activity.length) await new Promise((resolve) => setTimeout(resolve, 5));
  const server = createEngineServer(engine, { token: 'recovery-admin-token-123456789', userTokens: { 'user:alice': token } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await engine.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const terminal = client(`http://127.0.0.1:${address.port}`, room.id);
  t.after(() => terminal.child.kill());
  await terminal.wait(({ stdout }) => stdout.includes('Connected'));
  await terminal.wait(({ stderr }) => stderr.includes('COMMAND_UNANSWERED'));
  assert.equal(terminal.output().stderr.match(/COMMAND_UNANSWERED/g)?.length, 1);
  await terminal.quit();
});

test('terminal expired-cursor recovery shows missed failures and deduplicates snapshot/live activity', async (t) => {
  const first = { id: 'initial-failure', agentId: 'agent:a' as const, triggerIds: ['command-1'], requested: true, status: 'failed' as const, createdAt: '2026-11-04T00:00:00Z', error: { code: 'COMMAND_UNANSWERED', message: 'First command failed' } };
  const missed = { ...first, id: 'missed-failure', triggerIds: ['command-2'], error: { code: 'TIMEOUT', message: 'Missed command timed out' } };
  const room: Room = { id: 'recovery-room', eventCursor: 10, participants: ['user:alice', 'agent:a'], messages: [], activity: [first] };
  let snapshots = 0;
  let streams = 0;
  const server = createServer((request, response) => {
    if (!request.url?.includes('/events')) {
      snapshots++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(snapshots === 1 ? room : { ...room, eventCursor: 2000, activity: [first, missed] }));
    } else {
      streams++;
      if (streams === 2) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'EVENTS_EXPIRED', message: 'Fetch snapshot' } }));
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (streams === 1) {
          response.end(`data: ${JSON.stringify({ seq: 11, roomId: room.id, type: 'activity', activity: first })}\n\n`);
        } else {
          response.write(`data: ${JSON.stringify({ seq: 2001, roomId: room.id, type: 'message', message: { id: 'catch-up-marker', from: 'user:bob', text: 'recovery-caught-up' } })}\n\n`);
        }
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const terminal = client(`http://127.0.0.1:${address.port}`, room.id);
  t.after(() => terminal.child.kill());
  await terminal.wait(({ stdout }) => stdout.includes('recovery-caught-up'));
  assert.equal(terminal.output().stderr.match(/TIMEOUT/g)?.length, 1, 'Snapshot-only missed failure must be displayed');
  assert.equal(terminal.output().stderr.match(/COMMAND_UNANSWERED/g)?.length, 1, 'Repeated activity must not be displayed twice');
  await terminal.quit();
});
