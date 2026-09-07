# Demo campaign plan — hub#156 (Memory+skills mini-campaign)

Owner: demo-156 (lieutenant+squads-of-one+merger). Goal: .bais/goal.toml
done-criterion 3 (persistent memory + self-authored skills across a
multi-turn campaign). Agreement: parent operator brief orders execution;
this file is the plan; lieutenant protocol observed for squads-of-one
(plan before squads, one squad per component, integrate + system-test).

## Backlog enumeration (ground-first: `ls`+`grep`, not priors)

- 166 issue files; Doing held by ffi-06 (bi#06), goalwire-132 (bi#132),
  bits-153 (hub#153). None touches dispatch.mjs / briefs.mjs / AGENTS.md.
- hub#159 premise partly stale (caught by grep, not assumed): briefs.mjs
  line 125 ALREADY cites ground-first in the Restart line. Remainder =
  merger-checklist citation + witnessed case. No merger fold-checklist
  file exists; closest is AGENTS.md "Working with agents" merger bullets.
- fixtures/demo/ does NOT exist (verified by ls) — created by this plan.

## Components (one squad each, sequential)

1. hub#159 [tags: process, docs] — Adopt ground-first into merger checklist;
   record this campaign as the witnessed case. Persona per roster match():
   default generalist, LOUD fallback ("no roster entry matches
   [process, docs]"). Footprint: AGENTS.md (+2 lines), briefs.mjs
   selftest (+1 assertion), fixtures/demo/*, .bais/roster/libs/*.
2. bi#129 [tags: backend, coordination] — One outstanding pack: scripts-lane
   reentry guard warnReentry() in dispatch.mjs + §9 fixture (pack → claim
   slot → re-dispatch warns naming held slot → release → quiet) + src-lane
   NOTE (cli.ts wiring out of footprint, briefs.mjs precedent). Persona per
   match(): PhpJoe (1 tag overlap [backend], corpus evidence attached).
   Footprint: dispatch.mjs, fixtures/demo/*, libs.

Neither touches cli.ts, goal.mjs, hero.mjs, roster.mjs, baml_src,
goal.toml, or another line's files. Other .bais/issues read-only.

## Memory+skills demonstrations (hub#156 acceptance)

- Authored: skill-01 stale-premise-check (squad 1), skill-02 dispatch
  learning with coordination tags (squad 2).
- Reuse: squad 2 solves its scoping via skill-01 (verify-premise-first).
- Escalation: skill-02 routeCandidate() → coordinator library with reason.
- Persistence: filed under .bais/roster/libs/<library>/ (*.skill.toml),
  surviving across sessions; log quotes route outcomes.

## Handoffs + teardown

- Per squad: one `type: diff` handoff (base: git HEAD, Evidence: line),
  atomic write to /tmp/demo156-deliver/, `handoff-validate` exit 0.
- Fold = validate + applied + integrated line in log.md; folded handoffs
  move to /tmp/demo156-deliver/folded/ (teardown scans top level only).
- Teardown: `node bais/scripts/teardown.mjs check --hub <root>
  --handoffs /tmp/demo156-deliver` exit 0 + TEARDOWN CLOSED. Requires zero
  live Doing claims → hub#156 → Done last, then teardown, then report.
- Inbox: .bais/inbox absent (verified) → teardown inbox line passes with
  reason; squads note "nothing to re-read".

## Gates per squad

hub#159: briefs.mjs --selftest, dispatch.mjs green, baml check --project
bais, typecheck --prefix bais. bi#129: dispatch.mjs green (incl. new §9),
same baml/typecheck, red-check proof recorded (neuter guard → §9 red with
exact message → restore green).

## System test (lieutenant-owned)

teardown exit 0 + both issues Done + log shows skill/reuse/escalation +
/tmp/demo156-deliver/ cmp-confirmed against fixtures/demo/.
