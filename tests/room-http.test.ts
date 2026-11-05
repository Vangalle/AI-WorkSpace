import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AgentEngine } from '../src/engine.js';
import { createEngineServer } from '../src/http.js';
import { config, deferred } from './helpers.js';
import type { Room, RoomEvent } from '../src/rooms/types.js';

const admin = 'admin-test-token-123456789012345';
const alice = 'alice-test-token-123456789012345';
const bob = 'bob-test-token-12345678901234567';
const outsider = 'outsider-token-12345678901234567';

async function setup(
  engine = new AgentEngine(
    {
      load: async () => ({
        receive: async () => 'direct',
        observe: async () => ({ action: 'silent' }),
        dispose: () => {},
      }),
    },
    { roomDebounceMs: 0 },
  ),
) {
  engine.registerAgent(config('a'));
  await engine.startAgent('a');
  const server = createEngineServer(engine, {
    token: admin,
    userTokens: { 'user:alice': alice, 'user:bob': bob, 'user:outsider': outsider },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (token: string, path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const close = async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  const created = await request(alice, '/rooms', 'POST', {
    participants: ['user:alice', 'user:bob', 'agent:a'],
  });
  if (created.status !== 201) await close();
  assert.equal(created.status, 201);
  const room = (await created.json()) as Room;
  return { engine, server, base, request, room, close };
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
): Promise<RoomEvent> {
  for (;;) {
    const boundary = buffer.text.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffer.text.slice(0, boundary);
      buffer.text = buffer.text.slice(boundary + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6)) as RoomEvent;
    } else {
      const next = await reader.read();
      if (next.done) throw new Error('Stream closed before event');
      buffer.text += new TextDecoder().decode(next.value);
    }
  }
}

test('HTTP room supports independent humans without granting legacy admin permissions', async (t) => {
  const service = await setup();
  t.after(() => service.close());
  const { request, room } = service;
  const sent = await request(alice, `/rooms/${room.id}/messages`, 'POST', {
    text: 'hello Bob',
    clientId: 'one',
  });
  assert.equal(sent.status, 201);
  const message = (await sent.json()) as { id: string; from: string };
  assert.equal(message.from, 'user:alice');
  const replay = await request(alice, `/rooms/${room.id}/messages`, 'POST', {
    text: 'hello Bob',
    clientId: 'one',
  });
  assert.equal(((await replay.json()) as { id: string }).id, message.id);
  await request(bob, `/rooms/${room.id}/messages`, 'POST', { text: 'Hi Alice' });
  const view = (await (await request(bob, `/rooms/${room.id}`)).json()) as Room;
  assert.deepEqual(
    view.messages.map((m) => m.from),
    ['user:alice', 'user:bob'],
  );
  assert.equal((await request(alice, '/agents')).status, 403);
  assert.equal((await request(alice, '/agents/a/stop', 'POST')).status, 403);
  assert.equal((await request(alice, '/messages', 'POST', {})).status, 403);
  assert.equal((await request(admin, '/agents')).status, 200);
  assert.equal(
    ((await (await request(bob, '/health')).json()) as { principal: string }).principal,
    'user:bob',
  );
});

test('HTTP denies outsiders, spoofed senders and unconfigured human identities', async (t) => {
  const { request, room, close } = await setup();
  t.after(close);
  for (const path of [
    `/rooms/${room.id}`,
    `/rooms/${room.id}/messages`,
    `/rooms/${room.id}/events`,
  ]) {
    assert.equal((await request(outsider, path)).status, 403);
  }
  assert.equal(
    (await request(outsider, `/rooms/${room.id}/messages`, 'POST', { text: 'no' })).status,
    403,
  );
  assert.equal(
    (await request(alice, `/rooms/${room.id}/messages`, 'POST', { from: 'agent:a', text: 'spoof' }))
      .status,
    400,
  );
  assert.equal(
    (await request(alice, '/rooms', 'POST', { participants: ['user:alice', 'user:unknown'] }))
      .status,
    400,
  );
  assert.equal(
    (await request(bob, '/rooms', 'POST', { participants: ['user:alice', 'agent:a'] })).status,
    403,
  );
  assert.deepEqual(await (await request(outsider, '/rooms')).json(), []);
  assert.equal((await request('bad-token', `/rooms/${room.id}`)).status, 401);
});

test('HTTP immediately admits @ commands while the agent is still thinking', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const engine = new AgentEngine(
    {
      load: async () => ({
        receive: async () => 'direct',
        observe: async () => {
          entered.resolve();
          await release.promise;
          return { action: 'reply', text: 'Command handled' };
        },
        dispose: () => {},
      }),
    },
    { roomDebounceMs: 0 },
  );
  const service = await setup(engine);
  t.after(async () => {
    release.resolve();
    await service.close();
  });
  const response = await service.request(alice, `/rooms/${service.room.id}/messages`, 'POST', {
    text: '@a summarize',
  });
  assert.equal(response.status, 201);
  await entered.promise;
  const view = (await (await service.request(bob, `/rooms/${service.room.id}`)).json()) as Room;
  assert.equal(view.messages.length, 1);
  assert.deepEqual(view.messages[0]?.mentions, ['agent:a']);
  assert.equal(view.activity.length, 0);
});

