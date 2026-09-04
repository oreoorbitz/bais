// ns_event/delta — what-changed-since-heads (bi#47). Pure diff policy.
//
// A rejoining agent holds heads H (event ids it has already seen) and asks
// what moved since. diff_since answers with EITHER a complete delta
// (every surviving event the requester lacks, plus the coverage floor and
// the current heads for the next poll) OR an explicit re-bootstrap
// directive — never a partial diff presented as complete.
//
// Prune model (mirrors the host PruneAnchorRecord in src/hub.ts): pruning
// is truncation-with-anchor. anchor.lc == 0 means "never pruned", so the
// surviving log IS the full history and any unknown head id is just an
// id the requester invented (typo, cross-project edge) — the full log
// below is still complete. anchor.lc > 0 means history at/below that lc
// may be gone; a head naming an event no longer in the log therefore
// predates the anchor and the requester MUST re-bootstrap via snapshot
// (snapshot at anchor.state_root, then delta) — we cannot prove what it
// misses, so we return complete=false with events=[] rather than guess.
//
// Standing split: BAML owns this diff policy (reduce-adjacent, pure, no
// crypto, no IO). The host owns serving it (GET /sync, CLI flag, MCP
// tool), snapshot export/import, and state_root hashing. The projection
// "diff" is served by replay: the requester reduces snapshot-events +
// delta-events with reduce(); projection_fingerprint() below is the
// equality check for that composition (ties to bi#35).
//
// Coverage contract on DeltaResult when complete=true:
// - events: every event in log whose id is NOT in heads, in total
//   (lc, id) order via order_key. Admitted AND unadmitted events are
//   carried, so replay reproduces excluded[] evidence identically.
// - floor: max(anchor.lc, max lc over heads found in log). State at or
//   below floor is either already held (via heads) or comes from the
//   snapshot at the anchor — nothing in between is skipped.
// - heads: every event id in log, in log order — feed it straight back
//   as the next call's heads for exact chaining.
// When complete=false: events is ALWAYS empty and reason names the
// re-bootstrap (anchor lc + state_root). An empty delta with
// complete=true means "nothing moved", which is distinct by the flag.

// Prune anchor: the host's truncation floor. lc == 0 (with empty
// state_root) means the log was never pruned.
class SyncAnchor {
    lc: int @description("prune floor — events at/below may be gone; 0 = never pruned"),
    state_root: string @description("anchor snapshot hash; empty when never pruned"),
}

// The single return shape: complete=true carries a complete delta,
// complete=false carries the re-bootstrap directive (events empty).
class DeltaResult {
    complete: bool,
    events: WireEvent[],
    floor: int,
    heads: string[],
    reason: string?,
}

function no_anchor() -> SyncAnchor {
    SyncAnchor { lc: 0, state_root: "" }
}

function anchor_at(lc: int, state_root: string) -> SyncAnchor {
    SyncAnchor { lc: lc, state_root: state_root }
}

// Every id in the surviving log, in log order — the next call's heads.
function current_heads(log: WireEvent[]) -> string[] {
    log.map((e) -> {
        e.id
    })
}

function max_log_lc(log: WireEvent[]) -> int {
    let m = 0;
    for (let e in log) {
        if (e.lc > m) {
            m = e.lc;
        }
    }
    m
}

// Heads the requester names that are no longer in the surviving log.
// Meaningless without pruning (typo-grade); fatal with it (pruned away).
function unknown_heads(heads: string[], log: WireEvent[]) -> string[] {
    let ids = current_heads(log);
    let out: string[] = [];
    for (let h in heads) {
        if (!ids.includes(h) && !out.includes(h)) {
            out.push(h);
        }
    }
    out
}

function diff_since(heads: string[], anchor: SyncAnchor, log: WireEvent[]) -> DeltaResult {
    //# Heads naming pruned-away events cannot be diffed — demand re-bootstrap.
    let missing = unknown_heads(heads, log);
    if (anchor.lc > 0 && missing.length() > 0) {
        DeltaResult {
            complete: false,
            events: [],
            floor: anchor.lc,
            heads: current_heads(log),
            reason: `rebootstrap: ${missing.length()} head(s) predate prune anchor lc=${anchor.lc}; fetch snapshot ${anchor.state_root} then delta`,
        }
    } else {
        //# Complete delta: every surviving event the requester lacks, in total order.
        let have = heads;
        let events = log
            .filter((e) -> {
                !have.includes(e.id)
            })
            .map((e) -> {
                e
            })
            .sort_by_key((e) -> {
                order_key(e)
            });
        let floor = anchor.lc;
        for (let e in log) {
            if (have.includes(e.id) && e.lc > floor) {
                floor = e.lc;
            }
        }
        DeltaResult {
            complete: true,
            events: events,
            floor: floor,
            heads: current_heads(log),
            reason: null,
        }
    }
}

