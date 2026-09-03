// ns_event/lease — exclusive work leases (fusion v1, Phase 3, step 9).
//
// The one operation that needs coordination (envelope needs_coordinator):
// claiming work exclusively is impossible in an AP system, so LeaseClaim
// goes through the hub's linearizable coordinator (hub.ts) — but the
// REDUCER stays deterministic over the total (lc, id) order, so any peer
// replaying the same log derives the same lease state. The hub is a
// fast-path serializer; the log is the truth.
//
// Body contracts (WireEvent.body — readers MUST-ignore-unknown-fields):
//   LeaseClaim   { ttl: int (lc ticks), epoch: int = 0, idem: string,
//                  read_set: string[] = [] }
//   LeaseRenew   { lease_ref: string (claim event id) }
//   LeaseRelease { lease_ref: string }
//   TaskTransition / WorkSubmit may carry { fencing: int } — required iff
//   the task has an active unexpired lease (see lease_fence_ok).
//
// Rules:
// - First claim in total order wins. A competing claim while an active
//   unexpired lease exists is excluded `lease-held` (holder named).
// - Same holder + same idem is an idempotent retry: excluded
//   `idem-duplicate`, exactly one active lease survives.
// - Same holder + strictly greater epoch supersedes (old -> superseded).
//   Same or lower epoch is excluded `stale-epoch`.
// - Renew extends expiry by the lease's own ttl; only the holder, only the
//   current active lease. Release frees; anyone else is excluded.
// - `expire` is DERIVED, never written: finalize marks active leases with
//   expires_lc <= max admitted lc as expired.
// - Fencing token = the winning claim's lc (monotonic, causal). A
//   transition/submit on a leased task must echo it exactly, else
//   `stale-fence`. No active lease -> no fencing required (existing logs
//   keep reducing identically).

class Lease {
    entity: string @description("task:01J... under lease"),
    holder: string @description("did:key:... that won the claim"),
    lease_id: string @description("claim event id (bafy...); renew/release reference this"),
    epoch: int,
    fencing: int @description("winning claim's lc — echo on transition/submit"),
    ttl: int @description("lc ticks granted per claim/renew"),
    expires_lc: int,
    read_set: string[],
    idem: string @description("client idempotency key: same holder + same idem is a retry"),
    status: string @description("active | released | expired | superseded"),
}

function body_strings(body: map<string, unknown>, key: string) -> string[] {
    let v = body.get(key);
    if (v == null) {
        []
    } else if let l: string[] = v {
        l
    } else {
        []
    }
}

function find_lease(acc: Acc, lease_id: string) -> Lease? {
    acc.leases.find((l) -> {
        l.lease_id == lease_id
    })
}

// Latest active, unexpired record for the entity in fold order. History
// (released/superseded/expired-marked) stays in acc.leases as evidence.
function current_lease(acc: Acc, entity: string, now_lc: int) -> Lease? {
    let out: Lease? = null;
    for (let l in acc.leases) {
        if (l.entity == entity && l.status == "active" && l.expires_lc > now_lc) {
            out = l;
        }
    }
    out
}

// Fencing gate shared by TaskTransition (reduce.baml) and WorkSubmit
// (verify.baml): no active lease -> open; active lease -> exact token echo.
function lease_fence_ok(acc: Acc, entity: string, now_lc: int, fencing: int?) -> bool {
    match (current_lease(acc, entity, now_lc)) {
        null => true,
        let l: Lease => match (fencing) {
            null => false,
            let f: int => f == l.fencing,
        },
    }
}

function apply_claim(acc: Acc, e: WireEvent) -> void {
    if let ttl: int = body_int(e.body, "ttl") {
        if let idem: string = body_string(e.body, "idem") {
            let epoch = body_int(e.body, "epoch") ?? 0;
            if let cur: Lease = current_lease(acc, e.entity, e.lc) {
                if (cur.holder == e.author && cur.idem == idem) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "idem-duplicate" });
                } else if (cur.holder == e.author && epoch <= cur.epoch) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "stale-epoch" });
                } else if (cur.holder == e.author) {
                    cur.status = "superseded";
                    acc.leases.push(
                        Lease {
                            entity: e.entity,
                            holder: e.author,
                            lease_id: e.id,
                            epoch: epoch,
                            fencing: e.lc,
                            ttl: ttl,
                            expires_lc: e.lc + ttl,
                            read_set: body_strings(e.body, "read_set"),
                            idem: idem,
                            status: "active",
                        },
                    );
                } else {
                    acc.excluded.push(
                        Excluded { event_id: e.id, reason: `lease-held: ${cur.holder}` },
                    );
                }
            } else {
                acc.leases.push(
                    Lease {
                        entity: e.entity,
                        holder: e.author,
                        lease_id: e.id,
                        epoch: epoch,
                        fencing: e.lc,
                        ttl: ttl,
                        expires_lc: e.lc + ttl,
                        read_set: body_strings(e.body, "read_set"),
                        idem: idem,
                        status: "active",
                    },
                );
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-idem" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-ttl" });
    }
}

