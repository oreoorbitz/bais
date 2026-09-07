# Handoff file spec (bi#139)

Swarm handoffs used to be free-form `/tmp` notes with no base commit, which
caused the bi#91 base-mismatch incident (a handoff folded against the wrong
commit). This spec fixes the shape: line-oriented headers, two body types,
priority filenames so folds process in order, atomic writes, and a validate
gate with repair guidance plus a merge-time base check.

Spec-location note: the BAIS issue format lives in `../SPEC.md`; handoff
files are a *swarm protocol* surface, not issue files, so they get their
own doc here (`bais/spec/`), enforced by
`../scripts/handoff-validate.mjs` and wired as `bais handoff --validate`.

## 1. File layout

```text
id: handoff-001
from: hero
to: titan-1
priority: 00
type: diff
created_at: 2026-09-06T02:00:00Z

<blank line>
<body>
```

- Headers are the consecutive `key: value` lines starting at line 1
  (exactly one colon followed by one space). The block ends at the first
  blank line; everything after is the body.
- Required headers, exactly these six: `id`, `from`, `to`, `priority`,
  `type`, `created_at`. Missing, duplicate, malformed, or unknown headers
  are rejected with the offending line number.
- One optional header: `directed-by` — allowed **only** on `type: note`
  (rejected on diffs), **required** on notes. It names who directed the
  note (§3).

## 2. Header values

| Header       | Rule |
|--------------|------|
| `id`         | `^[A-Za-z0-9][A-Za-z0-9#_.-]*$`, e.g. `handoff-001` |
| `from`/`to`  | owner id, same shape as BAIS claim holders: `^[A-Za-z0-9][A-Za-z0-9.:@/_-]*$` |
| `priority`   | exactly two digits (`^[0-9]{2}$`), `00` highest. Bad values are rejected with their line number. |
| `type`       | `diff` or `note` only |
| `created_at` | RFC3339 UTC, `...Z` form, e.g. `2026-09-06T02:00:00Z` |

## 3. Body types

**`diff`** — scoped hunks + base commit + test evidence (all three required):

```text
base: <40-hex-sha>        # the commit the hunks apply against
diff --git a/a.ts b/a.ts  # at least one hunk line (diff --git / --- / +++ / @@)
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
Evidence: <ref>             # e.g. Evidence: drill(handoff-validate)
```

**`note`** — exactly one line, 80 chars max, only when directed (the
`directed-by` header is the direction receipt; a note without it is
rejected). Notes are for operator-directed pings, never for code.

## 4. Priority filenames

```text
NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.handoff
```

e.g. `00_20260906T120000_001_from_hero.handoff`. `NN` sorts first so `00`
folds first; the validator requires `NN` to equal the `priority` header
and `<sender>` to equal the `from` header (otherwise fold order or
attribution lies). `<seq>` is 3+ digits, zero-padded, per sender per
timestamp.

## 5. Atomic writes

Writers MUST publish atomically: write to `<name>.tmp.<pid>` in the same
directory, fsync, then `rename` over `<name>`. Readers never see a partial
handoff; concurrent writers never interleave. (Not validator-checkable —
writer discipline, stated here so folds can assume whole files.)

## 6. Validate gate

```bash
bais handoff --validate <file.handoff> [--base <sha>] [--json]
```

- Malformed drafts are rejected with repair guidance, mirroring
  `bais check`: `HANDOFF INVALID <file> (N errors)` + one
  `error\t<line>\t<message>` per problem + an `expected:` format block.
  Exit 0 + `HANDOFF VALID\t<file>` when clean.
- Merge-time base check: the merger runs
  `bais handoff --validate <file> --base $(git rev-parse HEAD)`.
  A `--base` that differs from the file's `base:` rejects with a
  `base mismatch` error (rebase the handoff or fold at its base) — this
  is the bi#91 guard. `--base` on a note is itself an error (notes carry
  no base).

## 7. Fixture gate (acceptance for bi#139)

In `../scripts/fixtures/`, run from `bais/`:

```bash
node scripts/handoff-validate.mjs scripts/fixtures/00_20260906T120000_001_from_hero.handoff
# → HANDOFF VALID, exit 0 (valid diff validates)
node scripts/handoff-validate.mjs scripts/fixtures/00_20260906T120100_002_from_hero.handoff
# → error line 4, bad priority "soon", exit 1
node scripts/handoff-validate.mjs scripts/fixtures/00_20260906T120200_003_from_hero.handoff \
  --base ffffffffffffffffffffffffffffffffffffffff
# → base mismatch, exit 1 (same file validates with its own base)
node scripts/handoff-validate.mjs scripts/fixtures/01_20260906T120300_004_from_hero.handoff
# → error line 9, note 93 chars, exit 1 (oversize note rejected)
node scripts/handoff-validate.mjs scripts/fixtures/01_20260906T120400_005_from_hero.handoff
# → HANDOFF VALID, exit 0 (valid directed note)
```

Plus: `baml check --project bais`, `npm run typecheck --prefix bais`.
