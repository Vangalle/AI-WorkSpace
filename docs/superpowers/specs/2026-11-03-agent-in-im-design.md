# Agent in IM engine: approved first slice

## Outcome and mechanism
Load Pi agents with explicit provider/model/system-prompt configuration, manage running instances, and exchange user↔agent and agent↔agent messages in IM-neutral conversations. The user approved implementation in chat. The delivery is executable TypeScript plus authenticated loopback HTTP; no vendor IM integration or graphical interface was promised.

## Boundaries
- Agent configuration, runtime instance, and conversation are separate. One Pi session per agent/conversation; no discovered user/project extensions, skills, context files, or shell/file tools.
- Runtime adapters implement `AgentRuntimeFactory.load(config)` and `AgentRuntime.receive(message, context)`. Engine owns identities, routing, membership, idempotency, deadlines, and lifecycle. Pi owns inference and its isolated conversation history.
- System prompt modes: replace uses the provided prompt as the base; append adds instructions to Pi's built-in base. Engine communication instructions are appended in either case. Provider credentials are referenced by environment-variable name, never accepted as plaintext in HTTP configuration.
- First version is a single-owner local service. Bearer token required for every endpoint. HTTP always derives sender `user:local-user`; only trusted in-process code and bound runtime capabilities can send as agents.
- Conversations have immutable participants. Both sender and recipient must be participants. Agent-config recipient allowlists further restrict runtime-originated messages; default deny. Explicit replies to an incoming request are allowed.
- Agent-to-agent messages use bounded request/reply. Runtime tool `send_message` to an agent waits for its answer; replies are recorded but never automatically trigger another inference. Reject cyclic call paths and depth > 4. A shared per-turn send budget prevents repeated tool loops.
- Serialize each conversation's root request, nested calls run within that turn. This prevents Pi streaming conflicts and cross-request deadlocks; independent conversations can run concurrently.
- Message statuses: accepted, processing, delivered (to a user), completed (agent answered), failed. Failure retains a safe error code and the original message ID. Deduplicate caller-provided IDs within a sender/conversation; reject conflicting reuse.
- Deadline aborts the runtime, invalidates late capabilities, and prevents late replies. Stop cancels active work, clears runtime session context, and allows restart. Conversation transcripts remain available.
- State and idempotency are process-memory only; restart loses them. No persistence, multi-tenant authorization, timer scheduler, attachments, streaming HTTP, or automatic retry in this slice. Failed inference can have partial Pi context; drop affected SDK session instead of reusing ambiguous history.

## Acceptance
Tests cover per-agent model/prompt selection; separate conversation histories; user request/reply; proactive host/runtime agent→user sends; A→B request/reply; user→A→B→A→user delegation; duplicate sends; participant and allowlist enforcement; bounded recursion; model/load errors; stop/restart; timeout and late completion. Real SDK sessions must load without inference. Loopback fixture inference may exercise the actual SDK tool protocol, but is not evidence of real model quality or paid-provider credentials.

## Evidence sources
Pi SDK 1.5.0 installed from npm, its docs/sdk.md, docs/models.md, docs/security.md, examples/sdk/{02-custom-model,03-custom-prompt,09-api-keys-and-oauth,12-full-control}.ts, and exported declarations. No globally installed Pi resources or credentials are implicitly inherited.
