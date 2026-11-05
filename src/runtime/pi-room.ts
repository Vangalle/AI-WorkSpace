import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentConfig } from '../agent.js';
import { checkSignal, EngineError } from '../errors.js';
import type { RoomDecision, RoomObservation, RoomObserverContext } from '../rooms/types.js';
import { piResources } from './pi-resources.js';

/**
 * Bound model input by characters, newest first; not exact token accounting.
 * Truncation affects only this prompt payload, not stored room records.
 */
function roomInput(input: RoomObservation): object {
  let remaining = 64_000;
  let historyTruncated = false;
  const messages: RoomObservation['messages'] = [];
  for (const message of [...input.messages].reverse()) {
    if (messages.length >= 100 || remaining <= 0) {
      historyTruncated = true;
      break;
    }
    const content = message.text.slice(0, Math.min(remaining, 16_000));
    historyTruncated ||= content.length !== message.text.length;
    remaining -= content.length;
    messages.unshift({ ...message, text: content });
  }
  return {
    roomId: input.roomId,
    agentId: input.agentId,
    participants: input.participants,
    messages,
    pendingMessageIds: input.pending.map((m) => m.id),
    requested: input.requested,
    // Use engine-recognized mentions rather than asking the model to infer
    // command targets from chat text.
    commandMessageIds: input.pending
      .filter((m) => m.mentions.includes(input.agentId))
      .map((m) => m.id),
    historyTruncated,
  };
}

/**
 * Each observation gets a temporary SDK session containing only room context
 * and the room_action tool. Never reuse directed sessions: private history
 * and send_message capabilities must not enter room chat.
 */
export function createPiRoomObserver(
  config: AgentConfig,
  options: Pick<CreateAgentSessionOptions, 'cwd' | 'agentDir' | 'model' | 'modelRuntime'>,
) {
  const sessions = new Set<AgentSession>();
  const openingSessions = new Set<Promise<unknown>>();
  let disposed = false;

  return {
    async observe(input: RoomObservation, context: RoomObserverContext): Promise<RoomDecision> {
      if (disposed) throw new EngineError('AGENT_STOPPED', 'Agent was stopped', 409);
      checkSignal(context.signal);
      let decision: RoomDecision | undefined;
      let duplicate = false;
      const parameters = Type.Union([
        Type.Object({ action: Type.Literal('silent') }, { additionalProperties: false }),
        Type.Object(
          { action: Type.Literal('reply'), text: Type.String({ minLength: 1, maxLength: 32000 }) },
          { additionalProperties: false },
        ),
      ]);
      const action: ToolDefinition<typeof parameters> = {
        name: 'room_action',
        label: 'Choose room participation',
        description:
          'Choose exactly once: publish one helpful room reply, or remain silent. An explicit @ command requires a reply or explanation.',
        parameters,
        async execute(_id, params) {
          checkSignal(context.signal);
          if (decision) {
            duplicate = true;
            throw new EngineError('MODEL_ERROR', 'Multiple room actions are not allowed', 502);
          }
          // Stage the decision; a later inference failure must not publish an unfinished result.
          decision = structuredClone(params);
          return {
            content: [
              { type: 'text', text: 'Decision staged. End the turn; do not call another tool.' },
            ],
            details: {},
          };
        },
      };
      // Expose only room_action, not shell, file, or private messaging tools;
      // prompts alone cannot enforce this.
      const opening = createAgentSession({
        ...options,
        thinkingLevel: 'off',
        tools: ['room_action'],
        customTools: [action],
        resourceLoader: piResources(config, 'room'),
        sessionManager: SessionManager.inMemory(options.cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      });
      openingSessions.add(opening);
      let session: AgentSession;
      try {
        ({ session } = await opening);
      } finally {
        openingSessions.delete(opening);
      }
      sessions.add(session);
      const cancel = () => {
        void session.abort().catch(() => {});
      };
      try {
        if (disposed) throw new EngineError('AGENT_STOPPED', 'Agent was stopped', 409);
        checkSignal(context.signal);
        context.signal.addEventListener('abort', cancel, { once: true });
        await session.prompt(JSON.stringify(roomInput(input)), { expandPromptTemplates: false });
        checkSignal(context.signal);
        const last = session.messages.at(-1);
        // Count raw tool calls too: SDK parameter validation may reject a call before execute runs.
        const actions = session.messages.flatMap((message) =>
          message.role === 'assistant'
            ? message.content.filter(
                (part) => part.type === 'toolCall' && part.name === 'room_action',
              )
            : [],
        );
        if (
          !last ||
          last.role !== 'assistant' ||
          last.stopReason === 'error' ||
          last.stopReason === 'aborted' ||
          !decision ||
          duplicate ||
          actions.length !== 1
        ) {
          throw new EngineError('MODEL_ERROR', 'Model did not complete one valid room action', 502);
        }
        // Final assistant text is not a room reply;
        // publish only the successfully completed structured decision.
        return decision;
      } finally {
        context.signal.removeEventListener('abort', cancel);
        if (!disposed) {
          session.dispose();
          sessions.delete(session);
        }
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.allSettled([...openingSessions]);
      const errors: unknown[] = [];
      for (const session of sessions) {
        try {
          session.dispose();
          sessions.delete(session);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Room session cleanup failed');
    },
  };
}
