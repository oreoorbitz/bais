// ── prompt registry: versioned prompt records with eval-bound provenance (hub#210) ──
// The cookbook's PromptVersionEntry {version, model, prompt, timestamp, eval_id,
// run_id, metadata} binds every prompt version to the eval run that justified
// it, with revert_to_version() rollback. Our BAML prompt specs (e.g.
// bi/baml_src/turn.baml TurnPrompt) change with no such binding — a regression
// has no recorded justification trail to revert to.
//
// This file is the BAIS answer: the registry record shape + validation policy
// as pure BAML, proved by `baml test` on literals (prompt_registry_test.baml).
// Records live file-per-record under .bais/prompts/ (new lane, same
// file-per-record + rg + git idiom as .bais/issues/). The BAML prompt spec
// stays the source of truth; the registry is the versioned JUSTIFICATION
// layer, never a second copy — records carry spec_ref (a reference), and a
// record that embeds prompt text is rejected.
//
// Split (same as urgency/oversight): BAML owns the policy proved on literals;
// the host (bais/src/prompt_registry.ts) owns IO and mirrors the arithmetic
// because the SDK cannot carry new functions until `baml generate` runs at
// fold (same FFI rationale as graph.ts's urgency mirror, proposals/05).
//
// Rollout (warn-first-then-fail, style/hero precedent hub#158): the default
// phase is Warn — `bais check` prints every problem but passes; the Fail
// phase (behind a flag) makes any problem fatal. The phase is an input, so
// the flip is a host decision, never a silent policy change (bi#55).
//
// Red-check 2026-09-07 (bi#57): deleting the EmbeddedPromptText guard hunk in
// record_problems (the `if (rec.prompt_text != null)` push) trips exactly
// "prompt registry: embedded prompt text is rejected" and nothing else
// (single-test run: `FAIL root::prompt registry: embedded prompt text is
// rejected` + `assertion failed: left = 0, right = 1` — expected 1
// EmbeddedPromptText problem, got 0; `0 passed, 1 failed, 1 total`).
// Restored → all green. Re-record on any hunk change.

enum PromptStatus {
    // Claimed by an author, eval run not yet concluded — not promotable.
    Proposed,
    // The live version: carried a passing eval-run edge when promoted.
    Active,
    // Replaced by a newer version (or rolled back from) — kept for the trail.
    Superseded,
}

enum PromptProblemKind {
    // prompt_text is set — the registry must REFERENCE the baml_src spec, never embed a copy.
    EmbeddedPromptText,
    // spec_ref does not name a .baml path — there is nothing referenced to govern.
    SpecRefNotBaml,
    // No eval_issue named — a prompt change with no eval-run edge.
    MissingEvalEdge,
    // eval_issue names an id no loaded issue has — typo or cross-project ref.
    UnresolvedEvalIssue,
    // The named eval issue is not Done — the justifying eval run has not passed.
    EvalNotPassing,
    // No Evidence: drill(<name>) cite (hub#153) — provenance without a drill is prose.
    MissingEvidence,
    // Two records claim the same (prompt, version).
    DuplicateVersion,
}

class PromptRecord {
    id: string @description("<prompt>@v<version>, e.g. turn-prompt@v2 — file name under .bais/prompts/"),
    prompt: string @description("prompt family key, e.g. turn-prompt"),
    version: int @description("monotonic within the family; revert mints max+1"),
    status: PromptStatus,
    spec_ref: string @description(
        "repo-relative path#symbol to the baml_src prompt spec, e.g. bi/baml_src/turn.baml#TurnPrompt — a REFERENCE, never a copy",
    ),
    prompt_text: string? @description(
        "MUST be null — embedding the prompt is the duplication this registry exists to prevent",
    ),
    eval_issue: string? @description(
        "issue id of the eval run that justified this version (the bits eval-run edge)",
    ),
    evidence: string? @description("Evidence: drill(<name>) cite per hub#153"),
    supersedes: string? @description("record id this version replaces (the previously Active record)"),
    timestamp: string @description("RFC3339; the host owns clocks (bi#42), BAML never reads them"),
}

class PromptProblem {
    record: string @description("id of the offending record"),
    kind: PromptProblemKind,
    detail: string @description("human-readable, names the fix — loud, never auto-mutating (bi#55)"),
}

enum RolloutPhase {
    // Warn-first: problems print, the gate still passes (default).
    Warn,
    // Then-fail: any problem fails the gate (behind a flag).
    Fail,
}

class RegistryVerdict {
    phase: RolloutPhase,
    problems: PromptProblem[],
    passed: bool @description("Warn: always true (advisory); Fail: problems.length() == 0"),
}

function eval_status(id: string, issues: Issue[]) -> Status? {
    for (let i in issues) {
        if (i.id == id) {
            return i.status;
        }
    }
    null
}

