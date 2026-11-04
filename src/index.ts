/** Public library exports for embedding the engine without the HTTP entrypoint. */
export { AgentEngine } from './engine.js';
export { ChatRooms } from './rooms/chat-rooms.js';
export type { RoomOptions } from './rooms/chat-rooms.js';
export type { AgentId, UserId, Room, RoomMessage, RoomActivity, RoomPost, RoomObservation, RoomDecision, RoomObserverContext, RoomEvent } from './rooms/types.js';
export { EngineError } from './errors.js';
export { PiRuntimeFactory } from './runtime/pi.js';
export type { PiRuntimeOptions } from './runtime/pi.js';
export { createEngineServer } from './http.js';
export type { EngineServerOptions } from './http-auth.js';
export type { ActorId, AgentConfig, AgentRuntime, AgentRuntimeFactory, AgentView, Conversation, Failure, Message, RuntimeContext, SendInput, SendResult } from './agent.js';
