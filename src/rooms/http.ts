import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentEngine } from '../engine.js';
import { EngineError } from '../errors.js';
import type { HttpPrincipal } from '../http-auth.js';
import { json, readJson } from '../http-io.js';
import { actor, invalid, object, onlyKeys } from '../validation.js';
import type { ChatRooms } from './chat-rooms.js';
import type { RoomEvent, RoomPost, UserId } from './types.js';

/** Authenticated SSE: replay and live updates share one event format and a room-local cursor. */
function events(
  rooms: ChatRooms,
  id: string,
  principal: UserId,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const raw =
    new URL(request.url ?? '/', 'http://localhost').searchParams.get('after') ??
    request.headers['last-event-id'] ??
    '0';
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) invalid('Invalid event cursor');
  let started = false;
  const replay: RoomEvent[] = [];
  let off = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    off();
    clearInterval(heartbeat);
  };
  const write = (event: RoomEvent) => {
    if (response.destroyed || response.writableEnded) return;
    // Disconnect slow clients once pending writes exceed 256 KiB;
    // replay is preferable to unbounded buffering.
    if (response.writableLength > 262144) {
      response.destroy();
      return;
    }
    response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'closed') {
      response.end();
      cleanup();
    }
  };
  // Subscribe validates and replays synchronously; buffer until headers are sent
  // so failures can still return JSON.
  off = rooms.subscribe(
    id,
    principal,
    (event) => {
      if (started) write(event);
      else replay.push(event);
    },
    Number(raw),
  );
  response.on('close', cleanup);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  started = true;
  for (const event of replay) write(event);
  if (response.destroyed || response.writableEnded) {
    cleanup();
    return;
  }
  heartbeat = setInterval(() => {
    if (response.writableLength > 262144) response.destroy();
    else response.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();
}

/**
 * Room HTTP routes. Non-admins may create a room only when they are a participant;
 * admins may create rooms for others. Reading and posting still require membership.
 */
export async function roomRoute(
  engine: AgentEngine,
  path: string[],
  principal: HttpPrincipal,
  knownUsers: Set<UserId>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const [, id, action] = path;
  const method = request.method ?? 'GET';
  if (path.length === 1 && method === 'POST') {
    const input = object(await readJson(request));
    onlyKeys(input, ['participants']);
    if (!Array.isArray(input.participants)) invalid('participants must be an array');
    const participants = input.participants.map(actor);
    if (!principal.admin && !participants.includes(principal.id))
      throw new EngineError('FORBIDDEN', 'Room must include the authenticated user', 403);
    if (participants.some((id) => id.startsWith('user:') && !knownUsers.has(id as UserId)))
      invalid('Room contains an unconfigured user');
    json(response, 201, engine.rooms.create(participants));
  } else if (path.length === 1 && method === 'GET') {
    json(response, 200, engine.rooms.list(principal.id));
  } else if (id && path.length === 2 && method === 'GET') {
    json(response, 200, engine.rooms.get(id, principal.id));
  } else if (id && path.length === 3 && action === 'messages' && method === 'POST') {
    // Reject nonmembers before reading the body;
    // admission rechecks membership rather than trusting call order.
    engine.rooms.get(id, principal.id);
    json(response, 201, engine.rooms.post(id, principal.id, (await readJson(request)) as RoomPost));
  } else if (id && path.length === 3 && action === 'messages' && method === 'GET') {
    json(response, 200, engine.rooms.get(id, principal.id).messages);
  } else if (id && path.length === 3 && action === 'events' && method === 'GET') {
    events(engine.rooms, id, principal.id, request, response);
  } else {
    throw new EngineError('NOT_FOUND', 'Route not found', 404);
  }
}
