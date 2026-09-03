// ns_event/verify — work submission and verification (fusion v1, Phase 3,
// step 10).
//
// Split done: the producer writes WorkSubmit{task, evidence}, a DIFFERENT
// principal writes VerifyRecord{submit_ref, verdict}, and WorkAccept closes
// the loop by linking accept verdicts. The reducer enforces producer !=
// verifier directly (self-verify is excluded); capability scopes (Phase 5)
// will additionally gate WHO may verify.
//
// Body contracts:
//   WorkSubmit   { evidence: string[] (artifact cids + ci refs, non-empty),
//                  fencing: int? (required iff the task is leased) }
//   VerifyRecord { submit_ref: string (WorkSubmit event id),
//                  verdict: string ("accept" | "reject"),
//                  method: string? (e.g. "ci", "human-review", "repro") }
//   WorkAccept   { verify_refs: string[] (VerifyRecord event ids, non-empty) }
//   WorkReject   { submit_ref: string (WorkSubmit event id) }
//
// Rules:
// - Submit on a leased task needs the fencing echo (same gate as
//   TaskTransition). Evidence is mandatory — a submit with nothing to
//   verify against is excluded `missing-evidence`.
// - Verify targets a known submit (`unknown-submit`), carries a known
//   verdict (`unknown-verdict`), is not the producer (`self-verify`), and
//   is not a repeat by the same verifier (`dupe-verify`).
// - Accept links accept verdicts for THIS task's submits only
//   (`foreign-ref`), at least one (`missing-verify-refs`); a reject
//   verdict in the set fails the whole accept (`reject-ref`). Idempotent:
//   re-accepting an accepted submit is a no-op.
// - Reject marks a submit rejected when the author is the producer
//   (withdraw) or a verifier with a recorded reject verdict on it;
//   otherwise `reject-denied`.

class Submission {
    submit_id: string @description("WorkSubmit event id (bafy...)"),
    entity: string @description("task:01J... the work claims to complete"),
    producer: string @description("did:key:... that submitted"),
    evidence: string[],
    status: string @description("submitted | accepted | rejected"),
}

class Verification {
    verify_id: string @description("VerifyRecord event id (bafy...)"),
    submit_id: string @description("WorkSubmit event id under verdict"),
    verifier: string @description("did:key:... — never the producer"),
    verdict: string @description("accept | reject"),
    method: string?,
}

function find_submission(acc: Acc, submit_id: string) -> Submission? {
    acc.submissions.find((s) -> {
        s.submit_id == submit_id
    })
}

function find_verification(acc: Acc, verify_id: string) -> Verification? {
    acc.verifications.find((v) -> {
        v.verify_id == verify_id
    })
}

function apply_submit(acc: Acc, e: WireEvent) -> void {
    if (!lease_fence_ok(acc, e.entity, e.lc, body_int(e.body, "fencing"))) {
        acc.excluded.push(Excluded { event_id: e.id, reason: "stale-fence" });
    } else if let evidence: string[] = body_string_list(e.body, "evidence") {
        if (evidence.length() == 0) {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-evidence" });
        } else {
            acc.submissions.push(
                Submission {
                    submit_id: e.id,
                    entity: e.entity,
                    producer: e.author,
                    evidence: evidence,
                    status: "submitted",
                },
            );
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-evidence" });
    }
}

function apply_verify(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "submit_ref") {
        if let verdict: string = body_string(e.body, "verdict") {
            if (verdict != "accept" && verdict != "reject") {
                acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-verdict" });
            } else if let s: Submission = find_submission(acc, ref) {
                if (s.producer == e.author) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "self-verify" });
                } else if (acc.verifications.find((v) -> {
                    v.submit_id == ref && v.verifier == e.author
                }) != null) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "dupe-verify" });
                } else {
                    acc.verifications.push(
                        Verification {
                            verify_id: e.id,
                            submit_id: ref,
                            verifier: e.author,
                            verdict: verdict,
                            method: body_string(e.body, "method"),
                        },
                    );
                }
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-submit" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-verdict" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-submit-ref" });
    }
}

