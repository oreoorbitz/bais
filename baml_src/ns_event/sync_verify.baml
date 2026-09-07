// ns_event/sync_verify — adversarial sync refusal predicates (bi#37, Mode A).
//
// The sync fault surface as a TESTED refusal surface. The host owns transport
// (appendForeignEvents stages, refreshProjectionTables projects); BAML owns
// these pure verdicts over reducer state. Every predicate returns null for
// admit/open and a NAMED refusal reason otherwise. Negative tests pin each
// refusal; bais/scripts/sync-adversarial.mjs proves the same reasons on the
// host path and their visibility in oversight (read-only there).
//
// Lane split (do not move):
// - dispatch.baml owns the type routing table; delta.baml owns diff policy;
// - lease.baml owns the min() liveness (lease_live/wall_lapsed/current_lease);
// - checkpoint.baml owns field/version gates; cap.baml owns grant liveness.
// This file only ADDS the sync-admission verdicts that consult those owners —
// it changes no existing rule, so every existing log reduces identically.
//
// Mode B (signature-required default) is NOT built here: requireSigs already
// exists as an opt-in host flag (drill (d) G-sig pins it); flipping the
// default needs key plumbing across the CLI/Hub/MCP surfaces — a follow-up
// issue if this suite triggers it. See NOTES.md in the delivery bundle.
//
// RED-CHECK record (bi#57, observed 2026-09-06, perturb + restore):
// - Hunk: lease_token_verdict dead-token arm weakened to `null` (admit).
// - Expected: the expired-lease negatives fail FOR THAT REASON — the dead
//   token "passes through" (verdict null = integrates) instead of refused.
// - Observed: `FAIL root.event::expired lc lease refuses the dead token
//   echo, bare reclaim stays open` + `FAIL root.event::wall-expired lease
//   refuses the dead token echo past the bound`, aggregate
//   `assertion failed: left = null, right = "expired-lease"`; 207 passed,
//   2 failed, 209 total — nothing else fires.
// - Restored (cmp-identical to pristine): 209 passed, 0 failed.
//   A predicate that cannot go red is camouflage.

// Latest lease record for the entity in fold order, live OR dead.
// current_lease (lease.baml) answers "who holds now"; the refusal surface
// needs the corpse too — a fencing echo of a dead token must name its
// killer (expired-lease), not ride the open gate silently.
function latest_lease_for(leases: Lease[], entity: string) -> Lease? {
    let out: Lease? = null;
    for (let l in leases) {
        if (l.entity == entity) {
            out = l;
        }
    }
    out
}

// Lease-token verdict for a sync-arriving write that touches a leased task.
// - No record ever: open (null) — free task, reclaim path.
// - Live lease (both clocks cover): exact fencing echo or "stale-fence"
//   (mirrors lease_fence_ok — the owning gate; t_live_token_agrees_* pins
//   the agreement both directions so neither check is vacuous).
// - Dead record (expired / released / superseded with no live successor):
//   echoing the dead token is "expired-lease" — reclaim must claim fresh,
//   never ride the corpse. Bare (no echo) stays open: the wall/lc DID free
//   the task, and the next admitted event is the observation (bi#42).
function lease_token_verdict(
    leases: Lease[],
    entity: string,
    fencing: int?,
    now_lc: int,
    now_wall: string? = null,
) -> string? {
    if let l: Lease = latest_lease_for(leases, entity) {
        if (lease_live(l, now_lc, now_wall = now_wall)) {
            match (fencing) {
                null => "stale-fence",
                let f: int => if (f == l.fencing) {
                    null
                } else {
                    "stale-fence"
                },
            }
        } else if let f: int = fencing {
            if (f == l.fencing) {
                "expired-lease"
            } else {
                null
            }
        } else {
            null
        }
    } else {
        null
    }
}

