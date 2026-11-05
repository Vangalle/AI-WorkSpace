import type { AgentRuntime, AgentView } from './agent.js';

/** Communication services borrow runtime capabilities without owning their lifecycle. */
export interface AgentAccess {
  getAgent(id: string): AgentView;
  lifecycleSignal(id: string): AbortSignal;
  useRuntime<T>(
    id: string,
    operation: (runtime: AgentRuntime, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
