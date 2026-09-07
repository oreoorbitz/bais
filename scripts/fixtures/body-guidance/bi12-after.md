## Problem

pi discovers tools via skills and slash-commands
(`coding-agent/src/core/skills.ts`, `agent/src/harness/skills.ts`,
`coding-agent/src/core/slash-commands.ts`); bi's tool registry
(`tools.baml`) has no equivalent, so skill-provided tools are invisible.

## Behavior

Skill registration and slash dispatch land in `tools.baml`, adjacent to
the existing registry: `bi run` lists skill-provided tools alongside the
15 built-ins, and dispatching a registered slash command invokes its
tool.

## Non-goals

Do not pin skill-file authoring format or slash-command UX here —
registry + dispatch wiring is in scope, the skill content format is a
later issue.

## Verification

- `baml check --project bi` green.
- `baml test --project bi` for skill registration + slash dispatch
  (no LLM).
- `bi run` probe: skill-provided tools appear alongside the 15
  built-ins.
- Red-check probe (recorded 2026-09-05): rename the "paste" builtin
  away → the "registry is pi's 23 plus bi extras" test FAILs;
  restored → 278/278 green.
