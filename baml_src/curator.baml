// ── curator: deterministic lifecycle sweep (hub#212) ──
// Port of hermes' curator (deterministic half): unused 30d -> stale, 90d ->
// archived (recoverable; never delete), pinned and live-lease-claimed issues
// exempt (bi#56), first run defers one interval, archive is a MOVE to
// .bais/archive/ (git keeps history), never a delete.
//
// Split (same as ns_event/lease bi#42 + oversight_join bi#50): the HOST owns
// clocks and filesystems — activity day (file mtime, whole days), pin set
// (.bais/curator_pins — the strict TOML parser rejects unknown issue keys, so
// pins cannot live inside issue files), and lease liveness (holder set and
// lease instant > now) are derived host-side and arrive here as plain
// CuratorIssue fields. BAML owns the pure transition policy. The host mirror
// lives in scripts/curator.mjs (report + ledger + snapshot + archive move);
// the `baml test` cases in curator_test.baml are the specification of what
// the mirror must do.
//
// Never-delete is static, not a promise: CuratorActionKind has no Delete
// variant, so no sweep output can name one. Archive = Archive (a move);
// restore is `git mv` back.
//
// Red-check 2026-09-07 (bi#57): the load-bearing hunk is the stale boundary
// `idle >= curator_stale_days()` in CuratorTransition. Flipping it to `>`
// must trip exactly the boundary test — "30 days idle is Stale, not Active"
// (observed: 1 FAIL that test, 75 pass; restored `>=` -> 76 green).
// Re-record on any hunk change.

enum CuratorState {
    Active,
    Stale,
    Archived,
}

enum CuratorActionKind {
    Keep,
    MarkStale,
    // A move to .bais/archive/ — recoverable, never a delete. There is no
    // Delete variant on purpose: the return type is the schema, and the
    // schema cannot name deletion.
    Archive,
}

class CuratorIssue {
    id: string,
    status: Status,
    last_activity_day: int @description(
        "whole days since epoch of last activity; host-stamped (file mtime). BAML never reads clocks",
    ),
    pinned: bool @description("host-derived from .bais/curator_pins (one id per line)"),
    live_lease: bool @description("host-derived: holder set and lease instant > now (bi#56)"),
}

class CuratorAction {
    id: string,
    action: CuratorActionKind,
    state: CuratorState,
    idle_days: int @description("clamped at 0 — unknown/future activity reads as fresh"),
    reason: string @description("single line naming the rule and the numbers behind it"),
}

// Policy constants as functions (same pattern as urgency_cost_cap) so the
// host mirror names the same numbers: STALE_DAYS / ARCHIVE_DAYS in
// scripts/curator.mjs must agree with these.
function curator_stale_days() -> int {
    30
}

function curator_archive_days() -> int {
    90
}

// Unknown age never inflates: activity stamped in the future (clock skew,
// bad mtime) clamps to fresh, matching urgency_stalled_days.
function curator_idle_days(issue: CuratorIssue, now: int) -> int {
    let idle = now - issue.last_activity_day;
    if (idle < 0) {
        0
    } else {
        idle
    }
}

// The pure per-issue transition. Exemptions win over age, in order:
// pinned, live-lease, non-Open status. Only Open issues are curated —
// Doing belongs to the lease/reap protocol (a dead lease is reaped to Open
// first and becomes curatable then), Done/Dropped are terminal and already
// covered by `bais stale`'s SHIPPED/archive flow.
function CuratorTransition(issue: CuratorIssue, now: int) -> CuratorState {
    if (issue.pinned) {
        CuratorState.Active
    } else if (issue.live_lease) {
        CuratorState.Active
    } else if (issue.status != Status.Open) {
        CuratorState.Active
    } else {
        let idle = curator_idle_days(issue, now);
        if (idle >= curator_archive_days()) {
            CuratorState.Archived
        } else if (idle >= curator_stale_days()) {
            // RED-CHECK HUNK (bi#57): `>=` is load-bearing. See file header.
            CuratorState.Stale
        } else {
            CuratorState.Active
        }
    }
}

