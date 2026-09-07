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
  the human to retire.
