import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatApplication } from '../src/application.js';
import { AgentEngine } from '../src/engine.js';
import { config, deferred } from './helpers.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'expected lifecycle outcome did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('engine shutdown cancels participation without closing human chat or its transcript', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const app = new ChatApplication(
    {
      load: async () => ({
        receive: async () => 'direct',
        observe: async () => {
          entered.resolve();
          await release.promise;
          return { action: 'reply', text: 'stale reply' };
        },
        dispose: () => {},
      }),
    },
    { roomDebounceMs: 0 },
  );
  t.after(async () => {
    release.resolve();
    await app.close();
  });
  app.agents.registerAgent(config());
  await app.agents.startAgent('a');
  const room = app.rooms.create(['user:alice', 'user:bob', 'agent:a']);
  const events: string[] = [];
  app.rooms.subscribe(room.id, 'user:bob', (event) => events.push(event.type));
  app.rooms.post(room.id, 'user:alice', { text: '@a help' });
  await entered.promise;
  await app.agents.close();
  app.rooms.post(room.id, 'user:bob', { text: 'We can still talk.' });
  release.resolve();
  await until(() => app.rooms.get(room.id, 'user:alice').activity.length >= 1);
  assert.deepEqual(
    app.rooms.get(room.id, 'user:alice').messages.map((message) => message.text),
    ['@a help', 'We can still talk.'],
  );
  assert.equal(events.includes('closed'), false);
  assert.equal(app.rooms.get(room.id, 'user:alice').activity[0]?.status, 'failed');
});

test('closing the room service does not stop agents or close directed conversations', async (t) => {
  const app = new ChatApplication({
    load: async () => ({ receive: async () => 'still running', dispose: () => {} }),
  });
  t.after(() => app.close());
  app.agents.registerAgent(config());
  await app.agents.startAgent('a');
  app.rooms.create(['user:alice', 'agent:a']);
  app.rooms.close();
  assert.equal(app.agents.getAgent('a').status, 'running');
  const direct = app.conversations.createConversation(['user:local-user', 'agent:a']);
  assert.equal(
    (
      await app.conversations.sendUserMessage({
        conversationId: direct.id,
        to: 'agent:a',
        text: 'hello',
      })
    ).reply?.text,
    'still running',
  );
});

test('closing one room cancels only its participation and keeps the shared agent available', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let blockedRoom = '';
  const app = new ChatApplication(
    {
      load: async () => ({
        receive: async () => 'direct',
        observe: async (input) => {
          if (input.roomId === blockedRoom) {
            entered.resolve();
            await release.promise;
          }
          return { action: 'reply', text: input.roomId === blockedRoom ? 'stale' : 'helpful' };
        },
        dispose: () => {},
      }),
    },
    { roomDebounceMs: 0 },
  );
  t.after(async () => {
    release.resolve();
    await app.close();
  });
  app.agents.registerAgent(config());
  await app.agents.startAgent('a');
  const first = app.rooms.create(['user:alice', 'agent:a']);
  const second = app.rooms.create(['user:alice', 'agent:a']);
  blockedRoom = first.id;
  app.rooms.post(first.id, 'user:alice', { text: '@a wait' });
  await entered.promise;
  app.rooms.closeRoom(first.id, 'user:alice');
  assert.throws(() => app.rooms.post(first.id, 'user:alice', { text: 'closed' }), {
    code: 'ROOM_CLOSED',
  });
  assert.equal(app.agents.getAgent('a').status, 'running');
  app.rooms.post(second.id, 'user:alice', { text: '@a help' });
  await until(() => app.rooms.get(second.id, 'user:alice').messages.length === 2);
  assert.equal(app.rooms.get(second.id, 'user:alice').messages[1]?.text, 'helpful');
  release.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.rooms.get(first.id, 'user:alice').messages.length, 1);
});

test('application shutdown is reentrant and rejects new agent work immediately', async () => {
  const app = new ChatApplication({
    load: async () => ({ receive: async () => 'ready', dispose: () => {} }),
  });
  app.agents.registerAgent(config());
  await app.agents.startAgent('a');
  const room = app.rooms.create(['user:alice', 'agent:a']);
  let reentered: Promise<void> | undefined;
  app.rooms.subscribe(room.id, 'user:alice', (event) => {
    if (event.type === 'closed') reentered = app.close();
  });
  const closing = app.close();
  assert.equal(reentered, closing);
  await assert.rejects(app.agents.startAgent('a'), { code: 'CLOSED' });
  await closing;
  assert.equal(app.agents.getAgent('a').status, 'stopped');
});

test('a runtime lease cancelled before invocation cannot use a restarted agent', async (t) => {
  const engine = new AgentEngine({
    load: async () => ({ receive: async () => 'ready', dispose: () => {} }),
  });
  t.after(() => engine.close());
  engine.registerAgent(config());
  await engine.startAgent('a');
  let invoked = 0;
  const pending = assert.rejects(
    engine.useRuntime('a', async () => {
      invoked++;
      return 'late';
    }),
    { code: 'AGENT_STOPPED' },
  );
  await engine.stopAgent('a');
  await engine.startAgent('a');
  await pending;
  assert.equal(invoked, 0);
  assert.equal(await engine.useRuntime('a', async () => 'new lease'), 'new lease');
});
