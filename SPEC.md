# BAIS Specification v1

**BAIS** (*Basically A made-up Issue Standard*) is a graph-native, directory-local
issue language. One issue is one file; `git` is the hosting; `rg` is the index.

This document is written for **tool implementers, including LLMs**: everything
needed to read, write, and validate BAIS without running the reference
implementation. Normative keywords (MUST/SHOULD/MAY) follow RFC 2119. Where a
rule is enforced by the reference CLI (`bais`), it says so; everything else is
convention a validator SHOULD check.

Companion machine-readable schemas: [`schema/issue.json`](schema/issue.json)
(parsed issue file), [`schema/event.json`](schema/event.json) (event envelope),
[`schema/check-output.json`](schema/check-output.json) (`bais check --json`).

Reference implementation: `baml_src/main.baml` (model + graph rules),
`baml_src/ns_toml/toml.baml` (strict parser), `baml_src/ns_event/` (event log),
`src/cli.ts` + `src/graph.ts` (host mirrors of the BAML rules).

## 1. Layout

```text
.bais/
  config.toml          # project = "<name>"   (single key)
  issues/
    <id>.toml          # one issue per file, e.g. bi#09.toml
```

- `config.toml` contains exactly one meaningful key: `project = "bi"`. It names
  the directory scope used to classify edge references (§5).
- Every `issues/*.toml` file SHOULD be named `<id>.toml` where `id` equals the
  issue's `id` field. This is convention only — the reference parser keys the
  graph by the `id` field, not the filename (a file whose `id` differs from its
  stem still parses).
- There is no database. Listing is a directory scan; history is `git log`.

## 2. Issue file format (BAIS_TOML)

A BAIS issue file is **TOML v1.0.0 verbatim** — no new grammar. Any conforming
TOML parser reads it; BAIS only constrains *which* TOML is valid. (Full
rationale: `toml/BAIS.md`; upstream grammar: `toml/toml.md`.)

### 2.1 Fields

| Key        | Type   | Required | Notes                                             |
|------------|--------|----------|---------------------------------------------------|
| `id`       | string | yes      | e.g. `bi#09`, `bagl#02`. Free-form, SHOULD match filename stem |
| `title`    | string | yes      | one line                                          |
| `status`   | string | yes      | one of §2.2, exact case                           |
| `kind`     | string | yes      | one of §2.2, exact case                           |
| `area`     | string | no       | e.g. `cli/bi`, `bridge/ffi`; absent → null        |
| `severity` | int    | no       | TOML integer, e.g. `3`; absent → null             |
| `source`   | string | no       | error class, e.g. `baml.errors.TypeMismatch`      |
| `body`     | string | yes      | Markdown; usually `"""` multiline                 |

Strictness (all enforced by the reference parser — violations make the file
`bad`, see §6):

- Unknown top-level keys are **rejected** (`unknown top-level key frobnicate`).
  Readers MUST-ignore nothing at top level; writers MUST NOT add keys.
- Missing `id`/`title`/`status`/`kind`/`body` is **rejected** (`missing body`).
- Unknown `status`/`kind`/`edge kind` values are **rejected**
  (`unknown Status Working`, `unknown EdgeKind Zap`). Matching is exact case:
  `open` is not `Open`.
- Dotted/quoted keys SHOULD NOT be used. `[table]` sections are reserved and
  MUST NOT appear in issue files (only `[[edge]]` array-of-tables).

### 2.2 Enumerations

```text
Status:   Open | Doing | Blocked | Done | Dropped
Kind:     Bug | Feat | Proposal | Debt | Flake | Spike
EdgeKind: Blocks | DependsOn | SubtaskOf | DuplicateOf | Related | Fixes | Replaces
```

Only `Blocks` and `DependsOn` carry ordering semantics (§4). The rest are
informational and never affect readiness or cycles.

### 2.3 Edges

Zero or more TOML array-of-tables entries. Each MUST have all three keys:

```toml
[[edge]]
from = "bi#08"
to = "bi#09"
kind = "Blocks"
```

`from`/`to` name issue ids. They MAY name ids outside the loaded directory
(cross-project edges) — §5 classifies them instead of rejecting them.

### 2.4 Minimal example

```toml
id = "bi#09"
title = "Phase 2 session header + trust (bi namespace)"
status = "Done"
kind = "Feat"
area = "cli/bi"
body = """
Port session-manager.ts + project-trust.ts into baml_src/session.baml.

Acceptance: baml check green, baml test one-test→one-impl.
"""

[[edge]]
from = "bi#08"
to = "bi#09"
kind = "Blocks"
```

### 2.5 If you are an LLM writing a `.bais` file

Write valid TOML v1.0.0, use only the keys in §2.1, put Markdown in
`body = """..."""`, edges in `[[edge]]`, exact-case enum values. Do not invent
keys — the parser rejects them. Then validate: `bais check`.

## 3. Graph semantics

All rules are pure functions of `(issues, edges)`; the reference proves them in
`baml test` on literal data.

