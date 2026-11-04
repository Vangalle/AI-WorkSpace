import type { IncomingMessage, ServerResponse } from 'node:http';
import { EngineError } from './errors.js';

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

/** Parse a JSON body with a hard 128 KiB cap. */
export function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new EngineError('CONTENT_TYPE', 'Use application/json', 415);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 131072) {
        chunks.length = 0;
        reject(new EngineError('BODY_TOO_LARGE', 'JSON body exceeds 128 KiB', 413));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > 131072) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new EngineError('INVALID_INPUT', 'Invalid JSON body')); }
    });
    request.on('error', () => reject(new EngineError('INVALID_INPUT', 'Could not read request body')));
    request.on('aborted', () => reject(new EngineError('INVALID_INPUT', 'Request was aborted')));
  });
}
