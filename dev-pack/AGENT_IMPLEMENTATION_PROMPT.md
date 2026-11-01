/skill:writing-for-agents

# Task: Implement a plugin-first manual Retry experience for DeepSeek Harness

Follow `README.md` in this directory as the design specification. Treat its code blocks as architectural pseudocode unless they explicitly cite working upstream APIs. The repository currently used by the operator may be `dsh-v0.2.1-rc.2`, while the design was checked against both that tag and `master@ce7073d5`. Inspect local installed package/source versions before implementing.

## Requirements

Implement `/retry` as a Host command and a Web Retry button using an identical Host coordinator. Reuse the existing `@deepseek-ai/dsh-llm-retry` for automatic retries. The Host command must use `ctx.commands.register` and the Web button must route through the existing `ctx.remote.commands.execute(sessionId, line, [])`; do not build a new provider retry loop or duplicate RPC unless the repo proves the existing command RPC is insufficient.

The semantics are **manual task continuation via a new Turn**. After the last eligible failed or user-aborted Turn, preserve all committed user/assistant/tool history, generate one short `createUserMessage` with a custom `MessageSourceMap` kind (not `user`), and enqueue it using `agent.followup()`. Do **not** re-submit the original prompt; do **not** delete session events; do **not** directly replay tool calls. Do not misrepresent this as the OMP promptless/step-replay implementation.

Use Session Projection to fold latest `turn/start`, `turn/end`, admitted `user/message`, and tool-result risk into an immutable, replayable latest-Turn recovery view. The client must render Retry only on the latest eligible Turn, including cases with no successful Assistant message. The correct Slot is `conversation.chat.turnTail`, not `conversation.chat.assistant-actions` (which depends on messageId).

For admission, claim `agent.runMaintenance()` from true idle, reject pending Inbox work, validate current target Turn (Web invokes `/retry --turn=N`), and synchronously enqueue `agent.followup()` with **no await between final validation and enqueue**. Return `CommandResult {kind:'success', text:'Continuation queued...'}` only after enqueue; this is not a completion guarantee. A failure must give actionable UI feedback.

Default to rejecting uncertain tool-side-effect cases such as `TOOL_OUTCOME_UNKNOWN`, started `ABORTED`, and `TOOL_TIMEOUT`; do not add a force override in v1. Scope to root Agent sessions, not subagents, and do not auto-resume crash `interrupted` or parent/hook/disposed cancels in v1. Do not spoof a human message source or bypass permission/approval layers.

## Execution sequence

1. Inspect the repository/installed version and read exact source contracts for commands, `Agent.runMaintenance`, `Agent.followup`, Session Projection, Browser Slot contribution, and Remote command submission. Pay special attention to the `rc.2` vs master Projection registration migration.
2. Draft a concise implementation plan and exact file map, then implement Host projection/coordinator/command and tests.
3. Implement Browser `conversation.chat.turnTail` entry, displaying only if the latest view's target Turn matches the rendered Turn, with loading, duplicate-click suppression, result-text errors, tooltip, and keyboard accessibility. Use the existing `commands.execute` Remote.
4. Validate full behavior: model error recovered automatically, exhausted automatic retry then manual continuation, user Esc abort, error without final assistant, stale button, concurrent double-clicks, queued user input, unknown tool outcome, session reopen, and no duplicate previous tool dispatch.
5. Run relevant unit/integration/UI tests and typecheck on the actual target version. Report changes, executed tests, failures, unresolved API incompatibilities, and what remains explicitly out of scope. If a public API is insufficient, report the exact blocker instead of using private Agent Loop state or silently editing the core.

## Acceptance criteria

- Both `/retry` and the Web button produce one new continuation Turn from the same Host command handler.
- Existing model-visible history remains intact and the original user prompt is not duplicated.
- The Resume message is explicitly attributed as a plugin-sourced user-role message.
- No replay of a historical tool batch is performed by the plugin.
- The original `dsh-llm-retry` retains complete ownership of request-level automatic retries.
- Invalid/busy/stale/unsafe attempts are rejected without enqueueing a Resume message.
- UI works even when the failed Turn has no successful Assistant message, and only offers Retry for the latest eligible Turn.
- Target version tests and typechecks succeed; cross-version differences are recorded, not assumed away.
