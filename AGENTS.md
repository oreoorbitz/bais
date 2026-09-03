# AGENTS.md — bais

> Read `../AGENTS.md` first — this file is the `bais` specialization.

## What this is

*Basically A made-up Issue Standard* — graph-native, directory-local, git-hosted, `rg`-indexed. Ingredients: GitHub Issues + TOML frontmatter + git + JIRA link types + `rg`; recipe (file-per-issue + graph) is new.

* BAML owns the schema: `baml_src/main.baml` `Issue{Status,Kind,area,severity,source}+Edge{Blocks…}+IssueExtension` + `ns_toml/toml.baml` strict TOML v1.0.0 parser (`toml.md/abnf` vendor).
* Host owns validation: `src/toml.ts` re-exports BAML validator, `src/cli.ts` `bais list/ready/check`.

## Toolchain

Pinned `0.17.0` (wrapper `0.2.4`, bridge `0.17.0` — SDK and bridge versions must
match or every file reports `bad` with a version-skew error).

```
baml check --project bais    # 5 files Finished (main, tools, ns_toml, ns_event/envelope+rel)
baml test --project bais     # 66 passed
baml generate --project bais # 70 files
```

## Project wiring

* No `[dependencies]` — `bais` is the leaf. `bi`/`bagl` depend on it via `bais = { path = "../bais" }`.
* `0.17.0` compat: `IssueExtension::validate throws never`, `${ctx.output_format}` (no call parens — the `()` form is 0.18+).
* Public contract for other tooling: `SPEC.md` + `schema/*.json` (conformance levels L1 reader / L2 graph+CLI / L3 event log).
* Proposal to BAML team deferred until `bi`+`bais` have been dogfooded on a real project.

