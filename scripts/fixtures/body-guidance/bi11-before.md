<!-- bi11-before.md — VERBATIM live bi#11 body (2026-09-06). Do not reshape:
this fixture must keep failing [problem] [behavior] [nongoals]
[verification]. The rewrite is bi11-after.md. -->

Port pi's session compaction into bi: coding-agent/src/core/compaction
(compaction.ts, branch-summarization.ts, utils.ts) + agent/src/harness/compaction.
Without it long sessions die at the context limit.

BAML owns: compaction trigger rule (token threshold), summary schema.
Host owns: the summarization call + session rewrite.

Acceptance: baml check green, baml test one-test→one-impl for trigger rule
and branch summarization (no LLM), a long session compacts and continues
without losing the active goal.

Evidence: verdict(bi#57) # backfill 2026-09-05: should_compact boundary neutered to >= → "trigger fires past window minus reserve" FAIL, restored, 278/278 green.
