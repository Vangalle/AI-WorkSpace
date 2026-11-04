import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export interface ProviderRequest {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
}

export function providerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return JSON.stringify(content);
}

export async function fixtureProvider(options: { beforeReply?: (request: ProviderRequest) => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-im-'));
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as ProviderRequest;
    requests.push(input);
    await options.beforeReply?.(input);
    if (response.destroyed) return;
    const last = input.messages.at(-1);
    const content = providerText(last?.content);
    if (content.includes('provider-failure')) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'secret-provider-error', type: 'authentication_error' } }));
      return;
    }
    const system = JSON.stringify(input.messages.find((message) => ['system', 'developer'].includes(message.role))?.content);
    const toolCall = system.includes('You are a.') && last?.role === 'user' && content.includes('delegate');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null = null) => {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    chunk({ role: 'assistant' });
    const roomMode = input.tools?.some((tool) => tool.function.name === 'room_action') && last?.role === 'user';
    const roomInput = roomMode ? JSON.parse(content) as { messages: Array<{ id: string; text: string }>; pendingMessageIds: string[] } : undefined;
    const pendingContent = roomInput?.messages.filter((m) => roomInput.pendingMessageIds.includes(m.id)).map((m) => m.text).join('\n') ?? '';
    if (roomMode && !pendingContent.includes('room-raw')) {
      const args = pendingContent.includes('room-invalid') ? { action: 'reply', text: '' }
        : pendingContent.includes('room-silent') ? { action: 'silent' }
        : { action: 'reply', text: 'room fixture reply' };
      const calls = [{ index: 0, id: 'room-call', type: 'function', function: { name: 'room_action', arguments: JSON.stringify(args) } }];
      if (pendingContent.includes('room-multiple')) calls.push({ ...calls[0]!, index: 1, id: 'room-call-2' });
      chunk({ tool_calls: calls });
      chunk({}, 'tool_calls');
    } else if (toolCall) {
      chunk({ tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ to: 'agent:b', text: 'fixture question' }) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: last?.role === 'tool' ? 'A concludes: fixture answer' : 'fixture answer' });
      chunk({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const modelsPath = join(directory, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: 'openai-completions', apiKey: 'fixture-only-key',
    models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 128000, maxTokens: 1000, reasoning: false, input: ['text'] }],
  } } }));
  return {
    requests, directory, modelsPath,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
