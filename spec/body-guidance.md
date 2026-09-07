# Problem/Behavior/Verification body guidance (bi#146)

Issue bodies vary wildly in quality. This doc fixes the shape: three
parts, explicit non-goals, and a Verification that names the command or
probe. Guidance only — no new `bais check` gate until proven (per bi#146).

## Placement (future home)

- **bi#61 playbook** (prompt context): the P-B-V shape belongs in the
  playbook agents read before writing issues. bi#61 is still Open and no
  playbook file exists yet (checked: no `playbook` file under `bi/src/`,
  `bais/src/`, or `.bais/` besides issue bodies referencing bi#61) — when
  the playbook lands, copy §1–§3 there verbatim and keep this file as the
  reference copy.
- **bais/toml/BAIS.md**: body-shape guidance is semantics, not grammar,
  so it belongs in a later "Body conventions" section there, not in the
  TOML rules. Not added yet — same commit as the playbook copy, to avoid
  two drifting copies.

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

## 4. Red-check (bi#57, adapted — recorded 2026-09-06 by pbv-146)

A checklist that cannot fail is camouflage. `bi12-before.md` is the
standing failure demonstrator: it is the verbatim live bi#12 body
(three paragraphs, no `##` sections, acceptance ending in "`bi run`
lists skill-provided tools alongside the 15 built-ins" with no named
probe). `check.mjs --all` must report it as

```text
FAIL  bi12-before.md  [problem] [behavior] [nongoals] [verification]
```

naming every failed box. If a future edit to the checker ever turns
that fixture green without touching the fixture, the checker — not the
fixture — regressed: restore the refusal before landing.