function curator_reason(issue: CuratorIssue, now: int, state: CuratorState) -> string {
    let idle = curator_idle_days(issue, now);
    if (issue.pinned) {
        "pinned: exempt from lifecycle sweep (idle " + idle.to_string() + "d ignored)"
    } else if (issue.live_lease) {
        "live lease: claimed issue is in use (idle " + idle.to_string() + "d ignored)"
    } else if (issue.status != Status.Open) {
        "status " + issue.status.to_string() + ": only Open issues are curated"
    } else if (state == CuratorState.Archived) {
        "idle "
            + idle.to_string()
            + "d >= "
            + curator_archive_days().to_string()
            + "d: archive (move to .bais/archive/, never delete)"
    } else if (state == CuratorState.Stale) {
        "idle " + idle.to_string() + "d >= " + curator_stale_days().to_string() + "d: mark stale"
    } else {
        "idle " + idle.to_string() + "d < " + curator_stale_days().to_string() + "d: active"
    }
}

function curator_action(issue: CuratorIssue, now: int) -> CuratorAction {
    let state = CuratorTransition(issue, now);
    CuratorAction {
        id: issue.id,
        state: state,
        idle_days: curator_idle_days(issue, now),
        action: if (state == CuratorState.Archived) {
            CuratorActionKind.Archive
        } else if (state == CuratorState.Stale) {
            CuratorActionKind.MarkStale
        } else {
            CuratorActionKind.Keep
        },
        reason: curator_reason(issue, now, state),
    }
}

// One sweep over the library. `last_sweep_day` is the host's state-file
// record: null means this is the FIRST run, which records a baseline and
// defers every transition one interval — a freshly deployed curator must
// never act on ages it did not observe itself. Input order is preserved so
// the report is deterministic.
function curator_sweep(issues: CuratorIssue[], now: int, last_sweep_day: int?) -> CuratorAction[] {
    if (last_sweep_day == null) {
        issues.map((i) -> {
            CuratorAction {
                id: i.id,
                action: CuratorActionKind.Keep,
                state: CuratorState.Active,
                idle_days: curator_idle_days(i, now),
                reason: "first-run: baseline recorded, transitions deferred one interval",
            }
        })
    } else {
        issues.map((i) -> {
            curator_action(i, now)
        })
    }
}

// ── Phase 2 (opt-in, LLM): consolidation report ──
// Compiles via `baml check` but is NEVER called by baml test or by
// curator.mjs's default path: it exists so a human can opt into a
// distill-vs-file pass over the stale candidates. The output is a REPORT
// filed for human approval — `approval` is pinned to pending by the prompt
// contract, and nothing in the curator applies a CuratorReport.

class ConsolidationGroup {
    theme: string @description("umbrella name for a cluster of near-duplicate stale issues"),
    member_ids: string[] @description("stale issue ids that collapse into this umbrella"),
    rationale: string @description("why these distill into one issue — evidence, not vibes"),
}

class CuratorReport {
    summary: string,
    groups: ConsolidationGroup[],
    approval: string @description(
        "always \"pending-human-approval\" — the report is filed for a human, never applied by the curator",
    ),
}

function ConsolidateIssues(candidates: string) -> CuratorReport {
    client: "openai/gpt-4o-mini"
    prompt: `
        You are the BAIS curator's opt-in consolidation pass. Below are stale
        issue candidates (id, title, body) from a directory-local issue
        library that has grown past hand-review size.

        Distill, do not file: group near-duplicates and fragments into
        umbrella themes. Every group must name its member ids and give a
        rationale a reviewer can check. Never propose deleting anything —
        archival is reversible and deletion does not exist here. Set
        approval to "pending-human-approval": this report is filed for a
        human to approve or reject, never applied directly.

        ${ctx.output_format}

        Candidates:
        ${candidates}
    `
}
