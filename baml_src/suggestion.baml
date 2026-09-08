// Consent-first Suggestion lane (hub#211)
//
// A Suggestion is a ready-to-run spec the user may accept — nothing
// auto-creates an Issue from one. It is a record class SEPARATE from Issue
// (not a new Kind) so `bais ready` stays work-only by construction: the
// suggestion lane lists Suggestion records, ready_issues lists Issue records,
// and promote_derivation is the only bridge between them — a pure function
// that derives the Issue + Edge data. The host writes the new issue TOML
// only when promote is explicitly called with consent (see
// bais/src/suggestion.ts writePromotedIssue); derivation here never writes.
//
// Dedup latch: a dedup_key that reaches ANY terminal status (Dismissed,
// Promoted, Evicted) is latched forever — a later offer carrying the same
// key is refused, never re-offered. Dismissal is the case the acceptance
// names; Promoted latches because re-offering would duplicate live work,
// Evicted latches because re-offering would defeat the cap.
//
// Pending cap: at most max_pending() Pending records. Admitting past the
// cap evicts the OLDEST Pending (lowest offered_at) and stamps it Evicted
// with the named eviction reason, so the lane receipt says exactly who
// left and why instead of going quiet.
//
// All rules are pure functions over literal Suggestion[] and are proved by
// `baml test` in suggestion_test.baml; the host mirrors them in
// bais/src/suggestion.ts (same mirror discipline as graph.ts/main.baml).

enum SuggestionStatus {
    Pending,
    Dismissed,
    Promoted,
    Evicted,
}

class Suggestion {
    id: string @description("lane-local id, e.g. sug#001 — NOT an issue id"),
    dedup_key: string @description("content key; terminal status latches it forever"),
    title: string,
    body: string @description("the ready-to-run spec markdown the user accepts"),
    status: SuggestionStatus,
    offered_at: int @description("monotone offer sequence (host-owned clock); the cap evicts the lowest"),
    evidence: string[] @description("issue ids the suggestion cites; promote links the new issue to them"),
    resolution: string? @description(
        "named reason once terminal (e.g. the cap eviction reason); null while Pending",
    ),
}

// What one offer did to the lane. The decision is always named — a refused
// offer and an evicting admit are distinguishable from a plain admit, and
// the receipt carries the evicted id + reason instead of a silent drop.
// Deliberately carries NO Issue: offering can never create one.
class LaneUpdate {
    lane: Suggestion[],
    decision: string @description(
        "offered | offered-evicted-oldest | refused-latched | refused-pending-duplicate",
    ),
    evicted_id: string?,
    eviction_reason: string?,
}

// Constants as functions (same idiom as urgency_cost_cap in main.baml) so
// the host mirror names the same values: MAX_PENDING = 5.
function max_pending() -> int {
    5
}

function cap_eviction_reason() -> string {
    "cap-evicted-oldest"
}

// Latched = some record already carries this key in a terminal status.
// A latched key is never re-offered.
function is_latched(dedup_key: string, lane: Suggestion[]) -> bool {
    for (let s in lane) {
        if (s.dedup_key == dedup_key && s.status != SuggestionStatus.Pending) {
            return true;
        }
    }
    false
}

// The lane listing: only Pending records are offered to the user. Terminal
// records stay on disk as the latch + audit trail but never list.
function pending_suggestions(lane: Suggestion[]) -> Suggestion[] {
    lane.filter((s) -> {
        s.status == SuggestionStatus.Pending
    })
}

// Oldest Pending by offered_at (ties: first seen). Null when none pending.
function oldest_pending(lane: Suggestion[]) -> Suggestion? {
    let best: Suggestion? = null;
    let best_at = 0;
    for (let s in lane) {
        if (s.status == SuggestionStatus.Pending) {
            if (best == null || s.offered_at < best_at) {
                best = s;
                best_at = s.offered_at;
            }
        }
    }
    best
}

// Copy with a new terminal status + named resolution (records are data;
// the latch needs the terminal record to persist, not vanish).
function with_status(s: Suggestion, status: SuggestionStatus, resolution: string?) -> Suggestion {
    Suggestion {
        id: s.id,
        dedup_key: s.dedup_key,
        title: s.title,
        body: s.body,
        status: status,
        offered_at: s.offered_at,
        evidence: s.evidence,
        resolution: resolution,
    }
}

// Admit one candidate to the lane. Order of checks is the contract:
//   1. latched key (any terminal record)  -> refused-latched, lane unchanged
//   2. key already Pending                -> refused-pending-duplicate
//   3. Pending count at cap               -> evict oldest (named reason), then admit
//   4. otherwise                          -> admit
// The candidate must arrive with status Pending; the lane it returns is a
// fresh array (no aliasing mutation of the input).
function offer_suggestion(lane: Suggestion[], candidate: Suggestion) -> LaneUpdate {
    if (is_latched(candidate.dedup_key, lane)) {
        return LaneUpdate {
            lane: lane,
            decision: "refused-latched",
            evicted_id: null,
            eviction_reason: null,
        };
    }
    for (let s in lane) {
        if (s.dedup_key == candidate.dedup_key && s.status == SuggestionStatus.Pending) {
            return LaneUpdate {
                lane: lane,
                decision: "refused-pending-duplicate",
                evicted_id: null,
                eviction_reason: null,
            };
        }
    }
    let evicted_id: string? = null;
    let eviction_reason: string? = null;
    let next: Suggestion[] = [];
    if (pending_suggestions(lane).length() >= max_pending()) {
        let victim = oldest_pending(lane);
        if let v: Suggestion = victim {
            evicted_id = v.id;
            eviction_reason = cap_eviction_reason();
            for (let s in lane) {
                if (s.id == v.id) {
                    next.push(with_status(s, SuggestionStatus.Evicted, cap_eviction_reason()));
                } else {
                    next.push(s);
                }
            }
        }
    } else {
        for (let s in lane) {
            next.push(s);
        }
    }
    next.push(candidate);
    LaneUpdate {
        lane: next,
        decision: if (evicted_id == null) {
            "offered"
        } else {
            "offered-evicted-oldest"
        },
        evicted_id: evicted_id,
        eviction_reason: eviction_reason,
    }
}

// The whole promote flow as pure derivation: the Issue to file plus the
// Related edges linking it to the suggestion's evidence. Status is Open so
// the promoted issue enters the normal ready/urgency machinery as work.
// kind is Proposal (it arrived as a proposal, accepted). Nothing here
// writes — the host's consent-gated writer is the only path to disk, and
// mark_promoted is applied to the lane record ONLY after that write
// succeeds so a failed promote never latches the key.
class PromoteDerivation {
    issue: Issue,
    edges: Edge[],
}

function promote_derivation(s: Suggestion, new_issue_id: string) -> PromoteDerivation {
    let edges: Edge[] = [];
    for (let ev in s.evidence) {
        edges.push(Edge { from: new_issue_id, to: ev, kind: EdgeKind.Related });
    }
    PromoteDerivation {
        issue: Issue {
            id: new_issue_id,
            title: s.title,
            status: Status.Open,
            kind: Kind.Proposal,
            area: null,
            severity: null,
            source: null,
            body: s.body,
        },
        edges: edges,
    }
}

function mark_promoted(s: Suggestion) -> Suggestion {
    with_status(s, SuggestionStatus.Promoted, "promoted")
}

function mark_dismissed(s: Suggestion) -> Suggestion {
    with_status(s, SuggestionStatus.Dismissed, "dismissed")
}
