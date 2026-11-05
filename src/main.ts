/** Loopback HTTP entry: Pi factory + AgentEngine, bearer token printed on listen. */
import { randomBytes } from 'node:crypto';
import { AgentEngine } from './engine.js';
import { createEngineServer } from './http.js';
import { PiRuntimeFactory } from './runtime/pi.js';

const rawPort = process.env.PORT ?? '3000';
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535)
  throw new Error('PORT must be an integer from 0 to 65535');
const token = process.env.ENGINE_TOKEN ?? randomBytes(32).toString('hex');
const factory = new PiRuntimeFactory({
  ...(process.env.ENGINE_MODELS_PATH ? { modelsPath: process.env.ENGINE_MODELS_PATH } : {}),
  ...(process.env.ENGINE_AUTH_PATH ? { authPath: process.env.ENGINE_AUTH_PATH } : {}),
});
const engine = new AgentEngine(factory);
let userTokens: Record<string, string> | undefined;
if (process.env.ENGINE_USER_TOKENS !== undefined) {
  try {
    userTokens = JSON.parse(process.env.ENGINE_USER_TOKENS) as Record<string, string>;
  } catch {
    throw new Error('ENGINE_USER_TOKENS must be a JSON object mapping user IDs to tokens');
  }
}
const server = createEngineServer(engine, {
  token,
  ...(userTokens === undefined ? {} : { userTokens }),
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`HTTP server failed: ${error.code ?? 'UNKNOWN'}`);
  void engine.close().finally(() => {
    process.exitCode = 1;
  });
});
server.listen(Number(rawPort), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(`Agent IM engine: http://127.0.0.1:${address.port}`);
    console.log(`Bearer token: ${token}`);
    console.log('Storage: memory only; no agents loaded. POST /agents to configure one.');
    console.log(
      'Shared chat: POST /rooms, then npm run room-chat -- <room-id>. @agent-id sends a command.',
    );
  }
});
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  // Stop accepting connections, let the engine abort inference and close SSE,
  // then clean up remaining sockets.
  server.close();
  void engine.close().finally(() => server.closeAllConnections());
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
