import { randomUUID } from 'node:crypto';
import type { ActorId } from '../agent.js';
import { abortable, checkSignal, EngineError, failure } from '../errors.js';
import { actor, identifier, invalid, object, onlyKeys, text } from '../validation.js';
import { roomMentions } from './mentions.js';
import type { AgentId, Room, RoomActivity, RoomDecision, RoomEvent, RoomMessage, RoomObservation, RoomPost } from './types.js';

interface RoomHost {
  assertAgent(id: string): void;
  observe(id: string, input: RoomObservation, signal: AbortSignal): Promise<RoomDecision>;
}

interface RoomState {
  view: Room;
  pending: RoomMessage[];
  firstPendingAt: number;
  immediate: boolean;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
  seq: number;
  events: RoomEvent[];
  listeners: Set<(event: RoomEvent) => void>;
  replays: Map<string, RoomMessage>;
}

export interface RoomOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  timeoutMs?: number;
}

export class ChatRooms {
  private readonly rooms = new Map<string, RoomState>();
  private readonly active = new Set<{ agentId: AgentId; controller: AbortController }>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(private readonly host: RoomHost, options: RoomOptions = {}) {
    this.debounceMs = options.debounceMs ?? 250;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    for (const [name, value, min, max] of [
      ['debounceMs', this.debounceMs, 0, 10_000],
      ['maxWaitMs', this.maxWaitMs, 1, 30_000],
      ['timeoutMs', this.timeoutMs, 1, 300_000],
    ] as const) {
      if (!Number.isInteger(value) || value < min || value > max) invalid(`${name} must be an integer between ${min} and ${max}`);
    }
  }

  create(participants: ActorId[]): Room {
    this.assertOpen();
    if (!Array.isArray(participants) || participants.length < 2 || participants.length > 100) invalid('A room needs 2 to 100 participants');
    const members = [...new Set(participants.map(actor))];
    if (members.length < 2 || !members.some((member) => member.startsWith('user:'))) invalid('A room needs distinct participants including a user');
    for (const member of members) if (member.startsWith('agent:')) this.host.assertAgent(member.slice(6));
    const view: Room = { id: randomUUID(), eventCursor: 0, participants: members, messages: [], activity: [] };
    this.rooms.set(view.id, { view, pending: [], firstPendingAt: 0, immediate: false, active: false, seq: 0, events: [], listeners: new Set(), replays: new Map() });
    return structuredClone(view);
  }

  get(id: string, principal: ActorId): Room { return structuredClone(this.member(id, principal).view); }

  list(principal: ActorId): Room[] {
    actor(principal);
    return [...this.rooms.values()].filter((state) => state.view.participants.includes(principal)).map((state) => structuredClone(state.view));
  }

  /** Admission is synchronous and independent of agent execution. */
  post(id: string, principal: ActorId, value: RoomPost): RoomMessage {
    this.assertOpen();
    const state = this.member(id, principal);
    if (!principal.startsWith('user:')) throw new EngineError('FORBIDDEN', 'Only authenticated users may submit room messages', 403);
    const input = object(value);
    onlyKeys(input, ['text', 'clientId']);
    const content = text(input.text, 'text');
    const clientId = input.clientId === undefined ? undefined : identifier(input.clientId, 'clientId');
    const replayKey = clientId ? JSON.stringify([principal, clientId]) : undefined;
    const replay = replayKey ? state.replays.get(replayKey) : undefined;
    if (replay) {
      if (replay.text !== content) throw new EngineError('IDEMPOTENCY_CONFLICT', 'clientId was used for different content', 409);
      return structuredClone(replay);
    }
    if (state.pending.length >= 100) throw new EngineError('ROOM_BUSY', 'Room has too many pending messages', 429);
    const message = this.message(state, principal, content);
    if (replayKey) state.replays.set(replayKey, message);
    if (!state.pending.length) state.firstPendingAt = Date.now();
    state.pending.push(message);
    state.immediate ||= message.mentions.length > 0;
    this.emit(state, { type: 'message', message });
    this.schedule(state);
    return structuredClone(message);
  }

  /** Replays retained events after `after`, then follows live events until unsubscribed. */
  subscribe(id: string, principal: ActorId, listener: (event: RoomEvent) => void, after = 0): () => void {
    this.assertOpen();
    const state = this.member(id, principal);
    if (!Number.isSafeInteger(after) || after < 0 || after > state.seq) invalid('Invalid event cursor');
    if (after < (state.events[0]?.seq ?? 1) - 1) throw new EngineError('EVENTS_EXPIRED', 'Event history expired; fetch the room snapshot', 409);
    for (const event of state.events.filter((event) => event.seq > after)) this.notify(listener, event);
    state.listeners.add(listener);
    return () => { state.listeners.delete(listener); };
  }

