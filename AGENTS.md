# AGENTS.md — bais

> Read `../AGENTS.md` first. BAIS is Basically A made-up Issue Standard: graph-native, directory-local work and coordination data.

## Ownership and entry points

* `skills/bais/SKILL.md` and its `scripts/bais-json.mjs` form the portable outside-agent package: explicit hub, read-only JSON adapter over the built BAIS host, no BI dependency. Keep diagnostics and partial results visible. Validate with `node scripts/portable-skill-fixture.mjs`; source stays in this repository, copied installs locate it through `BAIS_HOME`.
* `src/issue_commands.ts` implements native `new/show/edit`; `src/cli.ts` supplies explicit `--hub` routing. Use these commands for issue authoring instead of generating TOML in ad hoc scripts. Keep BAML validation, claim/hash checks, exclusive writes and projection refresh. Run `npm run issue:fixture`.
* `baml_src/main.baml` owns Issue/Edge and graph policies; `ns_toml/toml.baml` parses strict TOML plus BAIS conventions. `src/toml.ts` exposes the BAML validator to hosts.
* `baml_src/ns_event/` owns event envelopes, deterministic reduction, verification, leases, capabilities, budgets, checkpoints and sync policies.
* `src/graph.ts` implements host graph queries/mirrors. `src/store.ts` maintains an optional `node:sqlite` event-log projection at `.bais/store.db`; reads fall back to a file scan when absent. Hub, signing and sync modules own I/O.
* `scripts/` contains substantial goal, dispatch, campaign, handoff, evidence and test-tier logic. BAML curriculum/curator/foundation policies do not imply every host consumer is wired; inspect the script and hub issue.
* Public contracts: `SPEC.md`, `schema/*.json`, `toml/BAIS.md`, and `spec/`; conformance levels L1 reader / L2 graph+CLI / L3 event log. External implementations must not need BAML tooling.

## Integration and board discipline

* BAIS has no BAML package dependencies. BI/BAGL's reserved declarations do not enable BAML imports; they consume the built BAIS TS wrapper. Build BAIS before testing those paths.
* TOML issue files remain readable alongside the event projection. Queries carry freshness/completeness information. Re-ingest after board mutations, then run cross-check before diagnosing projection failures.
* The root `.bais/issues/` is the shared hub board. Resolve directory-local boards intentionally; BITS also has its own board.
* Claim Doing with `--as <owner> --for <ttl>`, renew while working, and respect live holders. Preserve named rejection reasons and executable evidence checks.
* On 0.17.0 retain `IssueExtension::validate throws never` and `${ctx.output_format}` without call parentheses.
* Proposal to the BAML team remains deferred until BI and BAIS are dogfooded on a real project; use the root upstream filing gate.

## Toolchain and gates

Follow the root [storage hygiene rules](../AGENTS.md#storage-hygiene): set `BAML_PROFILE=0` in the actual launcher environment, watch for new dumps after long runs, and retain Rust build artifacts only while needed. These projects use the installed CLI/bridge; normal work does not require compiling the BAML Rust checkout.

Wrapper `0.2.4`, toolchain `0.17.0`, bridge `0.17.0`; keep bridge/toolchain aligned. Use `BAML_PROFILE=0` before runtime initialization (root instructions explain shell/GUI setup). From the workspace root:

```bash
baml check --project bais
baml test --project bais
baml fmt --project bais
baml generate --project bais
npm run build --prefix bais
npm run typecheck --prefix bais
```

Never hand-edit `baml_sdk/` or `dist/`. Report observed test results; historical counts are not a current gate result.

`npm test --prefix bais` runs T0/T1. `npm run test:t2 --prefix bais` runs fast acceptance. Inspect `scripts/tiers.mjs`; re-ingest before cross-check after board mutations.
