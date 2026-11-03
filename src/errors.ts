import type { Failure } from './agent.js';

export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'EngineError';
  }
}

export function safeError(error: unknown): EngineError {
  return error instanceof EngineError ? error : new EngineError('RUNTIME_ERROR', 'Agent runtime failed', 502);
}

export function failure(error: unknown): Failure {
  const safe = safeError(error);
  return { code: safe.code, message: safe.message };
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw safeError(signal.reason);
}

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
