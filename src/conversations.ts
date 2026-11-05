import { randomUUID } from 'node:crypto';
import type { ActorId } from './agent.js';
import type { AgentAccess } from './agent-access.js';
import type { Conversation, Message, SendInput, SendResult } from './conversation-types.js';
import { checkSignal, EngineError, failure } from './errors.js';
import { actor, identifier, invalid, sendInput, text } from './validation.js';
import { MAX_CONVERSATION_PARTICIPANTS } from './constants.js';

interface Turn {
  controller: AbortController;
  agents: Set<ActorId>;
  busy: Set<ActorId>;
  sendsLeft: number;
  release: Array<() => void>;
}

/** Directed compatibility messaging. Shared-room admission never goes through this queue. */
export class Conversations {
  private readonly conversations = new Map<string, Conversation>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly replays = new Map<
    string,
    { fingerprint: string; result: Promise<SendResult> }
  >();
  private readonly turns = new Set<Turn>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly agents: AgentAccess,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000)
      invalid('timeoutMs must be between 1 and 300000');
  }

  createConversation(participants: ActorId[]): Conversation {
    this.assertOpen();
    if (
      !Array.isArray(participants) ||
      participants.length < 2 ||
      participants.length > MAX_CONVERSATION_PARTICIPANTS
    )
      invalid(`A conversation needs 2 to ${MAX_CONVERSATION_PARTICIPANTS} participants`);
    const members = [...new Set(participants.map(actor))];
    if (members.length < 2) invalid('A conversation needs two distinct participants');
    for (const member of members)
      if (member.startsWith('agent:')) this.agents.getAgent(member.slice(6));
    const conversation: Conversation = { id: randomUUID(), participants: members, messages: [] };
    this.conversations.set(conversation.id, conversation);
    return structuredClone(conversation);
  }

  getConversation(id: string): Conversation {
    return structuredClone(this.conversation(id));
  }

  sendUserMessage(input: SendInput): Promise<SendResult> {
    return this.enqueue('user:local-user', input);
  }

  /** Trusted in-process send; HTTP never accepts caller-supplied agent identity. */
  sendAgentMessage(id: string, input: SendInput): Promise<SendResult> {
    return this.enqueue(`agent:${identifier(id)}`, input);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.turns)
      turn.controller.abort(new EngineError('CLOSED', 'Conversations are closed', 503));
  }

  private async enqueue(from: ActorId, value: SendInput): Promise<SendResult> {
    this.assertOpen();
    const input = sendInput(value);
    this.authorize(from, input);
    const replayKey = input.clientId
      ? JSON.stringify([from, input.conversationId, input.clientId])
      : undefined;
    const fingerprint = JSON.stringify([input.to, input.text]);
    if (replayKey) {
      const replay = this.replays.get(replayKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new EngineError(
            'IDEMPOTENCY_CONFLICT',
            'clientId was used for different content',
            409,
          );
        return structuredClone(await replay.result);
      }
    }
    const previous = this.queues.get(input.conversationId) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        this.assertOpen();
        const turn: Turn = {
          controller: new AbortController(),
          agents: new Set(),
          busy: new Set(),
          sendsLeft: 16,
          release: [],
        };
        this.turns.add(turn);
        const timer = setTimeout(
          () =>
            turn.controller.abort(new EngineError('TIMEOUT', 'Agent processing timed out', 504)),
          this.timeoutMs,
        );
        try {
          if (from.startsWith('agent:')) this.touch(turn, from as `agent:${string}`);
          return await this.dispatch(from, input, turn, from.startsWith('agent:') ? [from] : []);
        } finally {
          clearTimeout(timer);
          turn.controller.abort(new EngineError('TURN_FINISHED', 'Message turn has finished', 409));
          for (const release of turn.release) release();
          this.turns.delete(turn);
        }
      });
    this.queues.set(input.conversationId, result);
    if (replayKey) this.replays.set(replayKey, { fingerprint, result });
    try {
      return structuredClone(await result);
    } finally {
      if (this.queues.get(input.conversationId) === result)
        this.queues.delete(input.conversationId);
    }
  }

  private touch(turn: Turn, id: `agent:${string}`): void {
    if (turn.agents.has(id)) return;
    const signal = this.agents.lifecycleSignal(id.slice(6));
    const cancel = () => turn.controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    turn.release.push(() => signal.removeEventListener('abort', cancel));
    turn.agents.add(id);
    if (signal.aborted) cancel();
  }

  private async dispatch(
    from: ActorId,
    input: SendInput,
    turn: Turn,
    chain: ActorId[],
  ): Promise<SendResult> {
    checkSignal(turn.controller.signal);
    const conversation = this.authorize(from, input);
    if (input.to.startsWith('agent:')) {
      if (chain.includes(input.to))
        throw new EngineError('AGENT_CYCLE', 'Cyclic agent request rejected', 409);
      if (chain.length >= 4)
        throw new EngineError('AGENT_DEPTH', 'Agent request depth exceeded', 409);
      if (turn.busy.has(input.to))
        throw new EngineError('AGENT_BUSY', 'Agent already processing in this conversation', 409);
    }
    const message = this.record(conversation, from, input.to, input.text);
    if (input.to.startsWith('user:')) {
      message.status = 'delivered';
      return { message };
    }
    let busy = false;
    let acceptingSends = true;
    try {
      this.touch(turn, input.to as `agent:${string}`);
      turn.busy.add(input.to);
      busy = true;
      message.status = 'processing';
      const context = {
        signal: turn.controller.signal,
        participants: Object.freeze([...conversation.participants]),
        send: async (to: ActorId, content: string): Promise<SendResult> => {
          checkSignal(turn.controller.signal);
          if (!acceptingSends)
            throw new EngineError('TURN_FINISHED', 'Agent message handling has finished', 409);
          if (turn.sendsLeft-- <= 0)
            throw new EngineError('SEND_LIMIT', 'Per-turn send limit exceeded', 429);
          const result = await this.dispatch(
            input.to,
            sendInput({ conversationId: input.conversationId, to, text: content }),
            turn,
            [...chain, input.to],
          );
          if (result.message.error)
            throw new EngineError(result.message.error.code, result.message.error.message, 502);
          return structuredClone(result);
        },
      };
      const response = await this.agents.useRuntime(
        input.to.slice(6),
        (runtime, signal) => runtime.receive(structuredClone(message), { ...context, signal }),
        turn.controller.signal,
      );
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
    if (!conversation.participants.includes(from) || !conversation.participants.includes(input.to))
      throw new EngineError(
        'FORBIDDEN',
        'Sender and recipient must belong to this conversation',
        403,
      );
    if (from === input.to)
      throw new EngineError('AGENT_CYCLE', 'Cannot send a message to yourself', 409);
    if (from.startsWith('agent:')) {
      const instance = this.agents.getAgent(from.slice(6));
      if (instance.status !== 'running')
        throw new EngineError('AGENT_UNAVAILABLE', 'Sender agent is not running', 409);
      if (!instance.config.allowSendTo.includes(input.to))
        throw new EngineError('FORBIDDEN', 'Agent may not send to this recipient', 403);
    }
    return conversation;
  }

  private record(
    conversation: Conversation,
    from: ActorId,
    to: ActorId,
    content: string,
    replyTo?: string,
  ): Message {
    const message: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      from,
      to,
      text: content,
      createdAt: new Date().toISOString(),
      status: 'accepted',
    };
    if (replyTo) message.replyTo = replyTo;
    conversation.messages.push(message);
    return message;
  }

  private conversation(id: string): Conversation {
    const conversation = this.conversations.get(identifier(id, 'conversationId'));
    if (!conversation) throw new EngineError('NOT_FOUND', 'Conversation not found', 404);
    return conversation;
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('CLOSED', 'Conversations are closed', 503);
  }
}
