import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { ChatApplication } from '../src/application.js';
import { createChatServer } from '../src/http.js';
import { PiRuntimeFactory } from '../src/runtime/pi.js';
import { config, TestRuntimeFactory } from './helpers.js';
import { fixtureProvider } from './fixtures/provider.js';

const token = 'integration-test-token-1234567890';

async function serve(app = new ChatApplication(new TestRuntimeFactory())) {
  const server = createChatServer(app, { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    async request(path: string, method = 'GET', body?: unknown) {
      return fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async close() {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test('http requires bearer authentication on all routes and rejects weak server tokens', async (t) => {
  const service = await serve();
  t.after(() => service.close());
  assert.equal((await fetch(`${service.base}/health`)).status, 401);
  assert.equal(
    (await fetch(`${service.base}/agents`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  const health = await service.request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ok',
    storage: 'memory',
    principal: 'user:local-user',
  });
  assert.throws(
    () => createChatServer(new ChatApplication(new TestRuntimeFactory()), { token: '' }),
    { code: 'INVALID_INPUT' },
  );
});

test('http exposes register/start/conversation/send/read/stop acceptance path', async (t) => {
  const service = await serve();
  t.after(() => service.close());
  assert.equal((await service.request('/agents', 'POST', config())).status, 201);
  assert.equal((await service.request('/agents/a/start', 'POST')).status, 200);
  const conversationResponse = await service.request('/conversations', 'POST', {
    participants: ['user:local-user', 'agent:a'],
  });
  assert.equal(conversationResponse.status, 201);
  const conversation = (await conversationResponse.json()) as { id: string };
  const input = { conversationId: conversation.id, to: 'agent:a', text: 'hello', clientId: 'one' };
  const resultResponse = await service.request('/messages', 'POST', input);
  assert.equal(resultResponse.status, 200);
  const sent = (await resultResponse.json()) as {
    message: { id: string };
    reply: { text: string };
  };
  assert.equal(sent.reply.text, '1: hello');
  const replay = (await (await service.request('/messages', 'POST', input)).json()) as typeof sent;
  assert.equal(replay.message.id, sent.message.id);
  const messages = (await (
    await service.request(`/conversations/${conversation.id}/messages`)
  ).json()) as unknown[];
  assert.equal(messages.length, 2);
  assert.equal((await service.request(`/conversations/${conversation.id}`)).status, 200);
  assert.equal((await service.request('/agents/a/stop', 'POST')).status, 200);
  assert.equal(
    ((await (await service.request('/agents/a')).json()) as { status: string }).status,
    'stopped',
  );
  assert.equal((await service.request('/agents')).status, 200);
});

test('http rejects spoofed identities, malformed input, oversized bodies and unknown paths', async (t) => {
  const service = await serve();
  t.after(() => service.close());
  assert.equal(
    (await service.request('/agents', 'POST', { ...config(), runtime: 'shell' })).status,
    400,
  );
  assert.equal(
    (
      await service.request('/messages', 'POST', {
        from: 'agent:a',
        conversationId: 'fake',
        to: 'agent:b',
        text: 'spoof',
      })
    ).status,
    400,
  );
  assert.equal(
    (await service.request('/conversations', 'POST', { participants: ['user:other', 'agent:a'] }))
      .status,
    403,
  );
  assert.equal((await service.request('/agents/nope')).status, 404);
  assert.equal((await service.request('/unknown')).status, 404);
  assert.equal((await service.request('/agents', 'PUT', {})).status, 405);
  assert.equal((await service.request('/agents', 'POST', null)).status, 400);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal(
    (await fetch(`${service.base}/agents`, { method: 'POST', headers, body: '{' })).status,
    400,
  );
  assert.equal(
    (await fetch(`${service.base}/agents`, { method: 'POST', headers, body: 'x'.repeat(150_000) }))
      .status,
    413,
  );
  assert.equal(
    (
      await fetch(`${service.base}/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      })
    ).status,
    415,
  );
});

test('http maps lifecycle errors and preserves failed message status', async (t) => {
  const app = new ChatApplication({
    load: async () => {
      throw new Error('secret-provider-key');
    },
  });
  const service = await serve(app);
  t.after(() => service.close());
  await service.request('/agents', 'POST', config());
  const failed = await service.request('/agents/a/start', 'POST');
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /secret-provider-key/);
  const conversation = (await (
    await service.request('/conversations', 'POST', {
      participants: ['user:local-user', 'agent:a'],
    })
  ).json()) as { id: string };
  const sent = (await (
    await service.request('/messages', 'POST', {
      conversationId: conversation.id,
      to: 'agent:a',
      text: 'hi',
    })
  ).json()) as { message: { status: string; error: { code: string } } };
  assert.equal(sent.message.status, 'failed');
  assert.equal(sent.message.error.code, 'AGENT_UNAVAILABLE');
});

test('http integrates real Pi SDK against local protocol fixture end-to-end', async (t) => {
  const fixture = await fixtureProvider();
  const app = new ChatApplication(
    new PiRuntimeFactory({
      cwd: fixture.directory,
      agentDir: fixture.directory,
      modelsPath: fixture.modelsPath,
    }),
  );
  const service = await serve(app);
  t.after(async () => {
    await service.close();
    await fixture.close();
  });
  for (const id of ['a', 'b']) {
    assert.equal(
      (
        await service.request(
          '/agents',
          'POST',
          config(id, { model: { provider: 'fixture', id: 'fixture-model' } }),
        )
      ).status,
      201,
    );
    assert.equal((await service.request(`/agents/${id}/start`, 'POST')).status, 200);
  }
  const conversation = (await (
    await service.request('/conversations', 'POST', {
      participants: ['user:local-user', 'agent:a', 'agent:b'],
    })
  ).json()) as { id: string };
  const response = await service.request('/messages', 'POST', {
    conversationId: conversation.id,
    to: 'agent:a',
    text: 'delegate',
  });
  const sent = (await response.json()) as { reply: { text: string } };
  assert.equal(sent.reply.text, 'A concludes: fixture answer');
});
