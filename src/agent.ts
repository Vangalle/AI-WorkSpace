import type { RoomDecision, RoomObservation, RoomObserverContext } from './rooms/types.js';

/** Stable participant identity: a user or a registered agent. */
export type ActorId = `user:${string}` | `agent:${string}`;

/** Declared agent configuration. Credentials are env var names, never plaintext secrets. */
export interface AgentConfig {
  id: string;
  runtime: 'pi';
  model: { provider: string; id: string; apiKeyEnv?: string };
  /**
   * `replace` sets the base prompt; `append` adds to the runtime base.
   * Engine communication rules are always appended.
   */
  systemPrompt: { mode: 'replace' | 'append'; text: string };
  /**
   * Default-deny allowlist for directed `send` recipients.
   * Room membership separately authorizes room replies.
   */
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
  status: 'stopped' | 'loading' | 'running' | 'stopping' | 'start_failed' | 'stop_failed';
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
 * Capabilities bound to the active directed turn.
 * Nested `send` waits for agent replies; those replies are recorded but do not
 * start another inference on the caller.
 */
export interface RuntimeContext {
  signal: AbortSignal;
  participants: readonly ActorId[];
  send(to: ActorId, text: string): Promise<SendResult>;
}

/**
 * Directed receive returns a mandatory reply string; room observe may choose silence.
 * Directed history is one session per agent/conversation; room observations do not share it.
 */
export interface AgentRuntime {
  /**
   * Handle a directed request. The engine records the returned text as the reply
   * to the sender.
   */
  receive(message: Readonly<Message>, context: RuntimeContext): Promise<string>;
  /**
   * Optional room participation. Missing support fails room use explicitly;
   * the engine never falls back to `receive`.
   */
  observe?(input: RoomObservation, context: RoomObserverContext): Promise<RoomDecision>;
  /** Idempotent; on failure retain unreleased resources so a later call can retry cleanup. */
  dispose(): void | Promise<void>;
}

/** Adapter that constructs a runtime from validated agent config. */
export interface AgentRuntimeFactory {
  /** Transfers runtime ownership on success; must clean up partial resources before rejecting. */
  load(config: AgentConfig): Promise<AgentRuntime>;
}
