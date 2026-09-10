# BAIS on TOML — BAIS_TOML

BAIS `.bais` files are **TOML v1.0.0** verbatim. No syntax fork.

Source of truth: [`toml.md`](./toml.md) + [`toml.abnf`](./toml.abnf) vendored from [`toml-lang/toml@master`](https://github.com/toml-lang/toml) (2026-08-30). Pin that commit; `bais/toml/toml.md` is the spec.

## Why no fork

LLMs are trained on TOML v1.0.0. Keeping `.bais/issues/<id>.toml` as strict TOML means:
- any off-the-shelf TOML parser parses BAIS,
- LLM can emit BAIS without learning a new grammar — prompt says “TOML v1.0.0 + BAIS conventions” and points to this file,
- we can evolve BAIS without breaking training-data priors.

## What BAIS adds (semantics only, not grammar)

All of these are *legal TOML* — they just constrain *which* TOML you write:

| TOML construct | BAIS convention |
|---|---|
| top-level `key = value` | `id`, `title`, `status`, `kind`, `body` required; `area`, `severity`, `source`, `holder`, `lease` optional. Values are TOML `string | integer | boolean` (BAIS uses `string`/`int`). `status`/`kind` map to BAML `enum Status`/`Kind`. `holder` (owner id) + `lease` (strict RFC3339 UTC `YYYY-MM-DDTHH:MM:SSZ`) form the file-envelope claim — see Claim protocol below. |
| multiline strings | `body` is `"""` or `'''` multiline basic/literal string (Markdown). |
| array of tables `[[edge]]` | zero or more `[[edge]]` tables, each `{ from: string, to: string, kind: EdgeKind }`. Graph edges for the directory-local DAG. |
| `[table]` | reserved for future per-project config (`[bais]` in `config.toml`), not used in issue files. `bais check` rejects unknown top-level tables in issue files. |
| comments `# ...` | allowed everywhere TOML allows; ignored by parser. |
| file layout | one issue = one file `.bais/issues/<id>.toml`, `id` matches filename stem (`bi#09` → `bi#09.toml`). `git` is the hosting; `rg` is the index. |

No new delimiters, no new value types, no alternative quoting.

## What BAIS does NOT change

- Keys: `unquoted-key` = `ALPHA / DIGIT / "-" / "_"` (so `id`, `title`, `status`, etc. are bare keys). Dotted/quoted keys remain valid TOML but BAIS issues should not use them — `bais check` warns.
- Strings: all four TOML string forms work (basic, literal, multiline-basic, multiline-literal). Escapes are TOML escapes (`\n`, `\t`, `\uHHHH`, etc.).
- Integers/floats/booleans/dates/arrays/inline-tables: per TOML — BAIS just doesn’t use most of them in issue files yet.
- Whitespace/comments/newlines: per TOML `ws`/`comment`/`newline`.

## Parser contract

- **BAML source of truth:** `baml_src/ns_toml/toml.baml` — line-oriented parser over `string` stdlib (`lines()`, `trim()`, `split()`, `slice()`, `starts_with()`, etc.). Parses the subset above and returns typed `root.Issue` / `root.Edge` (from `baml_src/main.baml`). `baml check` + `baml test` prove it.
- **TS interop:** `baml generate` → `baml_sdk`; `src/toml.ts` re-exports BAML parser for `bais` CLI (`bais check`, `bais list --json`, `bais graph`). For speed, CLI may also use a JS TOML lib (`smol-toml`) but must round-trip through BAML types — BAML is the validator.
- **LLM interop:** `CreateIssue(raw: string) -> Issue` in `main.baml` uses `${ctx.output_format}` — return type *is* the schema, not prose.

## Claim protocol (lease-bound Doing)

`Doing` without a live claim is stale — a dead agent's claim must never park an issue. Claims live on the file envelope (`holder` + `lease`), not in `Issue`:

- **Claim:** `bais move <id> Doing --as <owner> [--for 4h]` (default TTL 4h, `--for <n>s|m|h|d`). Bare `move <id> Doing` stays allowed (bi#49 contract) but claims anonymously — no lease, instantly stale, reaped on sight. Pass `--as` for a live claim.
- **Heartbeat:** `bais renew <id> --as <owner> [--for 4h]` extends. Only the recorded holder can renew (strangers are refused with the holder named).
- **Reclaim:** `bais reap [--now <instant>]` flips every `Doing` with an expired (or missing/unparseable) lease back to `Open`, clearing the claim. Pure function of (files, now); `--now` injects the instant for deterministic tests.
- **Surface:** `bais list --claims` appends holder/lease columns; `bais check` reports `stale-claim` lines (advisory, never fatal — reap is the fix).
- Moving out of `Doing` clears the claim. `ready` never hands out `Doing` either way.

Agent rule: claim with a stable owner id before starting, renew (heartbeat) while working, release by moving on completion. If you die, your lease expires and anyone may reap.

## File footprints + swarm dispatch (bi#123)

Parallel agents share one checkout, so the dispatcher must know what files an
issue will touch. Declare them in `body` markdown, one `Files:` line per
group (same line convention as `Evidence:` in bi#83):

```
Files: bais/src/graph.ts bais/src/cli.ts
Files: bais/baml_src/main.baml  # second group, unions with the first
```

Paths are relative to the project root, space-separated, `#` comments
stripped. A `Files:` prefix means declared — even `Files:` empty (touches no
files is a real claim). No prefix means `unknown`: the issue still packs, but
the operator must confirm the footprint by hand. A path may carry an LOD
level pointer (`path#L0`, `#L1`, `#L2`, either case, hub#236) — narrower-or-equal
to its file: same-file different-level claims never clash, unknown levels warn
and fall back to whole-file. Other `#` suffixes remain comments.

`bais dispatch --agents N [--json]` dry-runs the pack: ready + unclaimed
issues, greedy by open blast radius, skipping live claims and file
clashes with already-packed slots. Text rows read
`slot0<TAB><id><TAB>br=N<TAB>files: a.ts,b.ts|<unknown><TAB><title>`.
Dispatch never mutates — agents claim for themselves, so proxy claims cannot
break the lease model. Reference: BAML `dispatch_pack` (`baml test`), mirrored
by both hosts; `bais/scripts/dispatch.mjs` proves the CLI end to end.

## Evolving BAIS without deviating from training data

When you need a new field or kind, extend BAML (`Kind.NewKind`, `Issue.new_field?: type`) and document it here as an *additive* convention:

> “BAIS_TOML = TOML v1.0.0 + `new_field: string?` on issue + `Kind.NewKind`.”

LLM prompt becomes: “Emit TOML v1.0.0 matching this BAML Issue shape: …” — no grammar change, so prior TOML training still applies.

## For LLMs

If you are an LLM writing a `.bais` file: write valid TOML v1.0.0 per `toml.md`, use only the keys above, put Markdown in `body = """..."""`, edges in `[[edge]]`. Validate with `baml check --project bais`.