function apply_accept(acc: Acc, e: WireEvent) -> void {
    if let refs: string[] = body_string_list(e.body, "verify_refs") {
        if (refs.length() == 0) {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-verify-refs" });
        } else {
            let ok = true;
            for (let ref in refs) {
                if let v: Verification = find_verification(acc, ref) {
                    if let s: Submission = find_submission(acc, v.submit_id) {
                        if (s.entity != e.entity) {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "foreign-ref" });
                            ok = false;
                        } else if (v.verdict != "accept") {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "reject-ref" });
                            ok = false;
                        }
                    } else {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-submit" });
                        ok = false;
                    }
                } else {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-verify-ref" });
                    ok = false;
                }
            }
            if (ok) {
                for (let ref in refs) {
                    // Idempotent: re-accepting an accepted submit is a no-op.
                    if let v: Verification = find_verification(acc, ref) {
                        if let s: Submission = find_submission(acc, v.submit_id) {
                            s.status = "accepted";
                        }
                    }
                }
            }
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-verify-refs" });
    }
}

function apply_reject(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "submit_ref") {
        if let s: Submission = find_submission(acc, ref) {
            if (e.author == s.producer) {
                s.status = "rejected";
            } else if (acc.verifications.find((v) -> {
                v.submit_id == ref && v.verifier == e.author && v.verdict == "reject"
            }) != null) {
                s.status = "rejected";
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "reject-denied" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-submit" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-submit-ref" });
    }
}

function submit_body(evidence: string[]) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("evidence", evidence);
    b
}

function verify_body(submit_ref: string, verdict: string) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("submit_ref", submit_ref);
    let _ = b.set("verdict", verdict);
    let _ = b.set("method", "ci");
    b
}

function only_submission(r: Reduction) -> Submission {
    assert.equal(r.submissions.length(), 1);
    r.submissions[0]
}

test "submit with evidence is submitted, without is excluded" {
    let r = reduce([wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:abc", "ci:123"]), author = "did:key:z6Mk-alice")]);
    assert.equal(r.excluded.length(), 0);
    let s = only_submission(r);
    assert.equal(s.producer, "did:key:z6Mk-alice");
    assert.equal(s.status, "submitted");
    assert.equal(s.evidence.length(), 2);
    let bare = reduce([wire("WorkSubmit", "task:A", 1, "e1", submit_body([]))]);
    assert.equal(bare.submissions.length(), 0);
    assert.equal(bare.excluded[0].reason, "missing-evidence")
}

test "hosts send evidence and refs JSON-encoded" {
    let sb: map<string, unknown> = {};
    let _ = sb.set("evidence", "[\"cid:abc\"]");
    let r = reduce([wire("WorkSubmit", "task:A", 1, "e1", sb, author = "did:key:z6Mk-alice")]);
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_submission(r).evidence[0], "cid:abc");
    let ab: map<string, unknown> = {};
    let _ = ab.set("verify_refs", "[\"e2\"]");
    let ok = reduce(
        [
            wire("WorkSubmit", "task:A", 1, "e1", sb, author = "did:key:z6Mk-alice"),
            wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "accept"), author = "did:key:z6Mk-bob"),
            wire("WorkAccept", "task:A", 3, "e3", ab),
        ],
    );
    assert.equal(ok.excluded.length(), 0);
    assert.equal(only_submission(ok).status, "accepted")
}

test "submit on a leased task needs the fencing echo" {
    let claim = wire("LeaseClaim", "task:A", 1, "e1", claim_body(100, 0, "a1"), author = "did:key:z6Mk-alice");
    let fenced = submit_body(["cid:x"]);
    let _ = fenced.set("fencing", 1);
    let ok = reduce([claim, wire("WorkSubmit", "task:A", 2, "e2", fenced, author = "did:key:z6Mk-alice")]);
    assert.equal(ok.excluded.length(), 0);
    assert.equal(only_submission(ok).status, "submitted");
    let bare = reduce([claim, wire("WorkSubmit", "task:A", 2, "e2", submit_body(["cid:x"]), author = "did:key:z6Mk-alice")]);
    assert.equal(bare.submissions.length(), 0);
    assert.equal(bare.excluded[0].reason, "stale-fence")
}

test "verify records a foreign verdict, self-verify is excluded" {
    let events = [
        wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice"),
        wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "accept"), author = "did:key:z6Mk-bob"),
    ];
    let r = reduce(events);
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.verifications.length(), 1);
    assert.equal(r.verifications[0].verdict, "accept");
    assert.equal(r.verifications[0].method, "ci");
    let self = reduce(
        [
            wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice"),
            wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "accept"), author = "did:key:z6Mk-alice"),
        ],
    );
    assert.equal(self.verifications.length(), 0);
    assert.equal(self.excluded[0].reason, "self-verify")
}

