import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentEngine } from '../src/engine.js';
import type { RoomDecision, RoomObservation } from '../src/rooms/types.js';
import { config, deferred } from './helpers.js';

async function setup(handler: (input: RoomObservation, signal: AbortSignal) => Promise<RoomDecision> = async () => ({ action: 'silent' }), options: { debounceMs?: number; maxWaitMs?: number; timeoutMs?: number } = {}) {
  const observations: RoomObservation[] = [];
  const engine = new AgentEngine({ load: async () => ({
    receive: async () => 'direct reply',
    observe: async (input, context) => { observations.push(structuredClone(input)); return handler(input, context.signal); },
    dispose: () => {},
  }) }, { roomDebounceMs: options.debounceMs ?? 10, roomMaxWaitMs: options.maxWaitMs ?? 40, timeoutMs: options.timeoutMs ?? 1000 });
  engine.registerAgent(config('a'));
  await engine.startAgent('a');
  const room = engine.rooms.create(['user:alice', 'user:bob', 'agent:a']);
  return { engine, room, observations };
}

async function until(check: () => boolean, timeout = 1500) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('room human delivery does not wait for inference; intentional silence adds no reply', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const { engine, room } = await setup(async () => { entered.resolve(); await release.promise; return { action: 'silent' }; });
  t.after(async () => { release.resolve(); await engine.close(); });
  const first = engine.rooms.post(room.id, 'user:alice', { text: 'hello' });
  assert.equal(first.from, 'user:alice');
  await entered.promise;
  engine.rooms.post(room.id, 'user:bob', { text: 'hello back' });
  assert.deepEqual(engine.rooms.get(room.id, 'user:bob').messages.map((m) => m.text), ['hello', 'hello back']);
  release.resolve();
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 2);
  assert.deepEqual(engine.rooms.get(room.id, 'user:alice').activity.map((a) => a.status), ['silent', 'silent']);
  assert.equal(engine.rooms.get(room.id, 'user:bob').messages.length, 2);
});

test('unmentioned agent may speak once; its speech does not trigger an autonomous loop', async (t) => {
  const { engine, room, observations } = await setup(async () => ({ action: 'reply', text: 'I can help with that.' }));
  t.after(() => engine.close());
  const userMessage = engine.rooms.post(room.id, 'user:alice', { text: 'We need to organize this.' });
  await until(() => engine.rooms.get(room.id, 'user:alice').messages.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const view = engine.rooms.get(room.id, 'user:bob');
  assert.equal(view.messages[1]?.from, 'agent:a');
  assert.equal(view.messages[1]?.replyTo, userMessage.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.requested, false);
});

test('exact @ commands bypass debounce and cannot silently count as handled', async (t) => {
  const { engine, room, observations } = await setup(undefined, { debounceMs: 1000, maxWaitMs: 2000 });
  t.after(() => engine.close());
  const message = engine.rooms.post(room.id, 'user:alice', { text: '请 @a，整理大家的安排' });
  assert.deepEqual(message.mentions, ['agent:a']);
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 1, 500);
  assert.equal(observations[0]?.requested, true);
  const view = engine.rooms.get(room.id, 'user:alice');
  assert.equal(view.activity[0]?.status, 'failed');
  assert.equal(view.activity[0]?.error?.code, 'COMMAND_UNANSWERED');
  assert.equal(view.messages.length, 1);
});

test('mentions do not match emails, substrings or longer agent IDs', async (t) => {
  const { engine, room } = await setup();
  t.after(() => engine.close());
  for (const input of ['email@a.com', '@ab help', 'x@a', '@a.other', '@a-b']) {
    assert.deepEqual(engine.rooms.post(room.id, 'user:alice', { text: input }).mentions, []);
  }
  assert.deepEqual(engine.rooms.post(room.id, 'user:alice', { text: '@a: do this (@a) @a！' }).mentions, ['agent:a']);
  assert.deepEqual(engine.rooms.post(room.id, 'user:alice', { text: 'Please help, @a.' }).mentions, ['agent:a']);
  assert.deepEqual(engine.rooms.post(room.id, 'user:alice', { text: '请@a帮忙整理' }).mentions, ['agent:a']);
});

test('ASCII punctuation adjacent to @ still creates an explicit command', async (t) => {
  const { engine, room, observations } = await setup();
  t.after(() => engine.close());
  for (const prefix of ['Please,', 'Command:', 'Next;', 'Help?', 'Hey!']) {
    const message = engine.rooms.post(room.id, 'user:alice', { text: `${prefix}@a summarize` });
    assert.deepEqual(message.mentions, ['agent:a'], prefix);
  }
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 1);
  assert.equal(observations[0]?.requested, true);
  assert.equal(engine.rooms.get(room.id, 'user:alice').activity[0]?.error?.code, 'COMMAND_UNANSWERED');
});

