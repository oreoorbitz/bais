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
//                  read_set: string[] = [],
//                  ttl_wall_ms?: int (wall TTL, optional),
//                  expires_wall?: string (RFC3339 UTC Z, hub-stamped) }
//   LeaseRenew   { lease_ref: string (claim event id),
//                  expires_wall?: string (hub restamp, wall leases only) }
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
// - Wall-clock companion (bi#42): a claim may ALSO carry a wall bound
//   (ttl_wall_ms + hub-stamped expires_wall). Liveness is the min() of the
//   two clocks — a lease is live iff BOTH bounds still cover the observation
//   point, expired when EITHER lapses. Lc advances only on admission, so on
//   a quiet log the wall bound is what frees a dead holder's task; the next
//   admitted event (e.g. the reclaim claim itself) observes the lapse via
//   its own (lc, ts) and the sweep confirms it at finalize.
//   Split: the HOST owns clocks (stamps expires_wall = claim ts +
//   ttl_wall_ms, restamps on renew from the lease's own ttl_wall_ms — never
//   from client input, so holders cannot inflate); BAML owns this min()
//   comparison. WireEvent.ts is advisory and author-controlled on the sync
//   path, so wall bounds resolve to ~ the 1h skew-gate precision across
//   hostile peers — the coordinator path (hub-stamped ts) is exact.
//   Shape constraint: expires_wall MUST be fixed-shape RFC3339 UTC Z
//   (hub `Date.toISOString()`), where lexicographic order == chronological
//   order. Missing expires_wall (or missing observation wall) degrades to
//   pure lc semantics — legacy claims keep reducing identically.
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
    ttl_wall_ms: int? @description("wall-clock TTL in ms (optional; absent = lc-only lease)"),
    expires_wall: string? @description(
        "RFC3339 UTC Z wall expiry, hub-stamped (host owns clocks); null = lc-only",
    ),
    read_set: string[],
    idem: string @description("client idempotency key: same holder + same idem is a retry"),
    status: string @description("active | released | expired | superseded"),
}

// Lists cross the host boundary as JSON text: over the TS→BAML bridge,
// a JS array inside map<string,unknown> never narrows to string[] (and
// an integer-valued JS number never narrows to float) — BAML-native
// callers are unaffected, hence the dual path. Hosts MUST JSON-encode
// list bodies (hub encodeBodyArrays does this centrally); BAML-native
// callers may pass real arrays. Malformed JSON counts as missing.
function body_string_list(body: map<string, unknown>, key: string) -> string[]? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let l: string[] = v {
        l
    } else if let s: string = v {
        baml.json.from_string<string[]>(s) catch_all (e) {
            _ => null
        }
    } else {
        null
    }
}

function find_lease(acc: Acc, lease_id: string) -> Lease? {
    acc.leases.find((l) -> {
        l.lease_id == lease_id
    })
}

// Wall bound lapses at or after the stamped expiry (fixed-shape RFC3339
// UTC Z compares lexicographically == chronologically). A null lease bound
// or a null observation wall means "no wall evidence" -> wall-inert.
function wall_lapsed(expires_wall: string?, now_wall: string?) -> bool {
    if let w: string = expires_wall {
        if let n: string = now_wall {
            n >= w
        } else {
            false
        }
    } else {
        false
    }
}

// Min() liveness (bi#42, BAML owns this): live iff status is active AND the
// lc bound covers AND the wall bound covers. now_wall null (or a lease
// without expires_wall) degrades to pure lc semantics.
function lease_live(l: Lease, now_lc: int, now_wall: string? = null) -> bool {
    if (l.status != "active" || l.expires_lc <= now_lc) {
        false
    } else if (wall_lapsed(l.expires_wall, now_wall)) {
        false
    } else {
        true
    }
}

// Latest live record for the entity in fold order. History
// (released/superseded/expired-marked) stays in acc.leases as evidence.
// During the fold callers pass the observing event's own (lc, ts), so a
// quiet-log lapse is seen by the next admitted event itself.
function current_lease(acc: Acc, entity: string, now_lc: int, now_wall: string? = null) -> Lease? {
    let out: Lease? = null;
    for (let l in acc.leases) {
        if (l.entity == entity && lease_live(l, now_lc, now_wall = now_wall)) {
            out = l;
        }
    }
    out
}

