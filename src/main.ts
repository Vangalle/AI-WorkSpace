import { randomBytes } from 'node:crypto';
import { AgentEngine } from './engine.js';
import { createEngineServer } from './http.js';
import { PiRuntimeFactory } from './runtime/pi.js';

const rawPort = process.env.PORT ?? '3000';
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('PORT must be an integer from 0 to 65535');
const token = process.env.ENGINE_TOKEN ?? randomBytes(32).toString('hex');
const factory = new PiRuntimeFactory({
  ...(process.env.ENGINE_MODELS_PATH ? { modelsPath: process.env.ENGINE_MODELS_PATH } : {}),
  ...(process.env.ENGINE_AUTH_PATH ? { authPath: process.env.ENGINE_AUTH_PATH } : {}),
});
const engine = new AgentEngine(factory);
const server = createEngineServer(engine, { token });
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`HTTP server failed: ${error.code ?? 'UNKNOWN'}`);
  void engine.close().finally(() => { process.exitCode = 1; });
});
server.listen(Number(rawPort), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(`Agent IM engine: http://127.0.0.1:${address.port}`);
    console.log(`Bearer token: ${token}`);
    console.log('Storage: memory only; no agents loaded. POST /agents to configure one.');
  }
});
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  void engine.close().finally(() => server.closeAllConnections());
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
