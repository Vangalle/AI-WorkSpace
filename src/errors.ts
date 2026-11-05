import type { Failure } from './agent.js';

/** Typed engine failure with HTTP-oriented status for the local API. */
export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** Map unknown throws to a safe EngineError without leaking internals. */
export function safeError(error: unknown): EngineError {
  return error instanceof EngineError
    ? error
    : new EngineError('RUNTIME_ERROR', 'Agent runtime failed', 502);
}

/** Convert an error into a transcript-safe Failure record. */
export function failure(error: unknown): Failure {
  const safe = safeError(error);
  return { code: safe.code, message: safe.message };
}

/** Throw immediately if the turn AbortSignal is already aborted. */
export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw safeError(signal.reason);
}

/**
 * Stop waiting on abort without forcibly terminating the underlying promise.
 * Callers must pass the signal to the runtime and recheck it before publishing late results.
 */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal);
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(safeError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
