# Chain forwarding + terminal broadcast (bi#143)

Continuations are operator-driven today (the dispatcher assigns every
hop). This spec formalizes agent-to-agent forwarding for
scripts-lane chains: on completion the assignee forwards directly to
the next-branch owner with a handoff; the terminal node broadcasts to
the merger (= Done). Routing rule: footprint collision or ambiguity
routes via the operator instead of direct-forward — the operator stays
the conflict resolver, and bi#129's one-pack rule still gates
concurrent packs.

## 1. No new surfaces (invent nothing)

A forward rides the three existing protocol surfaces:

- The forward itself is a handoff **diff** (`handoff.md` §3): scoped
  hunks + base commit + test evidence, addressed from the completing
  assignee to the next-branch owner. `handoff-validate.mjs` owns the
  file shape; this spec only references handoff ids.
- Operator-routed forwards travel the same handoff shape addressed to
  the operator, who re-dispatches; operator steer uses the inbox
  (`inbox.md` §3 — only `operator` or a lieutenant may send, peers
  never message peers sideways).
- Branch/directory structure follows the lieutenant protocol
  (`lieutenant.md`): one squad per component, lieutenant-signed
  integration. Forwarding moves outputs along the chain; it does not
  replace the plan-agreed gate or the owned system test.

## 2. Event log format (checker input)

Line-oriented text, one record per line, like the lieutenant fixtures:
blank lines and `#` comments ignored; line numbers are 1-based over
all lines (comments count, so refusals point at the real line).

```text
chain: <id>                                              # exactly once, first record
branch: <name> owner=<owner> files=<f,...>               # one per branch; files= is the footprint (may be empty)
forward: <from> to=<to|?> via=direct|operator [reason=<why>] handoff=<id>
broadcast: to=merger chain=<id> result=done ref=<handoff-id>
```

- `chain:` names the continuation; a second `chain:` is refused.
- `branch:` declares a branch, its owner, and its file footprint.
  Names are unique per log. `files=` lists the paths the branch
  writes, comma-separated; an empty value means footprint-free.
- `forward:` records one hop. `handoff=` is always required — every
  hop, direct or routed, carries a handoff diff. `to=?` spells an
  ambiguous next branch (no unique successor); it is only legal with
  `via=operator`.
- `broadcast:` is the terminal broadcast, exactly once. `to` must be
  `merger`, `chain` must match §2's id, `result` must be `done`, and
  `ref` names the closing handoff to the merger.

## 3. Routing rule: forward vs via-operator

`via=direct` is allowed **iff** all four hold:

1. Both branches are declared, and `to` is a real branch (never `?`).
2. Footprints are disjoint — no shared path between the from-branch
   `files=` and the to-branch `files=`. Any overlap is a **collision**.
3. The hop continues the chain: the `from` equals the previous
   forward's `to` (the first hop may start at any declared branch; a
   hop after `to=?` may start anywhere, since the successor was
   unknown).
4. One forward per branch — a branch that already forwarded cannot
   forward again (linear chain discipline).

Otherwise the hop routes `via=operator` with a `reason=` naming the
cause (`collision on <path>` / `ambiguous next branch` / ...). A
`via=operator` hop without `reason=` is refused. A `via=direct` hop
over a collision, or to `?`, or to an undeclared branch, is refused
at its line — the checker never silently re-routes.

## 4. Terminal broadcast

The terminal node (the last hop's `to`) broadcasts to the merger with
`result=done` and the closing handoff `ref`. The broadcast closes the
chain: a log that ends without it is `INCOMPLETE` (`chain never
closed`), and every declared branch must be covered — each branch
appears as a forward `from` exactly once, except the terminal branch,
which appears only as a `to`. The broadcast is the `= Done`
transition; no further forwards may follow it.

## 5. Standing invariants (not weakened)

- **Operator stays conflict resolver** (`inbox.md` §3): direct
  forwards never resolve collisions or ambiguity themselves; they
  route via the operator, who re-dispatches through the inbox.
- **One-pack rule** (bi#129): forwarding hands off *within* the single
  active pack. A forward never authorizes a second concurrent pack;
  concurrent-pack gating is unchanged and out of scope here.

## 6. Verdicts

- `FORWARD OK <file>`: every hop satisfies §3, every branch is
  covered, the terminal broadcast closes the chain.
- `FORWARD REFUSED <file>` + `error\t<line>\t<message>`: a
  structural violation at a line (undeclared branch, `direct` over a
  collision, `direct` to `?`, routed hop without `reason=`, hop
  without `handoff=`, second broadcast, unknown record kind).
- `FORWARD INCOMPLETE <file>` + errors: the log ends without
  satisfying the verdict (no terminal broadcast, a branch never
  forwarded).

## 7. Fixture gate (acceptance for bi#143)

In `../scripts/fixtures/forwarding/`, run from `bais/`:

```bash
node scripts/fixtures/forwarding/check.mjs --all
# → 6/6 fixtures behave as specified, exit 0
node scripts/fixtures/forwarding/check.mjs scripts/fixtures/forwarding/clean-chain.events
# → FORWARD OK, exit 0 (three direct hops, disjoint footprints, no operator hops; broadcast closes)
node scripts/fixtures/forwarding/check.mjs scripts/fixtures/forwarding/collision-via-operator.events
# → FORWARD OK, exit 0 (colliding hop routes via operator with reason; broadcast closes)
node scripts/fixtures/forwarding/check.mjs scripts/fixtures/forwarding/ambiguous-next-via-operator.events
# → FORWARD OK, exit 0 (ambiguous successor spells to=? and routes via operator with reason)
node scripts/fixtures/forwarding/check.mjs scripts/fixtures/forwarding/terminal-broadcast.events
# → FORWARD OK, exit 0 (minimal chain: one direct hop, terminal broadcast closes it)
node scripts/fixtures/forwarding/check.mjs scripts/fixtures/forwarding/direct-despite-collision.events
# → REFUSED line 6, direct hop over a footprint collision, exit 1 (must-fail fixture)
node scripts/fixtures/forwarding/check.mjs scripts/fixtures/forwarding/missing-broadcast.events
# → INCOMPLETE, chain never closed (no terminal broadcast), exit 1
```

Plus: `baml check --project bais` stays green (no `.baml` touched).

## 8. Red-check (bi#57)

Recorded in `../scripts/fixtures/forwarding/check.mjs` header
comments: the collision refusal hunk was removed (direct hops over
shared footprints treated as legal), then the fixture run was
repeated over untouched fixtures — the must-fail fixture proceeded
past line 6 and `--all` went red with `expected REFUSED "collision"
@ line 6, got OK` (wrong outcome — the silent-collision path the
gate exists to prevent); with the hunk restored all 6 fixtures
return to their §7 outcomes. A gate that cannot go red on a
direct-over-collision hop is camouflage, not coverage.
