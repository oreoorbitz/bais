# Goal object + /goal flow (bi#132)

Goals live per directory in `.bais/goal.toml` — one active campaign per
directory, not one backlog ever. Scripts-lane implementation:
`bais/scripts/goal.mjs` (pure functions + selftest) with fixtures under
`bais/scripts/fixtures/goal/`. CLI wiring (`/goal` command) is explicitly
out of scope; see the SRC-LANE WIRING header in `goal.mjs`.

## goal.toml schema

```toml
[goal]
statement = "Ship per-directory goal tracking for BAIS"
style = "plain"
hero = "plain"
non_goals = ["backlog-wide campaigns"]
done_criteria = [{ text = "sketch refused while open", done = false }]
testing_surface = [{ surface = "bais list shows open issues", exercise = "run: bais list --json => exit 0 (facets: cli output shape)" }]
surface_spec = [{ facet = "cli output shape", spec = "TSV rows + --json envelopes per SPEC.md" }]
contract = [{ field = "outcome", text = "..." }]  # all five fields: outcome, verification, constraints, boundaries, stop_when
goal_snapshot = "goal-snapshot-a071da2aceaa"
approved_sketch_hash = "sha256:<hex of the approved sketch.toml>"
surface_decisions = [{ surface = "...", case = "<slug>", decision = "keep|retire", reason = "<retire reason>", snapshot = "<live snapshot for keep>" }]

[interview.users]
status = "filled"   # open | filled | waived | defaulted
value = "solo dev"
# ... one [interview.<box>] table per checklist box (see below)
```

- `statement`: the campaign in one sentence (from `/goal <statement>`).
- `non_goals`: explicitly out of scope (mirrors the `non-goals` box).
- `done_criteria`: acceptance list; each has `text` + `done` flag.
  `/goal status` reports done/total plus the still-open texts.
- `style`: working style for the campaign.
- `hero`: the node the sketch's criterion nodes depend on (defaults to
  the style answer; the sketch falls back to the statement).
- `testing_surface` / `surface_spec` / `contract`: the file-level lists
  backing the `testing-surface`, `surface-spec`, and `contract`
  interview boxes (inline tables; missing/empty is grandfathered for
  pre-surface/spec/contract goals).
- `goal_snapshot` (hub#195): the campaign snapshot id stamped by
  `commit()` (`goalSnapshotId` of the approved sketch.toml) and into
  every e2e scaffold header (`// goal snapshot: <id>` — the campaign
  version the case was authored under). Kept cases rebind explicitly to
  the new snapshot id (`rebindE2eSnapshot`); cross-goal reuse without an
  explicit keep decision flags as `e2e-snapshot-stale` in `bais check`.
- `approved_sketch_hash` (hub#195): `sha256:<hex>` of the exact
  sketch.toml bytes `commit()` wrote. Post-approval sketch edits flag
  loud as `goal-sketch-stale` in `bais check` (`verifyApprovedSketch`);
  a goal.toml without the hash is grandfathered (pre-195 campaigns).
- `surface_decisions` (hub#221): the recorded keep/retire ledger,
  written only by `bais goal keep-surface` / `retire-surface`, rendered
  only when non-empty. `bais check` suppresses the retired surfaces'
  gap/stale/snapshot rows and prints a `surface-retired` line with the
  reason instead.
- `[interview.<box>]`: per-box scoping state so the interview can resume.

## Scoping interview

Checklist boxes, asked in order: `users, scale, platform, constraints,
style, acceptance, non-goals`. Rules:

1. The LLM may not sketch until every box is `filled`, `waived`, or
   `defaulted` — `sketch()` refuses with
   `sketch refused: checklist open (...)` while any box is open.
2. Every question ends with the use-defaults escape: reply with a value,
   `"waive"`, or `"defaults"` to fill every remaining box with defaults.
3. Max rounds cap (`MAX_ROUNDS = 10`): past the cap the remaining boxes
   auto-default instead of asking again. Scoping cannot interrogate.

## Sketch / commit / status / switch

- `sketch` is a dry run: pure `{ nodes, edges }` data, writes nothing.
  Nodes are the hero plus one per done criterion; edges chain criteria
  onto the hero (`DependsOn`); each node carries a `radius` (path
  prefixes it touches — hero defaults to `["."]`, criterion nodes to
  `[]`). The human edits the proposal before anything lands.
- `commit` writes `.bais/goal.toml` only with explicit human approval
  (`{ approved: true }`) plus a complete checklist plus a sketch.
  Without approval the write callback is never invoked.
- `status` tracks acceptance: `{ done, total, open[], checklist, sketched }`.
- `switch` (restructure flow) archives the old campaign, starts a fresh
  interview for the new statement, and lists prior sketch node ids for
  the human to retire. Old testing-surface items list as undecided +
  flagged for an explicit keep/retire decision.
- `keep-surface <surface|case>` (hub#221) records a keep decision and
  rebinds the case file to the live campaign snapshot; `retire-surface
  <surface|case> --reason <R>` records a retire decision and marks the
  case file. A second decision for the same surface refuses loud
  (bi#55); `bais check` stops flagging decided surfaces.