// Checkpoint verdict for a sync-arriving (or re-anchor) candidate.
// Field/version arms mirror apply_checkpoint (the owning gate); the
// staleness arm is new: a candidate at/below the prune floor (anchor_lc > 0
// means history there may be gone) is "stale-checkpoint" — re-anchoring on
// it is refused, never a quiet rewind. anchor_lc == 0 means never pruned,
// so no candidate is stale. Boundary: at == anchor re-anchors the same
// checkpoint (idempotent no-op) — only strictly-below is stale.
function checkpoint_sync_verdict(
    state_root: string,
    heads: string[],
    version: string,
    at_lc: int,
    anchor_lc: int,
) -> string? {
    if (state_root == "" || heads.length() == 0) {
        "missing-checkpoint-field"
    } else if (version != reducer_version()) {
        "version-skew"
    } else if (anchor_lc > 0 && at_lc < anchor_lc) {
        "stale-checkpoint"
    } else {
        null
    }
}

// Pub-cursor verdict for a sync-arriving subscriber poll (GET /pub ?since=).
// Mirrors the host gap_unknown rule (hub owns retention windows, BAML owns
// this verdict): since < 0 is "from the start" (no cursor, no gap); without
// retention pressure (floor null) every cursor replays; a non-negative
// cursor below the gap floor names evicted history the subscriber never saw
// and will never replay — "gap-unknown", re-bootstrap via the durable log.
// Today an evicted cursor replays empty and passes silently; this predicate
// is the name the host consults to stay loud.
function pub_cursor_verdict(since: int, oldest: int?, floor: int?) -> string? {
    if (since < 0) {
        null
    } else if let f: int = floor {
        if (since < f) {
            "gap-unknown"
        } else {
            null
        }
    } else {
        null
    }
}

// Sync-poll verdict for an author cursor the log has never seen
// (GET /sync ?since_seq= with an unknown author). Known authors replay or
// report empty against their chain; an unknown author is not "caught up on
// everything" — it is "unknown-subscriber", and silence would promote a
// typo'd (or spoofed) identity to full sync standing.
function sync_poll_verdict(author: string, known_authors: string[]) -> string? {
    if (known_authors.includes(author)) {
        null
    } else {
        "unknown-subscriber"
    }
}

// Replay verdict for a sync-arriving event id (hub checkEarly, first branch):
// unknown id is new (null — downstream gates still apply); known id with
// identical bytes is the benign re-pull — "silent-skip", never evidence;
// known id with different bytes is a tampered replay — "replay-tamper",
// parked in rejected_evidence (slice-A collision parking) so the attack
// itself is oversight-visible. A pure duplicate (same id, same verdict
// already stored) is a no-op: the first copy stands.
function replay_verdict(known_id: bool, same_bytes: bool) -> string? {
    if (!known_id) {
        null
    } else if (same_bytes) {
        "silent-skip"
    } else {
        "replay-tamper"
    }
}

// Replay depth: how many of the arriving ids are actually new. A full
// redelivery of a settled (Done) task's event set has depth 0 — nothing to
// admit, nothing to refuse, projection identical. The drill asserts this on
// the host path; this helper is the offline form the tests pin.
function replay_depth(new_ids: string[], known_ids: string[]) -> int {
    let n = 0;
    for (let id in new_ids) {
        if (!known_ids.includes(id)) {
            n = n + 1;
        }
    }
    n
}

test "expired lc lease refuses the dead token echo, bare reclaim stays open" {
    let r = reduce(
        [
            wire("LeaseClaim", "task:A", 1, "e1", claim_body(5, 0, "a1"), author = "did:key:z6Mk-alice"),
            wire("TaskCreate", "task:B", 10, "e2", str_body("title", "b")),
        ],
    );
    assert.equal(r.leases.length(), 1);
    assert.equal(r.leases[0].status, "expired");
    assert.equal(lease_token_verdict(r.leases, "task:A", 1, 10), "expired-lease");
    assert.equal(lease_token_verdict(r.leases, "task:A", null, 10), null);
    assert.equal(lease_token_verdict(r.leases, "task:A", 99, 10), null);
    assert.equal(lease_token_verdict(r.leases, "task:ZZZ", 1, 10), null)
}

