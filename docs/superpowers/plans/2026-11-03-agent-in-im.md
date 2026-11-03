# Agent in IM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an executable Pi-backed local messaging engine.

**Architecture:** A framework-independent engine consumes a small runtime interface. Pi implements that interface, HTTP exposes authenticated owner operations, and main wires both. Per-conversation serialization and bounded nested requests preserve coherent context.

**Tech Stack:** Node >=22.19.0, TypeScript, Pi SDK 1.5.0, typebox, node:test via tsx.

**Spec:** docs/superpowers/specs/2026-11-03-agent-in-im-design.md

## Global Constraints
- State is in-memory; no remote IM vendor or persistent history in this slice.
- Bearer-authenticated loopback only, HTTP sender fixed to user:local-user.
- No implicit extension loading, shell/file tools, or global credential discovery.
- Every runtime uses the configured provider/model/prompt.
- Native implementation; no Git repository exists, so no branch/worktree/commit operations.

## Review Focus
- Concurrent root sends and A→B→A cycles must not deadlock.
- Late inference after timeout/stop must not publish replies or send tools.
- Malformed/oversized HTTP requests must fail without exposing secrets or crashing.
- Config/model selection must work with actual SDK rather than only test doubles.
- A user must be able to run the built service and complete the documented API sequence.

### Task 1: Engine and runtime contracts
**Files:** src/agent.ts, src/engine.ts, src/errors.ts, src/validation.ts, tests/engine.test.ts, tests/helpers.ts.
**Interfaces:** `AgentRuntimeFactory.load(config): Promise<AgentRuntime>`; `AgentRuntime.receive(message, context): Promise<string>`; `AgentEngine` registers/starts/stops agents, creates conversations, sends user/agent messages, lists transcript/status, closes resources. Context binds participant list, AbortSignal and `send(to,text)` to the current agent and conversation.
- [ ] Write node:test cases using a deterministic runtime with separate history maps. Assert delivered transcript, reply linkage, isolated histories, proactive send, nested delegation, idempotency/conflicts, forbidden recipients, stop/restart, cyclic sends, per-turn budgets, timeout and late send suppression.
- [ ] Run `npm test -- --test-name-pattern=engine` (or `npx tsx --test tests/engine.test.ts`); expected missing exported engine, then failing behavior assertions as each slice is added.
- [ ] Implement domain validation (identifiers, text lengths, runtime/pi only, prompt modes, env key reference); states; queues; per-turn cancellation; request/reply routing.
- [ ] Run `npx tsx --test tests/engine.test.ts` and `npm run typecheck`; expected all engine tests green.

### Task 2: Pi adapter
**Files:** src/runtime/pi.ts, src/runtime/pi-resources.ts, tests/pi.test.ts, tests/fixtures/provider.ts.
**Interfaces:** `PiRuntimeFactory(options).load(config)` implements Task 1 contract. Explicit ModelRuntime options control credential and model paths, no network model refresh. One SDK session per conversation, custom send_message tool bound to the active context.
- [ ] Write real-SDK tests: unknown model fails; configured model/prompt and tool allowlist visible in session; append retains base; separate sessions; a local OpenAI-compatible HTTP fixture returns text/tool calls for a complete delegation exchange; SDK stopReason error is failure, not stale successful text.
- [ ] Run `npx tsx --test tests/pi.test.ts`; expected missing adapter then feature failures before implementation.
- [ ] Implement isolated ResourceLoader, model selection, env API key override, session creation, tool wrapper, prompt results/error handling, cancellation and cleanup. Use authoritative final assistant message and discard failed session history.
- [ ] Run `npm test` and `npm run typecheck`; expected all green. Fixture evidence is protocol-level only.

### Task 3: Authenticated HTTP and executable entry
**Files:** src/http.ts, src/main.ts, src/index.ts, examples/agent.json, examples/delegate.json, tests/http.test.ts.
**Interfaces:** `createEngineServer(engine,{token})` returns Node HTTP server; main listens only on 127.0.0.1 and prints URL/token. Routes: health; agents create/list/get/start/stop; conversations create/get; messages post/get. JSON messages do not accept sender fields; principal is fixed.
- [ ] Write fetch integration cases for token rejection, JSON validation, body limit, unknown routes, register/start/conversation/send/read/stop, unsupported runtime/model errors, idempotent replay and spoofed-sender rejection.
- [ ] Run `npx tsx --test tests/http.test.ts`; expected missing server then behavior failures.
- [ ] Implement routing, bounded JSON parsing, status-code mapping, loopback startup, token validation and shutdown; supply directly runnable example configurations with env key references.
- [ ] Run `npm test && npm run typecheck && npm run build`, then start built service on an ephemeral port, verify health/auth/config/start/error status using HTTP and terminate it.

## Completion
One review-only final gate checks delivery/acceptance and implementation; resolve blockers with regression tests. No inference against a paid provider without explicit user credentials/model selection. Final chat gives commands, API sequence and measured verification limits, not a reading assignment.