test('authenticated SSE replays and follows room messages with a resumable event cursor', async (t) => {
  const service = await setup();
  t.after(() => service.close());
  const { request, room, base } = service;
  await request(alice, `/rooms/${room.id}/messages`, 'POST', { text: 'first' });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/rooms/${room.id}/events`, {
    headers: { authorization: `Bearer ${bob}` },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  const buffer = { text: '' };
  const first = await nextEvent(reader, buffer);
  assert.equal(first.type, 'message');
  if (first.type === 'message') assert.equal(first.message.text, 'first');
  await request(bob, `/rooms/${room.id}/messages`, 'POST', { text: 'second' });
  let second: RoomEvent;
  do {
    second = await nextEvent(reader, buffer);
  } while (second.type !== 'message');
  assert.equal(second.message.text, 'second');
  assert.ok(second.seq > first.seq);
  await reader.cancel();
  const resumed = await fetch(`${base}/rooms/${room.id}/events`, {
    headers: { authorization: `Bearer ${alice}`, 'last-event-id': String(first.seq) },
    signal: controller.signal,
  });
  const resumedReader = resumed.body!.getReader();
  const replay = await nextEvent(resumedReader, { text: '' });
  assert.equal(replay.seq, first.seq + 1);
  await resumedReader.cancel();
  assert.equal((await request(alice, `/rooms/${room.id}/events?after=-1`)).status, 400);
  assert.equal((await request(alice, `/rooms/${room.id}/events?after=999999`)).status, 400);
});

test('server rejects duplicate, weak or non-user credentials', () => {
  const engine = new AgentEngine({
    load: async () => {
      throw new Error('unused');
    },
  });
  for (const userTokens of [
    { 'user:alice': admin },
    { 'user:alice': 'short' },
    { 'agent:a': alice },
    { 'user:alice': alice, 'user:bob': alice },
  ]) {
    assert.throws(() => createEngineServer(engine, { token: admin, userTokens }), {
      code: 'INVALID_INPUT',
    });
  }
});

test('terminal room client can post as a user and read another user over SSE', async (t) => {
  const service = await setup();
  t.after(() => service.close());
  const child = spawn(process.execPath, ['examples/room-chat.mjs', service.room.id], {
    cwd: process.cwd(),
    env: { ...process.env, ENGINE_URL: service.base, ENGINE_TOKEN: alice },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 3000;
    while (!output.includes(text)) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error(`Missing ${text}; stdout=${output}; stderr=${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor('Connected');
  child.stdin.write('hello from terminal\n');
  await waitFor('user:alice: hello from terminal');
  await service.request(bob, `/rooms/${service.room.id}/messages`, 'POST', {
    text: 'hello terminal',
  });
  await waitFor('user:bob: hello terminal');
  const exit = once(child, 'exit');
  child.stdin.write('/quit\n');
  const [code] = await exit;
  assert.equal(code, 0);
});
