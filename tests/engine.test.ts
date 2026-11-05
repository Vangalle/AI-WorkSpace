import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatApplication } from '../src/application.js';
import { config, deferred, TestRuntimeFactory } from './helpers.js';

async function setup(factory = new TestRuntimeFactory(), timeoutMs = 1000) {
  const app = new ChatApplication(factory, { timeoutMs });
  app.agents.registerAgent(config('a'));
  app.agents.registerAgent(config('b'));
  await app.agents.startAgent('a');
  await app.agents.startAgent('b');
  const conversation = app.conversations.createConversation([
    'user:local-user',
    'agent:a',
    'agent:b',
  ]);
  return { app, factory, conversationId: conversation.id };
}

test('app loads selected configuration and links user request/reply', async (t) => {
  const { app, factory, conversationId } = await setup();
  t.after(() => app.close());
  assert.equal(factory.loads[0]?.model.id, 'gpt-4.1-mini');
  assert.equal(factory.loads[0]?.systemPrompt.text, 'You are a.');
  const result = await app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:a',
    text: 'hello',
  });
  assert.equal(result.message.status, 'completed');
  assert.equal(result.reply?.text, '1: hello');
  assert.equal(result.reply?.from, 'agent:a');
  assert.equal(result.reply?.to, 'user:local-user');
  assert.equal(result.reply?.replyTo, result.message.id);
  assert.equal(result.reply?.status, 'delivered');
  assert.equal(app.conversations.getConversation(conversationId).messages.length, 2);
});

test('app separates conversation contexts and protects returned state from mutation', async (t) => {
  const { app, conversationId } = await setup();
  t.after(() => app.close());
  const second = app.conversations.createConversation(['user:local-user', 'agent:a']);
  const send = (id: string, text: string) =>
    app.conversations.sendUserMessage({ conversationId: id, to: 'agent:a', text });
  assert.equal((await send(conversationId, 'one')).reply?.text, '1: one');
  assert.equal((await send(conversationId, 'two')).reply?.text, '2: two');
  assert.equal((await send(second.id, 'other')).reply?.text, '1: other');
  const view = app.conversations.getConversation(conversationId);
  view.messages[0]!.text = 'tampered';
  assert.equal(app.conversations.getConversation(conversationId).messages[0]?.text, 'one');
});

test('app supports proactive agent-to-user send without a user request', async (t) => {
  const { app, conversationId } = await setup();
  t.after(() => app.close());
  const result = await app.conversations.sendAgentMessage('a', {
    conversationId,
    to: 'user:local-user',
    text: 'ready',
  });
  assert.equal(result.message.from, 'agent:a');
  assert.equal(result.message.status, 'delivered');
  assert.equal(result.reply, undefined);
});

test('app runs user→A→B→A→user without retriggering replies', async (t) => {
  const factory = new TestRuntimeFactory(async (message, context, _history, agent) => {
    if (agent.id === 'b') return 'answer from B';
    const delegated = await context.send('agent:b', 'question for B');
    return `A concludes: ${delegated.reply?.text}`;
  });
  const { app, conversationId } = await setup(factory);
  t.after(() => app.close());
  const result = await app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:a',
    text: 'delegate',
  });
  assert.equal(result.reply?.text, 'A concludes: answer from B');
  assert.deepEqual(
    app.conversations.getConversation(conversationId).messages.map((m) => [m.from, m.to]),
    [
      ['user:local-user', 'agent:a'],
      ['agent:a', 'agent:b'],
      ['agent:b', 'agent:a'],
      ['agent:a', 'user:local-user'],
    ],
  );
});

