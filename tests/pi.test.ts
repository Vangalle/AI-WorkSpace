import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentEngine } from '../src/engine.js';
import { PiRuntimeFactory } from '../src/runtime/pi.js';
import { config, deferred } from './helpers.js';
import { fixtureProvider } from './fixtures/provider.js';

async function setup() {
  const fixture = await fixtureProvider();
  const factory = new PiRuntimeFactory({ cwd: fixture.directory, agentDir: fixture.directory, modelsPath: fixture.modelsPath });
  const engine = new AgentEngine(factory, { timeoutMs: 5000 });
  const model = { provider: 'fixture', id: 'fixture-model' };
  engine.registerAgent(config('a', { model }));
  engine.registerAgent(config('b', { model }));
  await engine.startAgent('a');
  await engine.startAgent('b');
  const conversation = engine.createConversation(['user:local-user', 'agent:a', 'agent:b']);
  return { fixture, factory, engine, conversationId: conversation.id, async close() { await engine.close(); await fixture.close(); } };
}

test('pi uses real SDK with selected model, replaced prompt and communication-only tools', async (t) => {
  const setupResult = await setup();
  t.after(() => setupResult.close());
  const { engine, fixture, conversationId } = setupResult;
  assert.equal(fixture.requests.length, 0);
  const result = await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'hello' });
  assert.equal(result.reply?.text, 'fixture answer');
  assert.equal(fixture.requests[0]?.model, 'fixture-model');
  const system = JSON.stringify(fixture.requests[0]?.messages[0]?.content);
  assert.match(system, /You are a\./);
  assert.match(system, /send_message/);
  assert.doesNotMatch(system, /Global Instructions|coding assistant/);
  assert.deepEqual(fixture.requests[0]?.tools?.map((tool) => tool.function.name), ['send_message']);
});

test('pi real SDK tool protocol completes A→B delegation', async (t) => {
  const result = await setup();
  t.after(() => result.close());
  const sent = await result.engine.sendUserMessage({ conversationId: result.conversationId, to: 'agent:a', text: 'delegate' });
  assert.equal(sent.message.status, 'completed');
  assert.equal(sent.reply?.text, 'A concludes: fixture answer');
  assert.equal(result.fixture.requests.length, 3);
  assert.deepEqual(result.engine.getConversation(result.conversationId).messages.map((message) => message.text), [
    'delegate', 'fixture question', 'fixture answer', 'A concludes: fixture answer',
  ]);
  assert.ok(result.fixture.requests[2]?.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('fixture answer')));
});

test('pi keeps conversation SDK history separate and supports append prompt mode', async (t) => {
  const result = await setup();
  t.after(() => result.close());
  result.engine.registerAgent(config('append', { model: { provider: 'fixture', id: 'fixture-model' }, systemPrompt: { mode: 'append', text: 'APPENDED-INSTRUCTION' } }));
  await result.engine.startAgent('append');
  const appended = result.engine.createConversation(['user:local-user', 'agent:append']);
  await result.engine.sendUserMessage({ conversationId: appended.id, to: 'agent:append', text: 'hi' });
  const system = JSON.stringify(result.fixture.requests[0]?.messages[0]?.content);
  assert.match(system, /APPENDED-INSTRUCTION/);
  assert.match(system, /coding assistant/);
  await result.engine.sendUserMessage({ conversationId: result.conversationId, to: 'agent:a', text: 'private-one' });
  const other = result.engine.createConversation(['user:local-user', 'agent:a']);
  await result.engine.sendUserMessage({ conversationId: other.id, to: 'agent:a', text: 'private-two' });
  assert.doesNotMatch(JSON.stringify(result.fixture.requests.at(-1)?.messages), /private-one/);
});

test('pi recognizes SDK provider errors instead of returning an old successful response', async (t) => {
  const result = await setup();
  t.after(() => result.close());
  await result.engine.sendUserMessage({ conversationId: result.conversationId, to: 'agent:a', text: 'first' });
  const failed = await result.engine.sendUserMessage({ conversationId: result.conversationId, to: 'agent:a', text: 'provider-failure' });
  assert.equal(failed.message.status, 'failed');
  assert.equal(failed.message.error?.code, 'MODEL_ERROR');
  assert.equal(failed.reply, undefined);
  assert.doesNotMatch(JSON.stringify(failed), /secret-provider-error/);
  const recovered = await result.engine.sendUserMessage({ conversationId: result.conversationId, to: 'agent:a', text: 'recovered' });
  assert.equal(recovered.reply?.text, 'fixture answer');
  assert.doesNotMatch(JSON.stringify(result.fixture.requests.at(-1)?.messages), /provider-failure/);
});

test('pi replaces a timed-out session before the next queued message and rejects late output', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const fixture = await fixtureProvider({ beforeReply: async (request) => {
    if (JSON.stringify(request.messages.at(-1)?.content).includes('slow-first')) {
      entered.resolve();
      await release.promise;
    }
  } });
  const engine = new AgentEngine(new PiRuntimeFactory({ cwd: fixture.directory, agentDir: fixture.directory, modelsPath: fixture.modelsPath }), { timeoutMs: 500 });
  t.after(async () => { release.resolve(); await engine.close(); await fixture.close(); });
  engine.registerAgent(config('a', { model: { provider: 'fixture', id: 'fixture-model' } }));
  await engine.startAgent('a');
  const conversation = engine.createConversation(['user:local-user', 'agent:a']);
  const first = engine.sendUserMessage({ conversationId: conversation.id, to: 'agent:a', text: 'slow-first' });
  await Promise.race([entered.promise, first.then(() => { throw new Error('First turn timed out before reaching fixture'); })]);
  const second = engine.sendUserMessage({ conversationId: conversation.id, to: 'agent:a', text: 'recovery-message' });
  const [timedOut, recovered] = await Promise.all([first, second]);
  assert.equal(timedOut.message.error?.code, 'TIMEOUT');
  assert.equal(recovered.message.status, 'completed');
  assert.equal(recovered.reply?.text, 'fixture answer');
  assert.equal(fixture.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(fixture.requests[1]?.messages), /slow-first/);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const third = await engine.sendUserMessage({ conversationId: conversation.id, to: 'agent:a', text: 'third-message' });
  assert.equal(third.reply?.text, 'fixture answer');
  assert.match(JSON.stringify(fixture.requests[2]?.messages), /recovery-message/);
  assert.doesNotMatch(JSON.stringify(fixture.requests[2]?.messages), /slow-first/);
  assert.deepEqual(engine.getConversation(conversation.id).messages.map((message) => message.status), ['failed', 'completed', 'delivered', 'completed', 'delivered']);
});

test('pi rejects unknown models and missing explicitly referenced credentials at load', async (t) => {
  const result = await setup();
  t.after(() => result.close());
  await assert.rejects(result.factory.load(config('unknown', { model: { provider: 'fixture', id: 'missing-model' } })), { code: 'MODEL_NOT_FOUND' });
  await assert.rejects(result.factory.load(config('missing-key', { model: { provider: 'fixture', id: 'fixture-model', apiKeyEnv: 'AGENT_IM_NONEXISTENT_TEST_KEY' } })), { code: 'MISSING_CREDENTIALS' });
});
