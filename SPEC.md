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

`bais list | ready | check [--json]` plus `bais ingest` and `bais graph`,
`bais hub | keygen | checkpoint | snapshot | sync`,
`bais oversight | sample | caps [--json]`, `bais grant | revoke --hub`,
`bais mcp`. JSON output goes to stdout; diagnostics to stderr. Machine
consumers MUST pass `--json` and parse stdout.

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

`bais ready --why-not [--json]` accounts for every omission: each
Open-but-unready issue carries at least one reason naming the exact
edge/lease/cycle, and no listed-ready issue carries one. Reasons are shaped
by BAML `why_not` (`WhyNotKind` =
`BlockedBy` (blocker id + status + edge) | `DanglingRef` (end + `Missing` /
`External` + edge) | `InCycle` (cycle members) | `Leased` (holder +
`expires_lc`)); the host renders text + `--json` from `baml_sdk` types, so
`why_not` JSON round-trips through them unchanged. Non-Open issues carry no
reason (their status is the explanation); an all-Done backlog reports empty
with no reasons — finished, not jammed. The scan path (no store) reasons over
the graph alone; the store path adds lease reasons. Without the flag, `ready`
output is byte-identical to before. Exit code is 0 even with reasons.

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
`bais init` creates `.bais/issues/` + `config.toml`. (`new`/`move`
subcommands are reserved, not yet implemented.)

### 4.5 Capabilities, oversight, MCP

- `bais grant <audience> --can a,b --scope S --expiry-lc N [--budget-usd
  X --budget-tokens Y --issuer DID] --hub URL` issues a `CapGrant`
  through the live hub (single writer, correct chains). The issuer
  defaults to the hub key; anyone else needs `cap.admin` over the scope
  when the hub runs with `requireCaps` (off by default — trusted-local
  coordinator). Strict deployments issue signed grants via `POST /sync`.
- `bais revoke <grant-id> --revoker DID --hub URL` is the kill switch:
  revocation is fail-open by design (no cap check); BAML admits only
  issuer- or audience-authored revokes, strangers get `revoke-denied`,
  re-revoke is an idempotent no-op. Revocation is sticky per grant id —
  only a NEW grant event re-enables.
- `bais caps [--audience DID] [--json]` reads the capability projection
  (live + revoked). `GET /caps[?audience=]` on the hub serves the
  causal-position-correct head view.
- `bais oversight [--json]` prints the exception feeds: `conflicts`,
  `budget_overruns` (spend past cap), `unverified_submits` (submitted
  with no accept verdict), `stalled_leases` (active past `expires_lc`),
  `caps_over_budget` (audience spend past the grant's `budget_cap_usd`).
  `GET /oversight` serves the same shape.
- `bais sample <n> [--seed S] [--json]` returns a deterministic (FNV-1a
  over seed+entity) sample of `Done` work for human review.
  Reproducible beats random for audits.
- Approval rule: a task carrying the `needs-human` label cannot
  transition to `Dropped` (`needs-approval` exclusion). Removing the
  label IS the approval — the `LabelRemove` event is the audit trail.
- `bais mcp` serves the MCP tool surface over stdio (Content-Length
  framed JSON-RPC 2.0): `initialize`, `tools/list`, `tools/call` for
  `bais_list|ready|graph|check|oversight|sample`. Tool specs
  (name/description/input_schema) come from BAML `mcp_tools()`; the host
  executes against the projection. Stdout is protocol bytes only.

### 4.6 Hub, keys, checkpoints, sync

- `bais keygen [--force]` creates `.bais/key.json` (ed25519 peer
  identity, mode 600, `did:key` form). The hub and local CLI sign as the
  same peer. Without `--force` an existing key is kept and printed.
- `bais hub [--port N]` serves the coordinator + relay until SIGINT:
  `POST /claim|/renew|/release` (409 on contention, 402 when the author's
  budget is exhausted, 413 over bounds), `GET /leases`,
  `POST /checkpoint`, `GET /checkpoint`
  (`{checkpoint, verified, history: "complete"|"pruned", anchor}`),
  `GET /snapshot`, `GET|POST /sync`, `GET /sync/digest`,
  `POST /pub` + `GET /pub` + `GET /pub/stream` (ephemeral only),
  `POST /prune` (truncate below a checkpoint — see §4.1),
  `POST /grant` (issues a `CapGrant` as the hub key; 403 when the
  issuer lacks `cap.admin` under `requireCaps`), `POST /revoke`
  (fail-open kill switch — see §4.5), `GET /caps[?audience=]`,
  `GET /oversight` (exception feeds — see §4.5).
- `bais checkpoint` publishes a signed `{state_root, heads[],
  reducer_version}` over the current log. `GET /checkpoint` recomputes
  the root live — `verified: false` with `history: "complete"` is a
  divergence alarm; with `history: "pruned"` it means the covered log
  was truncated by operator action (last full proof in
  `anchor.verified_at`), not divergence.
- `bais snapshot [--out <file>]` exports `{checkpoint, tables/*, as_of,
  completeness}` for fast bootstrap (requires a published checkpoint).
  The hub's `GET /snapshot` additionally attaches `anchor_state` (the
  stored anchor reduction) + `cursors` so peers bootstrapping from a
  pruned hub can anchor themselves.
