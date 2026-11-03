import type { AgentConfig, AgentRuntime, AgentRuntimeFactory, Message, RuntimeContext } from '../src/agent.js';

export function config(id = 'a', overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    runtime: 'pi',
    model: { provider: 'openai', id: 'gpt-4.1-mini' },
    systemPrompt: { mode: 'replace', text: `You are ${id}.` },
    allowSendTo: ['agent:a', 'agent:b', 'user:local-user'],
    ...overrides,
  };
}

export type Handler = (message: Readonly<Message>, context: RuntimeContext, history: string[], agent: AgentConfig) => Promise<string>;

export class TestRuntimeFactory implements AgentRuntimeFactory {
  loads: AgentConfig[] = [];
  disposals: string[] = [];
  constructor(public handler: Handler = async (message, _context, history) => {
    history.push(message.text);
    return `${history.length}: ${message.text}`;
  }) {}

  async load(agent: AgentConfig): Promise<AgentRuntime> {
    this.loads.push(structuredClone(agent));
    const histories = new Map<string, string[]>();
    return {
      receive: async (message, context) => {
        const history = histories.get(message.conversationId) ?? [];
        histories.set(message.conversationId, history);
        return this.handler(message, context, history, agent);
      },
      dispose: async () => { this.disposals.push(agent.id); histories.clear(); },
    };
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