test('app deduplicates concurrent sends and rejects changed payloads', async (t) => {
  const { app, conversationId } = await setup();
  t.after(() => app.close());
  const input = { conversationId, to: 'agent:a' as const, text: 'hello', clientId: 'request-1' };
  const [first, second] = await Promise.all([
    app.conversations.sendUserMessage(input),
    app.conversations.sendUserMessage(input),
  ]);
  assert.equal(first.message.id, second.message.id);
  assert.equal(first.reply?.text, '1: hello');
  assert.equal(app.conversations.getConversation(conversationId).messages.length, 2);
  await assert.rejects(app.conversations.sendUserMessage({ ...input, text: 'different' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('app enforces membership and agent recipient allowlists', async (t) => {
  const { app, conversationId } = await setup();
  t.after(() => app.close());
  const privateConversation = app.conversations.createConversation(['user:other', 'agent:a']);
  await assert.rejects(
    app.conversations.sendUserMessage({
      conversationId: privateConversation.id,
      to: 'agent:a',
      text: 'steal',
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    app.conversations.sendAgentMessage('a', {
      conversationId,
      to: 'user:outsider',
      text: 'leak',
    }),
    { code: 'FORBIDDEN' },
  );
  app.agents.registerAgent(config('restricted', { allowSendTo: [] }));
  await app.agents.startAgent('restricted');
  const restricted = app.conversations.createConversation([
    'user:local-user',
    'agent:restricted',
  ]);
  await assert.rejects(
    app.conversations.sendAgentMessage('restricted', {
      conversationId: restricted.id,
      to: 'user:local-user',
      text: 'denied',
    }),
    { code: 'FORBIDDEN' },
  );
});

test('app rejects cyclic calls promptly and caps tool sends', async (t) => {
  const cycle = await setup(
    new TestRuntimeFactory(async (_message, context, _history, agent) => {
      await context.send(agent.id === 'a' ? 'agent:b' : 'agent:a', 'loop');
      return 'unreachable';
    }),
  );
  t.after(() => cycle.app.close());
  const result = await cycle.app.conversations.sendUserMessage({
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
  t.after(() => budget.app.close());
  const limited = await budget.app.conversations.sendUserMessage({
    conversationId: budget.conversationId,
    to: 'agent:a',
    text: 'many',
  });
  assert.equal(limited.message.error?.code, 'SEND_LIMIT');
  assert.equal(
    budget.app.conversations.getConversation(budget.conversationId).messages.length,
    17,
  );
});

test('app serializes concurrent conversation turns', async (t) => {
  let active = 0;
  let peak = 0;
  const { app, conversationId } = await setup(
    new TestRuntimeFactory(async (message) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return message.text;
    }),
  );
  t.after(() => app.close());
  const results = await Promise.all(
    ['one', 'two', 'three'].map((text) =>
      app.conversations.sendUserMessage({ conversationId, to: 'agent:a', text }),
    ),
  );
  assert.equal(peak, 1);
  assert.deepEqual(
    results.map((r) => r.reply?.text),
    ['one', 'two', 'three'],
  );
});

test('app times out and blocks late sends/replies', async (t) => {
  const release = deferred<void>();
  const late = deferred<unknown>();
  const { app, conversationId } = await setup(
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
  t.after(() => app.close());
  const result = await app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:a',
    text: 'slow',
  });
  assert.equal(result.message.status, 'failed');
  assert.equal(result.message.error?.code, 'TIMEOUT');
  release.resolve();
  assert.equal(((await late.promise) as { code: string }).code, 'TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.conversations.getConversation(conversationId).messages.length, 1);
});

test('app stops active work and restart gets fresh runtime context', async (t) => {
  const entered = deferred<void>();
  const factory = new TestRuntimeFactory(async (_message, context) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return 'must not arrive';
  });
  const { app, conversationId } = await setup(factory);
  t.after(() => app.close());
  const pending = app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:a',
    text: 'wait',
  });
  await entered.promise;
  await app.agents.stopAgent('a');
  assert.equal((await pending).message.error?.code, 'AGENT_STOPPED');
  assert.equal(app.agents.getAgent('a').status, 'stopped');
  factory.handler = async () => 'restarted';
  await app.agents.startAgent('a');
  assert.equal(
    (await app.conversations.sendUserMessage({ conversationId, to: 'agent:a', text: 'again' }))
      .reply?.text,
    'restarted',
  );
});

test('app records unavailable and runtime failures without leaking exception text', async (t) => {
  const { app, conversationId } = await setup(
    new TestRuntimeFactory(async () => {
      throw new Error('secret-api-key');
    }),
  );
  t.after(() => app.close());
  const failed = await app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:a',
    text: 'fail',
  });
  assert.deepEqual(failed.message.error, {
    code: 'RUNTIME_ERROR',
    message: 'Agent runtime failed',
  });
  await app.agents.stopAgent('b');
  const stopped = await app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:b',
    text: 'stopped',
  });
  assert.equal(stopped.message.error?.code, 'AGENT_UNAVAILABLE');
});

test('app revokes a completed nested agent capability before the root turn ends', async (t) => {
  let nestedSend: ((to: 'user:local-user', text: string) => Promise<unknown>) | undefined;
  const { app, conversationId } = await setup(
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
  t.after(() => app.close());
  const result = await app.conversations.sendUserMessage({
    conversationId,
    to: 'agent:a',
    text: 'go',
  });
  assert.equal(result.reply?.text, 'A done');
  assert.equal(app.conversations.getConversation(conversationId).messages.length, 4);
});

test('app rejects invalid config and reports loading errors as start_failed', async (t) => {
  const app = new ChatApplication({
    load: async () => {
      throw new Error('private path');
    },
  });
  t.after(() => app.close());
  assert.throws(() => app.agents.registerAgent({ ...config(), runtime: 'unknown' } as never), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => app.agents.registerAgent(config('bad/id')), { code: 'INVALID_INPUT' });
  app.agents.registerAgent(config());
  await assert.rejects(app.agents.startAgent('a'), { code: 'RUNTIME_ERROR' });
  assert.equal(app.agents.getAgent('a').status, 'start_failed');
  assert.equal(app.agents.getAgent('a').error?.message, 'Agent runtime failed');
});
