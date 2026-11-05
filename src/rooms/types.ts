/** Room contracts: chat text, agent activity, and live events stay separate; silence creates no placeholder. */
import type { ActorId, Failure } from '../agent.js';

export type UserId = `user:${string}`;
export type AgentId = `agent:${string}`;

/** A room-wide message with no required recipient or obligation to reply. */
export interface RoomMessage {
  id: string;
  roomId: string;
  from: ActorId;
  text: string;
  createdAt: string;
  /**
   * Engine-parsed `@agent-id` mentions from user text only;
   * agent-authored messages always have an empty list.
   */
  mentions: AgentId[];
  replyTo?: string;
}

/**
 * One agent's outcome for a batch, separate from chat text.
 * Failures are visible without inventing a silent chat message.
 */
export interface RoomActivity {
  id: string;
  agentId: AgentId;
  triggerIds: string[];
  /**
   * True when this batch `@`-mentions the agent;
   * then silence becomes an unanswered-command failure.
   */
  requested: boolean;
  status: 'replied' | 'silent' | 'failed';
  createdAt: string;
  replyId?: string;
  error?: Failure;
}

export interface Room {
  id: string;
  status: 'open' | 'closed';
  /**
   * Latest retained event seq in this process;
   * subscribe with `after: eventCursor` to continue without gaps after a snapshot.
   */
  eventCursor: number;
  /** Fixed at creation; also the ACL for who may read or post. */
  participants: ActorId[];
  messages: RoomMessage[];
  activity: RoomActivity[];
}

/** Body only; the trusted sender identity is supplied by the caller, never by this object. */
export interface RoomPost {
  text: string;
  /**
   * Deduplicated per room and sender;
   * a matching replay returns the prior message and does not re-run inference.
   */
  clientId?: string;
}

/**
 * Snapshot passed to an observer for one batch.
 * `messages` is room history; `pending` is the new user messages in this batch.
 */
export interface RoomObservation {
  roomId: string;
  agentId: AgentId;
  participants: ActorId[];
  messages: RoomMessage[];
  pending: RoomMessage[];
  requested: boolean;
}

/** Silence is an explicit outcome, not an empty string or a text sentinel such as NO_REPLY. */
export type RoomDecision = { action: 'silent' } | { action: 'reply'; text: string };

/**
 * Process-local sequence numbers for one room;
 * retained events may expire and are not a durable log.
 */
export type RoomEvent = { seq: number; roomId: string } & (
  | { type: 'message'; message: RoomMessage }
  | { type: 'activity'; activity: RoomActivity }
  | { type: 'closed' }
);

export interface RoomObserverContext {
  signal: AbortSignal;
}
