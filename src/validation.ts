import type { ActorId, AgentConfig } from './agent.js';
import type { SendInput } from './conversation-types.js';
import { EngineError } from './errors.js';

/** Fail validation with a stable INVALID_INPUT error. */
export function invalid(message: string): never {
  throw new EngineError('INVALID_INPUT', message);
}

/** Require a plain object (not null/array). */
export function object(value: unknown, label = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Reject unexpected fields so configs cannot smuggle extra keys. */
export function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid('Unknown input field');
}

/** Nonempty trimmed string within a max length. */
export function text(value: unknown, label: string, max = 32_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    invalid(`${label} must be nonempty text (max ${max} characters)`);
  return value;
}

/** Check the validity of an identifier used for agents, conversations, and clientIds.
 *  Valid identifier is returned; invalid identifier throws an INVALID_INPUT error.
 */
export function identifier(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))
    invalid(`${label} is invalid`);
  return value;
}

/** Parse `user:…` / `agent:…` participant IDs as ActorId. */
export function actor(value: unknown): ActorId {
  if (typeof value !== 'string' || !/^(user|agent):[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))
    invalid('Invalid participant ID');
  return value as ActorId;
}

/** Validate and normalize AgentConfig; only the `pi` runtime is accepted. */
export function agentConfig(value: unknown): AgentConfig {
  const input = object(value);
  onlyKeys(input, ['id', 'runtime', 'model', 'systemPrompt', 'allowSendTo']);
  if (input.runtime !== 'pi') invalid('Only the pi runtime is currently supported');
  const model = object(input.model, 'model');
  onlyKeys(model, ['provider', 'id', 'apiKeyEnv']);
  const prompt = object(input.systemPrompt, 'systemPrompt');
  onlyKeys(prompt, ['mode', 'text']);
  if (prompt.mode !== 'replace' && prompt.mode !== 'append')
    invalid('systemPrompt.mode must be replace or append');
  if (!Array.isArray(input.allowSendTo) || input.allowSendTo.length > 100)
    invalid('allowSendTo must be an array (max 100)');
  const selectedModel: AgentConfig['model'] = {
    provider: identifier(model.provider, 'model.provider'),
    id: text(model.id, 'model.id', 256),
  };
  if (model.apiKeyEnv !== undefined) {
    if (typeof model.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv))
      invalid('Invalid apiKeyEnv name');
    selectedModel.apiKeyEnv = model.apiKeyEnv;
  }
  return {
    id: identifier(input.id),
    runtime: 'pi',
    model: selectedModel,
    systemPrompt: { mode: prompt.mode, text: text(prompt.text, 'systemPrompt.text') },
    allowSendTo: [...new Set(input.allowSendTo.map(actor))],
  };
}

/** Validate a user/agent send payload. */
export function sendInput(value: unknown): SendInput {
  const input = object(value);
  onlyKeys(input, ['conversationId', 'to', 'text', 'clientId']);
  const result: SendInput = {
    conversationId: identifier(input.conversationId, 'conversationId'),
    to: actor(input.to),
    text: text(input.text, 'text'),
  };
  if (input.clientId !== undefined) result.clientId = identifier(input.clientId, 'clientId');
  return result;
}
