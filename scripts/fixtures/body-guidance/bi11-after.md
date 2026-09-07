## Problem

Long sessions die at the context limit: pi's session compaction
(`coding-agent/src/core/compaction`, `branch-summarization.ts`,
`utils.ts`, plus `agent/src/harness/compaction`) has no bi mirror.

## Behavior

BAML owns the compaction trigger rule (token threshold) and the summary
schema; the host owns the summarization call and the session rewrite. A
long session compacts past the threshold and continues with the active
goal intact.

## Non-goals

Do not pin the summarizer prompt or the summary prose quality here —
compaction policy (when to compact, what schema survives) is in scope,
LLM summary wording is not.

## Verification

- `baml check --project bi` green.
- `baml test --project bi`: one-test→one-impl for the trigger rule and
  branch summarization (no LLM).
- Red-check probe (recorded 2026-09-05): neuter the `should_compact`
  boundary to `>=` → the "trigger fires past window minus reserve"
  test FAILs; restored → 278/278 green.
