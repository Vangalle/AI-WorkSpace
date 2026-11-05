import type { AgentConfig, AgentRuntime, AgentRuntimeFactory, AgentView } from './agent.js';
import { abortable, checkSignal, EngineError, failure, safeError } from './errors.js';
import { agentConfig, identifier } from './validation.js';

interface Startup {
  loaded: Promise<void>;
  cancellation?: { reason: EngineError; stopped: Promise<AgentView> };
}

interface Instance extends AgentView {
  runtime?: AgentRuntime;
  lifetime?: AbortController;
  startup?: Startup;
  stopping?: Promise<AgentView>;
}

/** Owns agent identities, runtime resources and lifecycle, not communication state. */
export class AgentEngine {
  private readonly agents = new Map<string, Instance>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly factory: AgentRuntimeFactory) {}

  /** Register a stopped agent. IDs must be unique. */
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

  listAgents(): AgentView[] {
    return [...this.agents.keys()].map((id) => this.getAgent(id));
  }

  /** Load the runtime for an agent. Idempotent when already running. */
  async startAgent(id: string): Promise<AgentView> {
    this.assertOpen();
    const instance = this.instance(id);
    if (instance.status === 'running') return this.getAgent(id);
    if (instance.status === 'loading')
      throw new EngineError('AGENT_BUSY', 'Agent lifecycle operation in progress', 409);
    else if (instance.status === 'stopping')
      throw new EngineError('AGENT_BUSY', 'Agent is stopping, please try again later', 409);
    if (instance.status === 'stop_failed')
      throw new EngineError(
        'AGENT_CLEANUP_REQUIRED',
        'Retry stopping the agent before starting it',
        409,
      );
    instance.status = 'loading';
    delete instance.error;
    const startup: Startup = {
      loaded: Promise.resolve().then(async () => {
        instance.runtime = await this.factory.load(structuredClone(instance.config));
      }),
    };
    instance.startup = startup;
    try {
      try {
        await startup.loaded;
      } catch (error) {
        if (!startup.cancellation) {
          instance.status = 'start_failed';
          instance.error = failure(error);
          throw safeError(error);
        }
      }
      if (startup.cancellation) {
        await startup.cancellation.stopped;
        throw startup.cancellation.reason;
      }
      instance.lifetime = new AbortController();
      instance.status = 'running';
      return this.getAgent(id);
    } finally {
      if (instance.startup === startup) delete instance.startup;
    }
  }

  /** The signal belongs to this runtime generation and remains aborted after restart. */
  lifecycleSignal(id: string): AbortSignal {
    this.assertOpen();
    const instance = this.instance(id);
    if (instance.status !== 'running' || !instance.lifetime)
      throw new EngineError('AGENT_UNAVAILABLE', 'Agent is not running', 409);
    return instance.lifetime.signal;
  }

  /** Capture one running runtime; stop/restart cancels the lease, never redirects it. */
  async useRuntime<T>(
    id: string,
    operation: (runtime: AgentRuntime, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lifetime = this.lifecycleSignal(id);
    const runtime = this.instance(id).runtime!;
    const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
    checkSignal(combined);
    const result = await abortable(
      Promise.resolve().then(() => {
        checkSignal(combined);
        return operation(runtime, combined);
      }),
      combined,
    );
    checkSignal(combined);
    return result;
  }

  /** Cancel runtime leases and dispose resources; concurrent stops share cleanup. */
  async stopAgent(id: string): Promise<AgentView> {
    const instance = this.instance(id);
    if (instance.stopping) return instance.stopping;
    if (instance.status === 'stopped') return this.getAgent(id);
    instance.status = 'stopping';

    let reason: EngineError;
    if (this.closed) reason = new EngineError('CLOSED', 'Engine is closed', 503);
    else reason = new EngineError('AGENT_STOPPED', 'Agent was stopped', 409);

    const startup = instance.startup;
    const operation = this.disposeAgent(id, instance, startup?.loaded);
    instance.stopping = operation;
    if (startup && !startup.cancellation) startup.cancellation = { reason, stopped: operation };
    instance.lifetime?.abort(reason);
    try {
      return await operation;
    } finally {
      if (instance.stopping === operation) delete instance.stopping;
    }
  }

  /** Wait for agent cleanup only. Repeated calls share failures as well as success. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    // Abort callbacks may synchronously reenter close().
    this.closing = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.closed = true;
    void Promise.allSettled([...this.agents.keys()].map((id) => this.stopAgent(id)))
      .then((results) => {
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [safeError(result.reason)] : [],
        );
        if (errors.length) throw new AggregateError(errors, 'Failed to stop one or more agents');
      })
      .then(resolveClose, rejectClose);
    return this.closing;
  }

  private async disposeAgent(
    id: string,
    instance: Instance,
    loaded?: Promise<void>,
  ): Promise<AgentView> {
    // A rejected load owns its partial resources; a successful one transfers ownership here.
    await loaded?.catch(() => {});
    try {
      await instance.runtime?.dispose();
      delete instance.runtime;
      delete instance.lifetime;
      delete instance.error;
      instance.status = 'stopped';
      return this.getAgent(id);
    } catch (error) {
      instance.status = 'stop_failed';
      instance.error = failure(error);
      throw safeError(error);
    }
  }

  private instance(id: string): Instance {
    const instance = this.agents.get(identifier(id));
    if (!instance) throw new EngineError('NOT_FOUND', 'Agent not found', 404);
    return instance;
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('CLOSED', 'Engine is closed', 503);
  }
}
