import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentEngine } from '../src/engine.js';
import { config, deferred, TestRuntimeFactory } from './helpers.js';

async function setup(factory = new TestRuntimeFactory(), timeoutMs = 1000) {
  const engine = new AgentEngine(factory, { timeoutMs });
  engine.registerAgent(config('a'));
  engine.registerAgent(config('b'));
  await engine.startAgent('a');
  await engine.startAgent('b');
  const conversation = engine.createConversation(['user:local-user', 'agent:a', 'agent:b']);
  return { engine, factory, conversationId: conversation.id };
}

test('engine loads selected configuration and links user request/reply', async (t) => {
  const { engine, factory, conversationId } = await setup();
  t.after(() => engine.close());
  assert.equal(factory.loads[0]?.model.id, 'gpt-4.1-mini');
  assert.equal(factory.loads[0]?.systemPrompt.text, 'You are a.');
  const result = await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'hello' });
  assert.equal(result.message.status, 'completed');
  assert.equal(result.reply?.text, '1: hello');
  assert.equal(result.reply?.from, 'agent:a');
  assert.equal(result.reply?.to, 'user:local-user');
  assert.equal(result.reply?.replyTo, result.message.id);
  assert.equal(result.reply?.status, 'delivered');
  assert.equal(engine.getConversation(conversationId).messages.length, 2);
});

test('engine separates conversation contexts and protects returned state from mutation', async (t) => {
  const { engine, conversationId } = await setup();
  t.after(() => engine.close());
  const second = engine.createConversation(['user:local-user', 'agent:a']);
  const send = (id: string, text: string) =>
    engine.sendUserMessage({ conversationId: id, to: 'agent:a', text });
  assert.equal((await send(conversationId, 'one')).reply?.text, '1: one');
  assert.equal((await send(conversationId, 'two')).reply?.text, '2: two');
  assert.equal((await send(second.id, 'other')).reply?.text, '1: other');
  const view = engine.getConversation(conversationId);
  view.messages[0]!.text = 'tampered';
  assert.equal(engine.getConversation(conversationId).messages[0]?.text, 'one');
});

test('engine supports proactive agent-to-user send without a user request', async (t) => {
  const { engine, conversationId } = await setup();
  t.after(() => engine.close());
  const result = await engine.sendAgentMessage('a', {
    conversationId,
    to: 'user:local-user',
    text: 'ready',
  });
  assert.equal(result.message.from, 'agent:a');
  assert.equal(result.message.status, 'delivered');
  assert.equal(result.reply, undefined);
});

test('engine runs user→A→B→A→user without retriggering replies', async (t) => {
  const factory = new TestRuntimeFactory(async (message, context, _history, agent) => {
    if (agent.id === 'b') return 'answer from B';
    const delegated = await context.send('agent:b', 'question for B');
    return `A concludes: ${delegated.reply?.text}`;
  });
  const { engine, conversationId } = await setup(factory);
  t.after(() => engine.close());
  const result = await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'delegate' });
  assert.equal(result.reply?.text, 'A concludes: answer from B');
  assert.deepEqual(
    engine.getConversation(conversationId).messages.map((m) => [m.from, m.to]),
    [
      ['user:local-user', 'agent:a'],
      ['agent:a', 'agent:b'],
      ['agent:b', 'agent:a'],
      ['agent:a', 'user:local-user'],
    ],
  );
});