test "wall-expired lease refuses the dead token echo past the bound" {
    let cb = claim_body(1000000, 0, "w1");
    let _ = cb.set("ttl_wall_ms", 60000);
    let _ = cb.set("expires_wall", "2026-09-04T00:01:00Z");
    // No live successor: the quiet log's next event (unrelated entity) is
    // the observation that sees the wall lapse, and the sweep confirms it.
    let dead = reduce(
        [
            wire(
                "LeaseClaim",
                "task:W",
                9100,
                "e1",
                cb,
                author = "did:key:z6Mk-alice",
                ts = "2026-09-04T00:00:00Z",
            ),
            wire("TaskCreate", "task:OTHER", 9101, "e2", str_body("title", "b"), ts = "2026-09-04T00:02:00Z"),
        ],
    );
    assert.equal(dead.leases.length(), 1);
    assert.equal(dead.leases[0].status, "expired");
    assert.equal(
        lease_token_verdict(dead.leases, "task:W", 9100, 9101, now_wall = "2026-09-04T00:02:00Z"),
        "expired-lease",
    );
    assert.equal(
        lease_token_verdict(dead.leases, "task:W", null, 9101, now_wall = "2026-09-04T00:02:00Z"),
        null,
    );
    // With a live successor the old token is stale-fence, not expired-lease:
    // the task is held, and the echo names the wrong epoch.
    let rival = claim_body(1000000, 0, "w2");
    let _ = rival.set("ttl_wall_ms", 60000);
    let _ = rival.set("expires_wall", "2026-09-04T00:03:00Z");
    let reclaimed = reduce(
        [
            wire(
                "LeaseClaim",
                "task:W",
                9100,
                "e1",
                cb,
                author = "did:key:z6Mk-alice",
                ts = "2026-09-04T00:00:00Z",
            ),
            wire(
                "LeaseClaim",
                "task:W",
                9101,
                "e2",
                rival,
                author = "did:key:z6Mk-bob",
                ts = "2026-09-04T00:02:00Z",
            ),
        ],
    );
    assert.equal(reclaimed.leases.length(), 2);
    assert.equal(reclaimed.leases[0].status, "expired");
    assert.equal(reclaimed.leases[1].holder, "did:key:z6Mk-bob");
    assert.equal(
        lease_token_verdict(reclaimed.leases, "task:W", 9100, 9101, now_wall = "2026-09-04T00:02:00Z"),
        "stale-fence",
    );
    assert.equal(
        lease_token_verdict(reclaimed.leases, "task:W", 9101, 9101, now_wall = "2026-09-04T00:02:00Z"),
        null,
    )
}

