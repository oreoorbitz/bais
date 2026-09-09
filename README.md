# BAIS — Basically A made-up Issue Standard

Graph-native, directory-local issue language. One Issue = one file in `.bais/issues/<id>.toml`, `git` is the hosting for now.

**Objectives (same as bi/bagl):** learn language design, have fun making BAML projects, surface real BAML issues.

**Ingredients (popular):** GitHub Issues model, TOML frontmatter, git file layout, JIRA link types (`blocks`/`depends_on`), `rg` as index. **Recipe (unique):** graph + directory-local + file-per-issue.

**Implementation:** BAML owns Issue/Edge, strict TOML validation, graph rules, and event reduction. The TypeScript host provides file I/O, CLI, hub/sync, and an optional SQLite projection at `.bais/store.db`, with scan fallback when absent. TOML files remain directly readable with ordinary tools.

External implementers can use [SPEC.md](SPEC.md), [JSON schemas](schema/), and [workflow contracts](spec/) without BAML tooling. See [AGENTS.md](AGENTS.md) for current ownership and gates.

**Quickstart:**

```bash
cd bais
export BAML_PROFILE=0
baml check && baml test && baml generate
npm install && npm run build
node dist/src/cli.js --help
```

BI and BAGL consume the built `bais/dist/src/toml.js` wrapper through TS-host interop. Their `baml.toml` dependency declarations are reserved for Phase B; cross-package BAML imports are not active. Build BAIS before using those consumers' BAIS commands.
