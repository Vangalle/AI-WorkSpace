import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentEngine } from '../src/engine.js';
import { PiRuntimeFactory } from '../src/runtime/pi.js';
import { config } from './helpers.js';
import { fixtureProvider, providerText } from './fixtures/provider.js';

async function setup() {
  const fixture = await fixtureProvider();
  const engine = new AgentEngine(new PiRuntimeFactory({ cwd: fixture.directory, agentDir: fixture.directory, modelsPath: fixture.modelsPath }), { roomDebounceMs: 0, timeoutMs: 5000 });
  engine.registerAgent(config('a', { model: { provider: 'fixture', id: 'fixture-model' }, allowSendTo: [] }));
  await engine.startAgent('a');
  const room = engine.rooms.create(['user:alice', 'user:bob', 'agent:a']);
  return { engine, fixture, room, close: async () => { await engine.close(); await fixture.close(); } };
}

async function settled(engine: AgentEngine, roomId: string, count = 1) {
  const start = Date.now();
  while (engine.rooms.get(roomId, 'user:alice').activity.length < count) {
    if (Date.now() - start > 7000) throw new Error('Room did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return engine.rooms.get(roomId, 'user:alice');
}

test('real Pi SDK room observer publishes explicit actions, not final assistant text', async (t) => {
  const { engine, fixture, room, close } = await setup();
  t.after(close);
  engine.rooms.post(room.id, 'user:alice', { text: 'Can someone help?' });
  const view = await settled(engine, room.id);
  assert.equal(view.activity[0]?.status, 'replied');
  assert.equal(view.messages[1]?.text, 'room fixture reply');
  assert.deepEqual(fixture.requests[0]?.tools?.map((tool) => tool.function.name), ['room_action']);
  assert.doesNotMatch(JSON.stringify(view.messages), /A concludes/);
});

test('real Pi SDK supports intentional silence and preserves shared human context', async (t) => {
  const { engine, fixture, room, close } = await setup();
  t.after(close);
  engine.rooms.post(room.id, 'user:alice', { text: 'room-silent: just chatting' });
  assert.equal((await settled(engine, room.id)).activity[0]?.status, 'silent');
  engine.rooms.post(room.id, 'user:bob', { text: 'what do you think?' });
  const view = await settled(engine, room.id, 2);
  assert.equal(view.messages.length, 3);
  const userInput = fixture.requests[2]!.messages.find((m) => m.role === 'user');
  assert.match(JSON.stringify(userInput), /just chatting/);
  assert.match(JSON.stringify(userInput), /user:alice/);
  assert.match(JSON.stringify(userInput), /user:bob/);
});

test('@ command metadata reaches the real SDK and a silent command becomes visible failure', async (t) => {
  const { engine, fixture, room, close } = await setup();
  t.after(close);
  engine.rooms.post(room.id, 'user:alice', { text: '@a room-silent' });
  const view = await settled(engine, room.id);
  assert.equal(view.activity[0]?.error?.code, 'COMMAND_UNANSWERED');
  const input = fixture.requests[0]!.messages.find((m) => m.role === 'user');
  const payload = JSON.parse(providerText(input!.content)) as { requested: boolean; commandMessageIds: string[] };
  assert.equal(payload.requested, true);
  assert.deepEqual(payload.commandMessageIds, [view.messages[0]!.id]);
});

test('missing, invalid and duplicate room actions never leak raw text into chat', async (t) => {
  const { engine, room, close } = await setup();
  t.after(close);
  for (const marker of ['room-raw', 'room-invalid', 'room-multiple', 'provider-failure']) {
    const isolated = engine.rooms.create(['user:alice', 'agent:a']);
    engine.rooms.post(isolated.id, 'user:alice', { text: marker });
    const view = await settled(engine, isolated.id);
    assert.equal(view.activity[0]?.status, 'failed', marker);
    assert.equal(view.messages.length, 1, marker);
    assert.doesNotMatch(JSON.stringify(view), /secret-provider-error/);
  }
  assert.equal(engine.rooms.get(room.id, 'user:alice').messages.length, 0);
});

test('room and directed SDK sessions cannot leak histories across boundaries', async (t) => {
  const { engine, fixture, room, close } = await setup();
  t.after(close);
  const direct = engine.createConversation(['user:local-user', 'agent:a']);
  await engine.sendUserMessage({ conversationId: direct.id, to: 'agent:a', text: 'private-secret' });
  engine.rooms.post(room.id, 'user:alice', { text: '@a group-question' });
  await settled(engine, room.id);
  assert.doesNotMatch(JSON.stringify(fixture.requests[1]?.messages), /private-secret/);
  await engine.sendUserMessage({ conversationId: direct.id, to: 'agent:a', text: 'private-followup' });
  assert.match(JSON.stringify(fixture.requests.at(-1)?.messages), /private-secret/);
  assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)?.messages), /group-question/);
  const other = engine.rooms.create(['user:alice', 'agent:a']);
  engine.rooms.post(other.id, 'user:alice', { text: '@a other-room' });
  await settled(engine, other.id);
  assert.doesNotMatch(JSON.stringify(fixture.requests.at(-2)?.messages), /group-question|private-secret/);
});
