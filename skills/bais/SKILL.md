---
name: bais
description: Read and navigate BAIS issue boards, inspect readiness and dependencies, and coordinate work through the BAIS CLI from any shell-capable coding agent. Use for .bais boards; does not require BI.
---

# BAIS from an outside agent

Use native `bais` commands for ordinary issue work. Use this skill's `scripts/bais-json.mjs` when a JSON stdin/stdout read adapter is useful. It accepts one JSON object on stdin and emits one JSON envelope on stdout. Run the helper by its absolute path so the agent's cwd can be any project. When the skill is copied away from its checkout, set `BAIS_HOME` to the BAIS checkout (the directory containing `package.json`), not the board directory.

Prerequisites: Node with `node:sqlite`, a built BAIS host/SDK and matching bridge. This helper needs BAIS's runtime but does not require BI or model credentials. Set `BAML_PROFILE=0` in the launcher before initializing the runtime. If the build is missing, use BAIS's documented generate/build steps; do not install or rebuild unrelated tools.

## Read the board

`hub` is the directory containing the target `.bais/config.toml` and `.bais/issues/`. Always name it explicitly; the helper refuses a missing board instead of falling back to a parent. Example stdin:

```json
{"action":"ready","hub":"/absolute/path/to/project"}
```

Actions:

| Action | Additional input | Result |
|---|---|---|
| `list` | none | CLI issue listing with completeness diagnostics |
| `ready` | none | Current CLI readiness rules, including policy exclusions |
| `show` | `id` | Full file record, body, edges, holder and lease |
| `graph` | `id` | CLI dependency graph from that issue |
| `check` | none | Board validation report, including failed checks |
| `dispatch` | positive integer `agents` | Dry-run work pack; does not start workers |

Use shell stdin redirection or a properly quoted heredoc. In code, spawn Node with an argument array and write `JSON.stringify(request)` to stdin; never interpolate issue text into a shell command.

Every response has `ok`; successful responses include `data`. Failures exit 1 and carry a named `error`. CLI responses retain `exit_code` and stderr as `diagnostics`. **Parse stdout even on nonzero exit**: a failed `check` still returns its report. An `unparseable` list makes `ok:false`, with partial data retained. Never interpret that as an empty board. Preserve `as_of`/`completeness` when present. `show` reads files directly; list/ready/graph can use the CLI's projection. A stale-store diagnostic requires reconciliation, not a confident answer from stale results.

Inspect `show` before taking work. Do not implement readiness from issue status alone; Blocks, missing references, cycles, epics and coordination policies can matter. An edge labeled DependsOn does not by itself mean the same thing as a Blocks edge for readiness.

## Native commands and claims

`bais` is the standalone package executable. If it is not linked into PATH, invoke `node /absolute/path/to/bais/dist/src/cli.js` with the same arguments. Use `--hub /absolute/path/to/project` to select an exact board from any cwd. A missing explicit board fails instead of selecting its parent.

```sh
bais ready --hub /path/to/project --json
bais show 'project#12' --hub /path/to/project --json
bais new "Fix parser escaping" --kind Bug --files src/parser.ts --body-file /path/to/repro.md --hub /path/to/project --json
bais edit 'project#12' --append-body "Evidence: drill(parser-fixture)" --as agent-session-id --hub /path/to/project --json
bais move 'project#12' Doing --as agent-session-id --for 30m --hub /path/to/project --json
bais renew 'project#12' --as agent-session-id --for 30m --hub /path/to/project
```

`new` creates Open with a numeric ID allocated from the board project; `--id project#name` selects an explicit ID. Existing and archived IDs are protected. `--files PATH` is repeatable and adds footprint lines to the body. Kinds are case-sensitive (`Bug`, `Feat`, `Proposal`, `Debt`, `Flake`, `Spike`); severity is 1–5.

`edit` supports title, kind, area, severity, source and body updates. `--body`/`--body-file` replaces the body; `--append-body`/`--append-body-file` appends a paragraph. File paths resolve from the invoking cwd, and `--body-file -` reads stdin. Choose one body option. Prefer body files for multiline evidence or shell-sensitive text; agents do not need to generate TOML or write Python to update issues.

`show --json` returns the complete `issue` envelope and `content_hash`. Pass that hash to `edit --expect-hash HASH` when editing from a previously read snapshot. A live claim requires matching `--as`; do not use another agent's identity to take its work. Edits retain status, claims and edges, and serialize through BAML; TOML formatting and comments are normalized. Errors return `ok:false` with a named `error` and exit 1. `show` rejects an incomplete board; the portable helper can expose partial read diagnostics for repair.

Use `move` and `renew` for status and leases. Choose a stable owner ID, inspect claims before taking work, and renew before expiry. Follow the board's Files/scope and close-evidence rules. Do not automatically pass `--scope-confirmed` to bypass a refusal. Run acceptance gates and record evidence before Done.

`new` and `edit` refresh an existing local projection; they do not create one when absent. As with existing `move`, a seed rebuild does not preserve hub/sync-only events. Use the board's coordination workflow for a live synchronized hub. After direct TOML edits, run `ingest` and board checks. A failed refresh after a successful file write reports that the issue was written; reconcile the projection before retrying the mutation. Native writers use exclusive lock files; after a crashed writer, confirm it has stopped before removing its leftover issue lock.

The portable JSON helper stays read-only; mutations use the native CLI. Consult `bais --help` for the other board and coordination commands.

For a file-only reader without the BAIS runtime, see the checkout's `spec/interop.md` and `scripts/interop.mjs`. That older reader supports a restricted format and may reject current literal bodies or claim fields; it is not a silent fallback for this helper.
