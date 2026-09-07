# Outside-agent BAIS interop (hub#154)

An outside agent — no BAML toolchain, no `baml_sdk`, no Node, no third-party
packages — reads a BAIS graph straight from the files. This spec is the
contract that makes that possible. It normatively restates the smallest
subset of `SPEC.md` an independent reader must implement, plus the two
things `SPEC.md` leaves to the reference implementation: **stable
file-layout guarantees** and **issue schema versioning**.

Goal constraint (`.bais/goal.toml`): no BAML-only protocols on this path.
Anything here that requires BAML tooling is a spec bug — file it.

## 1. File-layout guarantees

A hub root is a directory containing `.bais/` with exactly this shape:

```text
<root>/
  .bais/
    config.toml          # flat keys: project = "<name>" (required),
                         # interop_version = <int> (optional, §2)
    issues/
      <id>.toml          # one issue per file
```

Normative rules (a hub breaking these is not an interop hub):

1. `config.toml` holds flat `key = value` lines only — no `[table]`
   sections. `project` (string) is required; `interop_version` (integer,
   §2) is optional. Unknown keys MUST be rejected loud by readers.
2. Every `issues/*.toml` file SHOULD be named `<id>.toml` where `id` equals
   the issue's `id` field. Readers key the graph by the `id` field, never
   the filename (SPEC §1) — a rename without an id change MUST NOT alter
   the graph.
3. Listing is a directory scan of `issues/*.toml` (sorted by filename for
   determinism); history is `git log`. There is no database, no server, no
   SDK handshake. `store.db`, if present, MUST be ignored by interop
   readers (rebuildable artifact, never committed).
4. Issue files are TOML v1.0.0 verbatim (SPEC §2). Readers implement the
   §3 subset; writers MUST NOT use TOML features outside it and expect
   interop readers to cope.

## 2. Schema versioning

`INTEROP_VERSION = 1` (this document). Every JSON envelope (§5) carries it
as `interop_version`; readers declare the versions they support and refuse
anything newer LOUD — non-zero exit plus a message matching
`INTEROP VERSION <n> UNSUPPORTED`. Silence or best-effort parsing of a
newer schema is forbidden: a reader that guesses is worse than one that
refuses.

Two layers, both asserted by the conformance fixture (§6):

1. **Hub-level gate.** `interop_version` in `.bais/config.toml`; absent
   means 1. A hub declaring a version above the reader's supported range
   MUST be refused before any issue file is trusted.
2. **File-level strictness.** Readers reject unknown top-level keys,
   unknown `status`/`kind`/edge-kind values, missing required fields, and
   `[table]` sections (SPEC §2 strictness). A schema addition that lands
   as a new key or enum value therefore fails an old reader even if the
   hub-level gate is skipped — belt and suspenders.

Evolution rules for future versions of this spec:

- Additive, backward-compatible changes (new optional key, new enum
  value): bump minor. Old readers keep working on hubs that do not use
  the addition, and fail loud (layer 2) on files that do.
- Breaking changes (new required key, removed value, changed semantics):
  bump major. Old readers fail loud (layer 1) on the whole hub.
- The bump and the loud failure ship together: a version number is never
  raised without a fixture proving the old reader refuses it (§6, clause 2).

## 3. File subset readers implement

Enough to parse every valid issue file, little enough to reimplement in an
afternoon in any language:

- `key = "string"` (basic strings; `\"` and `\\` escapes),
  `key = 123` (integers, currently only `severity`), and
  `key = """..."""` (multi-line bodies, same-line or spanning lines).
- `#` comments and blank lines are ignored.
- `[[edge]]` array-of-tables entries with string `from`/`to`/`kind`.
- Fields: required `id`, `title`, `status`, `kind`, `body`; optional
  `area`, `severity`, `source` (absent means null). Status/Kind/EdgeKind
  enums are exactly SPEC §2.2, exact case.

