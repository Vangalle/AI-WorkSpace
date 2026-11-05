# Room / Agent Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make server-hosted rooms the primary chat entry and remove communication lifecycle from AgentEngine.
**Architecture:** Lifecycle-scoped runtime access connects independent conversation/room services to agents. ChatApplication wires services and closes communication services before agents; it contains no routing policy.
**Tech Stack:** TypeScript, Node >=22.19.0, installed Pi SDK 1.5.0, node:test/tsx, HTTP/SSE.
**Spec:** docs/superpowers/specs/2026-11-05-room-agent-boundaries.md

## Global Constraints
- Preserve immediate human delivery, asynchronous burst batching, helpful single replies and invisible structured silence.
- Preserve authentication, ACLs, history isolation, retryable cleanup and cancellation of late output.
- No GUI, paid inference, new dependencies, remote operations or automatic commits.
- Work in the user's editor workspace on a new local branch; no unapproved worktree or collaboration.

## Review Focus
- Engine shutdown during an observation: humans can continue using the room and no stale reply publishes.
- One room closing while another uses the same agent: no shared-agent disposal.
- Runtime lease created immediately before stop/restart: never invokes the replacement runtime.
- Slow/failed agents: human delivery remains immediate and only agent activity fails.
- Client exit or reconnect: room, transcript and agent remain available.

### Task 1: Independent lifecycle and communication owners
**Files:** src/engine.ts, src/agent-access.ts, src/conversations.ts, src/conversation-types.ts, src/agent.ts, src/application.ts, src/http.ts, src/rooms/http.ts, src/main.ts, src/index.ts, tests/*.
**Interfaces:** AgentEngine.useRuntime<T>(id, operation, signal?), lifecycleSignal(id), getAgent(id); Conversations owns existing directed API; ChatApplication exposes agents/rooms/conversations/close.
- [x] Write boundary tests: engine shutdown leaves rooms usable, room shutdown leaves agents running, old lease cannot access restarted runtime. Run `npx tsx --test tests/ownership.test.ts`; expected failure before services exist.
- [x] Extract directed methods and message types without changing their algorithms. Keep the lifecycle state machine, add captured-runtime lease cancellation, and compose the services explicitly.
- [x] Migrate callers/tests to the appropriate owner, preserving test assertions and directed HTTP behavior. Run `npm test` and `npm run typecheck`; expect all passing.

### Task 2: Participation scheduling separate from room state
**Files:** src/rooms/chat-rooms.ts, src/rooms/participation.ts, tests/ownership.test.ts, tests/rooms.test.ts.
**Interfaces:** scheduler accepts room snapshot/reply/activity callbacks and agent observer; owns enqueue/assertCapacity/closeRoom/close. ChatRooms owns records and public events.
- [x] Add room-specific close cancellation test: close room one during inference, continue room two with the same running agent; expect no late output in room one. Run ownership tests before implementation and observe the missing closeRoom behavior.
- [x] Extract current scheduler mechanically, retaining serial per-room observations, independent rooms, mentions, batching and silent-decision validation. Add room-specific close without stopping agents.
- [x] Run ownership, rooms, real SDK room and HTTP/SSE tests, then the full suite; expect all passing.

### Task 3: Continuous primary chat client
**Files:** src/chat.ts, examples/room-chat.mjs, package.json, tests/cli.test.ts, tests/room-http.test.ts, tests/server-main.test.ts.
**Interfaces:** npm run chat -- <room-id>, CHAT/ENGINE credentials and existing HTTP/SSE room API; no local agent factory or conversation creation in chat.ts.
- [x] Test src/chat.ts as two authenticated clients that exchange multiple messages, quit one client, verify the room and agent remain, then reconnect. Run before implementation and observe the old one-shot CLI fail to connect.
- [x] Export the existing room client entry, wire both command names to it, and keep usage/errors safe. Do not duplicate the SSE parser or retry loop.
- [x] Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, inspect imports and actual changed API/ownership. Report fixture limits and API migration in chat.