test('short bursts are merged and new messages during inference wait for a separate snapshot', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const { engine, room, observations } = await setup(async () => { entered.resolve(); await release.promise; return { action: 'silent' }; });
  t.after(async () => { release.resolve(); await engine.close(); });
  engine.rooms.post(room.id, 'user:alice', { text: 'one' });
  engine.rooms.post(room.id, 'user:bob', { text: 'two' });
  await entered.promise;
  engine.rooms.post(room.id, 'user:alice', { text: 'future' });
  assert.deepEqual(observations[0]?.messages.map((m) => m.text), ['one', 'two']);
  assert.deepEqual(observations[0]?.pending.map((m) => m.text), ['one', 'two']);
  release.resolve();
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 2);
  assert.deepEqual(observations[1]?.pending.map((m) => m.text), ['future']);
  assert.deepEqual(observations[1]?.messages.map((m) => m.text), ['one', 'two', 'future']);
});

test('continuous traffic cannot postpone participation indefinitely', async (t) => {
  const { engine, room, observations } = await setup(undefined, { debounceMs: 100, maxWaitMs: 50 });
  t.after(() => engine.close());
  engine.rooms.post(room.id, 'user:alice', { text: 'start' });
  const interval = setInterval(() => engine.rooms.post(room.id, 'user:bob', { text: 'more' }), 10);
  t.after(() => clearInterval(interval));
  await until(() => observations.length > 0, 500);
  clearInterval(interval);
  assert.ok(observations[0]!.pending.length > 1);
});

test('room deduplication is sender-bound and validates conflicting reuse', async (t) => {
  const { engine, room } = await setup();
  t.after(() => engine.close());
  const input = { text: 'hello', clientId: 'same' };
  const a = engine.rooms.post(room.id, 'user:alice', input);
  assert.equal(engine.rooms.post(room.id, 'user:alice', input).id, a.id);
  assert.notEqual(engine.rooms.post(room.id, 'user:bob', input).id, a.id);
  assert.throws(() => engine.rooms.post(room.id, 'user:alice', { ...input, text: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  a.text = 'tampered';
  assert.equal(engine.rooms.get(room.id, 'user:alice').messages[0]?.text, 'hello');
});

test('room membership prevents outsider reads/writes and agent impersonation', async (t) => {
  const { engine, room } = await setup();
  t.after(() => engine.close());
  assert.throws(() => engine.rooms.get(room.id, 'user:outsider'), { code: 'FORBIDDEN' });
  assert.throws(() => engine.rooms.post(room.id, 'user:outsider', { text: 'no' }), { code: 'FORBIDDEN' });
  assert.throws(() => engine.rooms.post(room.id, 'agent:a', { text: 'spoof' }), { code: 'FORBIDDEN' });
  assert.throws(() => engine.rooms.post(room.id, 'user:alice', { text: 'spoof', from: 'user:bob' } as never), { code: 'INVALID_INPUT' });
  assert.throws(() => engine.rooms.create(['user:alice', 'agent:missing']), { code: 'NOT_FOUND' });
  assert.deepEqual(engine.rooms.list('user:outsider'), []);
  const humans = engine.rooms.create(['user:alice', 'user:bob']);
  engine.rooms.post(humans.id, 'user:alice', { text: 'humans only' });
  assert.equal(engine.rooms.get(humans.id, 'user:bob').messages.length, 1);
});

test('addressed agents run first and other observers see the already-published response', async (t) => {
  const { engine, observations } = await setup(async (input) => ({ action: 'reply', text: `from ${input.agentId}` }));
  t.after(() => engine.close());
  engine.registerAgent(config('b'));
  await engine.startAgent('b');
  const room = engine.rooms.create(['user:alice', 'agent:a', 'agent:b']);
  engine.rooms.post(room.id, 'user:alice', { text: '@b help' });
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 2);
  assert.deepEqual(observations.map((o) => o.agentId), ['agent:b', 'agent:a']);
  assert.equal(observations[1]?.messages.at(-1)?.text, 'from agent:b');
});

test('timeout and stop reject late replies without failing human delivery', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const { engine, room } = await setup(async () => { entered.resolve(); await release.promise; return { action: 'reply', text: 'too late' }; }, { timeoutMs: 30 });
  t.after(async () => { release.resolve(); await engine.close(); });
  engine.rooms.post(room.id, 'user:alice', { text: '@a help' });
  await entered.promise;
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 1);
  assert.equal(engine.rooms.get(room.id, 'user:alice').activity[0]?.error?.code, 'TIMEOUT');
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.rooms.get(room.id, 'user:alice').messages.length, 1);
  await engine.stopAgent('a');
  engine.rooms.post(room.id, 'user:bob', { text: '@a stopped?' });
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 2);
  assert.equal(engine.rooms.get(room.id, 'user:alice').activity[1]?.error?.code, 'AGENT_UNAVAILABLE');
});