- `bais sync --from <url>`: snapshot import (instant reads) → backfill
  the covered log → recompute `state_root` locally → pull the delta →
  unlock writes only on a root match. A mismatch keeps tables readable
  but writes blocked (exit 1). From a pruned peer the backfill is
  unavailable: the CLI falls back to signature trust (the surviving
  `CheckpointPublish` event is signature-checked on ingest), records
  `trust: "signature"` in bootstrap meta, and anchors tables/floors from
  the snapshot's `anchor_state` + `cursors`. `trust: "recomputed"` is the
  full-verify path. Pruned peers running pre-anchor-state hubs are
  refused — upgrade the peer, not the trust.

### 4.1 Prune (truncation-with-anchor)

The reducer is whole-log, so prune is truncation, not compaction:
`POST /prune [{checkpoint}]` verifies the (latest) checkpoint by full
recompute over the covered rows — refusing with 400 on divergence, on an
unknown id, or when asked to anchor on a stale (non-latest) checkpoint —
captures per-author chain floors, deletes event rows at or below the
coverage `lc`, and records `{prune_anchor, author_cursors,
anchor_reduction}` in meta. The `CheckpointPublish` event itself sits at
coverage `lc + 1`, so it survives as the in-log trust root. Refused with
503 while a snapshot bootstrap is still pending.

Consequences, all fail-closed:

- Reads keep serving from the materialized tables, which refresh merges
  (anchor + surviving rows) instead of rebuilding. Budget `incurred`
  sums across the truncation (deleted sets are disjoint, so no
  double-count); anchor leases past expiry are marked expired at merge.
- Writes and delta sync continue from the floors (`lc` never goes
  backwards; `seq`/`prev` continue per author). Delta ingest additionally
  accepts floor-head replays (surviving rows the floors were captured
  from) and anchor-linked first events (prev in checkpoint heads).
- A claim that the truncated log admits but a surviving anchor lease
  still covers is rejected `409 lease-active-at-anchor` — prune idle
  hubs, or holders re-claim after anchor leases expire. Renew/release of
  pre-prune leases is likewise closed (unknown in the truncated view).
- Budget overspend past pruned `incurred` totals can slip the sync-path
  gate (bounded by one cap per prune cycle): anti-spam degrades
  gracefully, fencing does not.
- `bais ingest` wipes prune floors and bootstrap locks with the rows
  they reference (reseed orphans them).
- `bais ingest` rebuilds from the TOML seed and DROPS hub/sync-appended
  events: back up `store.db` (or export a snapshot) before re-ingesting
  a live hub.

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
  route to memory/pubsub only (`POST /pub`, `GET /pub`, live `GET
  /pub/stream`; no replay, no history).