test "live lease agrees with the owning fence gate both directions" {
    let r = reduce(
        [
            wire("LeaseClaim", "task:A", 1, "e1", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice"),
        ],
    );
    assert.equal(r.leases[0].status, "active");
    assert.equal(lease_token_verdict(r.leases, "task:A", 1, 5), null);
    assert.equal(lease_token_verdict(r.leases, "task:A", 99, 5), "stale-fence");
    assert.equal(lease_token_verdict(r.leases, "task:A", null, 5), "stale-fence");
    let fenced: map<string, unknown> = {};
    let _ = fenced.set("to", "Doing");
    let _ = fenced.set("fencing", 1);
    let plain: map<string, unknown> = {};
    let _ = plain.set("to", "Doing");
    let create = wire("TaskCreate", "task:A", 2, "e9", str_body("title", "a"));
    let ok = reduce(
        [
            wire("LeaseClaim", "task:A", 1, "e1", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice"),
            create,
            wire("TaskTransition", "task:A", 3, "e3", fenced),
        ],
    );
    assert.equal(ok.excluded.length(), 0);
    let bare = reduce(
        [
            wire("LeaseClaim", "task:A", 1, "e1", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice"),
            create,
            wire("TaskTransition", "task:A", 3, "e3", plain),
        ],
    );
    assert.equal(bare.excluded[0].reason, "stale-fence")
}

test "stale checkpoint below the prune floor is refused, same-anchor re-anchors" {
    assert.equal(checkpoint_sync_verdict("ab12", ["e0"], "bais.reduce@1", 4, 8), "stale-checkpoint");
    assert.equal(checkpoint_sync_verdict("ab12", ["e0"], "bais.reduce@1", 8, 8), null);
    assert.equal(checkpoint_sync_verdict("ab12", ["e0"], "bais.reduce@1", 9, 8), null);
    assert.equal(checkpoint_sync_verdict("ab12", ["e0"], "bais.reduce@1", 4, 0), null);
    assert.equal(checkpoint_sync_verdict("ab12", ["e0"], "bais.reduce@99", 9, 8), "version-skew");
    assert.equal(checkpoint_sync_verdict("ab12", [], "bais.reduce@1", 9, 8), "missing-checkpoint-field");
    assert.equal(checkpoint_sync_verdict("", ["e0"], "bais.reduce@1", 9, 8), "missing-checkpoint-field")
}

test "evicted pub cursor is gap-unknown, live cursors replay" {
    assert.equal(pub_cursor_verdict(-1, oldest = null, floor = null), null);
    assert.equal(pub_cursor_verdict(3, oldest = 0, floor = 5), "gap-unknown");
    assert.equal(pub_cursor_verdict(5, oldest = 0, floor = 5), null);
    assert.equal(pub_cursor_verdict(7, oldest = 0, floor = 5), null);
    assert.equal(pub_cursor_verdict(3, oldest = null, floor = null), null);
    assert.equal(pub_cursor_verdict(0, oldest = 0, floor = 5), "gap-unknown")
}

test "unknown sync poller is unknown-subscriber, known authors pass" {
    let known = ["did:key:z6Mk-alice", "did:key:z6Mk-bob"];
    assert.equal(sync_poll_verdict("did:key:z6Mk-alice", known), null);
    assert.equal(sync_poll_verdict("did:key:z6Mk-mallory", known), "unknown-subscriber");
    assert.equal(sync_poll_verdict("did:key:z6Mk-mallory", []), "unknown-subscriber")
}

test "replay names the benign re-pull and the tampered replay apart" {
    assert.equal(replay_verdict(false, false), null);
    assert.equal(replay_verdict(false, true), null);
    assert.equal(replay_verdict(true, true), "silent-skip");
    assert.equal(replay_verdict(true, false), "replay-tamper")
}

test "tampered replay is evidence through the owning dispatch, never state" {
    let create = wire("TaskCreate", "task:A", 1, "e1", str_body("title", "a"));
    let tampered = wire(
        "TaskSet",
        "task:A",
        2,
        "e2",
        str_body("title", "tampered"),
        admitted = false,
        drop_reason = "replay-tamper",
    );
    let r = reduce([create, tampered]);
    assert.equal(only_issue(r).title, "a");
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "not-admitted: replay-tamper")
}

test "done task redelivery has replay depth zero" {
    let log = [
        wire("TaskCreate", "task:A", 1, "e1", str_body("title", "a")),
        wire("TaskTransition", "task:A", 2, "e2", str_body("to", "Doing")),
        wire("TaskTransition", "task:A", 3, "e3", str_body("to", "Done")),
    ];
    let r = reduce(log);
    assert.equal(only_issue(r).status, "Done");
    let ids = log.map((e) -> {
        e.id
    });
    assert.equal(replay_depth(ids, ids), 0);
    assert.equal(replay_depth([], ids), 0);
    assert.equal(replay_depth(["e9"], ids), 1)
}

test "no-op subscriber noise claims nothing and leaves no trace" {
    let r = reduce(
        [
            wire("Heartbeat", "task:A", 1, "e1", {}),
            wire("Progress", "task:A", 2, "e2", {}),
            wire("Heartbeat", "task:A", 3, "e3", {}),
        ],
    );
    assert.equal(r.issues.length(), 0);
    assert.equal(r.leases.length(), 0);
    assert.equal(r.submissions.length(), 0);
    assert.equal(r.excluded.length(), 0)
}