test('events replay in order, listener failures are isolated and unsubscribe works', async (t) => {
  const { engine, room } = await setup();
  t.after(() => engine.close());
  engine.rooms.post(room.id, 'user:alice', { text: 'one' });
  const events: number[] = [];
  const off = engine.rooms.subscribe(room.id, 'user:bob', (event) => { events.push(event.seq); });
  const bad = engine.rooms.subscribe(room.id, 'user:alice', () => { throw new Error('bad consumer'); });
  engine.rooms.post(room.id, 'user:alice', { text: 'two' });
  assert.deepEqual(events, [1, 2]);
  assert.equal(engine.rooms.get(room.id, 'user:bob').eventCursor, 2);
  off(); bad();
  engine.rooms.post(room.id, 'user:alice', { text: 'three' });
  assert.deepEqual(events, [1, 2]);
  assert.throws(() => engine.rooms.subscribe(room.id, 'user:outsider', () => {}), { code: 'FORBIDDEN' });
});

test('malformed runtime decisions cannot publish arbitrary text; closed rooms reject new posts', async (t) => {
  const { engine, room } = await setup(async () => ({ action: 'reply', text: '' }));
  t.after(() => engine.close());
  engine.rooms.post(room.id, 'user:alice', { text: '@a help' });
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 1);
  assert.equal(engine.rooms.get(room.id, 'user:alice').activity[0]?.status, 'failed');
  assert.equal(engine.rooms.get(room.id, 'user:alice').messages.length, 1);
  await engine.close();
  assert.throws(() => engine.rooms.post(room.id, 'user:alice', { text: 'closed' }), { code: 'CLOSED' });
});

test('stop cancels active room work, restart recovers and late output is ignored', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let first = true;
  let activeSignal: AbortSignal | undefined;
  const { engine, room } = await setup(async (_input, signal) => {
    if (first) { first = false; activeSignal = signal; entered.resolve(); await release.promise; }
    return { action: 'reply', text: 'recovered' };
  });
  t.after(async () => { release.resolve(); await engine.close(); });
  engine.rooms.post(room.id, 'user:alice', { text: '@a first' });
  await entered.promise;
  await engine.stopAgent('a');
  assert.equal(activeSignal?.aborted, true);
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 1);
  assert.equal(engine.rooms.get(room.id, 'user:alice').activity[0]?.error?.code, 'AGENT_STOPPED');
  await engine.startAgent('a');
  engine.rooms.post(room.id, 'user:bob', { text: '@a next' });
  await until(() => engine.rooms.get(room.id, 'user:alice').activity.length === 2);
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(engine.rooms.get(room.id, 'user:alice').messages.map((m) => m.text), ['@a first', '@a next', 'recovered']);
});

test('one blocked room does not block another; close aborts work and closes subscriptions', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let blockedSignal: AbortSignal | undefined;
  const { engine, room } = await setup(async (input, signal) => {
    if (input.pending[0]?.text === '@a blocked') { blockedSignal = signal; entered.resolve(); await release.promise; }
    return { action: 'reply', text: 'answer' };
  });
  t.after(async () => { release.resolve(); await engine.close(); });
  const other = engine.rooms.create(['user:alice', 'agent:a']);
  const events: string[] = [];
  engine.rooms.subscribe(room.id, 'user:alice', (event) => events.push(event.type));
  engine.rooms.post(room.id, 'user:alice', { text: '@a blocked' });
  await entered.promise;
  engine.rooms.post(other.id, 'user:alice', { text: '@a independent' });
  await until(() => engine.rooms.get(other.id, 'user:alice').messages.length === 2);
  await engine.close();
  assert.equal(blockedSignal?.aborted, true);
  assert.equal(events.at(-1), 'closed');
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.rooms.get(room.id, 'user:alice').messages.length, 1);
  assert.equal(events.at(-1), 'closed');
});

test('expired event cursors require snapshot resync, while the snapshot cursor follows live events', async (t) => {
  const { engine } = await setup(undefined, { debounceMs: 0 });
  t.after(() => engine.close());
  const room = engine.rooms.create(['user:alice', 'user:bob']);
  for (let batch = 0; batch < 11; batch++) {
    for (let i = 0; i < 100; i++) engine.rooms.post(room.id, 'user:alice', { text: `message ${batch}-${i}` });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.throws(() => engine.rooms.subscribe(room.id, 'user:bob', () => {}, 0), { code: 'EVENTS_EXPIRED' });
  const snapshot = engine.rooms.get(room.id, 'user:bob');
  assert.equal(snapshot.eventCursor, 1100);
  const received: string[] = [];
  const off = engine.rooms.subscribe(room.id, 'user:bob', (event) => { if (event.type === 'message') received.push(event.message.text); }, snapshot.eventCursor);
  engine.rooms.post(room.id, 'user:alice', { text: 'live after resync' });
  assert.deepEqual(received, ['live after resync']);
  off();
});
