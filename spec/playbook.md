# BAIS swarm playbook — prompt context block (bi#61)

`bi run` injects the BAIS ready list as bare `- id title` lines plus 8
`bais_*` tools — no playbook. The LLM must infer: claim before work,
fencing echo on writes, holder-only renewals, notifications via queue,
move announces unblocks, verify when it smells. Inferred protocol is
violated protocol. This file is the canonical playbook: a single compact
context block (§2) assembled from the landed specs (§1 — enumerated
first, ground-first; the block quotes their exact commands and points at
the full rule, never paraphrases the rule into new wording).

PLAYBOOK_VERSION = 1. Supported hub `interop_version`: <= 1 (absent means 1).

## How this file serves (inside + outside)

- INSIDE agents: `bi run` injects the §2 block with the ready list.
  Injection wiring is explicitly OUT of this issue — the header spec rides
  bi#135/bi#128. This issue ships the canonical text + the assembler only.
- OUTSIDE agents: this file is plain Markdown — fetchable as a file (a
  future endpoint over the hub#154 interop surface serves these same
  bytes). No BAML toolchain, no `baml_sdk`, no Node needed to READ it;
  the scripts-lane commands it names need only `node` (never `baml_sdk`).

Protocol-change checklist (binding): update this playbook in the same
commit as any protocol change that invalidates it (lease clocks bi#42,
sig mode bi#37). A stale playbook is worse than none.

## 1. Spec inventory (sources — the block quotes these)

Landed specs under `bais/spec/` (seven files — this enumeration is the
ground-first inventory; a new spec file here without a block pointer is
a playbook bug, file it):

- `interop.md` (hub#154) — outside-agent file layout, `INTEROP_VERSION
  = 1`, loud refusal: "Silence or best-effort parsing of a newer schema
  is forbidden: a reader that guesses is worse than one that refuses."
- `handoff.md` (bi#139) — handoff headers, `diff` bodies (`base:` +
  hunks + `Evidence:`), priority filenames, atomic writes, validate gate.
- `inbox.md` (bi#149) — per-owner queues, operator-or-lieutenant-only
  sends, liveness-gated delivery with loud re-queue, read-and-acknowledge.
- `lieutenant.md` (bi#145) — plan-agreed gate, one squad per component,
  lieutenant-signed integration, owned system test.
- `forwarding.md` (bi#143) — direct vs via-operator routing, terminal
  broadcast to the merger.
- `goal.md` (bi#132) — goal.toml schema, scoping interview, sketch/commit.
- `body-guidance.md` (bi#146) — Problem/Behavior/Verification + non-goals
  + reviewer checklist; its §1–§3 are copied verbatim into §3 below per
  that file's Placement rule (this file is the playbook copy; the
  `bais/toml/BAIS.md` "Body conventions" section is deferred, see
  Non-goals).

Plus two non-spec sources the block quotes verbatim:

- `bais/scripts/briefs.mjs` `renderBrief` — claim line, Restart line,
  Trust scope line, six `REQUIRED_BRIEF_LINES`, PRE-FINISH DELIVERY clause.
- Ground-first (`.agents/skills/ground-first/SKILL.md`, hub#159) —
  enumerate before theorizing; docs are hypotheses, listings are the world.

Load-bearing quotes (exact wording the block reuses — kept in sync by
the fixture gate in §4):

- Claim: `bais move <id> Doing --as <owner> --for 2h` — "never start
  unclaimed — Doing without --as is instantly stale" (briefs.mjs).
- Renewal: "Strangers cannot renew; the holder can." (claim.mjs probe —
  `renew --as <other>` is refused). bi#61's "keeper holds" is this
  discipline: the holder heartbeats its own claim; no separate keeper
  process exists — if one lands, this playbook updates same-commit.
- Liveness: "an owner is **live** iff the hub holds an issue with
  `status = "Doing"`, `holder == <owner>`, and a parseable `lease` in
  the future" (inbox.md §4). "Missing, unparseable, expired, anonymous,
  or non-`Doing` claims all read as **dead**."
- Every write echoes: `moved\t<id>\t<from>\t<to>` (claim.mjs),
  `HANDOFF VALID` / `HANDOFF INVALID <file> (N errors)` (handoff.md §6),
  `INBOX DELIVERED` / `INBOX REQUEUED <relpath> (owner <to> has no live
  claim; re-queued for operator triage)` (inbox.md §5).
- Version refusal shape: `INTEROP VERSION <n> UNSUPPORTED` (interop.md
  §2); the playbook's own assert mirrors it (§2 line 0, §4).

## 2. Context block (canonical — assembled by `scripts/playbook.mjs`)

<!-- PLAYBOOK-BLOCK-BEGIN -->
PLAYBOOK_VERSION = 1 (hub interop_version <= 1; full rules: bais/spec/*.md).
Version first: read <hub>/.bais/config.toml `interop_version` (absent means 1).
Hub newer than 1: STOP, warn loud PLAYBOOK VERSION MISMATCH — a reader that
guesses is worse than one that refuses (interop.md §2).

1. CLAIM FIRST. `bais move <id> Doing --as <owner> --for 2h` from the hub dir.
Doing without `--as` is anonymous, instantly stale — never start unclaimed (briefs.mjs).
2. GROUND FIRST. On start/resume re-read the issue + inbox before touching code
(Restart, bi#144). Enumerate before theorizing: ls, read the file, run the
command. Docs are hypotheses; listings are the world (ground-first).
3. HOLD WHILE YOU WORK. Heartbeat your own claim:
`bais renew <id> --as <owner> --for 2h` (holder-only — strangers are refused).
Never adopt another holder's live claim (claim.mjs).
4. TOUCH ONLY OWNED FILES. Change only your brief's paths; read before editing.
Anything else goes to the operator, never sideways — peers never message peers
(inbox.md §3).
5. SUBMIT BY HANDOFF. Write atomically (<name>.tmp.<pid>, fsync, rename), then
`node bais/scripts/handoff-validate.mjs <file.handoff>`. A diff handoff carries
all three: `base: <40-hex-sha>` + scoped hunks + `Evidence: <ref>`
(handoff.md §3). Red handoffs come back with repair guidance — fix, re-validate,
never hand red work to the merger. Fold order is filename order: 00 first.
6. EVERY WRITE ECHOES. move prints moved + unblocks; validate prints HANDOFF
VALID/INVALID; inbox send prints DELIVERED/REQUEUED. Silence after a write means
it did not happen — re-read before retrying (handoff.md §6, inbox.md §5).
7. MOVE, THEN VERIFY WHEN IT SMELLS. `bais move <id> <status>` announces what it
unblocked. Suspicious state: run `bais verify` (content fingerprint) before done (cli.ts).
8. INBOX IS READ + ACK. read lists your queue in priority order; reading never
removes — `ack <id>` removes exactly one. Only operator or a lieutenant may send;
a dead owner's mail re-queues loud for triage, never lands to rot (inbox.md §§5-6).
9. LEAVE NOTHING OPEN. No live Doing claim, no unfolded handoff, no undrained
inbox, no stray process or *.tmp partial (teardown.mjs lines: agents/claims/handoffs/
inbox/processes/files). Drained or re-queued — never silently dropped.
10. EVIDENCE, NOT ADJECTIVES. Bodies are Problem/Behavior/Verification with
explicit non-goals (§3); handoffs cite base + hunks + Evidence ref. Never write
"works correctly" — name the command or probe.
<!-- PLAYBOOK-BLOCK-END -->

## 2S. Swarm block (dispatch-class only — bi#128)

Assembled only in swarm mode (`scripts/playbook.mjs assemble --mode
swarm`); the standard §2 block never carries it. The dispatcher picks
the mode: dispatch-class tasks ("start a batch", parallel tracks) get
swarm appended, regular requests get §2 alone.

<!-- SWARM-BLOCK-BEGIN -->
SWARM MODE (dispatch-class tasks only). Regular requests ignore this
section entirely — normal work stays normal.
1. EXPLORE FIRST. Read the issues + file footprints yourself before
spawning; every brief carries exact paths, acceptance, handoff dir.
2. PACK BY FOOTPRINT. `bais dispatch --agents N` dry-runs the pack:
disjoint footprints only, load-bearing first, never headcount.
3. SPAWN FROM BRIEFS. One worker per slot; read-only may overlap,
conflicting writes never do — fork is costly, batch related queries.
4. MERGE IN BUILD ORDER. Re-run every gate; worker PASS claims are
hypotheses until reproduced; red-check every safety net.
5. NEXT PACK. Drained or re-queued — never silently dropped.
<!-- SWARM-BLOCK-END -->

## 3. Body shape (verbatim copy of `body-guidance.md` §1–§3)

Per `body-guidance.md` Placement: copied here verbatim when the playbook
landed; that file stays the reference copy.

<!-- BODY-GUIDANCE-BEGIN -->
## 1. The three-part shape

Every issue body has exactly three sections, in order, with `##`
headings so `rg` finds them:

```markdown
## Problem

<what gap or bug motivates this — one or two sentences, no solution>

## Behavior

<the observable change: who sees what after the fix/feature>

## Verification

<the command or probe that proves it, never "works correctly">
```

- **Problem** names the gap, not the solution. "Long sessions die at
  the context limit" is a Problem; "port compaction.ts" is not.
- **Behavior** states what an observer sees: which command output
  changes, which file appears, which error disappears.
- **Verification** names a runnable command or probe:
  `baml test --project bi`, `node bais/scripts/<suite>.mjs`,
  `bi bais ready`, a named red-check ("neuter X → suite FAILs with
  <exact-reason>"). The banned phrase is **"works correctly"** and its
  siblings ("works as expected", "behaves properly", "functions
  correctly") — they assert correctness without saying how to observe
  it. Any occurrence FAILs the `[no-works-correctly]` box, even inside
  an otherwise good Verification.

## 2. Non-goals — do not pin X

Every body names what it deliberately does NOT do, inside Behavior or a
trailing `## Non-goals` section, in the form "do not pin X" / "X is out
of scope (see <issue>)":

- A port issue pins which upstream files are in scope AND which stay
  out ("prompt rendering stays host-owned; no TUI color work here").
- A protocol issue names the neighboring issue that owns the excluded
  half ("refill/burndown belong to bi#137, not this protocol").
- If there genuinely is nothing adjacent, write
  "Non-goals: none adjacent — <why>". An absent Non-goals section
  FAILs the `[nongoals]` box; "none" without a reason fails it too.

## 3. One-pass reviewer checklist

Tick all five boxes in a single read. The runnable version is
`bais/scripts/fixtures/body-guidance/check.mjs` (reviewer aid, not a
gate — same precedent as the lieutenant `check.mjs`).

- [ ] `[problem]` — a `## Problem` section exists and is non-empty.
- [ ] `[behavior]` — a `## Behavior` section exists and is non-empty.
- [ ] `[nongoals]` — non-goals are explicit: a `## Non-goals` section,
      or a "do not pin" / "out of scope" / "not in scope" line.
- [ ] `[verification]` — a `## Verification` section exists, is
      non-empty, and names a command or probe (backticked command,
      `baml ...`, `node ...`, `bi ...`, `bais ...`, `rg ...`, or the
      word "probe").
- [ ] `[no-works-correctly]` — the body contains no "works correctly"
      (or "works as expected" / "behaves properly" / "functions
      correctly"), case-insensitive.
<!-- BODY-GUIDANCE-END -->

## 4. Assembler + fixture gate (acceptance for bi#61)

`../scripts/playbook.mjs` (scripts lane, pure ESM, zero dependencies,
never imports `baml_sdk`) extracts the §2 block verbatim and enforces
the token budget:

```bash
node scripts/playbook.mjs assemble [--budget N] [--file <md>]
# → block bytes on stdout, exit 0; over budget → PLAYBOOK BUDGET REFUSED, exit 1
node scripts/playbook.mjs check-version --hub <root>
# → PLAYBOOK VERSION OK, exit 0; newer hub → PLAYBOOK VERSION MISMATCH, exit 1
```

Budget: `DEFAULT_BUDGET = 4000` chars over the extracted block (current
block ≈ 2.3k — headroom for protocol growth, refusal before injection
bloat). The budget counts block bytes only, never the pointers' targets.

In `../scripts/fixtures/playbook/`, run from `bais/`:

```bash
node scripts/fixtures/playbook/check.mjs --all
# → 8/8 assertions green across 7 checks, exit 0:
#   assemble-green (block fits budget, every protocol anchor present),
#   budget-red (tiny budget refuses loud),
#   swarm-present (--mode swarm carries the §2S block within budget),
#   swarm-absent (default assemble has no swarm text),
#   stub-probe (an LLM-less scripted run following ONLY the block text
#     completes version-check → claim → work → handoff submit+validate →
#     move → ready/teardown confirm against a stub hub with zero
#     off-script calls, plus one deliberate off-script call refused),
#   version-mismatch (interop_version = 2 hub warns loud, interop.md §2 style),
#   outside-reader (stdlib string ops alone recover the claim shape, the
#     handoff trio, inbox verbs, teardown lines, and version line from the
#     block — a non-BAML reader understands claims/handoffs/evidence from
#     the playbook alone, hub#154 conformance style).
```

Plus: `baml check --project bais` stays green (no `.baml` touched).

## 5. Red-check (bi#57)

Recorded in `../scripts/playbook.mjs` header comments: the budget-refusal
hunk was neutered (over-budget blocks assemble silently), then the
fixture gate was repeated over untouched fixtures — `budget-red` went red
with `expected PLAYBOOK BUDGET REFUSED, got ASSEMBLED` (wrong outcome —
the silent-bloat path the gate exists to prevent); with the hunk restored
all 5 checks return to their §4 outcomes. A gate that cannot go red on an
over-budget block is camouflage, not coverage.

## Non-goals — do not pin X

- Injection wiring is out of scope (rides bi#135/bi#128): this issue pins
  the canonical text + assembler, not the `bi run` header that injects it.
- Endpoint serving is out of scope: the playbook pairs with hub#154's
  interop surface by being fetchable as a file; a served endpoint follows
  the interop CLI wiring precedent, not this protocol.
- The `bais/toml/BAIS.md` "Body conventions" section is out of scope here
  (deferred per body-guidance.md Placement — same-commit rule applies when
  it lands; this file does not drift toward it in the meantime).
- Message shapes as BAML types (bi#53 Handoff/Progress/Verdict) plug in at
  the `Evidence:` refs, not in this text — procedure stays plain text.
- Non-goals: none adjacent beyond the above — the playbook covers the full
  claim → work → submit → move → verify loop, so neighbors are named, not
  open.