Rejected loud: `[table]` sections, dotted/quoted keys, non-`[[edge]]`
tables, unknown top-level keys, unknown enum values, missing required
fields, non-string edge keys, unterminated strings.

## 4. Graph semantics (restated from SPEC §3)

- **Ready** = `status == Open` AND no `Blocks` edge `from = B, to = X`
  with `B` neither `Done`/`Dropped` nor missing. A dangling blocker parks
  (conservative). Only `Blocks` parks — `DependsOn`/`Related`/others never do.
- **Ordering**: `Blocks{from,to}` means `from` precedes `to`;
  `DependsOn{from,to}` means `to` precedes `from` (JIRA sense). All other
  kinds are informational and are never followed by graph walks.
- **Graph from root**: the transitive dependents through the two ordering
  kinds, including the root itself; edge ends naming unloaded ids are
  skipped, never credited.

## 5. JSON read API

Three reads over files alone. JSON goes to stdout; diagnostics to stderr;
machine consumers parse stdout. Exit 0 on success (even when `ready` is
empty — empty means "nothing to do" *or* "everything parked"; run the
equivalent of `check` to tell them apart). Exit 1 with an `INTEROP ...`
stderr line on version refusal, missing hub, unknown graph root, or any
parse rejection of the version gate path. Per-file parse failures that do
not trip the version gate are reported inside the envelope (`unparseable`)
and excluded from the issue set — a non-empty `unparseable` is a gap in
the data, never zero issues.

- `list --hub <root>`: `{ interop_version, project, issues:
  [{ issue: {<§3 fields>}, edges: [{from,to,kind}] }], unparseable: [...] }`
  (issues sorted by id).
- `ready --hub <root>`: same envelope with `ready` in place of `issues`
  (§4 readiness, sorted by id).
- `graph --hub <root> --from <id>`: `{ interop_version, project, from,
  nodes: [<sorted ids>], unparseable: [...] }` (§4 transitive closure).

Reference reader (scripts lane): `bais/scripts/interop.mjs` implements all
three with zero dependencies and never imports `baml_sdk`. Future
`bais interop ...` CLI wiring maps 1:1 onto it (see that file's SRC-LANE
WIRING header) but is not required for interop — the files are the API.

## 6. Conformance

Directory `bais/scripts/fixtures/interop/`:

```text
hub/.bais/{config.toml, issues/iw#01..07.toml}  # the graph (§4 cases:
                                                # Done-freed, live-parked,
                                                # DependsOn-ready, non-Open,
                                                # Related-ignored, dangling-blocker)
v2hub/.bais/{config.toml, issues/iw#01.toml}    # schema bump: version 2 + v2-only key
expected.json                                   # ready + graph_from answers
conformance.py                                  # Python-stdlib-only client (hub#154 acceptance)
```

Self-test (both acceptance clauses, either entry point — they cross-check):

```bash
python3 bais/scripts/fixtures/interop/conformance.py --conform \
  --hub bais/scripts/fixtures/interop/hub \
  --expected bais/scripts/fixtures/interop/expected.json \
  --v2hub bais/scripts/fixtures/interop/v2hub
node bais/scripts/interop.mjs --selftest   # asserts the JS reader + shells out to the above
```

Clause 1: the client lists ready (`iw#02, iw#04, iw#05`) and renders the
transitive graphs (`iw#01 → iw#01,02,05`; `iw#04 → iw#03,04`) from the files
alone — `conformance.py` uses only the stdlib (it ships its own §3
micro-parser because the stdlib has no TOML parser before Python 3.11) and
`interop.mjs` uses only `node:fs`/`node:path`. Clause 2: the v2 hub fails
the v1 reader loud (`INTEROP VERSION 2 UNSUPPORTED`), asserted for both
readers. A conformance run that cannot go red is camouflage (bi#57): the
`iw#07` dangling-blocker anchor exists so that dropping the conservative
missing-blocker arm leaks `iw#07` into ready and trips the gate — verified
by the red-check recorded in `interop.mjs`.
