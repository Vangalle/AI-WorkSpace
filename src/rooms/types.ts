import type { ActorId, Failure } from '../agent.js';

export type UserId = `user:${string}`;
export type AgentId = `agent:${string}`;

export interface RoomMessage {
  id: string;
  roomId: string;
  from: ActorId;
  text: string;
  createdAt: string;
  mentions: AgentId[];
  replyTo?: string;
}

export interface RoomActivity {
  id: string;
  agentId: AgentId;
  triggerIds: string[];
  requested: boolean;
  status: 'replied' | 'silent' | 'failed';
  createdAt: string;
  replyId?: string;
  error?: Failure;
}

export interface Room {
  id: string;
  eventCursor: number;
  participants: ActorId[];
  messages: RoomMessage[];
  activity: RoomActivity[];
}

export interface RoomPost {
  text: string;
  clientId?: string;
}

export interface RoomObservation {
  roomId: string;
  agentId: AgentId;
  participants: ActorId[];
  messages: RoomMessage[];
  pending: RoomMessage[];
  requested: boolean;
}

export type RoomDecision = { action: 'silent' } | { action: 'reply'; text: string };

export type RoomEvent = { seq: number; roomId: string } & (
  | { type: 'message'; message: RoomMessage }
  | { type: 'activity'; activity: RoomActivity }
  | { type: 'closed' }
);

export interface RoomObserverContext { signal: AbortSignal }
