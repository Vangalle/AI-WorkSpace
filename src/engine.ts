import { randomUUID } from 'node:crypto';
import type { ActorId, AgentConfig, AgentRuntime, AgentRuntimeFactory, AgentView, Conversation, Message, SendInput, SendResult } from './agent.js';
import { abortable, checkSignal, EngineError, failure, safeError } from './errors.js';
import { actor, agentConfig, identifier, invalid, sendInput, text } from './validation.js';

interface Instance extends AgentView { runtime?: AgentRuntime }
interface Turn {
  controller: AbortController;
  agents: Set<ActorId>;
  busy: Set<ActorId>;
  sendsLeft: number;
}

export class AgentEngine {
  private readonly agents = new Map<string, Instance>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly replays = new Map<string, { fingerprint: string; result: Promise<SendResult> }>();
  private readonly turns = new Set<Turn>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly factory: AgentRuntimeFactory, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) invalid('timeoutMs must be between 1 and 300000');
  }

  registerAgent(value: AgentConfig): AgentView {
    this.assertOpen();
    const config = agentConfig(value);
    if (this.agents.has(config.id)) throw new EngineError('CONFLICT', 'Agent already exists', 409);
    this.agents.set(config.id, { config, status: 'stopped' });
    return this.getAgent(config.id);
  }

  getAgent(id: string): AgentView {
    const { config, status, error } = this.instance(id);
    return structuredClone(error ? { config, status, error } : { config, status });
  }

  listAgents(): AgentView[] { return [...this.agents.keys()].map((id) => this.getAgent(id)); }

  async startAgent(id: string): Promise<AgentView> {
    this.assertOpen();
    const instance = this.instance(id);
    if (instance.status === 'running') return this.getAgent(id);
    if (instance.status === 'loading' || instance.status === 'stopping') throw new EngineError('AGENT_BUSY', 'Agent lifecycle operation in progress', 409);
    instance.status = 'loading';
    delete instance.error;
    try {
      const runtime = await this.factory.load(structuredClone(instance.config));
      if (this.closed) {
        await runtime.dispose();
        throw new EngineError('CLOSED', 'Engine is closed', 503);
      }
      instance.runtime = runtime;
      instance.status = 'running';
      return this.getAgent(id);
    } catch (error) {
      instance.status = 'failed';
      instance.error = failure(error);
      throw safeError(error);
    }
  }

  async stopAgent(id: string): Promise<AgentView> {
    const instance = this.instance(id);
    if (instance.status === 'loading' || instance.status === 'stopping') throw new EngineError('AGENT_BUSY', 'Agent lifecycle operation in progress', 409);
    instance.status = 'stopping';
    const actorId: ActorId = `agent:${id}`;
    for (const turn of this.turns) {
      if (turn.agents.has(actorId)) turn.controller.abort(new EngineError('AGENT_STOPPED', 'Agent was stopped', 409));
    }
    try {
      await instance.runtime?.dispose();
      delete instance.runtime;
      delete instance.error;
      instance.status = 'stopped';
      return this.getAgent(id);
    } catch (error) {
      instance.status = 'failed';
      instance.error = failure(error);
      throw safeError(error);
    }
  }

  createConversation(participants: ActorId[]): Conversation {
    this.assertOpen();
    if (!Array.isArray(participants) || participants.length < 2 || participants.length > 100) invalid('A conversation needs 2 to 100 participants');
    const members = [...new Set(participants.map(actor))];
    if (members.length < 2) invalid('A conversation needs two distinct participants');
    for (const member of members) if (member.startsWith('agent:')) this.instance(member.slice(6));
    const conversation: Conversation = { id: randomUUID(), participants: members, messages: [] };
    this.conversations.set(conversation.id, conversation);
    return structuredClone(conversation);
  }

  getConversation(id: string): Conversation { return structuredClone(this.conversation(id)); }

  sendUserMessage(input: SendInput): Promise<SendResult> {
    return this.enqueue('user:local-user', input);
  }

  sendAgentMessage(id: string, input: SendInput): Promise<SendResult> {
    return this.enqueue(`agent:${identifier(id)}`, input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.turns) turn.controller.abort(new EngineError('CLOSED', 'Engine is closed', 503));
    await Promise.allSettled([...this.agents.keys()].filter((id) => this.instance(id).status !== 'loading').map((id) => this.stopAgent(id)));
  }

  private async enqueue(from: ActorId, value: SendInput): Promise<SendResult> {
    this.assertOpen();
    const input = sendInput(value);
    this.authorize(from, input);
    const replayKey = input.clientId ? JSON.stringify([from, input.conversationId, input.clientId]) : undefined;
    const fingerprint = JSON.stringify([input.to, input.text]);
    if (replayKey) {
      const replay = this.replays.get(replayKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new EngineError('IDEMPOTENCY_CONFLICT', 'clientId was used for different content', 409);
        return structuredClone(await replay.result);
      }
    }
    const previous = this.queues.get(input.conversationId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      this.assertOpen();
      const turn: Turn = { controller: new AbortController(), agents: new Set(), busy: new Set(), sendsLeft: 16 };
      if (from.startsWith('agent:')) turn.agents.add(from);
      this.turns.add(turn);
      const timer = setTimeout(() => turn.controller.abort(new EngineError('TIMEOUT', 'Agent processing timed out', 504)), this.timeoutMs);
      try {
        return await this.dispatch(from, input, turn, from.startsWith('agent:') ? [from] : []);
      } finally {
        clearTimeout(timer);
        turn.controller.abort(new EngineError('TURN_FINISHED', 'Message turn has finished', 409));
        this.turns.delete(turn);
      }
    });
    this.queues.set(input.conversationId, result);
    if (replayKey) this.replays.set(replayKey, { fingerprint, result });
    try {
      return structuredClone(await result);
    } finally {
      if (this.queues.get(input.conversationId) === result) this.queues.delete(input.conversationId);
    }
  }

  private async dispatch(from: ActorId, input: SendInput, turn: Turn, chain: ActorId[]): Promise<SendResult> {
    checkSignal(turn.controller.signal);
    const conversation = this.authorize(from, input);
    if (input.to.startsWith('agent:')) {
      if (chain.includes(input.to)) throw new EngineError('AGENT_CYCLE', 'Cyclic agent request rejected', 409);
      if (chain.length >= 4) throw new EngineError('AGENT_DEPTH', 'Agent request depth exceeded', 409);
      if (turn.busy.has(input.to)) throw new EngineError('AGENT_BUSY', 'Agent already processing in this conversation', 409);
    }
    const message = this.record(conversation, from, input.to, input.text);
    if (input.to.startsWith('user:')) {
      message.status = 'delivered';
      return { message };
    }
    let busy = false;
    let acceptingSends = true;
    try {
      const instance = this.instance(input.to.slice(6));
      if (instance.status !== 'running' || !instance.runtime) throw new EngineError('AGENT_UNAVAILABLE', 'Recipient agent is not running', 409);
      turn.agents.add(input.to);
      turn.busy.add(input.to);
      busy = true;
      message.status = 'processing';
      const context = {
        signal: turn.controller.signal,
        participants: Object.freeze([...conversation.participants]),
        send: async (to: ActorId, content: string): Promise<SendResult> => {
          checkSignal(turn.controller.signal);
          if (!acceptingSends) throw new EngineError('TURN_FINISHED', 'Agent message handling has finished', 409);
          if (turn.sendsLeft-- <= 0) throw new EngineError('SEND_LIMIT', 'Per-turn send limit exceeded', 429);
          const result = await this.dispatch(input.to, sendInput({ conversationId: input.conversationId, to, text: content }), turn, [...chain, input.to]);
          if (result.message.error) throw new EngineError(result.message.error.code, result.message.error.message, 502);
          return structuredClone(result);
        },
      };
      const response = await abortable(Promise.resolve().then(() => instance.runtime!.receive(structuredClone(message), context)), turn.controller.signal);
      checkSignal(turn.controller.signal);
      text(response, 'Agent response');
      const reply = this.record(conversation, input.to, from, response, message.id);
      reply.status = 'delivered';
      message.status = 'completed';
      return { message, reply };
    } catch (error) {
      message.status = 'failed';
      message.error = failure(error);
      return { message };
    } finally {
      acceptingSends = false;
      if (busy) turn.busy.delete(input.to);
    }
  }

  private authorize(from: ActorId, input: SendInput): Conversation {
    const conversation = this.conversation(input.conversationId);
    if (!conversation.participants.includes(from) || !conversation.participants.includes(input.to)) throw new EngineError('FORBIDDEN', 'Sender and recipient must belong to this conversation', 403);
    if (from === input.to) throw new EngineError('AGENT_CYCLE', 'Cannot send a message to yourself', 409);
    if (from.startsWith('agent:')) {
      const instance = this.instance(from.slice(6));
      if (instance.status !== 'running') throw new EngineError('AGENT_UNAVAILABLE', 'Sender agent is not running', 409);
      if (!instance.config.allowSendTo.includes(input.to)) throw new EngineError('FORBIDDEN', 'Agent may not send to this recipient', 403);
    }
    return conversation;
  }

  private record(conversation: Conversation, from: ActorId, to: ActorId, content: string, replyTo?: string): Message {
    const message: Message = { id: randomUUID(), conversationId: conversation.id, from, to, text: content, createdAt: new Date().toISOString(), status: 'accepted' };
    if (replyTo) message.replyTo = replyTo;
    conversation.messages.push(message);
    return message;
  }

  private instance(id: string): Instance {
    const instance = this.agents.get(identifier(id));
    if (!instance) throw new EngineError('NOT_FOUND', 'Agent not found', 404);
    return instance;
  }

  private conversation(id: string): Conversation {
    const conversation = this.conversations.get(identifier(id, 'conversationId'));
    if (!conversation) throw new EngineError('NOT_FOUND', 'Conversation not found', 404);
    return conversation;
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('CLOSED', 'Engine is closed', 503);
  }
}
