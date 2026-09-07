## Problem

bi has no interactive loop: `pi/packages/tui` (differential rendering)
and `pi/packages/agent` (agent-loop) have no BAML-side mirror, so `bi`
cannot hold a session open the way pi does.

## Behavior

BAML owns `LoopState {Idle, Thinking, ToolUse, Done}`, `AgentEvent`,
the `Component` interface, and pure diff logic; the host owns
`Terminal`, `streamFn` (`ai.Client`), and TUI main-screen rendering.
`bi` with TUI renders ready BAIS + prompt differentially with no pi
drift, and `agentLoopContinue` rejects a history whose last message is
not the expected role. Upstream spec vendored as `bi/vendor/pi-tui.ts`
(1263 lines) + `pi-agent-loop.ts` (796) + `pi-terminal.ts`.

## Non-goals

Do not pin TUI theming, keybinding maps, or prompt-string content here —
rendering policy stays host-owned; color/key work belongs to later
issues, not this port.

## Verification

- `baml check --project bi` green.
- `baml test --project bi`: one-test→one-impl for `LoopState` /
  `Component` arms (no LLM).
- Red-check probe (recorded 2026-09-05): neuter the `next_loop_state`
  Idle arm to Waiting → the `next_loop_state` test FAILs; restored →
  278/278 green.
