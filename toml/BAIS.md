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
| top-level `key = value` | `id`, `title`, `status`, `kind`, `body` required; `area`, `severity`, `source` optional. Values are TOML `string | integer | boolean` (BAIS uses `string`/`int`). `status`/`kind` map to BAML `enum Status`/`Kind`. |
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

## Evolving BAIS without deviating from training data

When you need a new field or kind, extend BAML (`Kind.NewKind`, `Issue.new_field?: type`) and document it here as an *additive* convention:

> “BAIS_TOML = TOML v1.0.0 + `new_field: string?` on issue + `Kind.NewKind`.”

LLM prompt becomes: “Emit TOML v1.0.0 matching this BAML Issue shape: …” — no grammar change, so prior TOML training still applies.

## For LLMs

If you are an LLM writing a `.bais` file: write valid TOML v1.0.0 per `toml.md`, use only the keys above, put Markdown in `body = """..."""`, edges in `[[edge]]`. Validate with `baml check --project bais`.
