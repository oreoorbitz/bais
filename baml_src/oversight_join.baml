// ── oversight: blocked-behind-stalled join (bi#50) ──
// `oversight` reports stalled_leases, but nothing links a stalled node to
// the chain parked behind it. A blocker Doing for weeks with a silent holder
// is a different fact from a blocker Doing since yesterday — join them:
// "N issues parked behind stalled X, holder silent since ...".
//
// Split (same as ns_event/lease bi#42): the HOST owns clocks — stalled-ness
// (leaseExpired: null/unparseable/<= now over check.staleClaims) is derived
// host-side and arrives here as plain StalledHolder input. BAML owns this
// pure join predicate: blocked-transitive closure over Blocks edges crossed
// with the stalled set, over projection rows only (no log scan, no wall
// clock). The host mirror lives in scripts/oversight-join.mjs (feed
// rendering: text + --json for review triage); the `baml test` cases below
// are the specification of what the mirror must do.
//
// Traversal rules (mirror is_blocked conservatism):
// - Forward-Blocks BFS from the stalled root (e.from == current -> e.to is
//   a dependent: from is the blocker, to is the blocked). BFS order, so
//   `parked` reads root-outward, deterministic.
// - Traverse THROUGH a node only while it is unresolved: missing ids stay
//   conservative (unresolvable = blocking, same as is_blocked) so a typo
//   cannot hide a chain; a Done/Dropped intermediate resolves the block, so
//   its downstream is NOT parked behind the root via that path.
// - Output excludes the root itself (cycle-safe via the seen set) and any
//   Done/Dropped dependents (finished, not parked).
// - A stalled root with zero parked issues yields NO entry: the stall itself
//   is already reported by stalled.mjs / stale-claim — this feed is the
//   join, not the stall list.
//
// Red-check 2026-09-06 (bi#57): deleting the Done/Dropped traversal gate
// (always pushing resolved dependents) trips exactly the two gate tests —
// "done mid-chain resolves the block and breaks traversal" and "side branch
// survives while the done branch is excluded" (2 FAIL, 195 pass). Restored →
// 197 green. Re-record on any hunk change.

class StalledHolder {
    id: string @description("stalled blocker issue id, e.g. bi#09"),
    holder: string @description("silent holder named on the dead claim"),
    silent_since: string @description(
        "dead lease instant (RFC3339); host-derived from the claim envelope, BAML never reads clocks",
    ),
}

class StalledChain {
    blocker: string @description("the stalled root everything below is parked behind"),
    holder: string @description("silent holder, carried through from StalledHolder"),
    silent_since: string @description("dead lease instant, carried through for the feed line"),
    parked: string[] @description("transitive parked-behind ids, BFS order root-outward"),
}

function stalled_status(id: string, issues: Issue[]) -> Status? {
    for (let i in issues) {
        if (i.id == id) {
            return i.status;
        }
    }
    null
}

function parked_behind(blocker: string, issues: Issue[], edges: Edge[]) -> string[] {
    //# BFS over reverse-Blocks from the stalled root
    let seen: string[] = [blocker];
    let frontier: string[] = [blocker];
    while let cur: string = frontier.shift() {
        for (let e in edges) {
            if (e.kind == EdgeKind.Blocks && e.from == cur) {
                if (!seen.includes(e.to)) {
                    let st = stalled_status(e.to, issues);
                    if (st == null) {
                        //# unresolvable dependent: conservative, still parked
                        seen.push(e.to);
                        frontier.push(e.to);
                    } else if let s: Status = st {
                        if (s != Status.Done && s != Status.Dropped) {
                            seen.push(e.to);
                            frontier.push(e.to);
                        }
                    }
                }
            }
        }
    }
    seen.filter((id) -> {
        id != blocker
    })
}

function stalled_chains(
    issues: Issue[],
    edges: Edge[],
    stalled: StalledHolder[],
) -> StalledChain[] {
    stalled.filter_map((s) -> {
        let parked = parked_behind(s.id, issues, edges);
        if (parked.length() == 0) {
            null
        } else {
            StalledChain {
                blocker: s.id,
                holder: s.holder,
                silent_since: s.silent_since,
                parked: parked,
            }
        }
    })
}

function join_issue(id: string, status: Status) -> Issue {
    Issue {
        id: id,
        title: id,
        status: status,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    }
}

function chain_edges() -> Edge[] {
    [
        Edge { from: "j#01", to: "j#02", kind: EdgeKind.Blocks },
        Edge { from: "j#02", to: "j#03", kind: EdgeKind.Blocks },
        Edge { from: "j#03", to: "j#04", kind: EdgeKind.Blocks },
    ]
}

test "stalled holder plus 3-deep chain reports one entry naming all four" {
    let issues = [
        join_issue("j#01", Status.Doing),
        join_issue("j#02", Status.Open),
        join_issue("j#03", Status.Open),
        join_issue("j#04", Status.Open),
    ];
    let stalled = [StalledHolder { id: "j#01", holder: "ghost-1", silent_since: "2000-01-01T00:00:00Z" }];
    let chains = stalled_chains(issues, chain_edges(), stalled);
    assert.equal(chains.length(), 1);
    assert.equal(chains[0].blocker, "j#01");
    assert.equal(chains[0].holder, "ghost-1");
    assert.equal(chains[0].silent_since, "2000-01-01T00:00:00Z");
    assert.equal(chains[0].parked, ["j#02", "j#03", "j#04"])
}

test "renewing holder with the same shape reports nothing" {
    let issues = [
        join_issue("j#01", Status.Doing),
        join_issue("j#02", Status.Open),
        join_issue("j#03", Status.Open),
        join_issue("j#04", Status.Open),
    ];
    // Live lease: the holder renewed, so the host never lists j#01 in the
    // stalled input — the same chain shape yields no entry.
    let chains = stalled_chains(issues, chain_edges(), []);
    assert.equal(chains.length(), 0)
}

test "done mid-chain resolves the block and breaks traversal" {
    let issues = [
        join_issue("j#01", Status.Doing),
        join_issue("j#02", Status.Done),
        join_issue("j#03", Status.Open),
        join_issue("j#04", Status.Open),
    ];
    let stalled = [StalledHolder { id: "j#01", holder: "ghost-1", silent_since: "2000-01-01T00:00:00Z" }];
    // j#02 Done frees j#03 via that path: nothing below j#01 is parked.
    assert.equal(parked_behind("j#01", issues, chain_edges()), []);
    assert.equal(stalled_chains(issues, chain_edges(), stalled).length(), 0)
}

test "side branch survives while the done branch is excluded" {
    let issues = [
        join_issue("j#01", Status.Doing),
        join_issue("j#02", Status.Open),
        join_issue("j#05", Status.Done),
    ];
    let edges = [
        Edge { from: "j#01", to: "j#02", kind: EdgeKind.Blocks },
        Edge { from: "j#01", to: "j#05", kind: EdgeKind.Blocks },
    ];
    assert.equal(parked_behind("j#01", issues, edges), ["j#02"])
}

test "blocks cycle terminates and never names the root as parked" {
    let issues = [join_issue("j#01", Status.Doing), join_issue("j#02", Status.Open)];
    let edges = [
        Edge { from: "j#01", to: "j#02", kind: EdgeKind.Blocks },
        Edge { from: "j#02", to: "j#01", kind: EdgeKind.Blocks },
    ];
    assert.equal(parked_behind("j#01", issues, edges), ["j#02"])
}
