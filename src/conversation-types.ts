import type { ActorId, Failure } from './agent.js';

/** A directed request/reply record; never part of a shared room transcript implicitly. */
export interface Message {
  id: string;
  conversationId: string;
  from: ActorId;
  to: ActorId;
  text: string;
  createdAt: string;
  replyTo?: string;
  status: 'accepted' | 'processing' | 'delivered' | 'completed' | 'failed';
  error?: Failure;
}

export interface Conversation {
  id: string;
  participants: ActorId[];
  messages: Message[];
}

export interface SendInput {
  conversationId: string;
  to: ActorId;
  text: string;
  clientId?: string;
}

export interface SendResult {
  message: Message;
  reply?: Message;
}

/** Nested sends share the caller's deadline/budget and do not start a new root turn. */
export interface RuntimeContext {
  signal: AbortSignal;
  participants: readonly ActorId[];
  send(to: ActorId, text: string): Promise<SendResult>;
}
