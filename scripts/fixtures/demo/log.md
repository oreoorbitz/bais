# Campaign log — hub#156 demo (owner demo-156)

## Claim
- `bais move hub#156 Doing --as demo-156 --for 3h` → moved (hub#156 Open→Doing).
  First attempt with bare `bais` failed (`bais: command not found`); grounded:
  CLI is `node bais/dist/src/cli.js` from repo root (bais/package.json bin).
- Inbox re-read: `.bais/inbox/` absent (ls verified) → nothing to re-read;
  teardown inbox line will pass with named reason.

## Assignment (roster.mjs match(), observed)
- hub#159 tags [process, docs] → default generalist, LOUD fallback:
  "no roster entry matches component tags [process, docs]".
- bi#129 tags [backend, coordination] → PhpJoe (1 overlap), corpus
  bagl:corpora/php-v1 attached.
- Persona follows match(); no tag-gaming to force one specialist.

## Witnessed case for hub#159 (ground-first reuse)
- Squad 1 applied the filed ground-first skill itself: grep before code.
  Catch: hub#159 bullet 1 ("cite the skill in the spawn-brief template")
  was already landed (briefs.mjs:125) — verified by grep, not assumed.
  Without the grep the squad would have re-implemented a landed line.
  Remainder done here: merger-checklist citation (AGENTS.md +1 bullet)
  + briefs selftest asserts the Restart line cites ground-first.

## Squad 1 — hub#159 (default, LOUD fallback)
- Claimed hub#159 Doing --as demo-156.
- Diff A (root repo, base 519c2c5): AGENTS.md merger ground-first bullet.
- Diff B (bais repo, base 0f4f96b): briefs.mjs selftest ground-first
  assertion. NOTE (ground-first catch #2): bais scripts/ is untracked in
  bais HEAD — fold verified by content-presence + gates, not git-apply.
- Gates observed: briefs selftest green
  ("6 required lines, positive + 6 negatives, restart cites ground-first");
  dispatch.mjs "all green"; `baml check --project bais` 14 files;
  `typecheck --prefix bais` clean.
- Skill authored: skill-demo-01 [process, review] → routeCandidate →
  coordinator library ("matches no specialty [process, review]...
  escalated to coordinator library on read"). Persisted:
  .bais/roster/libs/coordinator/skill-demo-01.toml (cmp-confirmed).
- Handoffs 001/002 (priority 00): HANDOFF VALID with --base; folded
  (content-presence 1/1 each + gates) → moved to folded/.
- integrated: hub#159 by=demo-156 ref=handoff-demo156-s1a+s1b.
- hub#159 → Done.

## Squad 2 — bi#129 (PhpJoe)
- Re-read bi#129 + inbox (still absent) before touching code.
- Reused skill-demo-01 first: grepped dispatch lane premises — confirmed
  warnPartial precedent (§8) and "NOTE for the src lane" convention, so
  the scripts-lane + CLI-wiring-out shape is the honest scope (cli.ts is
  out of footprint); no redundant CLI edit attempted.
- Claimed bi#129 Doing --as demo-156.
- Work: warnReentry(leased) in briefs.mjs (kimi-veto shape, exit 0) +
  dispatch.mjs §9 fixture (pack → claim t#01 → re-dispatch warns naming
  t#01 → release → quiet) + exact-format assertions + src-lane NOTE
  (cli.ts wiring out of footprint). Observed: all §9 checks ok first run,
  including `moved t#01 Open Doing` / `moved t#01 Doing Open` in fixture hub.
- Red-check (bi#57): neutered guard to always-null → `FAIL: reentry
  format exact`, `FAIL: reentry plural format exact`,
  `FAIL: re-dispatch warns naming the held slot (null)`, `3 failure(s)`;
  restored → `dispatch: all green`. Recorded verbatim in §9 comments.
- Gates observed: dispatch.mjs "all green" (re-run after final comment
  touch); briefs selftest green; `baml check --project bais` 14 files;
  `typecheck --prefix bais` clean.
- Skill authored: skill-demo-02 [dispatch, coordination] →
  routeCandidate → coordinator library ("matches no specialty
  [dispatch, coordination]... escalated to coordinator library on
  read"). Persisted: .bais/roster/libs/coordinator/skill-demo-02.toml.
- Handoff 003 (priority 01): HANDOFF VALID with --base; folded
  (warnReentry + §9 content-present + gates re-run) → folded/.
- integrated: bi#129 by=demo-156 ref=handoff-demo156-s2-reentry.
- bi#129 → Done.

## System test (lieutenant-owned, covers hub#159 + bi#129)
- Hub-wide teardown observed (exit 1, TEARDOWN OPEN): the ONLY violations
  are 4 foreign live claims — bi#06 (ffi-06), bi#69 + bi#85 (tui-69, new
  since enumeration), hub#153 (bits-153). Untouched per claim protocol
  (never adopt another holder's live claim); stop-and-report to operator.
- Campaign scope CLOSED on all six lines: zero Doing held by demo-156
  (hub#156, hub#159, bi#129 all Done); handoffs PASS (3 folded, none
  unfolded); inbox/processes/files PASS.
- Log shows skill authored (01, 02) + reuse (ground-first applied by
  squad 1, skill-01 scoping applied by squad 2) + escalation (01 and 02
  → coordinator with reasons); libraries persist on disk across sessions.
- result=pass-on-campaign-scope; hub-wide close-out blocked by parallel
  lines (named above), not by this campaign.
