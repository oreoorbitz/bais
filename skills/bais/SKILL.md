---
name: bais
description: Read and navigate BAIS issue boards, inspect readiness and dependencies, and coordinate work through the BAIS CLI from any shell-capable coding agent. Use for .bais boards; does not require BI.
---

# BAIS from an outside agent

Use this skill's `scripts/bais-json.mjs` for reads. It accepts one JSON object on stdin and emits one JSON envelope on stdout. Run the helper by its absolute path so the agent's cwd can be any project. When the skill is copied away from its checkout, set `BAIS_HOME` to the BAIS checkout (the directory containing `package.json`), not the board directory.

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

## Changes and claims

The JSON helper is deliberately read-only. For an authorized mutation, run the existing BAIS CLI from the explicit hub directory using an absolute executable path:

```sh
cd /absolute/path/to/project
BAML_PROFILE=0 node /absolute/path/to/bais/dist/src/cli.js move 'project#12' Doing --as 'agent-session-id' --for 30m --json
BAML_PROFILE=0 node /absolute/path/to/bais/dist/src/cli.js renew 'project#12' --as 'agent-session-id' --for 30m
```

Choose a stable owner ID, respect existing live holders, and renew before expiry. Follow the board's Files/scope and close-evidence rules. Do not automatically pass `--scope-confirmed` to bypass a refusal. Before moving to Done, run the issue's acceptance gates and preserve evidence. After direct file changes, run the CLI's `ingest` and relevant board checks so the projection is current.

Consult the installed CLI's help and implementation for other mutations. This package does not add a create/edit API; do not assume `bais new` works solely because an old help example mentions it. If editing TOML is part of the authorized task, use the checkout's `toml/BAIS.md` and BAML validator; preserve claims, edges and body escaping. No BI fallback is required or implied.

For a file-only reader without the BAIS runtime, see the checkout's `spec/interop.md` and `scripts/interop.mjs`. That older reader supports a restricted format and may reject current literal bodies or claim fields; it is not a silent fallback for this helper.