function apply_renew(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "lease_ref") {
        if let l: Lease = find_lease(acc, ref) {
            if (l.holder != e.author) {
                acc.excluded.push(Excluded { event_id: e.id, reason: "not-holder" });
            } else if (l.status != "active" || l.expires_lc <= e.lc) {
                acc.excluded.push(Excluded { event_id: e.id, reason: "not-current" });
            } else {
                l.expires_lc = e.lc + l.ttl;
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-lease" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-lease-ref" });
    }
}

function apply_release(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "lease_ref") {
        if let l: Lease = find_lease(acc, ref) {
            if (l.holder != e.author) {
                acc.excluded.push(Excluded { event_id: e.id, reason: "not-holder" });
            } else if (l.status != "active") {
                acc.excluded.push(Excluded { event_id: e.id, reason: "not-current" });
            } else {
                l.status = "released";
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-lease" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-lease-ref" });
    }
}

// Derived expiry (never written): rebuild with expired marks. Runs once at
// finalize over the max admitted lc — during the fold, current_lease sees
// expiry live off each event's own lc.
function sweep_expiry(acc: Acc, max_lc: int) -> void {
    acc.leases
        = acc.leases.map((l) -> {
            if (l.status == "active" && l.expires_lc <= max_lc) {
                Lease { ...l, status: "expired" }
            } else {
                l
            }
        });
}

function claim_body(ttl: int, epoch: int, idem: string) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("ttl", ttl);
    let _ = b.set("epoch", epoch);
    let _ = b.set("idem", idem);
    b
}

function only_lease(r: Reduction) -> Lease {
    assert.equal(r.leases.length(), 1);
    r.leases[0]
}

test "claim creates an active lease keyed by claim lc" {
    let b = claim_body(100, 0, "a1");
    let _ = b.set("read_set", ["task:B"]);
    let r = reduce([wire("LeaseClaim", "task:A", 1, "e1", b, author = "did:key:z6Mk-alice")]);
    assert.equal(r.excluded.length(), 0);
    let l = only_lease(r);
    assert.equal(l.holder, "did:key:z6Mk-alice");
    assert.equal(l.fencing, 1);
    assert.equal(l.expires_lc, 101);
    assert.equal(l.status, "active");
    assert.equal(l.read_set.length(), 1);
    assert.equal(l.read_set[0], "task:B")
}

test "competing claim while held is excluded, first holder wins" {
    let events = [
        wire("LeaseClaim", "task:A", 1, "e1", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice"),
        wire("LeaseClaim", "task:A", 2, "e2", claim_body(100, 0, "b1"), author = "did:key:z6Mk-bob"),
    ];
    let r = reduce(events);
    assert.equal(r.leases.length(), 1);
    assert.equal(r.leases[0].holder, "did:key:z6Mk-alice");
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "lease-held: did:key:z6Mk-alice")
}

test "same holder plus same idem is an idempotent retry" {
    let events = [
        wire("LeaseClaim", "task:A", 1, "e1", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice"),
        wire("LeaseClaim", "task:A", 2, "e2", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice"),
    ];
    let r = reduce(events);
    assert.equal(r.leases.length(), 1);
    assert.equal(r.leases[0].status, "active");
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "idem-duplicate")
}

test "greater epoch supersedes, equal or lower epoch is stale" {
    let sup = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire(
                "LeaseClaim",
                "task:A",
                2,
                "e2",
                claim_body(100, 1, "a2"),
                author = "did:key:z6Mk-alice",
            ),
        ],
    );
    assert.equal(sup.excluded.length(), 0);
    assert.equal(sup.leases.length(), 2);
    assert.equal(sup.leases[0].status, "superseded");
    assert.equal(sup.leases[1].status, "active");
    assert.equal(sup.leases[1].fencing, 2);
    let stale = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 1, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire(
                "LeaseClaim",
                "task:A",
                2,
                "e2",
                claim_body(100, 1, "a2"),
                author = "did:key:z6Mk-alice",
            ),
        ],
    );
    assert.equal(stale.leases.length(), 1);
    assert.equal(stale.excluded.length(), 1);
    assert.equal(stale.excluded[0].reason, "stale-epoch")
}