  cancelAgent(agentId: AgentId): void {
    for (const active of this.active) {
      if (active.agentId === agentId) active.controller.abort(new EngineError('AGENT_STOPPED', 'Agent was stopped', 409));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active) active.controller.abort(new EngineError('CLOSED', 'Engine is closed', 503));
    for (const state of this.rooms.values()) {
      clearTimeout(state.timer);
      state.pending.length = 0;
      this.emit(state, { type: 'closed' });
      state.listeners.clear();
    }
  }

  private schedule(state: RoomState): void {
    if (this.closed || state.active || !state.pending.length) return;
    clearTimeout(state.timer);
    const remaining = Math.max(0, this.maxWaitMs - (Date.now() - state.firstPendingAt));
    const delay = state.immediate ? 0 : Math.min(this.debounceMs, remaining);
    state.timer = setTimeout(() => { void this.drain(state); }, delay);
  }

  private async drain(state: RoomState): Promise<void> {
    if (this.closed || state.active || !state.pending.length) return;
    state.active = true;
    const pending = state.pending.splice(0);
    state.immediate = false;
    const history = [...state.view.messages];
    const agents = state.view.participants.filter((id): id is AgentId => id.startsWith('agent:'));
    const requested = (id: AgentId) => pending.some((message) => message.mentions.includes(id));
    agents.sort((a, b) => Number(requested(b)) - Number(requested(a)));
    try {
      for (const agentId of agents) {
        if (this.closed) break;
        await this.observe(state, agentId, pending, history, requested(agentId));
      }
    } finally {
      state.active = false;
      this.schedule(state);
    }
  }

  private async observe(state: RoomState, agentId: AgentId, pending: RoomMessage[], history: RoomMessage[], requested: boolean): Promise<void> {
    const active = { agentId, controller: new AbortController() };
    const signal = active.controller.signal;
    this.active.add(active);
    const timer = setTimeout(() => active.controller.abort(new EngineError('TIMEOUT', 'Agent observation timed out', 504)), this.timeoutMs);
    const activity: RoomActivity = { id: randomUUID(), agentId, triggerIds: pending.map((m) => m.id), requested, status: 'failed', createdAt: new Date().toISOString() };
    try {
      const input: RoomObservation = structuredClone({ roomId: state.view.id, agentId, participants: state.view.participants, messages: history, pending, requested });
      const decision = await abortable(Promise.resolve().then(() => this.host.observe(agentId.slice(6), input, signal)), signal);
      checkSignal(signal);
      const action = object(decision, 'Room decision');
      if (action.action === 'silent') {
        onlyKeys(action, ['action']);
        if (requested) throw new EngineError('COMMAND_UNANSWERED', 'Addressed agent did not answer the command', 502);
        activity.status = 'silent';
      } else if (action.action === 'reply') {
        onlyKeys(action, ['action', 'text']);
        const content = text(action.text, 'Agent reply');
        const trigger = [...pending].reverse().find((m) => m.mentions.includes(agentId)) ?? pending.at(-1)!;
        const reply = this.message(state, agentId, content, trigger.id);
        history.push(reply);
        activity.status = 'replied';
        activity.replyId = reply.id;
        this.emit(state, { type: 'message', message: reply });
      } else throw new EngineError('MODEL_ERROR', 'Agent returned an invalid room decision', 502);
    } catch (error) {
      activity.error = failure(error);
    } finally {
      clearTimeout(timer);
      active.controller.abort(new EngineError('TURN_FINISHED', 'Observation has finished', 409));
      this.active.delete(active);
    }
    if (!this.closed) {
      state.view.activity.push(activity);
      this.emit(state, { type: 'activity', activity });
    }
  }

  private message(state: RoomState, from: ActorId, content: string, replyTo?: string): RoomMessage {
    const message: RoomMessage = { id: randomUUID(), roomId: state.view.id, from, text: content, createdAt: new Date().toISOString(), mentions: from.startsWith('user:') ? roomMentions(content, state.view.participants) : [] };
    if (replyTo) message.replyTo = replyTo;
    state.view.messages.push(message);
    return message;
  }

  private emit(state: RoomState, value: { type: 'message'; message: RoomMessage } | { type: 'activity'; activity: RoomActivity } | { type: 'closed' }): void {
    const event: RoomEvent = structuredClone({ ...value, seq: ++state.seq, roomId: state.view.id });
    state.view.eventCursor = event.seq;
    state.events.push(event);
    if (state.events.length > 1000) state.events.shift();
    for (const listener of state.listeners) this.notify(listener, event);
  }

  private notify(listener: (event: RoomEvent) => void, event: RoomEvent): void {
    try { listener(structuredClone(event)); } catch { /* A failed client must not affect room delivery. */ }
  }

  private member(id: string, principal: ActorId): RoomState {
    actor(principal);
    const state = this.rooms.get(identifier(id, 'roomId'));
    if (!state) throw new EngineError('NOT_FOUND', 'Room not found', 404);
    if (!state.view.participants.includes(principal)) throw new EngineError('FORBIDDEN', 'Room is not accessible', 403);
    return state;
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('CLOSED', 'Engine is closed', 503);
  }
}
