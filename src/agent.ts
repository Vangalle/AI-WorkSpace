import type { RoomDecision, RoomObservation, RoomObserverContext } from './rooms/types.js';

/** Stable participant identity: local user or registered agent. */
export type ActorId = `user:${string}` | `agent:${string}`;

/** Declared agent configuration. Credentials are env var names, never plaintext secrets. */
export interface AgentConfig {
  id: string;
  runtime: 'pi';
  model: { provider: string; id: string; apiKeyEnv?: string };
  /** `replace` sets the base prompt; `append` adds to the runtime base. Engine communication rules are always appended. */
  systemPrompt: { mode: 'replace' | 'append'; text: string };
  /** Recipients this agent may message via runtime `send`. Default deny. */
  allowSendTo: ActorId[];
}

/** Safe failure payload retained on messages and agent views. */
export interface Failure {
  code: string;
  message: string;
}

/** Public agent status snapshot (no live runtime handle). */
export interface AgentView {
  config: AgentConfig;
  status: 'stopped' | 'loading' | 'running' | 'stopping' | 'failed';
  error?: Failure;
}

/**
 * One IM-neutral message in a conversation transcript.
 * Status progresses accepted → processing → completed|failed for agent recipients,
 * or accepted → delivered for user recipients.
 */
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

/** Conversation with immutable participants and in-memory transcript. */
export interface Conversation {
  id: string;
  participants: ActorId[];
  messages: Message[];
}

/** Outbound send request. Optional `clientId` enables sender/conversation idempotent replay. */
export interface SendInput {
  conversationId: string;
  to: ActorId;
  text: string;
  clientId?: string;
}

/** Result of a send: the recorded outbound message and optional agent reply. */
export interface SendResult {
  message: Message;
  reply?: Message;
}

/**
 * Capabilities bound to the active agent turn.
 * Nested `send` waits for agent replies; replies are recorded but do not auto-trigger another inference.
 */
export interface RuntimeContext {
  signal: AbortSignal;
  participants: readonly ActorId[];
  send(to: ActorId, text: string): Promise<SendResult>;
}

/** Loaded runtime instance: one conversation history per agent/conversation pair. */
export interface AgentRuntime {
  receive(message: Readonly<Message>, context: RuntimeContext): Promise<string>;
  observe?(input: RoomObservation, context: RoomObserverContext): Promise<RoomDecision>;
  dispose(): void | Promise<void>;
}

/** Adapter that constructs a runtime from validated agent config. */
export interface AgentRuntimeFactory {
  load(config: AgentConfig): Promise<AgentRuntime>;
}
