/** CLI one-shot chat: load agent JSON configs, send one user message, print the reply. */
import { readFile } from 'node:fs/promises';
import { AgentEngine } from './engine.js';
import { EngineError, safeError } from './errors.js';
import { PiRuntimeFactory } from './runtime/pi.js';
import { agentConfig } from './validation.js';

async function chat() {
  const [message, ...paths] = process.argv.slice(2);
  if (!message?.trim()) {
    console.error('Usage: npm run chat -- "message" [agent-config.json ...]');
    process.exitCode = 1;
    return;
  }
  const factory = new PiRuntimeFactory({
    ...(process.env.ENGINE_MODELS_PATH ? { modelsPath: process.env.ENGINE_MODELS_PATH } : {}),
    ...(process.env.ENGINE_AUTH_PATH ? { authPath: process.env.ENGINE_AUTH_PATH } : {}),
  });
  const engine = new AgentEngine(factory);
  try {
    const configs = [];
    for (const path of paths.length ? paths : ['examples/agent.json']) {
      let input: unknown;
      try {
        input = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        throw new EngineError('CONFIG_ERROR', 'Could not read an agent configuration file');
      }
      const config = agentConfig(input);
      configs.push(config);
      engine.registerAgent(config);
      await engine.startAgent(config.id);
    }
    const first = configs[0]!;
    const conversation = engine.createConversation([
      'user:local-user',
      ...configs.map((config) => `agent:${config.id}` as const),
    ]);
    const result = await engine.sendUserMessage({
      conversationId: conversation.id,
      to: `agent:${first.id}`,
      text: message,
    });
    if (result.message.error)
      throw new EngineError(result.message.error.code, result.message.error.message);
    console.log(result.reply?.text ?? '');
  } finally {
    await engine.close();
  }
}

void chat().catch((error: unknown) => {
  const safe = safeError(error);
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = 1;
});
