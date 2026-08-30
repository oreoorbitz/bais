# BAIS — Basically A made-up Issue Standard

Graph-native, directory-local issue language. One Issue = one file in `.bais/issues/<id>.toml`, `git` is the hosting for now.

**Objectives (same as bi/bagl):** learn language design, have fun making BAML projects, surface real BAML issues.

**Ingredients (popular):** GitHub Issues model, TOML frontmatter, git file layout, JIRA link types (`blocks`/`depends_on`), `rg` as index. **Recipe (unique):** graph + directory-local + file-per-issue.

**BAML spirit:** `baml_src/main.baml` defines `Issue`/`Edge`/`Status`/`CreateIssue(raw) -> Issue` where the return type *is* the schema (`${ctx.output_format}`). `baml check`/`baml test` make it provable (ready = Open where not blocked). `baml generate` gives typed `Issue` to every consumer (`bi` TODOs, `bagl`, `bais CLI`, future `bais-*` tools in TS/Python/Go) — one `issue.baml`, many SDKs. That's interop + perf (no DB, `rg` is your index, `spawn`/`baml.future.all` parallelizes `graph`).

**Quickstart:**
```bash
cd bais
baml check && baml test && baml generate
npm install && npm run build
node dist/src/cli.js --help
```

`bi` consumes BAIS: `bi/baml.toml` adds `bais = { path = "../bais" }` → `bais.Issue` in `bi` (see `bi`'s `TurnFailure -> bais.Issue` mapping).