// Deterministic structural fingerprint over a materialized projection.
// No crypto (BAML has none): row order is normalized by sorting, so two
// hosts reducing the same event SET — in any input order — produce the
// same string. The host's sha256 state_root is the wire-grade version of
// this for checkpoints; this is the offline composition check.
function projection_fingerprint(r: Reduction) -> string {
    let parts: string[] = [];
    for (let i in r.issues) {
        let labs = "";
        for (let l in i.labels) {
            labs = `${labs}${l},`;
        }
        let coms = "";
        for (let c in i.comments) {
            coms = `${coms}${c},`;
        }
        let sev = "null";
        if let n: int = i.severity {
            sev = n.to_string();
        }
        parts.push(
            `issue:${i.entity}:${i.status}:${i.title}:${i.kind}:${i.area ?? ""}:${sev}:${labs}:${coms}:${i.body}`,
        );
    }
    for (let x in r.rels) {
        parts.push(`rel:${x.id}:${x.source}:${x.type}:${x.target}`);
    }
    for (let c in r.conflicts) {
        let opts = "";
        for (let o in c.options) {
            opts = `${opts}${o},`;
        }
        let eids = "";
        for (let e in c.event_ids) {
            eids = `${eids}${e},`;
        }
        parts.push(`conflict:${c.entity}:${c.field}:${opts}:${c.winner ?? ""}:${eids}:${c.at_lc}`);
    }
    for (let e in r.excluded) {
        parts.push(`excluded:${e.event_id}:${e.reason}`);
    }
    for (let c in r.checkpoints) {
        parts.push(`checkpoint:${c.id}:${c.lc}:${c.state_root}`);
    }
    for (let l in r.leases) {
        parts.push(`lease:${l.lease_id}:${l.entity}:${l.holder}:${l.status}:${l.fencing}`);
    }
    for (let s in r.submissions) {
        parts.push(`submission:${s.submit_id}:${s.entity}:${s.status}`);
    }
    for (let v in r.verifications) {
        parts.push(`verification:${v.verify_id}:${v.submit_id}:${v.verdict}`);
    }
    for (let b in r.budgets) {
        parts.push(
            `budget:${b.principal}:${b.cap_tokens}:${b.reserved_tokens}:${b.incurred_tokens}`,
        );
    }
    for (let c in r.costs) {
        parts.push(`cost:${c.entry_id}:${c.principal}:${c.task}:${c.kind}`);
    }
    for (let c in r.caps) {
        parts.push(`cap:${c.grant_id}:${c.audience}:${c.scope}:${c.revoked}`);
    }
    let rows = parts.sort_by_key((s) -> {
        s
    });
    let fp = r.version;
    for (let p in rows) {
        fp = `${fp}\n${p}`;
    }
    fp
}

function delta_ids(d: DeltaResult) -> string[] {
    d.events.map((e) -> {
        e.id
    })
}

// Acceptance fixture 1 (bi#47): three sequential deltas — each polled with
// the previous delta's heads against the growing server log — compose
// exactly to the full log, in order.
test "sequential deltas compose to the full log" {
    let e1 = wire("TaskCreate", "task:A", 1, "e1", str_body("title", "a"));
    let e2 = wire("TaskTransition", "task:A", 2, "e2", str_body("to", "Doing"));
    let e3 = wire("TaskTransition", "task:A", 3, "e3", str_body("to", "Done"));
    let e4 = wire("CommentPost", "task:A", 4, "e4", str_body("text", "hi"));
    let e5 = wire("TaskCreate", "task:B", 5, "e5", str_body("title", "b"));
    let e6 = wire("TaskTransition", "task:B", 6, "e6", str_body("to", "Doing"));
    let d1 = diff_since([], no_anchor(), [e1, e2]);
    assert.equal(d1.complete, true);
    assert.equal(delta_ids(d1), ["e1", "e2"]);
    assert.equal(d1.floor, 0);
    let d2 = diff_since(d1.heads, no_anchor(), [e1, e2, e3, e4]);
    assert.equal(d2.complete, true);
    assert.equal(delta_ids(d2), ["e3", "e4"]);
    assert.equal(d2.floor, 2);
    let d3 = diff_since(d2.heads, no_anchor(), [e1, e2, e3, e4, e5, e6]);
    assert.equal(d3.complete, true);
    assert.equal(delta_ids(d3), ["e5", "e6"]);
    assert.equal(d3.floor, 4);
    let composed: string[] = [];
    for (let e in d1.events) {
        composed.push(e.id);
    }
    for (let e in d2.events) {
        composed.push(e.id);
    }
    for (let e in d3.events) {
        composed.push(e.id);
    }
    assert.equal(composed, ["e1", "e2", "e3", "e4", "e5", "e6"]);
    // A fourth poll with the final heads is an empty — but complete — delta.
    let d4 = diff_since(d3.heads, no_anchor(), [e1, e2, e3, e4, e5, e6]);
    assert.equal(d4.complete, true);
    assert.equal(d4.events.length(), 0)
}

