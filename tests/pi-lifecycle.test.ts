import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { AgentEngine } from '../src/engine.js';
import { PiRuntimeFactory } from '../src/runtime/pi.js';
import { config, deferred } from './helpers.js';
import { fixtureProvider } from './fixtures/provider.js';

async function setup() {
  const fixture = await fixtureProvider();
  const factory = new PiRuntimeFactory({
    cwd: fixture.directory,
    agentDir: fixture.directory,
    modelsPath: fixture.modelsPath,
  });
  const engine = new AgentEngine(factory, { roomDebounceMs: 0 });
  engine.registerAgent(config('a', { model: { provider: 'fixture', id: 'fixture-model' } }));
  await engine.startAgent('a');
  return { engine, fixture, factory };
}

test('Pi cleanup attempts every directed session and retries only unreleased sessions', async (t) => {
  const { engine, fixture } = await setup();
  t.after(async () => {
    t.mock.restoreAll();
    await engine.stopAgent('a');
    await engine.close();
    await fixture.close();
  });
  for (const text of ['one', 'two']) {
    const conversation = engine.createConversation(['user:local-user', 'agent:a']);
    const result = await engine.sendUserMessage({ conversationId: conversation.id, to: 'agent:a', text });
    assert.equal(result.message.status, 'completed');
  }
  const original = AgentSession.prototype.dispose;
  const attempts = new Map<AgentSession, number>();
  let failed: AgentSession | undefined;
  t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
    const count = (attempts.get(this) ?? 0) + 1;
    attempts.set(this, count);
    failed ??= this;
    if (this === failed && count === 1) throw new Error('session cleanup failed');
    return original.call(this);
  });
  await assert.rejects(engine.stopAgent('a'), { code: 'RUNTIME_ERROR' });
  assert.equal(engine.getAgent('a').status, 'stop_failed');
  assert.equal(attempts.size, 2, 'one failure must not skip other sessions');
  await engine.stopAgent('a');
  assert.equal(attempts.get(failed!), 2);
  assert.deepEqual([...attempts.values()].sort(), [1, 2]);
  assert.equal(engine.getAgent('a').status, 'stopped');
});

test('Pi retains cancelled directed sessions until cleanup succeeds', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const fixture = await fixtureProvider({ beforeReply: async () => {
    entered.resolve();
    await release.promise;
  } });
  const engine = new AgentEngine(new PiRuntimeFactory({
    cwd: fixture.directory, agentDir: fixture.directory, modelsPath: fixture.modelsPath,
  }));
  t.after(async () => {
    release.resolve();
    t.mock.restoreAll();
    await engine.stopAgent('a');
    await engine.close();
    await fixture.close();
  });
  engine.registerAgent(config('a', { model: { provider: 'fixture', id: 'fixture-model' } }));
  await engine.startAgent('a');
  const conversation = engine.createConversation(['user:local-user', 'agent:a']);
  const pending = engine.sendUserMessage({ conversationId: conversation.id, to: 'agent:a', text: 'wait' });
  await entered.promise;
  const original = AgentSession.prototype.dispose;
  let fail = true;
  let attempts = 0;
  t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
    attempts++;
    if (fail) throw new Error('cancelled session cleanup failed');
    return original.call(this);
  });
  await assert.rejects(engine.stopAgent('a'), { code: 'RUNTIME_ERROR' });
  assert.equal(engine.getAgent('a').status, 'stop_failed');
  assert.equal((await pending).message.error?.code, 'AGENT_STOPPED');
  fail = false;
  release.resolve();
  await engine.stopAgent('a');
  assert.ok(attempts >= 2, 'failed cleanup must remain retryable after cache eviction');
  assert.equal(engine.getAgent('a').status, 'stopped');
});

test('Pi disposal waits for session initialization and retains failed late cleanup', async (t) => {
  const { engine, fixture, factory } = await setup();
  const runtime = await factory.load(config('late', { model: { provider: 'fixture', id: 'fixture-model' } }));
  t.after(async () => {
    t.mock.restoreAll();
    await runtime.dispose();
    await engine.close();
    await fixture.close();
  });
  const original = AgentSession.prototype.dispose;
  let fail = true;
  let attempts = 0;
  t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
    attempts++;
    if (fail) throw new Error('late session cleanup failed');
    return original.call(this);
  });
  const received = assert.rejects(runtime.receive({
    id: 'message', conversationId: 'conversation', from: 'user:local-user', to: 'agent:late',
    text: 'hello', createdAt: '2026-01-01T00:00:00.000Z', status: 'processing',
  }, {
    signal: new AbortController().signal, participants: ['user:local-user', 'agent:late'],
    send: async () => { throw new Error('unexpected send'); },
  }), { code: 'AGENT_STOPPED' });
  const stopped = assert.rejects(Promise.resolve(runtime.dispose()), AggregateError);
  await Promise.all([received, stopped]);
  fail = false;
  await runtime.dispose();
  assert.equal(attempts, 2, 'late session must be retained for the cleanup retry');
});

test('Pi disposal waits for room session initialization before reporting cleanup success', async (t) => {
  const { engine, fixture, factory } = await setup();
  const runtime = await factory.load(config('late', { model: { provider: 'fixture', id: 'fixture-model' } }));
  t.after(async () => {
    t.mock.restoreAll();
    await runtime.dispose();
    await engine.close();
    await fixture.close();
  });
  const original = AgentSession.prototype.dispose;
  let fail = true;
  let attempts = 0;
  t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
    attempts++;
    if (fail) throw new Error('late room cleanup failed');
    return original.call(this);
  });
  const observed = assert.rejects(runtime.observe!({
    roomId: 'room', agentId: 'agent:late', participants: ['user:alice', 'agent:late'],
    messages: [], pending: [], requested: false,
  }, { signal: new AbortController().signal }), { code: 'AGENT_STOPPED' });
  const stopped = assert.rejects(Promise.resolve(runtime.dispose()), AggregateError);
  await Promise.all([observed, stopped]);
  fail = false;
  await runtime.dispose();
  assert.equal(attempts, 2);
});

test('Pi retains a room session when its per-observation cleanup fails', async (t) => {
  const { engine, fixture } = await setup();
  t.after(async () => {
    t.mock.restoreAll();
    await engine.stopAgent('a');
    await engine.close();
    await fixture.close();
  });
  const original = AgentSession.prototype.dispose;
  let attempts = 0;
  t.mock.method(AgentSession.prototype, 'dispose', function (this: AgentSession) {
    if (++attempts === 1) throw new Error('temporary room cleanup failure');
    return original.call(this);
  });
  const room = engine.rooms.create(['user:alice', 'agent:a']);
  engine.rooms.post(room.id, 'user:alice', { text: 'hello' });
  const deadline = Date.now() + 5000;
  while (engine.rooms.get(room.id, 'user:alice').activity.length === 0) {
    assert.ok(Date.now() < deadline, 'room observation must settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(engine.rooms.get(room.id, 'user:alice').activity[0]?.status, 'failed');
  await engine.stopAgent('a');
  assert.equal(attempts, 2, 'agent cleanup must retry the retained room session');
  assert.equal(engine.getAgent('a').status, 'stopped');
});
