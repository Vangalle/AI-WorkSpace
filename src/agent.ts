import type { RoomDecision, RoomObservation, RoomObserverContext } from './rooms/types.js';
import type { Message, RuntimeContext } from './conversation-types.js';

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
