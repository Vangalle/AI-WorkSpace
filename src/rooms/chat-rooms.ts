import { randomUUID } from 'node:crypto';
import type { ActorId } from '../agent.js';
import { EngineError } from '../errors.js';
import { actor, identifier, invalid, object, onlyKeys, text } from '../validation.js';
import { MAX_CONVERSATION_PARTICIPANTS } from '../constants.js';
import { roomMentions } from './mentions.js';
import { ParticipationScheduler, type RoomOptions } from './participation.js';
import type {
  Room,
  RoomDecision,
  RoomEvent,
  RoomMessage,
  RoomObservation,
  RoomPost,
} from './types.js';
export type { RoomOptions } from './participation.js';

interface RoomHost {
  assertAgent(id: string): void;
  observe(id: string, input: RoomObservation, signal: AbortSignal): Promise<RoomDecision>;
}

interface RoomState {
  view: Room;
  seq: number;
  events: RoomEvent[];
  listeners: Set<(event: RoomEvent) => void>;
  replays: Map<string, RoomMessage>;
}

/** Owns shared places, membership, transcripts and delivery; participation is asynchronous. */
export class ChatRooms {
  private readonly rooms = new Map<string, RoomState>();
  private readonly participation: ParticipationScheduler;
  private closed = false;

  constructor(
    private readonly host: RoomHost,
    options: RoomOptions = {},
  ) {
    this.participation = new ParticipationScheduler(
      {
        snapshot: (id) => this.rooms.get(id)!.view,
        observe: (id, input, signal) => host.observe(id, input, signal),
        reply: (id, agent, content, replyTo) => {
          const state = this.rooms.get(id)!;
          const message = this.message(state, agent, content, replyTo);
          this.emit(state, { type: 'message', message });
          return message;
        },
        activity: (id, activity) => {
          const state = this.rooms.get(id)!;
          state.view.activity.push(activity);
          this.emit(state, { type: 'activity', activity });
        },
      },
      options,
    );
  }

  /** Members are fixed; agents must be registered but need not be running. */
  create(participants: ActorId[]): Room {
    this.assertOpen();
    if (
      !Array.isArray(participants) ||
      participants.length < 2 ||
      participants.length > MAX_CONVERSATION_PARTICIPANTS
    )
      invalid(`A room needs 2 to ${MAX_CONVERSATION_PARTICIPANTS} participants`);
    const members = [...new Set(participants.map(actor))];
    if (members.length < 2 || !members.some((member) => member.startsWith('user:')))
      invalid('A room needs distinct participants including a user');
    for (const member of members)
      if (member.startsWith('agent:')) this.host.assertAgent(member.slice(6));
    const view: Room = {
      id: randomUUID(),
      status: 'open',
      eventCursor: 0,
      participants: members,
      messages: [],
      activity: [],
    };
    this.rooms.set(view.id, { view, seq: 0, events: [], listeners: new Set(), replays: new Map() });
    this.participation.register(view.id);
    return structuredClone(view);
  }

  get(id: string, principal: ActorId): Room {
    return structuredClone(this.member(id, principal).view);
  }

  list(principal: ActorId): Room[] {
    actor(principal);
    return [...this.rooms.values()]
      .filter((state) => state.view.participants.includes(principal))
      .map((state) => structuredClone(state.view));
  }

  /** Return after delivery, without awaiting any agent observation. */
  post(id: string, principal: ActorId, value: RoomPost): RoomMessage {
    this.assertOpen();
    const state = this.member(id, principal);
    this.assertRoomOpen(state);
    if (!principal.startsWith('user:'))
      throw new EngineError('FORBIDDEN', 'Only authenticated users may submit room messages', 403);
    const input = object(value);
    onlyKeys(input, ['text', 'clientId']);
    const content = text(input.text, 'text');
    const clientId =
      input.clientId === undefined ? undefined : identifier(input.clientId, 'clientId');
    const replayKey = clientId ? JSON.stringify([principal, clientId]) : undefined;
    const replay = replayKey ? state.replays.get(replayKey) : undefined;
    if (replay) {
      if (replay.text !== content)
        throw new EngineError(
          'IDEMPOTENCY_CONFLICT',
          'clientId was used for different content',
          409,
        );
      return structuredClone(replay);
    }
    this.participation.assertCapacity(id);
    const message = this.message(state, principal, content);
    if (replayKey) state.replays.set(replayKey, message);
    // Subscribers may post reentrantly; queue in admission order before notifying them.
    this.participation.enqueue(id, message);
    this.emit(state, { type: 'message', message });
    return structuredClone(message);
  }

  /** Replay then follow live updates; expired cursors require a new room snapshot. */
  subscribe(
    id: string,
    principal: ActorId,
    listener: (event: RoomEvent) => void,
    after = 0,
  ): () => void {
    this.assertOpen();
    const state = this.member(id, principal);
    this.assertRoomOpen(state);
    if (!Number.isSafeInteger(after) || after < 0 || after > state.seq)
      invalid('Invalid event cursor');
    if (after < (state.events[0]?.seq ?? 1) - 1)
      throw new EngineError(
        'EVENTS_EXPIRED',
        'Event history expired; fetch the room snapshot',
        409,
      );
    for (const event of state.events.filter((event) => event.seq > after))
      this.notify(listener, event);
    if (state.view.status === 'open') state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  /** Close one place without disposing its agent participants or deleting its transcript. */
  closeRoom(id: string, principal: ActorId): void {
    const state = this.member(id, principal);
    this.closeState(state);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.participation.close();
    for (const state of this.rooms.values()) this.closeState(state);
  }

  private closeState(state: RoomState): void {
    if (state.view.status === 'closed') return;
    state.view.status = 'closed';
    this.participation.closeRoom(state.view.id);
    this.emit(state, { type: 'closed' });
    state.listeners.clear();
  }

  private message(state: RoomState, from: ActorId, content: string, replyTo?: string): RoomMessage {
    const message: RoomMessage = {
      id: randomUUID(),
      roomId: state.view.id,
      from,
      text: content,
      createdAt: new Date().toISOString(),
      mentions: from.startsWith('user:') ? roomMentions(content, state.view.participants) : [],
    };
    if (replyTo) message.replyTo = replyTo;
    state.view.messages.push(message);
    return message;
  }

  private emit(
    state: RoomState,
    value:
      | { type: 'message'; message: RoomMessage }
      | { type: 'activity'; activity: Room['activity'][number] }
      | { type: 'closed' },
  ): void {
    const event: RoomEvent = structuredClone({ ...value, seq: ++state.seq, roomId: state.view.id });
    state.view.eventCursor = event.seq;
    state.events.push(event);
    if (state.events.length > 1000) state.events.shift();
    for (const listener of state.listeners) this.notify(listener, event);
  }

  private notify(listener: (event: RoomEvent) => void, event: RoomEvent): void {
    try {
      listener(structuredClone(event));
    } catch {
      /* Client errors must not break delivery. */
    }
  }

  private member(id: string, principal: ActorId): RoomState {
    actor(principal);
    const state = this.rooms.get(identifier(id, 'roomId'));
    if (!state) throw new EngineError('NOT_FOUND', 'Room not found', 404);
    if (!state.view.participants.includes(principal))
      throw new EngineError('FORBIDDEN', 'Room is not accessible', 403);
    return state;
  }

  private assertRoomOpen(state: RoomState): void {
    if (state.view.status === 'closed') throw new EngineError('ROOM_CLOSED', 'Room is closed', 409);
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('CLOSED', 'Chat rooms are closed', 503);
  }
}