// Acceptance fixture 2 (bi#47): a head predating the prune anchor yields
// the re-bootstrap directive — never a partial diff presented as complete.
test "heads predating the prune anchor demand re-bootstrap" {
    let e3 = wire("TaskTransition", "task:A", 3, "e3", str_body("to", "Done"));
    let e4 = wire("CommentPost", "task:A", 4, "e4", str_body("text", "hi"));
    // Server pruned everything at/below lc 2; the client still names e1.
    let r = diff_since(["e1"], anchor_at(2, "ab12"), [e3, e4]);
    assert.equal(r.complete, false);
    assert.equal(r.events.length(), 0);
    assert.equal(r.floor, 2);
    assert.equal(
        r.reason,
        "rebootstrap: 1 head(s) predate prune anchor lc=2; fetch snapshot ab12 then delta",
    );
    // A head that survived the prune diffs normally against the same log.
    let ok = diff_since(["e3"], anchor_at(2, "ab12"), [e3, e4]);
    assert.equal(ok.complete, true);
    assert.equal(delta_ids(ok), ["e4"]);
    assert.equal(ok.floor, 3);
    // A fresh peer (no heads) bootstraps: complete delta over the floor,
    // composed with the anchor snapshot by the host.
    let fresh = diff_since([], anchor_at(2, "ab12"), [e3, e4]);
    assert.equal(fresh.complete, true);
    assert.equal(delta_ids(fresh), ["e3", "e4"]);
    assert.equal(fresh.floor, 2)
}

// Unknown heads WITHOUT pruning are not pruned-away history: the
// surviving log is the whole history, so the full diff stays complete.
test "unknown heads without a prune anchor stay complete" {
    let e1 = wire("TaskCreate", "task:A", 1, "e1", {});
    let r = diff_since(["typo-id"], no_anchor(), [e1]);
    assert.equal(r.complete, true);
    assert.equal(delta_ids(r), ["e1"]);
    assert.equal(r.reason, null)
}

// Acceptance fixture 3 (bi#47, ties to bi#35): delta + snapshot composes
// to the same projection fingerprint as a full replay — while the delta
// alone does not.
test "delta plus snapshot composes to the full-replay fingerprint" {
    let e1 = wire("TaskCreate", "task:A", 1, "e1", str_body("title", "a"));
    let e2 = wire("TaskTransition", "task:A", 2, "e2", str_body("to", "Doing"));
    let e3 = wire("LabelAdd", "task:A", 3, "e3", str_body("label", "backend"));
    let e4 = wire("TaskTransition", "task:A", 4, "e4", str_body("to", "Done"));
    let full = [e1, e2, e3, e4];
    let snap = [e1, e2];
    let snap_heads = snap.map((e) -> {
        e.id
    });
    let d = diff_since(snap_heads, no_anchor(), full);
    assert.equal(d.complete, true);
    assert.equal(delta_ids(d), ["e3", "e4"]);
    // Host composition: snapshot events + delta events, then reduce.
    let composed: WireEvent[] = [];
    for (let e in snap) {
        composed.push(e);
    }
    for (let e in d.events) {
        composed.push(e);
    }
    assert.equal(projection_fingerprint(reduce(composed)), projection_fingerprint(reduce(full)));
    // The delta alone is NOT the full state — the fingerprint must differ.
    assert.equal(
        projection_fingerprint(reduce(d.events)) == projection_fingerprint(reduce(full)),
        false,
    );
    // Fingerprints are order-insensitive over the same event set (bi#35).
    assert.equal(
        projection_fingerprint(reduce([e2, e1, e4, e3])),
        projection_fingerprint(reduce(full)),
    )
}
