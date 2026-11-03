export type ActorId = `user:${string}` | `agent:${string}`;

export interface AgentConfig {
  id: string;
  runtime: 'pi';
  model: { provider: string; id: string; apiKeyEnv?: string };
  systemPrompt: { mode: 'replace' | 'append'; text: string };
  allowSendTo: ActorId[];
}

export interface Failure {
  code: string;
  message: string;
}

export interface AgentView {
  config: AgentConfig;
  status: 'stopped' | 'loading' | 'running' | 'stopping' | 'failed';
  error?: Failure;
}

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

export interface RuntimeContext {
  signal: AbortSignal;
  participants: readonly ActorId[];
  send(to: ActorId, text: string): Promise<SendResult>;
}

export interface AgentRuntime {
  receive(message: Readonly<Message>, context: RuntimeContext): Promise<string>;
  dispose(): void | Promise<void>;
}

export interface AgentRuntimeFactory {
  load(config: AgentConfig): Promise<AgentRuntime>;
}