// Fencing gate shared by TaskTransition (reduce.baml) and WorkSubmit
// (verify.baml): no live lease -> open; live lease -> exact token echo.
function lease_fence_ok(
    acc: Acc,
    entity: string,
    now_lc: int,
    fencing: int?,
    now_wall: string? = null,
) -> bool {
    match (current_lease(acc, entity, now_lc, now_wall = now_wall)) {
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
            if let cur: Lease = current_lease(acc, e.entity, e.lc, now_wall = e.ts) {
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
                            ttl_wall_ms: body_int(e.body, "ttl_wall_ms"),
                            expires_wall: body_string(e.body, "expires_wall"),
                            read_set: body_string_list(e.body, "read_set") ?? [],
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
                        ttl_wall_ms: body_int(e.body, "ttl_wall_ms"),
                        expires_wall: body_string(e.body, "expires_wall"),
                        read_set: body_string_list(e.body, "read_set") ?? [],
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
            } else if (l.status != "active" || l.expires_lc <= e.lc || wall_lapsed(l.expires_wall, e.ts)) {
                acc.excluded.push(Excluded { event_id: e.id, reason: "not-current" });
            } else {
                l.expires_lc = e.lc + l.ttl;
                // Wall restamp rides the renew body (hub recomputes it from
                // the lease's own ttl_wall_ms — never from client input).
                // Absent on lc-only leases: the wall bound stays absent.
                if let w: string = body_string(e.body, "expires_wall") {
                    l.expires_wall = w;
                }
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
// finalize over the max admitted lc AND the max admitted wall ts — during
// the fold, current_lease sees expiry live off each event's own (lc, ts).
function sweep_expiry(acc: Acc, max_lc: int, max_wall: string? = null) -> void {
    acc.leases
        = acc.leases.map((l) -> {
            if (
                l.status == "active"
                    && (l.expires_lc <= max_lc || wall_lapsed(l.expires_wall, max_wall))
            ) {
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

test "hosts send read_set JSON-encoded (bridge arrays do not narrow)" {
    let b = claim_body(100, 0, "a1");
    let _ = b.set("read_set", "[\"task:B\",\"task:C\"]");
    let r = reduce([wire("LeaseClaim", "task:A", 1, "e1", b, author = "did:key:z6Mk-alice")]);
    assert.equal(r.excluded.length(), 0);
    let l = only_lease(r);
    assert.equal(l.read_set.length(), 2);
    assert.equal(l.read_set[1], "task:C");
    // Malformed JSON counts as missing, not as a crash.
    let bad = claim_body(100, 0, "a2");
    let _ = bad.set("read_set", "nope[");
    let r2 = reduce([wire("LeaseClaim", "task:A", 1, "e1", bad, author = "did:key:z6Mk-alice")]);
    assert.equal(r2.excluded.length(), 0);
    assert.equal(only_lease(r2).read_set.length(), 0)
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

// bi#42 wall-clock arms: fixed-shape RFC3339 UTC Z throughout (millis
// shape, as the hub stamps). The lc ttl is deliberately huge in every arm
// so only the wall bound can fire — lc must never free these leases.
function wall_claim_body(
    ttl: int,
    idem: string,
    ttl_wall_ms: int,
    expires_wall: string,
) -> map<string, unknown> {
    let b = claim_body(ttl, 0, idem);
    let _ = b.set("ttl_wall_ms", ttl_wall_ms);
    let _ = b.set("expires_wall", expires_wall);
    b
}

test "wall expiry frees the task while the lc bound still covers" {
    let t0 = "2026-09-03T00:00:00.000Z";
    let bound = "2026-09-03T00:01:00.000Z";
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                wall_claim_body(1000000, "a1", 60000, bound),
                author = "did:key:z6Mk-alice",
                ts = t0,
            ),
            // lc 2 is deep inside the million-tick grant — only the wall
            // lapse (ts past the stamped bound) frees the task.
            wire(
                "LeaseClaim",
                "task:A",
                2,
                "e2",
                wall_claim_body(1000000, "b1", 60000, "2026-09-03T00:02:01.000Z"),
                author = "did:key:z6Mk-bob",
                ts = "2026-09-03T00:01:01.000Z",
            ),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.leases.length(), 2);
    assert.equal(r.leases[0].status, "expired");
    assert.equal(r.leases[1].holder, "did:key:z6Mk-bob");
    assert.equal(r.leases[1].status, "active")
}

test "claim inside the wall bound is still held" {
    let t0 = "2026-09-03T00:00:00.000Z";
    let bound = "2026-09-03T00:01:00.000Z";
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                wall_claim_body(1000000, "a1", 60000, bound),
                author = "did:key:z6Mk-alice",
                ts = t0,
            ),
            wire(
                "LeaseClaim",
                "task:A",
                2,
                "e2",
                wall_claim_body(1000000, "b1", 60000, bound),
                author = "did:key:z6Mk-bob",
                ts = "2026-09-03T00:00:59.000Z",
            ),
        ],
    );
    assert.equal(r.leases.length(), 1);
    assert.equal(r.leases[0].holder, "did:key:z6Mk-alice");
    assert.equal(r.leases[0].status, "active");
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "lease-held: did:key:z6Mk-alice")
}

test "wall lapse is exact at the stamped instant" {
    let bound = "2026-09-03T00:01:00.000Z";
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                wall_claim_body(1000000, "a1", 60000, bound),
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:00.000Z",
            ),
            wire(
                "LeaseClaim",
                "task:A",
                2,
                "e2",
                wall_claim_body(1000000, "b1", 60000, bound),
                author = "did:key:z6Mk-bob",
                ts = bound,
            ),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.leases[0].status, "expired");
    assert.equal(r.leases[1].holder, "did:key:z6Mk-bob")
}

