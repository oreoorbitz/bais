// ns_event/checkpoint — signed state snapshots (fusion v1, Phase 4,
// step 13; "ship in v1, not v3").
//
// A checkpoint is a tamper-evidence anchor over derived state, not a
// replacement for the log: {state_root, heads[], reducer_version} covers
// every event at or below `lc`, signed by the publisher (hub or peer key).
// Peers use it two ways: (1) recompute state_root from their own reduction
// and compare (divergence alarm — report failure mode #2); (2) fast
// bootstrap — import the materialized tables + checkpoint, then pull only
// the delta (see hub GET /snapshot, POST /prune).
//
// state_root is host-computed (BAML has no crypto): sha256 over the
// JCS-canonical JSON of the materialized reduction
// {issues, rels, leases, submissions, verifications, budgets, costs,
// conflicts} — see computeStateRoot in hub.ts, shared by publish and
// verify so the two cannot drift.
//
// Body contract:
//   CheckpointPublish { state_root: string (64 hex chars),
//                       heads: string[] (covered event ids, non-empty),
//                       reducer_version: string, lc: int }
// Rules:
// - Missing/empty fields are excluded, never defaulted.
// - A checkpoint naming a DIFFERENT reducer version than this binary is
//   excluded `version-skew`: replaying an old log under new merge rules
//   silently changes derived state (report §5), so skew is evidence with
//   a name, not a quiet accept.
// - Checkpoints accumulate as evidence; the LATEST (max lc) is canonical
//   for prune/bootstrap. Overlapping checkpoints are fine.

class Checkpoint {
    id: string @description("CheckpointPublish event id (bafy...)"),
    publisher: string @description("did:key:... that signed it"),
    lc: int @description("max covered lc — every event at or below is in state_root"),
    state_root: string @description("hex sha256 over canonical materialization"),
    heads: string[] @description("covered event ids"),
    reducer_version: string,
}

function apply_checkpoint(acc: Acc, e: WireEvent) -> void {
    if let root: string = body_string(e.body, "state_root") {
        let heads = body_strings(e.body, "heads");
        if let version: string = body_string(e.body, "reducer_version") {
            if let at: int = body_int(e.body, "lc") {
                if (root == "" || heads.length() == 0) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "missing-checkpoint-field" });
                } else if (version != reducer_version()) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "version-skew" });
                } else {
                    acc.checkpoints.push(
                        Checkpoint {
                            id: e.id,
                            publisher: e.author,
                            lc: at,
                            state_root: root,
                            heads: heads,
                            reducer_version: version,
                        },
                    );
                }
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "missing-checkpoint-field" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-checkpoint-field" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-checkpoint-field" });
    }
}

function checkpoint_body(root: string, heads: string[], version: string, lc: int) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("state_root", root);
    let _ = b.set("heads", heads);
    let _ = b.set("reducer_version", version);
    let _ = b.set("lc", lc);
    b
}

function only_checkpoint(r: Reduction) -> Checkpoint {
    assert.equal(r.checkpoints.length(), 1);
    r.checkpoints[0]
}

test "valid checkpoint records with publisher and coverage" {
    let r = reduce(
        [wire("CheckpointPublish", "task:A", 5, "e1", checkpoint_body("ab12", ["e0"], "bais.reduce@1", 4))],
    );
    assert.equal(r.excluded.length(), 0);
    let c = only_checkpoint(r);
    assert.equal(c.lc, 4);
    assert.equal(c.state_root, "ab12");
    assert.equal(c.heads.length(), 1);
    assert.equal(c.reducer_version, "bais.reduce@1")
}

test "checkpoint with missing fields is excluded" {
    let no_root: map<string, unknown> = {};
    let _ = no_root.set("heads", ["e0"]);
    let r1 = reduce([wire("CheckpointPublish", "task:A", 5, "e1", no_root)]);
    assert.equal(r1.checkpoints.length(), 0);
    assert.equal(r1.excluded[0].reason, "missing-checkpoint-field");
    let empty_heads = checkpoint_body("ab12", [], "bais.reduce@1", 4);
    let r2 = reduce([wire("CheckpointPublish", "task:A", 5, "e2", empty_heads)]);
    assert.equal(r2.excluded[0].reason, "missing-checkpoint-field")
}

test "foreign reducer version is version-skew, not silent accept" {
    let r = reduce(
        [wire("CheckpointPublish", "task:A", 5, "e1", checkpoint_body("ab12", ["e0"], "bais.reduce@99", 4))],
    );
    assert.equal(r.checkpoints.length(), 0);
    assert.equal(r.excluded[0].reason, "version-skew")
}

test "checkpoints accumulate, latest wins by lc" {
    let r = reduce(
        [
            wire("CheckpointPublish", "task:A", 5, "e1", checkpoint_body("aa", ["e0"], "bais.reduce@1", 4)),
            wire("CheckpointPublish", "task:A", 9, "e2", checkpoint_body("bb", ["e0", "e1"], "bais.reduce@1", 8)),
        ],
    );
    assert.equal(r.checkpoints.length(), 2);
    assert.equal(r.checkpoints[1].state_root, "bb")
}
