<!-- bi12-before.md — VERBATIM live bi#12 body (2026-09-06). Do not reshape:
this fixture is the standing red-check failure demonstrator (bi#57
adapted) — it must keep failing [problem] [behavior] [nongoals]
[verification]. The rewrite is bi12-after.md. -->

Port pi's skills (coding-agent/src/core/skills.ts, agent/src/harness/skills.ts)
and slash-commands (coding-agent/src/core/slash-commands.ts) into bi. They are
how pi's agent discovers tools, adjacent to bi's tool registry (tools.baml).

Acceptance: baml check green, baml test for skill registration + slash
dispatch (no LLM), `bi run` lists skill-provided tools alongside the 15
built-ins.

Evidence: verdict(bi#57) # backfill 2026-09-05: "paste" builtin renamed away → "registry is pi's 23 plus bi extras" FAIL, restored, 278/278 green.