- **Coordination:** only `LeaseClaim` requires a central coordinator (exclusive
  work claims are impossible merge-only). All other types merge without
  coordination. Lease fencing: `epoch`/`ttl`/`read_set` accompany side effects
  so zombies are rejected.
- **Done is split:** `WorkSubmit{evidence} → VerifyRecord{verdict} →
  WorkAccept`; producer MUST NOT be sole verifier.
- **Signing:** hosts sign `ed25519(canonical(project + prev + refs + type +
  entity + body))` under `did:key` (`type` + `entity` included — without
  them a signed body replays across tasks and types). Canonical form is
  sorted-keys compact JSON (JCS-lite; full RFC 8785 number normalization
  deferred — cross-impl float canonicalization may differ). `sig` is null
  only pre-signing: coordinator-built events are unsigned by design
  (trusted-local hub); peer replication verifies sigs when present and
  always enforces seq/prev continuity. Hubs started with `requireSigs`
  reject unsigned peer events outright.
- **Lists cross the bridge JSON-encoded:** hosts MUST send list-typed
  body fields (`read_set`, `evidence`, `verify_refs`, `heads`) as JSON
  text — raw arrays do not survive the TS→BAML boundary (toolchain gap).
  The reducer parses them back and accepts native arrays from BAML-side
  callers. Whole-number amounts (`10`, not `10.0`) narrow to `float`.
  Encode BEFORE signing: signatures cover the wire form, and the hub
  normalizes arrays on store — a sig over raw arrays breaks for every
  downstream verifier (ingress rejects it as `unencoded-lists`).
- **Bounds (hub-enforced, pre-admission):** body ≤ 256 KiB, `refs[]` ≤ 64,
  sync batches ≤ 500 events (413 past any bound); authors with exhausted
  budgets get 402 on new state writes (renew/release stay open as
  wind-down). Bounds never enter the log — they reject before reduction.

### 5.5 Sync protocol (want/have, per-actor logs)

- `GET /sync?author=<did>&since_seq=<n>` follows one actor's log;
  `GET /sync?since_lc=<n>` catches up whole-workspace; `have=<id,…>`
  subtracts what the requester holds. Every response carries
  `cursors: [{author, seq, id}]` (each actor's head) and `lc`.
- `GET /sync/digest` returns `{count, digest, head_lc}` over the sorted
  id set — compare fingerprints before fetching (Negentropy shape, no
  DHT; the reconcile loop itself is future work).
- `POST /sync {events}` appends through chain + signature + bounds
  checks. Invalid events persist as evidence (`admitted=0` +
  `drop_reason`), never silently: `chain-break`, `prev-mismatch`,
  `genesis-prev`, `bad-sig`, `sig-required`, `over-size`, `over-fanout`.
  Known ids are idempotent skips. Malformed shapes are dropped with a
  reason (they cannot be represented).
- Chain rule (envelope genesis): new authors start at `seq 0`/`prev
  null`; every later event links its author's last id. Forks and gaps
  break here, before the reducer ever sees them.
- `state_root` = sha256 over the canonical materialization
  `{issues, rels, leases, submissions, verifications, budgets, costs,
  conflicts}` — one function computes it for publish and verify, so the
  two cannot drift. Row-deletion prune is truncation-with-anchor (§4.1):
  projections merge anchor + surviving rows because the covered log can
  no longer re-derive them.

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
- **L4 sync:** implement §5.5 (§4.5 CLI) — want/have catch-up, digest
  compare, evidence-preserving ingest, checkpoint publish/verify, and
  snapshot bootstrap with backfill-verified writes.

## 7. Evolution

`BAIS_TOML = TOML v1.0.0 + <additive delta>`. New fields/kinds are additive
conventions documented here (`Kind.NewKind`, `Issue.new_field?: type`); the
grammar never forks, so existing TOML training data keeps applying. The event
log versions via wire `@<n>` suffixes and `schema.register`, never renames.