### 3.1 Readiness

`ready` = issues with `status == Open` that are **not blocked**. An issue `X`
is blocked if any `Blocks` edge `from = B, to = X` exists where `B` is not
`Done`/`Dropped` — **including when `B` cannot be found**. An unresolvable
blocker is conservative: the issue parks rather than shipping on an unproven
assumption. (A typo'd blocker id therefore parks the issue; `bais check`
makes it loud via §5.)

Only `Blocks` affects readiness. A dangling `Related`/`DependsOn` edge never
parks an issue.

### 3.2 Ordering (cycles)

Both directional kinds normalize to one "must precede" relation:

| Edge | Meaning |
|------|---------|
| `Blocks{from, to}` | `from` must close before `to` |
| `DependsOn{from, to}` | `to` must close before `from` (JIRA sense: A depends on B) |

A dependency cycle (or anything downstream of one) can never become ready, and
`ready` reports it only as silence. `check` reports cycle members explicitly
(§6) — that list is the diagnosis for an unexpectedly empty `ready`.

### 3.3 Dangling references

An edge end naming an id outside the loaded set is classified, never rejected:

| Status | Meaning | Verdict |
|--------|---------|---------|
| `Resolved` | id is loaded | not reported |
| `Missing` | id's scope is this project (or unscoped, e.g. `typo-no-hash`) but no such issue exists | **defect** — typo, deleted file, never created |
| `External` | id's scope is another project (`bagl#02` seen from `bi`) | legitimate, reported for visibility |

Scope = text before `#` (`bi#04` → `bi`); an id with no `#` is local scope.
`check` fails on `Missing`, never on `External`.

## 4. CLI contract

`bais list | ready | check [--json]` plus `bais ingest` and `bais graph`.
JSON output goes to stdout; diagnostics to stderr. Machine consumers MUST pass
`--json` and parse stdout.

Reads prefer the SQLite projection (`.bais/store.db`, built by `bais ingest`
from the TOML seed through the BAML reducer) and fall back to the directory
scan when absent. Store-backed `list`/`ready`/`graph` add `as_of: {heads, lc,
wall_ts}` and `completeness: "complete"|"partial"` so `empty` is
distinguishable from `not-synced`; `check` keeps the §4.3 shape exactly.
`store.db` is a rebuildable artifact — never commit it.

### 4.1 `bais list --json`

```json
{ "issues": [ { "issue": {<§2.1 + nulls>}, "edges": [{ "from": "…", "to": "…", "kind": "Blocks" }] } ],
  "unparseable": [ { "file": "bad.toml", "error": "<message>" } ] }
```

`unparseable` files are excluded from `issues` — treat non-empty as a gap in
the list, never as zero issues. (`error` strings contain VM traces; match on
`file`, not message text.)

### 4.2 `bais ready --json`

```json
{ "ready": [ <same BaisFile shape as list> ], "unparseable": [ … ] }
```

Store-backed reads append `"as_of": {"heads": […], "lc": 10, "wall_ts": "…"}`
and `"completeness": "complete"|"partial"`. `bais graph --from <id> --json`
returns `{from, nodes: […], as_of, completeness}` (recursive CTE; BFS fallback
without a store).

`ready` applies §3.1. Empty `ready` is ambiguous by design — it means *either*
"nothing to do" *or* "everything parked/cyclic/unsynced". Disambiguate with
`check` (§4.3): cycles and Missing blockers explain silence. Exit code is 0
even when empty.

### 4.3 `bais check --json`

```json
{ "ok": 10,
  "bad": [ { "file": "….toml", "error": "<message>" } ],
  "dangling": [ { "declaredBy": "sp#a", "from": "sp#missing", "to": "sp#a",
                   "kind": "Blocks", "id": "sp#missing", "side": "from",
                   "status": "Missing" } ],
  "cycles": ["sp#a", "sp#b"] }
```

- `ok` = count of parseable files. `bad` = per-file rejections (§2 strictness).
- `dangling` = every edge end that is not `Resolved` (§3.3).
- `cycles` = ids in or downstream of a dependency cycle (§3.2).
- Exit code is 1 if `bad` is non-empty OR any `Missing` exists OR `cycles` is
  non-empty; `External` alone never fails. Human (non-JSON) output uses
  `ok|bad|dangling|external|cycle` tab-separated lines.

### 4.4 Errors

No `.bais` directory → stderr `No .bais — run bais init`, exit 1.
`bais init` creates `.bais/issues/` + `config.toml`. (`new`/`move`/`graph`
subcommands are reserved, not yet implemented.)

## 5. Event log (source of truth)

TOML files are the human projection. The machine source of truth is an
append-only log of signed per-actor events; state = deterministic reduction of
events. Hosts sign `ed25519(canonical-CBOR(project + prev + refs + body))`
under `did:key`; BAML owns the shape, never the crypto.

### 5.1 Envelope

