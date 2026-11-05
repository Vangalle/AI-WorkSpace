import { createServer } from 'node:http';
import type { ActorId } from './agent.js';
import type { AgentEngine } from './engine.js';
import { EngineError, safeError } from './errors.js';
import { actor, agentConfig, invalid, object, onlyKeys, sendInput } from './validation.js';

import { serverCredentials, type EngineServerOptions } from './http-auth.js';
import { json, readJson } from './http-io.js';
import { roomRoute } from './rooms/http.js';

/**
 * Loopback HTTP adapter: authenticate, map credentials to principals, and call the engine.
 * Directed conversation/message routes stay admin-only (`user:local-user`).
 * Room routes accept distinct user tokens, still subject to room membership.
 * Sender identity comes only from authentication, never from request bodies.
 */
export function createEngineServer(engine: AgentEngine, options: EngineServerOptions) {
  const credentials = serverCredentials(options);
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    void (async () => {
      const principal = credentials.authenticate(request.headers.authorization);
      if (!principal) {
        request.resume();
        response.setHeader('www-authenticate', 'Bearer');
        json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
        return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
        .split('/')
        .filter(Boolean)
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return invalid('Invalid URL encoding');
          }
        });
      const method = request.method ?? 'GET';
      if (!['GET', 'POST'].includes(method))
        throw new EngineError('METHOD_NOT_ALLOWED', 'Use GET or POST', 405);
      const [resource, id, action] = path;
      if (resource === 'health' && path.length === 1 && method === 'GET') {
        json(response, 200, { status: 'ok', storage: 'memory', principal: principal.id });
        return;
      }
      if (resource === 'rooms') {
        await roomRoute(engine, path, principal, credentials.knownUsers, request, response);
        return;
      }
      if (!principal.admin)
        throw new EngineError('FORBIDDEN', 'This endpoint requires the admin credential', 403);
      if (resource === 'agents' && path.length === 1) {
        if (method === 'GET') json(response, 200, engine.listAgents());
        else json(response, 201, engine.registerAgent(agentConfig(await readJson(request))));
      } else if (resource === 'agents' && id && path.length === 2 && method === 'GET') {
        json(response, 200, engine.getAgent(id));
      } else if (
        resource === 'agents' &&
        id &&
        path.length === 3 &&
        method === 'POST' &&
        ['start', 'stop'].includes(action ?? '')
      ) {
        request.resume();
        json(
          response,
          200,
          action === 'start' ? await engine.startAgent(id) : await engine.stopAgent(id),
        );
      } else if (resource === 'conversations' && path.length === 1 && method === 'POST') {
        const input = object(await readJson(request));
        onlyKeys(input, ['participants']);
        if (!Array.isArray(input.participants)) invalid('participants must be an array');
        const participants: ActorId[] = input.participants.map(actor);
        if (!participants.includes('user:local-user'))
          throw new EngineError(
            'FORBIDDEN',
            'Conversation must include the authenticated user',
            403,
          );
        if (
          participants.some((member) => member.startsWith('user:') && member !== 'user:local-user')
        )
          throw new EngineError(
            'FORBIDDEN',
            'This single-owner service only supports user:local-user',
            403,
          );
        json(response, 201, engine.createConversation(participants));
      } else if (
        resource === 'conversations' &&
        id &&
        method === 'GET' &&
        (path.length === 2 || (path.length === 3 && action === 'messages'))
      ) {
        const conversation = engine.getConversation(id);
        if (!conversation.participants.includes('user:local-user'))
          throw new EngineError('FORBIDDEN', 'Conversation is not accessible', 403);
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