// Per-record policy. Every check is a named problem, never a throw: the
// caller wants the full inventory, and rollout decides warn vs fail.
function record_problems(rec: PromptRecord, issues: Issue[]) -> PromptProblem[] {
    let out: PromptProblem[] = [];
    //# No duplication: reference the spec, never embed a copy
    if (rec.prompt_text != null) {
        out.push(
            PromptProblem {
                record: rec.id,
                kind: PromptProblemKind.EmbeddedPromptText,
                detail: "record embeds prompt text — the registry references the baml_src spec (spec_ref), never carries a copy",
            },
        );
    }
    if (rec.spec_ref.index_of(".baml") == null) {
        out.push(
            PromptProblem {
                record: rec.id,
                kind: PromptProblemKind.SpecRefNotBaml,
                detail: `spec_ref '${rec.spec_ref}' does not name a .baml spec path — records REFERENCE the baml_src prompt spec`,
            },
        );
    }
    if (rec.eval_issue == null) {
        out.push(
            PromptProblem {
                record: rec.id,
                kind: PromptProblemKind.MissingEvalEdge,
                detail: "prompt change with no eval-run edge — name the eval issue that justified this version",
            },
        );
    } else if let eval_id: string = rec.eval_issue {
        let st = eval_status(eval_id, issues);
        if (st == null) {
            out.push(
                PromptProblem {
                    record: rec.id,
                    kind: PromptProblemKind.UnresolvedEvalIssue,
                    detail: `eval issue ${eval_id} does not resolve to a loaded issue`,
                },
            );
        } else if let s: Status = st {
            if (s != Status.Done) {
                out.push(
                    PromptProblem {
                        record: rec.id,
                        kind: PromptProblemKind.EvalNotPassing,
                        detail: `eval issue ${eval_id} is ${s.to_string()}, not Done — no passing eval run justifies this change`,
                    },
                );
            }
        }
    }
    if (rec.evidence == null || rec.evidence == "") {
        out.push(
            PromptProblem {
                record: rec.id,
                kind: PromptProblemKind.MissingEvidence,
                detail: "no Evidence: drill(<name>) cite (hub#153) — provenance without a drill is prose",
            },
        );
    }
    out
}

// Cross-record policy: two records claiming the same (prompt, version). The
// later record in the input is blamed and the first claimant is named, so the
// report is deterministic and points at the file to fix.
function duplicate_versions(records: PromptRecord[]) -> PromptProblem[] {
    let seen: map<string, string> = {};
    let out: PromptProblem[] = [];
    for (let r in records) {
        let key = `${r.prompt}@v${r.version}`;
        let first = seen.get(key);
        if (first == null) {
            let _ = seen.set(key, r.id);
        } else if let f: string = first {
            out.push(
                PromptProblem {
                    record: r.id,
                    kind: PromptProblemKind.DuplicateVersion,
                    detail: `${r.prompt} version ${r.version} also claimed by ${f}`,
                },
            );
        }
    }
    out
}

// The full registry check: per-record problems plus cross-record duplicates.
function registry_problems(records: PromptRecord[], issues: Issue[]) -> PromptProblem[] {
    let out: PromptProblem[] = [];
    for (let r in records) {
        for (let p in record_problems(r, issues)) {
            out.push(p);
        }
    }
    for (let p in duplicate_versions(records)) {
        out.push(p);
    }
    out
}

// Warn-first-then-fail rollout (style/hero precedent): Warn always passes —
// the problems print as advisories while the lane beds in; Fail makes any
// problem fatal. The phase is an input, so flipping is a deliberate host
// decision with the rollout state named in the output, never a silent change.
function registry_verdict(
    records: PromptRecord[],
    issues: Issue[],
    phase: RolloutPhase,
) -> RegistryVerdict {
    let problems = registry_problems(records, issues);
    let passed = match (phase) {
        RolloutPhase.Warn => true,
        RolloutPhase.Fail => problems.length() == 0,
    };
    RegistryVerdict { phase: phase, problems: problems, passed: passed }
}

function find_record(records: PromptRecord[], prompt: string, version: int) -> PromptRecord? {
    for (let r in records) {
        if (r.prompt == prompt && r.version == version) {
            return r;
        }
    }
    null
}

function latest_version(records: PromptRecord[], prompt: string) -> int {
    let max = 0;
    for (let r in records) {
        if (r.prompt == prompt && r.version > max) {
            max = r.version;
        }
    }
    max
}

function active_record(records: PromptRecord[], prompt: string) -> PromptRecord? {
    for (let r in records) {
        if (r.prompt == prompt && r.status == PromptStatus.Active) {
            return r;
        }
    }
    null
}

// Cookbook revert_to_version(), registry form: mint a NEW record at max+1
// whose spec_ref, eval_issue, and evidence are copied from the target version
// — the older prompt reference is restored with its justification trail
// intact — superseding the currently Active record. History is append-only:
// the reverted-from records are never rewritten (git + the supersedes chain
// are the rollback story, per the issue body). Returns null when the target
// version does not exist — never a silent no-op (bi#55).
function revert_to(
    records: PromptRecord[],
    prompt: string,
    to_version: int,
    timestamp: string,
) -> PromptRecord? {
    if let target: PromptRecord = find_record(records, prompt, to_version) {
        //# Revert restores the older prompt reference with evidence intact
        let next = latest_version(records, prompt) + 1;
        let current = active_record(records, prompt);
        PromptRecord {
            id: `${prompt}@v${next}`,
            prompt: prompt,
            version: next,
            status: PromptStatus.Active,
            spec_ref: target.spec_ref,
            prompt_text: null,
            eval_issue: target.eval_issue,
            evidence: target.evidence,
            supersedes: current?.id ?? null,
            timestamp: timestamp,
        }
    } else {
        null
    }
}
