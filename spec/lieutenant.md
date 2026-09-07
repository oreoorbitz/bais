# Goal-mode lieutenant protocol (bi#145)

The lieutenant is the goal-mode dispatcher+merger: one named owner per
goal directory who agrees the component plan with the operator
(post-interview, before any squad forms), forms one squad per component,
coordinates dependencies, integrates squad outputs, and owns the system
test procedure. Squads are today's swipe packs; the lieutenant is the
role. The campaign loop that auto-refills packs (bi#137) is explicitly
OUT of scope here — no refill, no burndown, no release signals in this
protocol. A loop directive in an event log is rejected as unknown.

Single lieutenant per directory (matches one-goal-per-directory): a
second `lieutenant:` claim for the same directory is refused.

## 1. Lifecycle

```text
interview → plan-proposed → plan-agreed → executing → integrating → system-test → done
```

- `interview`: operator interview happens with NO squads. Any
  `squad-formed` before `plan-agreed` is refused (the plan-agreed gate).
- `plan-proposed`: the lieutenant drafts the component list.
- `plan-agreed`: the operator signs off (`plan-agreed: by=operator`).
  Only now may squads form — one squad per component, and only for
  components in the agreed plan.
- `executing` / `integrating`: squads land component outputs; the
  lieutenant records one `integrated:` line per component, signed by
  the lieutenant (`by=` must equal the directory's lieutenant) with an
  evidence ref. A component whose squad output is never integrated is
  an orphan — the log FAILs (no orphan integration).
- `system-test`: the lieutenant owns the system test. The
  `system-test:` line must name the lieutenant as `owner=`, cover every
  plan component in `covers=`, and record `result=pass|fail`. A test
  without the lieutenant owner, or missing a component, FAILs. The
  filled ownership checklist lives next to the log
  (`system-test-checklist.md`): every box ticked, owner and covers
  matching the log.

## 2. Event log format

Line-oriented text, one record per line. Blank lines and `#` comments
ignored. Line numbers are 1-based over all lines (comments count, so
refusals point at the real line).

```text
dir: <goal-dir>                        # exactly once, first record
lieutenant: <owner>                    # exactly once (a second claim is refused)
plan-proposed: <comp>,<comp>,...       # lieutenant drafts components
plan-agreed: by=operator               # operator sign-off (before any squad)
squad-formed: <squad> component=<comp> # one squad per component, plan members only
depends: <comp> on <comp>              # informational dependency note (optional)
integrated: <comp> by=<owner> ref=<ev> # lieutenant-signed, one per component
system-test: owner=<owner> covers=<c,..> result=pass|fail
```

Unknown record kinds (including bi#137 loop directives such as
`refill:` or `burndown:`) are rejected — the loop is a later issue.

## 3. Verdicts

- `LIEUTENANT OK <file>`: plan agreed before squads, every plan
  component has exactly one squad and one lieutenant-signed
  integration, system test owned by the lieutenant covering all
  components with `result=pass`.
- `LIEUTENANT REFUSED <file>` + `error\t<line>\t<message>`: a
  structural violation at a line (squad before agreement, duplicate
  lieutenant, unknown component, second squad, unsigned integration).
- `LIEUTENANT INCOMPLETE <file>` + errors: the log ends without
  satisfying the verdict (orphan output, unowned/under-covered test,
  `result=fail`).

## 4. Fixture gate (acceptance for bi#145)

In `../scripts/fixtures/lieutenant/`, run from `bais/`:

```bash
node scripts/fixtures/lieutenant/check.mjs --all
# → 4/4 fixtures behave as specified + checklist validates, exit 0
node scripts/fixtures/lieutenant/check.mjs scripts/fixtures/lieutenant/plan-agreed-ok.events
# → LIEUTENANT OK, exit 0 (component plan agreed before squads; outputs integrated; system test owned)
node scripts/fixtures/lieutenant/check.mjs scripts/fixtures/lieutenant/squad-before-agreement.events
# → REFUSED line 5, squad formation before plan-agreed, exit 1
node scripts/fixtures/lieutenant/check.mjs scripts/fixtures/lieutenant/orphan-output.events
# → INCOMPLETE, component "query" never integrated (orphan), exit 1
node scripts/fixtures/lieutenant/check.mjs scripts/fixtures/lieutenant/unowned-system-test.events
# → INCOMPLETE, system test not owned by the lieutenant, exit 1
```

Plus: `baml check --project bais` stays green (no `.baml` touched).

## 5. Red-check (bi#57)

Recorded in `check.mjs` header comments: the plan-agreed refusal hunk
was removed, the early-squad fixture then proceeded past line 5 and the
`--all` run went red for the WRONG reason (expected refusal missing),
then the hunk was restored and the run returned green. A gate that
cannot go red on a pre-agreement squad is camouflage, not coverage.
