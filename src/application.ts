import type { AgentRuntimeFactory } from './agent.js';
import { AgentEngine } from './engine.js';
import { Conversations } from './conversations.js';
import { EngineError } from './errors.js';
import { ChatRooms } from './rooms/chat-rooms.js';

export interface ChatApplicationOptions {
  timeoutMs?: number;
  roomDebounceMs?: number;
  roomMaxWaitMs?: number;
}

/** Composition and process shutdown only; each service owns its own communication state. */
export class ChatApplication {
  readonly agents: AgentEngine;
  readonly conversations: Conversations;
  readonly rooms: ChatRooms;
  private closing?: Promise<void>;

  constructor(factory: AgentRuntimeFactory, options: ChatApplicationOptions = {}) {
    this.agents = new AgentEngine(factory);
    this.conversations = new Conversations(this.agents, options);
    this.rooms = new ChatRooms(
      {
        assertAgent: (id) => {
          this.agents.getAgent(id);
        },
        observe: (id, input, signal) =>
          this.agents.useRuntime(
            id,
            (runtime, combined) => {
              if (!runtime.observe)
                throw new EngineError(
                  'UNSUPPORTED_RUNTIME',
                  'Runtime does not support room participation',
                  409,
                );
              return runtime.observe(input, { signal: combined });
            },
            signal,
          ),
      },
      {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.roomDebounceMs === undefined ? {} : { debounceMs: options.roomDebounceMs }),
        ...(options.roomMaxWaitMs === undefined ? {} : { maxWaitMs: options.roomMaxWaitMs }),
      },
    );
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    // Close notifications may reenter shutdown or attempt new agent work.
    this.closing = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    const agentCleanup = this.agents.close();
    this.conversations.close();
    this.rooms.close();
    void agentCleanup.then(resolveClose, rejectClose);
    return this.closing;
  }
}
