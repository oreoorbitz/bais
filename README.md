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

## Outside coding agents

The portable [BAIS skill](skills/bais/SKILL.md) provides a JSON helper for list, ready, show, graph, check and dry-run dispatch. It uses BAIS directly; BI is not required. Reads preserve partial results and diagnostics, and malformed boards exit nonzero.

Copy or symlink `skills/bais/` into your coding CLI's skill directory. If copied, set `BAIS_HOME` to this checkout. The built host needs Node with `node:sqlite`, the generated SDK, and the matching bridge. Set `BAML_PROFILE=0` in the agent's launcher environment.

```sh
BAIS_HOME=/absolute/path/to/bais node /path/to/installed/bais/scripts/bais-json.mjs <<'JSON'
{"action":"ready","hub":"/absolute/path/to/project"}
JSON
```

The helper reads a single JSON request on stdin and returns `{ok,data,...}` on stdout. Parse stdout even on exit 1: failed checks retain their report. It is read-only; the skill explains supported CLI claim operations. Run `node scripts/portable-skill-fixture.mjs` to exercise the adapter against temporary boards.