test "verify rejects unknown verdicts, submits, and dupes" {
    let submit = wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice");
    let bad_verdict = reduce(
        [submit, wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "maybe"), author = "did:key:z6Mk-bob")],
    );
    assert.equal(bad_verdict.excluded[0].reason, "unknown-verdict");
    let ghost = reduce([wire("VerifyRecord", "task:A", 2, "e2", verify_body("nope", "accept"), author = "did:key:z6Mk-bob")]);
    assert.equal(ghost.excluded[0].reason, "unknown-submit");
    let dupe = reduce(
        [
            submit,
            wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "accept"), author = "did:key:z6Mk-bob"),
            wire("VerifyRecord", "task:A", 3, "e3", verify_body("e1", "reject"), author = "did:key:z6Mk-bob"),
        ],
    );
    assert.equal(dupe.verifications.length(), 1);
    assert.equal(dupe.excluded[0].reason, "dupe-verify")
}

test "accept links verdicts and marks submitted accepted, idempotently" {
    let flow = [
        wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice"),
        wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "accept"), author = "did:key:z6Mk-bob"),
        wire("WorkAccept", "task:A", 3, "e3", accept_body(["e2"])),
    ];
    let r = reduce(flow);
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_submission(r).status, "accepted");
    // Re-accepting is a no-op, not an error.
    let again = reduce(
        [
            wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice"),
            wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "accept"), author = "did:key:z6Mk-bob"),
            wire("WorkAccept", "task:A", 3, "e3", accept_body(["e2"])),
            wire("WorkAccept", "task:A", 4, "e4", accept_body(["e2"])),
        ],
    );
    assert.equal(again.excluded.length(), 0);
    assert.equal(only_submission(again).status, "accepted")
}

test "accept refuses reject refs, foreign refs, and empty sets" {
    let submitted = wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice");
    let rejected = reduce(
        [
            submitted,
            wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "reject"), author = "did:key:z6Mk-bob"),
            wire("WorkAccept", "task:A", 3, "e3", accept_body(["e2"])),
        ],
    );
    assert.equal(rejected.excluded[0].reason, "reject-ref");
    assert.equal(only_submission(rejected).status, "submitted");
    let foreign = reduce(
        [
            submitted,
            wire("WorkSubmit", "task:B", 2, "e9", submit_body(["cid:y"]), author = "did:key:z6Mk-alice"),
            wire("VerifyRecord", "task:B", 3, "e8", verify_body("e9", "accept"), author = "did:key:z6Mk-bob"),
            wire("WorkAccept", "task:A", 4, "e3", accept_body(["e8"])),
        ],
    );
    assert.equal(foreign.excluded[0].reason, "foreign-ref");
    let empty = reduce([submitted, wire("WorkAccept", "task:A", 2, "e3", accept_body([]))]);
    assert.equal(empty.excluded[0].reason, "missing-verify-refs");
    let ghost = reduce([submitted, wire("WorkAccept", "task:A", 2, "e3", accept_body(["nope"]))]);
    assert.equal(ghost.excluded[0].reason, "unknown-verify-ref")
}

test "reject lands via producer withdraw or recorded reject verdict" {
    let submitted = wire("WorkSubmit", "task:A", 1, "e1", submit_body(["cid:x"]), author = "did:key:z6Mk-alice");
    let withdrawn = reduce(
        [submitted, wire("WorkReject", "task:A", 2, "e2", str_body("submit_ref", "e1"), author = "did:key:z6Mk-alice")],
    );
    assert.equal(withdrawn.excluded.length(), 0);
    assert.equal(only_submission(withdrawn).status, "rejected");
    let verified = reduce(
        [
            submitted,
            wire("VerifyRecord", "task:A", 2, "e2", verify_body("e1", "reject"), author = "did:key:z6Mk-bob"),
            wire("WorkReject", "task:A", 3, "e3", str_body("submit_ref", "e1"), author = "did:key:z6Mk-bob"),
        ],
    );
    assert.equal(verified.excluded.length(), 0);
    assert.equal(only_submission(verified).status, "rejected");
    let denied = reduce(
        [submitted, wire("WorkReject", "task:A", 2, "e2", str_body("submit_ref", "e1"), author = "did:key:z6Mk-bob")],
    );
    assert.equal(denied.excluded[0].reason, "reject-denied");
    assert.equal(only_submission(denied).status, "submitted")
}

function accept_body(refs: string[]) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("verify_refs", refs);
    b
}
