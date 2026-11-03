import { resolve } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ActorId, AgentConfig, AgentRuntime, AgentRuntimeFactory, Message, RuntimeContext } from '../agent.js';
import { checkSignal, EngineError } from '../errors.js';
import { actor, agentConfig } from '../validation.js';
import { piResources } from './pi-resources.js';

export interface PiRuntimeOptions {
  cwd?: string;
  agentDir?: string;
  modelsPath?: string;
  authPath?: string;
}

export class PiRuntimeFactory implements AgentRuntimeFactory {
  private readonly cwd: string;
  private readonly agentDir: string;
  constructor(private readonly options: PiRuntimeOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.agentDir = resolve(options.agentDir ?? resolve(this.cwd, '.pi'));
  }

  async load(value: AgentConfig): Promise<AgentRuntime> {
    const config = agentConfig(value);
    const modelRuntime = await ModelRuntime.create({
      authPath: this.options.authPath ?? resolve(this.agentDir, 'auth.json'),
      modelsPath: this.options.modelsPath ?? resolve(this.agentDir, 'models.json'),
      modelsStorePath: resolve(this.agentDir, 'model-cache.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const model = modelRuntime.getModel(config.model.provider, config.model.id);
    if (!model) throw new EngineError('MODEL_NOT_FOUND', 'Configured provider/model was not found', 400);
    if (config.model.apiKeyEnv) {
      const key = process.env[config.model.apiKeyEnv];
      if (!key?.trim()) throw new EngineError('MISSING_CREDENTIALS', 'Configured credential environment variable is empty', 400);
      await modelRuntime.setRuntimeApiKey(config.model.provider, key);
    }
    const sessions = new Map<string, { session: AgentSession; active?: RuntimeContext }>();
    let disposed = false;

    const openSession = async (conversationId: string) => {
      const existing = sessions.get(conversationId);
      if (existing) return existing;
      const entry: { session?: AgentSession; active?: RuntimeContext } = {};
      const parameters = Type.Object({ to: Type.String(), text: Type.String({ minLength: 1, maxLength: 32000 }) });
      const sendTool: ToolDefinition<typeof parameters> = {
        name: 'send_message', label: 'Send message',
        description: 'Send to an allowed participant in this conversation. For an agent recipient, return its reply. Do not call yourself or an agent already in the call chain.',
        parameters,
        async execute(_id, params) {
          const context = entry.active;
          if (!context) throw new EngineError('TURN_FINISHED', 'No active message turn', 409);
          checkSignal(context.signal);
          const result = await context.send(actor(params.to), params.text);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
        },
      };
      const { session } = await createAgentSession({
        cwd: this.cwd, agentDir: this.agentDir, model, modelRuntime, thinkingLevel: 'off',
        tools: ['send_message'], customTools: [sendTool],
        resourceLoader: piResources(config),
        sessionManager: SessionManager.inMemory(this.cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      if (disposed) {
        session.dispose();
        throw new EngineError('AGENT_STOPPED', 'Agent was stopped', 409);
      }
      entry.session = session;
      const ready = entry as { session: AgentSession; active?: RuntimeContext };
      sessions.set(conversationId, ready);
      return ready;
    };

    return {
      receive: async (message: Readonly<Message>, context: RuntimeContext): Promise<string> => {
        if (disposed) throw new EngineError('AGENT_STOPPED', 'Agent was stopped', 409);
        checkSignal(context.signal);
        const entry = await openSession(message.conversationId);
        checkSignal(context.signal);
        if (entry.active) throw new EngineError('AGENT_BUSY', 'Session is processing another message', 409);
        entry.active = context;
        const cancel = () => {
          if (sessions.get(message.conversationId) === entry) sessions.delete(message.conversationId);
          delete entry.active;
          void entry.session.abort().catch(() => {});
        };
        context.signal.addEventListener('abort', cancel, { once: true });
        try {
          await entry.session.prompt(JSON.stringify({
            sender: message.from, recipient: message.to, text: message.text,
            participants: context.participants,
            allowedRecipients: config.allowSendTo.filter((recipient: ActorId) => context.participants.includes(recipient)),
          }), { expandPromptTemplates: false });
          checkSignal(context.signal);
          const last = entry.session.messages.at(-1);
          if (!last || last.role !== 'assistant' || !('stopReason' in last) || last.stopReason === 'error' || last.stopReason === 'aborted') {
            throw new EngineError('MODEL_ERROR', 'Model did not complete successfully', 502);
          }
          const response = last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          if (!response.trim()) throw new EngineError('MODEL_ERROR', 'Model returned no text response', 502);
          return response;
        } catch (error) {
          entry.session.dispose();
          if (sessions.get(message.conversationId) === entry) sessions.delete(message.conversationId);
          throw error;
        } finally {
          context.signal.removeEventListener('abort', cancel);
          delete entry.active;
        }
      },
      dispose: async () => {
        disposed = true;
        for (const { session } of sessions.values()) session.dispose();
        sessions.clear();
      },
    };
  }
}