test('engine deduplicates concurrent sends and rejects changed payloads', async (t) => {
  const { engine, conversationId } = await setup();
  t.after(() => engine.close());
  const input = { conversationId, to: 'agent:a' as const, text: 'hello', clientId: 'request-1' };
  const [first, second] = await Promise.all([
    engine.sendUserMessage(input),
    engine.sendUserMessage(input),
  ]);
  assert.equal(first.message.id, second.message.id);
  assert.equal(first.reply?.text, '1: hello');
  assert.equal(engine.getConversation(conversationId).messages.length, 2);
  await assert.rejects(engine.sendUserMessage({ ...input, text: 'different' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('engine enforces membership and agent recipient allowlists', async (t) => {
  const { engine, conversationId } = await setup();
  t.after(() => engine.close());
  const privateConversation = engine.createConversation(['user:other', 'agent:a']);
  await assert.rejects(
    engine.sendUserMessage({
      conversationId: privateConversation.id,
      to: 'agent:a',
      text: 'steal',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    engine.sendAgentMessage('a', { conversationId, to: 'user:outsider', text: 'leak' }),
    { code: 'FORBIDDEN' },
  );
  engine.registerAgent(config('restricted', { allowSendTo: [] }));
  await engine.startAgent('restricted');
  const restricted = engine.createConversation(['user:local-user', 'agent:restricted']);
  await assert.rejects(
    engine.sendAgentMessage('restricted', {
      conversationId: restricted.id,
      to: 'user:local-user',
      text: 'denied',
    }),
    { code: 'FORBIDDEN' },
  );
});

test('engine rejects cyclic calls promptly and caps tool sends', async (t) => {
  const cycle = await setup(
    new TestRuntimeFactory(async (_message, context, _history, agent) => {
      await context.send(agent.id === 'a' ? 'agent:b' : 'agent:a', 'loop');
      return 'unreachable';
    }),
  );
  t.after(() => cycle.engine.close());
  const result = await cycle.engine.sendUserMessage({
    conversationId: cycle.conversationId,
    to: 'agent:a',
    text: 'cycle',
  });
  assert.equal(result.message.status, 'failed');
  assert.equal(result.message.error?.code, 'AGENT_CYCLE');
  const budget = await setup(
    new TestRuntimeFactory(async (_message, context) => {
      for (let index = 0; index < 20; index++) await context.send('user:local-user', 'update');
      return 'unreachable';
    }),
  );
  t.after(() => budget.engine.close());
  const limited = await budget.engine.sendUserMessage({
    conversationId: budget.conversationId,
    to: 'agent:a',
    text: 'many',
  });
  assert.equal(limited.message.error?.code, 'SEND_LIMIT');
  assert.equal(budget.engine.getConversation(budget.conversationId).messages.length, 17);
});

test('engine serializes concurrent conversation turns', async (t) => {
  let active = 0;
  let peak = 0;
  const { engine, conversationId } = await setup(
    new TestRuntimeFactory(async (message) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return message.text;
    }),
  );
  t.after(() => engine.close());
  const results = await Promise.all(
    ['one', 'two', 'three'].map((text) =>
      engine.sendUserMessage({ conversationId, to: 'agent:a', text }),
    ),
  );
  assert.equal(peak, 1);
  assert.deepEqual(
    results.map((r) => r.reply?.text),
    ['one', 'two', 'three'],
  );
});

test('engine times out and blocks late sends/replies', async (t) => {
  const release = deferred<void>();
  const late = deferred<unknown>();
  const { engine, conversationId } = await setup(
    new TestRuntimeFactory(async (_message, context) => {
      await release.promise;
      try {
        await context.send('user:local-user', 'too late');
      } catch (error) {
        late.resolve(error);
      }
      return 'late reply';
    }),
    20,
  );
  t.after(() => engine.close());
  const result = await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'slow' });
  assert.equal(result.message.status, 'failed');
  assert.equal(result.message.error?.code, 'TIMEOUT');
  release.resolve();
  assert.equal(((await late.promise) as { code: string }).code, 'TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getConversation(conversationId).messages.length, 1);
});

test('engine stops active work and restart gets fresh runtime context', async (t) => {
  const entered = deferred<void>();
  const factory = new TestRuntimeFactory(async (_message, context) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return 'must not arrive';
  });
  const { engine, conversationId } = await setup(factory);
  t.after(() => engine.close());
  const pending = engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'wait' });
  await entered.promise;
  await engine.stopAgent('a');
  assert.equal((await pending).message.error?.code, 'AGENT_STOPPED');
  assert.equal(engine.getAgent('a').status, 'stopped');
  factory.handler = async () => 'restarted';
  await engine.startAgent('a');
  assert.equal(
    (await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'again' })).reply?.text,
    'restarted',
  );
});

test('engine records unavailable and runtime failures without leaking exception text', async (t) => {
  const { engine, conversationId } = await setup(
    new TestRuntimeFactory(async () => {
      throw new Error('secret-api-key');
    }),
  );
  t.after(() => engine.close());
  const failed = await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'fail' });
  assert.deepEqual(failed.message.error, {
    code: 'RUNTIME_ERROR',
    message: 'Agent runtime failed',
  });
  await engine.stopAgent('b');
  const stopped = await engine.sendUserMessage({ conversationId, to: 'agent:b', text: 'stopped' });
  assert.equal(stopped.message.error?.code, 'AGENT_UNAVAILABLE');
});

test('engine revokes a completed nested agent capability before the root turn ends', async (t) => {
  let nestedSend: ((to: 'user:local-user', text: string) => Promise<unknown>) | undefined;
  const { engine, conversationId } = await setup(
    new TestRuntimeFactory(async (_message, context, _history, agent) => {
      if (agent.id === 'b') {
        nestedSend = context.send;
        return 'B done';
      }
      await context.send('agent:b', 'question');
      assert.ok(nestedSend);
      await assert.rejects(nestedSend('user:local-user', 'stale capability'), {
        code: 'TURN_FINISHED',
      });
      return 'A done';
    }),
  );
  t.after(() => engine.close());
  const result = await engine.sendUserMessage({ conversationId, to: 'agent:a', text: 'go' });
  assert.equal(result.reply?.text, 'A done');
  assert.equal(engine.getConversation(conversationId).messages.length, 4);
});

test('engine rejects invalid config and reports loading errors as failed state', async (t) => {
  const engine = new AgentEngine({
    load: async () => {
      throw new Error('private path');
    },
  });
  t.after(() => engine.close());
  assert.throws(() => engine.registerAgent({ ...config(), runtime: 'unknown' } as never), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => engine.registerAgent(config('bad/id')), { code: 'INVALID_INPUT' });
  engine.registerAgent(config());
  await assert.rejects(engine.startAgent('a'), { code: 'RUNTIME_ERROR' });
  assert.equal(engine.getAgent('a').status, 'failed');
  assert.equal(engine.getAgent('a').error?.message, 'Agent runtime failed');
});