test "live renew extends both bounds and keeps competitors out" {
    let bound = "2026-09-03T00:01:00.000Z";
    let bound2 = "2026-09-03T00:01:30.000Z";
    let renew_b: map<string, unknown> = {};
    let _ = renew_b.set("lease_ref", "e1");
    let _ = renew_b.set("expires_wall", bound2);
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                wall_claim_body(1000000, "a1", 60000, bound),
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:00.000Z",
            ),
            wire(
                "LeaseRenew",
                "task:A",
                5,
                "e2",
                renew_b,
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:30.000Z",
            ),
            // Past the ORIGINAL bound but inside the restamp: still held.
            wire(
                "LeaseClaim",
                "task:A",
                6,
                "e3",
                wall_claim_body(1000000, "b1", 60000, bound2),
                author = "did:key:z6Mk-bob",
                ts = "2026-09-03T00:01:01.000Z",
            ),
        ],
    );
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "lease-held: did:key:z6Mk-alice");
    assert.equal(r.leases.length(), 1);
    assert.equal(r.leases[0].status, "active");
    assert.equal(r.leases[0].expires_lc, 1000005);
    assert.equal(r.leases[0].expires_wall, bound2)
}

test "renew past wall expiry is refused even though lc covers" {
    let bound = "2026-09-03T00:01:00.000Z";
    let renew_b: map<string, unknown> = {};
    let _ = renew_b.set("lease_ref", "e1");
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                wall_claim_body(1000000, "a1", 60000, bound),
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:00.000Z",
            ),
            wire(
                "LeaseRenew",
                "task:A",
                5,
                "e2",
                renew_b,
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:01:01.000Z",
            ),
        ],
    );
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "not-current");
    assert.equal(r.leases[0].status, "expired")
}

test "lc-only leases ignore wall readings" {
    let r = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(1000000, 0, "a1"),
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:00.000Z",
            ),
            // A far-future observer changes nothing without a wall bound.
            wire(
                "LeaseClaim",
                "task:A",
                2,
                "e2",
                claim_body(1000000, 0, "b1"),
                author = "did:key:z6Mk-bob",
                ts = "2030-01-01T00:00:00.000Z",
            ),
        ],
    );
    assert.equal(r.leases.length(), 1);
    assert.equal(r.leases[0].holder, "did:key:z6Mk-alice");
    assert.equal(r.leases[0].status, "active");
    assert.equal(r.leases[0].expires_wall, null);
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "lease-held: did:key:z6Mk-alice");
    // Renew without a restamp keeps the lease lc-only.
    let renew_b: map<string, unknown> = {};
    let _ = renew_b.set("lease_ref", "e1");
    let r2 = reduce(
        [
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                claim_body(1000000, 0, "a1"),
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:00.000Z",
            ),
            wire(
                "LeaseRenew",
                "task:A",
                5,
                "e2",
                renew_b,
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:30.000Z",
            ),
        ],
    );
    assert.equal(r2.excluded.length(), 0);
    assert.equal(only_lease(r2).expires_wall, null)
}

test "fencing opens once the wall lapses" {
    let bound = "2026-09-03T00:01:00.000Z";
    let plain: map<string, unknown> = {};
    let _ = plain.set("to", "Doing");
    let r = reduce(
        [
            wire("TaskCreate", "task:A", 0, "e0", {}),
            wire(
                "LeaseClaim",
                "task:A",
                1,
                "e1",
                wall_claim_body(1000000, "a1", 60000, bound),
                author = "did:key:z6Mk-alice",
                ts = "2026-09-03T00:00:00.000Z",
            ),
            // No fencing echo, but the lease is wall-dead: gate is open.
            wire("TaskTransition", "task:A", 2, "e2", plain, ts = "2026-09-03T00:01:01.000Z"),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_issue(r).status, "Doing");
    assert.equal(r.leases[0].status, "expired")
}
