<!-- bi10-before.md — VERBATIM live bi#10 body (2026-09-06). Do not reshape:
this fixture must keep failing [problem] [behavior] [nongoals]
[verification]. The rewrite is bi10-after.md. -->

Port pi/packages/tui (differential rendering, Component {render, handleInput, invalidate}, CURSOR_MARKER, Terminal) + pi/packages/agent agent-loop (AgentLoopConfig, AgentContext with 8 tools, EventStream, StreamFn, agentLoop/continue) into bi.

Vendor: bi/vendor/pi-tui.ts (1263) + pi-agent-loop.ts (796) + pi-terminal.ts as spec.

BAML owns: LoopState {Idle, Thinking, ToolUse, Done}, AgentEvent, Component interface, diff logic (pure). Host owns: Terminal, streamFn (ai.Client), TUI main-screen rendering.

Acceptance: baml check green, baml test one-test→one-impl for LoopState/Component (no LLM), bi with TUI renders ready BAIS + prompt (differential, no pi drift), agentLoopContinue validates last message role.

Evidence: verdict(bi#57) # backfill 2026-09-05: next_loop_state Idle arm neutered to Waiting → "next_loop_state" FAIL, restored, 278/278 green.
