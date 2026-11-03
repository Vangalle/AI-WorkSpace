import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ActorId } from './agent.js';
import type { AgentEngine } from './engine.js';
import { EngineError, safeError } from './errors.js';
import { actor, agentConfig, invalid, object, onlyKeys, sendInput } from './validation.js';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new EngineError('CONTENT_TYPE', 'Use application/json', 415);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 131072) {
        chunks.length = 0;
        reject(new EngineError('BODY_TOO_LARGE', 'JSON body exceeds 128 KiB', 413));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > 131072) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new EngineError('INVALID_INPUT', 'Invalid JSON body')); }
    });
    request.on('error', () => reject(new EngineError('INVALID_INPUT', 'Could not read request body')));
    request.on('aborted', () => reject(new EngineError('INVALID_INPUT', 'Request was aborted')));
  });
}

export function createEngineServer(engine: AgentEngine, options: { token: string }) {
  if (typeof options.token !== 'string' || options.token.trim().length < 24 || options.token.length > 256 || /\s/.test(options.token)) invalid('HTTP token must be 24 to 256 non-whitespace characters');
  const authorization = Buffer.from(`Bearer ${options.token}`);
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    void (async () => {
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (provided.length !== authorization.length || !timingSafeEqual(provided, authorization)) {
        request.resume();
        response.setHeader('www-authenticate', 'Bearer');
        json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
        return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); } catch { return invalid('Invalid URL encoding'); }
      });
      const method = request.method ?? 'GET';
      if (!['GET', 'POST'].includes(method)) throw new EngineError('METHOD_NOT_ALLOWED', 'Use GET or POST', 405);
      const [resource, id, action] = path;
      if (resource === 'health' && path.length === 1 && method === 'GET') {
        json(response, 200, { status: 'ok', storage: 'memory', principal: 'user:local-user' });
      } else if (resource === 'agents' && path.length === 1) {
        if (method === 'GET') json(response, 200, engine.listAgents());
        else json(response, 201, engine.registerAgent(agentConfig(await readJson(request))));
      } else if (resource === 'agents' && id && path.length === 2 && method === 'GET') {
        json(response, 200, engine.getAgent(id));
      } else if (resource === 'agents' && id && path.length === 3 && method === 'POST' && ['start', 'stop'].includes(action ?? '')) {
        request.resume();
        json(response, 200, action === 'start' ? await engine.startAgent(id) : await engine.stopAgent(id));
      } else if (resource === 'conversations' && path.length === 1 && method === 'POST') {
        const input = object(await readJson(request));
        onlyKeys(input, ['participants']);
        if (!Array.isArray(input.participants)) invalid('participants must be an array');
        const participants: ActorId[] = input.participants.map(actor);
        if (!participants.includes('user:local-user')) throw new EngineError('FORBIDDEN', 'Conversation must include the authenticated user', 403);
        if (participants.some((member) => member.startsWith('user:') && member !== 'user:local-user')) throw new EngineError('FORBIDDEN', 'This single-owner service only supports user:local-user', 403);
        json(response, 201, engine.createConversation(participants));
      } else if (resource === 'conversations' && id && method === 'GET' && (path.length === 2 || (path.length === 3 && action === 'messages'))) {
        const conversation = engine.getConversation(id);
        if (!conversation.participants.includes('user:local-user')) throw new EngineError('FORBIDDEN', 'Conversation is not accessible', 403);
        json(response, 200, action === 'messages' ? conversation.messages : conversation);
      } else if (resource === 'messages' && path.length === 1 && method === 'POST') {
        json(response, 200, await engine.sendUserMessage(sendInput(await readJson(request))));
      } else {
        request.resume();
        throw new EngineError('NOT_FOUND', 'Route not found', 404);
      }
    })().catch((error: unknown) => {
      request.resume();
      const safe = safeError(error);
      if (!response.headersSent) {
        if (safe.status === 413) response.setHeader('connection', 'close');
        json(response, safe.status, { error: { code: safe.code, message: safe.message } });
      } else response.end();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
