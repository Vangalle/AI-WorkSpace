/** Public library exports for embedding the engine without the HTTP entrypoint. */
export { AgentEngine } from './engine.js';
export type { AgentAccess } from './agent-access.js';
export { ChatApplication } from './application.js';
export type { ChatApplicationOptions } from './application.js';
export { Conversations } from './conversations.js';
export { ChatRooms } from './rooms/chat-rooms.js';
export type { RoomOptions } from './rooms/chat-rooms.js';
export type {
  AgentId,
  UserId,
  Room,
  RoomMessage,
  RoomActivity,
  RoomPost,
  RoomObservation,
  RoomDecision,
  RoomObserverContext,
  RoomEvent,
} from './rooms/types.js';
export { EngineError } from './errors.js';
export { PiRuntimeFactory } from './runtime/pi.js';
export type { PiRuntimeOptions } from './runtime/pi.js';
export { createChatServer } from './http.js';
export type { EngineServerOptions } from './http-auth.js';
export type {
  ActorId,
  AgentConfig,
  AgentRuntime,
  AgentRuntimeFactory,
  AgentView,
  Failure,
} from './agent.js';
export type {
  Conversation,
  Message,
  RuntimeContext,
  SendInput,
  SendResult,
} from './conversation-types.js';