test "renew extends expiry by the lease ttl, strangers are refused" {
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(10, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire(
                "LeaseRenew",
                "task:A",
                5,
                "e2",
                str_body("lease_ref", "e1"),
                author = "did:key:z6Mk-alice",
            ),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_lease(r).expires_lc, 15);
    let bad = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(10, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire(
                "LeaseRenew",
                "task:A",
                5,
                "e2",
                str_body("lease_ref", "e1"),
                author = "did:key:z6Mk-bob",
            ),
        ],
    );
    assert.equal(bad.excluded.length(), 1);
    assert.equal(bad.excluded[0].reason, "not-holder");
    let unknown = reduce([wire("LeaseRenew", "task:A", 5, "e2", str_body("lease_ref", "nope"))]);
    assert.equal(unknown.excluded.length(), 1);
    assert.equal(unknown.excluded[0].reason, "unknown-lease")
}

test "release frees the task, strangers cannot release" {
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire(
                "LeaseRelease",
                "task:A",
                2,
                "e2",
                str_body("lease_ref", "e1"),
                author = "did:key:z6Mk-alice",
            ),
            wire("LeaseClaim", "task:A", 3, "e3", claim_body(100, 0, "b1"), author = "did:key:z6Mk-bob"),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.leases.length(), 2);
    assert.equal(r.leases[0].status, "released");
    assert.equal(r.leases[1].holder, "did:key:z6Mk-bob");
    let bad = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire(
                "LeaseRelease",
                "task:A",
                2,
                "e2",
                str_body("lease_ref", "e1"),
                author = "did:key:z6Mk-bob",
            ),
        ],
    );
    assert.equal(bad.excluded.length(), 1);
    assert.equal(bad.excluded[0].reason, "not-holder")
}

test "expiry is derived: a later claim past ttl succeeds with no release" {
    let r = reduce(
        [
            wire("LeaseClaim", "task:A", 1, "e1", claim_body(5, 0, "a1"), author = "did:key:z6Mk-alice"),
            wire("LeaseClaim", "task:A", 10, "e2", claim_body(5, 0, "b1"), author = "did:key:z6Mk-bob"),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.leases.length(), 2);
    assert.equal(r.leases[0].status, "expired");
    assert.equal(r.leases[1].holder, "did:key:z6Mk-bob")
}

test "fenced transition passes, unfenced or stale fence is excluded" {
    let fenced: map<string, unknown> = {};
    let _ = fenced.set("to", "Doing");
    let _ = fenced.set("fencing", 1);
    let plain: map<string, unknown> = {};
    let _ = plain.set("to", "Doing");
    let wrong: map<string, unknown> = {};
    let _ = wrong.set("to", "Doing");
    let _ = wrong.set("fencing", 99);
    // No array-concat operator (`+` is numeric-only): build each case literally.
    let ok = reduce(
        [
            wire("TaskCreate", "task:A", 0, "e0", {}),
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire("TaskTransition", "task:A", 2, "e2", fenced),
        ],
    );
    assert.equal(ok.excluded.length(), 0);
    assert.equal(only_issue(ok).status, "Doing");
    let bare = reduce(
        [
            wire("TaskCreate", "task:A", 0, "e0", {}),
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire("TaskTransition", "task:A", 2, "e2", plain),
        ],
    );
    assert.equal(bare.excluded.length(), 1);
    assert.equal(bare.excluded[0].reason, "stale-fence");
    assert.equal(only_issue(bare).status, "Open");
    let stale = reduce(
        [
            wire("TaskCreate", "task:A", 0, "e0", {}),
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(100, 0, "a1"),
                author = "did:key:z6Mk-alice",
            ),
            wire("TaskTransition", "task:A", 2, "e2", wrong),
        ],
    );
    assert.equal(stale.excluded.length(), 1);
    assert.equal(stale.excluded[0].reason, "stale-fence")
}

test "claim without ttl or idem is excluded, not defaulted" {
    let no_ttl: map<string, unknown> = {};
    let _ = no_ttl.set("idem", "a1");
    let r1 = reduce([wire("LeaseClaim", "task:A", 1, "e1", no_ttl)]);
    assert.equal(r1.leases.length(), 0);
    assert.equal(r1.excluded[0].reason, "missing-ttl");
    let no_idem: map<string, unknown> = {};
    let _ = no_idem.set("ttl", 10);
    let r2 = reduce([wire("LeaseClaim", "task:A", 1, "e1", no_idem)]);
    assert.equal(r2.leases.length(), 0);
    assert.equal(r2.excluded[0].reason, "missing-idem")
}
