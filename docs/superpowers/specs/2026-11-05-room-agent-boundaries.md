# Room-first communication and independent agent lifecycle

## Approved outcome
The user requires AgentEngine to own only agent lifecycle, with rooms as the primary enduring places for chat. The user's sequence diagram is binding: human messages are delivered immediately; participation scheduling asynchronously batches bursts; an agent publishes one helpful natural message or returns structured silence that creates no message. Moving ownership must not replace this mechanism with synchronous RPC.

## Boundaries
- AgentEngine: register/get/list/start/stop/close plus lifecycle-scoped runtime access. No room/conversation ownership, transcripts, queues, recipients, debounce or inference deadlines. Stopping/closing aborts resource leases, not rooms.
- ChatRooms: membership, transcripts, replay, events and room lifecycle. A separate participation module owns pending batches, timing, observation deadlines and late-result exclusion. Room closure cancels its scheduling, never shared agents. Room snapshots expose open/closed status; authenticated members can close their room with POST /rooms/:id/close while retaining readable history.
- Conversations: move existing directed request/reply implementation out of AgentEngine without changing delegation, per-conversation history isolation, authorization, idempotency, shared deadlines or cancellation. This is a compatibility capability, not the primary chat entry and never silently merged with shared transcripts.
- ChatApplication: composition and application shutdown only; exposes agents, rooms and conversations separately. Shutdown immediately blocks new agent work, closes communication services synchronously, then awaits runtime disposal. HTTP routes receive their actual owner through createChatServer. No facade forwarding communication through AgentEngine.
- CLI chat: connect to a server-hosted room using authenticated HTTP/SSE, continuously send/receive, and exit locally without destroying the room or stopping agents. Reuse the existing tested room client; preserve npm run room-chat as an alias.
- Existing Pi runtime isolation and cleanup-retry guarantees remain intact. No vendor SDK changes or paid inference.

## Acceptance
Behavioral tests establish that rooms continue human delivery after engine shutdown, stopping/restarting an agent does not destroy a room, closing a room does not stop shared agents, and stale completions never publish after cancellation. Retain and migrate the existing directed and shared-room tests. Exercise real SDK through the local protocol fixture only. Test two authenticated continuous clients in one persistent server room, including client exit and later reconnect.

## Scope limits
No persistence across process restarts, new GUI, autonomous agent reply loops, removal of directed HTTP endpoints, automatic engine restart or lifecycle load/dispose timeout. The old AgentEngine communication API moves to explicitly named services; embedding callers must migrate. Collaboration is disabled; implementation and review run in this conversation.