| Field     | Type    | Notes |
|-----------|---------|-------|
| `id`      | string  | version identity: `bafy…` content hash, assigned post-signing |
| `author`  | string  | `did:key:…` writer; one chain per author = per-writer total order |
| `seq`     | int     | author's sequence; `seq == 0` iff `prev` is null (genesis rule) |
| `prev`    | string? | author's previous event id; fork detection |
| `project` | string  | replication boundary, e.g. `bi` |
| `entity`  | string  | logical identity: stable `task:01J…` (or `rel:01J…`), never a hash |
| `refs`    | string[]| entity DAG heads seen; causal history for merge |
| `lc`      | int     | Lamport clock — tiebreak only, never truth |
| `ts`      | string  | advisory wall-clock (RFC3339); reducers ignore it |
| `type`    | string  | variant name, e.g. `LeaseClaim` (plain string at the FFI boundary — hosts MUST send the name, not an encoded enum) |
| `body`    | object  | per-type payload; readers MUST-ignore-unknown-fields |
| `cost`    | object? | `{tokens: int, usd: float}` |
| `cap`     | object? | `{event: "bafy…"}` — the `cap.grant` proving authorization |
| `sig`     | string? | ed25519 multibase signature; null only pre-signing |

Identity is two-layer: `entity` is stable across edits (Jujutsu change-ID
model); `id` changes per event. Human ids (`bi#09`) are indexer aliases.

### 5.2 Event types (wire names `bais.<dotted>@1`)

| Variant | Wire | Variant | Wire |
|---------|------|---------|------|
| `ProjectCreate` | `bais.project.create@1` | `LeaseClaim` | `bais.lease.claim@1` |
| `ProjectPolicy` | `bais.project.policy@1` | `LeaseRenew` | `bais.lease.renew@1` |
| `SchemaRegister` | `bais.schema.register@1` | `LeaseRelease` | `bais.lease.release@1` |
| `TaskCreate` | `bais.task.create@1` | `WorkSubmit` | `bais.work.submit@1` |
| `TaskSet` | `bais.task.set@1` | `VerifyRecord` | `bais.verify.record@1` |
| `TaskTransition` | `bais.task.transition@1` | `WorkAccept` | `bais.work.accept@1` |
| `LabelAdd` | `bais.label.add@1` | `WorkReject` | `bais.work.reject@1` |
| `LabelRemove` | `bais.label.remove@1` | `BudgetAuthorize` | `bais.budget.authorize@1` |
| `RelAdd` | `bais.rel.add@1` | `CostReserve` | `bais.cost.reserve@1` |
| `RelRetract` | `bais.rel.retract@1` | `CostIncurred` | `bais.cost.incurred@1` |
| `CommentPost` | `bais.comment.post@1` | `ReceiptAttach` | `bais.receipt.attach@1` |
| `KeyRotate` | `bais.key.rotate@1` | `CapGrant` | `bais.cap.grant@1` |
| `CheckpointPublish` | `bais.checkpoint.publish@1` | `CapRevoke` | `bais.cap.revoke@1` |
| `Heartbeat` | `bais.heartbeat@1` | `Progress` | `bais.progress@1` |

Unknown wire names MUST be preserved as evidence and excluded from derived
state; `body` fields not in the receiver's schema version MUST be ignored
(forward compat). `schema.register{lexicon, version}` events carry the
in-band registry; split wire names at `@` for dispatch.

### 5.3 Channel + coordination rules

- **Ephemeral:** `Heartbeat`/`Progress` MUST NEVER enter the durable DAG —
  route to memory/pubsub only.
- **Coordination:** only `LeaseClaim` requires a central coordinator (exclusive
  work claims are impossible merge-only). All other types merge without
  coordination. Lease fencing: `epoch`/`ttl`/`read_set` accompany side effects
  so zombies are rejected.
- **Done is split:** `WorkSubmit{evidence} → VerifyRecord{verdict} →
  WorkAccept`; producer MUST NOT be sole verifier.

### 5.4 Reified edges

A dependency is an entity: `{id: "rel:01J…", source: "task:…", type:
"Blocks"|…, target: "task:…", author: "did:key:…", reason?: string, retracted:
bool}`. Retraction is a fact, not a deletion. Concurrent add + retract of
different edges MUST NOT clobber each other.

## 6. Conformance levels

- **L1 reader:** parse §2 strictly (reject unknown keys/values/missing fields),
  expose `{issue, edges}` per §4.1.
- **L2 graph + CLI:** implement §3 exactly (dangling-blocks-blocks,
  Missing-vs-External, cycle detection over Blocks/DependsOn) and emit the §4
  JSON shapes with the §4.3 exit-code rule.
- **L3 event log:** append/verify §5 events, enforce genesis/sequence,
  ephemeral split, and coordinator routing.

## 7. Evolution

`BAIS_TOML = TOML v1.0.0 + <additive delta>`. New fields/kinds are additive
conventions documented here (`Kind.NewKind`, `Issue.new_field?: type`); the
grammar never forks, so existing TOML training data keeps applying. The event
log versions via wire `@<n>` suffixes and `schema.register`, never renames.
