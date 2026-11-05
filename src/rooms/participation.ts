import { randomUUID } from 'node:crypto';
import { abortable, checkSignal, EngineError, failure } from '../errors.js';
import { invalid, object, onlyKeys, text } from '../validation.js';
import type {
  AgentId,
  Room,
  RoomActivity,
  RoomDecision,
  RoomMessage,
  RoomObservation,
} from './types.js';

export interface RoomOptions {
  /** Quiet period for batching user messages; explicit mentions bypass it (milliseconds). */
  debounceMs?: number;
  /** Maximum idle batching delay, without preempting active inference (milliseconds). */
  maxWaitMs?: number;
  /** Deadline per observation, excluding time waiting for earlier agents (milliseconds). */
  timeoutMs?: number;
}

interface ParticipationHost {
  snapshot(roomId: string): Room;
  observe(id: string, input: RoomObservation, signal: AbortSignal): Promise<RoomDecision>;
  reply(roomId: string, agentId: AgentId, text: string, replyTo: string): RoomMessage;
  activity(roomId: string, activity: RoomActivity): void;
}

interface Schedule {
  id: string;
  pending: RoomMessage[];
  firstPendingAt: number;
  immediate: boolean;
  active: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Asynchronous participation policy; it never owns human message admission or transcripts. */
export class ParticipationScheduler {
  private readonly schedules = new Map<string, Schedule>();
  private readonly active = new Set<{
    roomId: string;
    agentId: AgentId;
    controller: AbortController;
  }>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly host: ParticipationHost,
    options: RoomOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 250;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    for (const [name, value, min, max] of [
      ['debounceMs', this.debounceMs, 0, 10_000],
      ['maxWaitMs', this.maxWaitMs, 1, 30_000],
      ['timeoutMs', this.timeoutMs, 1, 300_000],
    ] as const) {
      if (!Number.isInteger(value) || value < min || value > max)
        invalid(`${name} must be an integer between ${min} and ${max}`);
    }
  }

  register(roomId: string): void {
    this.schedules.set(roomId, {
      id: roomId,
      pending: [],
      firstPendingAt: 0,
      immediate: false,
      active: false,
      closed: false,
    });
  }

  assertCapacity(roomId: string): void {
    if ((this.schedules.get(roomId)?.pending.length ?? 0) >= 100)
      throw new EngineError('ROOM_BUSY', 'Room has too many pending messages', 429);
  }

  enqueue(roomId: string, message: RoomMessage): void {
    const state = this.schedules.get(roomId);
    if (this.closed || !state || state.closed) return;
    if (!state.pending.length) state.firstPendingAt = Date.now();
    state.pending.push(message);
    state.immediate ||= message.mentions.length > 0;
    this.schedule(state);
  }

  closeRoom(roomId: string, reason = new EngineError('ROOM_CLOSED', 'Room is closed', 409)): void {
    const state = this.schedules.get(roomId);
    if (!state || state.closed) return;
    state.closed = true;
    clearTimeout(state.timer);
    state.pending.length = 0;
    for (const active of this.active) if (active.roomId === roomId) active.controller.abort(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.schedules.keys())
      this.closeRoom(id, new EngineError('CLOSED', 'Room participation is closed', 503));
  }

  private schedule(state: Schedule): void {
    if (this.closed || state.closed || state.active || !state.pending.length) return;
    clearTimeout(state.timer);
    const remaining = Math.max(0, this.maxWaitMs - (Date.now() - state.firstPendingAt));
    const delay = state.immediate ? 0 : Math.min(this.debounceMs, remaining);
    state.timer = setTimeout(() => {
      void this.drain(state);
    }, delay);
  }

  private async drain(state: Schedule): Promise<void> {
    if (this.closed || state.closed || state.active || !state.pending.length) return;
    state.active = true;
    const pending = state.pending.splice(0);
    state.immediate = false;
    const room = this.host.snapshot(state.id);
    const history = [...room.messages];
    const agents = room.participants.filter((id): id is AgentId => id.startsWith('agent:'));
    const requested = (id: AgentId) => pending.some((message) => message.mentions.includes(id));
    agents.sort((a, b) => Number(requested(b)) - Number(requested(a)));
    try {
      for (const agentId of agents) {
        if (this.closed || state.closed) break;
        await this.observe(state, agentId, pending, history, requested(agentId));
      }
    } finally {
      state.active = false;
      this.schedule(state);
    }
  }

  private async observe(
    state: Schedule,
    agentId: AgentId,
    pending: RoomMessage[],
    history: RoomMessage[],
    requested: boolean,
  ): Promise<void> {
    const active = { roomId: state.id, agentId, controller: new AbortController() };
    const signal = active.controller.signal;
    this.active.add(active);
    const timer = setTimeout(
      () => active.controller.abort(new EngineError('TIMEOUT', 'Agent observation timed out', 504)),
      this.timeoutMs,
    );
    const activity: RoomActivity = {
      id: randomUUID(),
      agentId,
      triggerIds: pending.map((message) => message.id),
      requested,
      status: 'failed',
      createdAt: new Date().toISOString(),
    };
    try {
      const input: RoomObservation = structuredClone({
        roomId: state.id,
        agentId,
        participants: this.host.snapshot(state.id).participants,
        messages: history,
        pending,
        requested,
      });
      const decision = await abortable(
        Promise.resolve().then(() => this.host.observe(agentId.slice(6), input, signal)),
        signal,
      );
      checkSignal(signal);
      const action = object(decision, 'Room decision');
      if (action.action === 'silent') {
        onlyKeys(action, ['action']);
        if (requested)
          throw new EngineError(
            'COMMAND_UNANSWERED',
            'Addressed agent did not answer the command',
            502,
          );
        activity.status = 'silent';
      } else if (action.action === 'reply') {
        onlyKeys(action, ['action', 'text']);
        const content = text(action.text, 'Agent reply');
        const trigger =
          [...pending].reverse().find((message) => message.mentions.includes(agentId)) ??
          pending.at(-1)!;
        const reply = this.host.reply(state.id, agentId, content, trigger.id);
        // Prior replies inform later observers but never enqueue an autonomous reply loop.
        history.push(reply);
        activity.status = 'replied';
        activity.replyId = reply.id;
      } else throw new EngineError('MODEL_ERROR', 'Agent returned an invalid room decision', 502);
    } catch (error) {
      activity.error = failure(error);
    } finally {
      clearTimeout(timer);
      active.controller.abort(new EngineError('TURN_FINISHED', 'Observation has finished', 409));
      this.active.delete(active);
    }
    if (!this.closed && !state.closed) this.host.activity(state.id, activity);
  }
}
