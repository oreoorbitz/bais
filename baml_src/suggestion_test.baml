// Tests for the consent-first Suggestion lane (hub#211) — literals only,
// no LLM. One test -> one behaviour of baml_src/suggestion.baml.

function sug_fixture(id: string, key: string, status: SuggestionStatus, at: int) -> Suggestion {
    Suggestion {
        id: id,
        dedup_key: key,
        title: id,
        body: "spec",
        status: status,
        offered_at: at,
        evidence: [],
        resolution: null,
    }
}

// Acceptance 1a: a dismissed dedup_key is never re-offered.
test "dismissed dedup_key is never re-offered" {
    let lane = [mark_dismissed(sug_fixture("sug#001", "k-weekly", SuggestionStatus.Pending, 1))];
    let update = offer_suggestion(lane, sug_fixture("sug#002", "k-weekly", SuggestionStatus.Pending, 2));
    assert.equal(update.decision, "refused-latched");
    assert.equal(update.lane.length(), 1);
    assert.equal(pending_suggestions(update.lane).length(), 0);
    assert.equal(is_latched("k-weekly", update.lane), true)
}

// Acceptance 1a, sibling latch: a promoted key is latched too — re-offering
// would duplicate live work.
test "promoted dedup_key is never re-offered" {
    let lane = [mark_promoted(sug_fixture("sug#001", "k-done", SuggestionStatus.Pending, 1))];
    let update = offer_suggestion(lane, sug_fixture("sug#009", "k-done", SuggestionStatus.Pending, 2));
    assert.equal(update.decision, "refused-latched");
    assert.equal(update.lane.length(), 1)
}

// An evicted key stays latched: re-offering would defeat the cap.
test "evicted dedup_key is never re-offered" {
    let evicted = with_status(
        sug_fixture("sug#001", "k-old", SuggestionStatus.Pending, 1),
        SuggestionStatus.Evicted,
        cap_eviction_reason(),
    );
    let update = offer_suggestion([evicted], sug_fixture("sug#002", "k-old", SuggestionStatus.Pending, 2));
    assert.equal(update.decision, "refused-latched");
    assert.equal(pending_suggestions(update.lane).length(), 0)
}

// A key still Pending refuses the duplicate without latching anything.
test "pending duplicate is refused but not latched" {
    let lane = [sug_fixture("sug#001", "k-dup", SuggestionStatus.Pending, 1)];
    let update = offer_suggestion(lane, sug_fixture("sug#002", "k-dup", SuggestionStatus.Pending, 2));
    assert.equal(update.decision, "refused-pending-duplicate");
    assert.equal(update.lane.length(), 1);
    assert.equal(is_latched("k-dup", update.lane), false)
}

// Fresh key under the cap: plain admit, no eviction fields set.
test "fresh key is offered under the cap" {
    let lane = [sug_fixture("sug#001", "k-a", SuggestionStatus.Pending, 1)];
    let update = offer_suggestion(lane, sug_fixture("sug#002", "k-b", SuggestionStatus.Pending, 2));
    assert.equal(update.decision, "offered");
    assert.equal(update.evicted_id, null);
    assert.equal(update.eviction_reason, null);
    assert.equal(pending_suggestions(update.lane).length(), 2)
}

// Acceptance 1b: the sixth pending offer evicts the OLDEST pending record
// and names the eviction reason. MAX_PENDING = 5.
test "cap evicts the oldest pending with a named reason" {
    let lane = [
        sug_fixture("sug#001", "k1", SuggestionStatus.Pending, 10),
        sug_fixture("sug#002", "k2", SuggestionStatus.Pending, 20),
        sug_fixture("sug#003", "k3", SuggestionStatus.Pending, 30),
        sug_fixture("sug#004", "k4", SuggestionStatus.Pending, 40),
        sug_fixture("sug#005", "k5", SuggestionStatus.Pending, 50),
    ];
    assert.equal(pending_suggestions(lane).length(), max_pending());
    let update = offer_suggestion(lane, sug_fixture("sug#006", "k6", SuggestionStatus.Pending, 60));
    assert.equal(update.decision, "offered-evicted-oldest");
    assert.equal(update.evicted_id, "sug#001");
    assert.equal(update.eviction_reason, "cap-evicted-oldest");
    // Cap holds: still exactly 5 Pending, and the evicted record persists
    // as Evicted (the latch + audit trail) with the named resolution.
    assert.equal(pending_suggestions(update.lane).length(), 5);
    assert.equal(update.lane.length(), 6);
    assert.equal(update.lane[0].status, SuggestionStatus.Evicted);
    assert.equal(update.lane[0].resolution, "cap-evicted-oldest")
}

// The cap counts PENDING only: terminal records never trigger eviction.
test "terminal records do not count against the cap" {
    let lane = [
        mark_dismissed(sug_fixture("sug#000", "k0", SuggestionStatus.Pending, 1)),
        sug_fixture("sug#001", "k1", SuggestionStatus.Pending, 10),
        sug_fixture("sug#002", "k2", SuggestionStatus.Pending, 20),
        sug_fixture("sug#003", "k3", SuggestionStatus.Pending, 30),
        sug_fixture("sug#004", "k4", SuggestionStatus.Pending, 40),
    ];
    let update = offer_suggestion(lane, sug_fixture("sug#005", "k5", SuggestionStatus.Pending, 50));
    assert.equal(update.decision, "offered");
    assert.equal(update.evicted_id, null);
    assert.equal(pending_suggestions(update.lane).length(), 5)
}

// Acceptance 2: the lane lists suggestions separately from ready issues.
// A full lane and an Open issue coexist; ready_issues sees only the issue,
// pending_suggestions sees only the Pending records.
test "suggestion lane is separate from the ready issue list" {
    let lane = [
        sug_fixture("sug#001", "k1", SuggestionStatus.Pending, 1),
        mark_dismissed(sug_fixture("sug#002", "k2", SuggestionStatus.Pending, 2)),
    ];
    let issue = Issue {
        id: "hub#999",
        title: "real work",
        status: Status.Open,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    assert.equal(pending_suggestions(lane).length(), 1);
    assert.equal(pending_suggestions(lane)[0].id, "sug#001");
    let ready = ready_issues([issue], []);
    assert.equal(ready.length(), 1);
    assert.equal(ready[0].id, "hub#999")
}

// Offering never creates an Issue: LaneUpdate carries lane + named
// decision only — there is no issue field to accidentally write.
test "offering carries no issue, only a named lane decision" {
    let update = offer_suggestion([], sug_fixture("sug#001", "k1", SuggestionStatus.Pending, 1));
    assert.equal(update.decision, "offered");
    assert.equal(update.lane.length(), 1);
    assert.equal(update.evicted_id, null)
}

// Acceptance 2: promote derives a real Open issue LINKED to the
// suggestion's evidence via Related edges.
test "promote derives a linked Open issue from the suggestion" {
    let s = Suggestion {
        id: "sug#010",
        dedup_key: "k-review-digest",
        title: "Weekly digest of review-fork findings",
        body: "Run the digest, file findings.",
        status: SuggestionStatus.Pending,
        offered_at: 7,
        evidence: ["hub#203", "hub#200"],
        resolution: null,
    };
    let d = promote_derivation(s, "hub#212");
    assert.equal(d.issue.id, "hub#212");
    assert.equal(d.issue.title, "Weekly digest of review-fork findings");
    assert.equal(d.issue.status, Status.Open);
    assert.equal(d.issue.kind, Kind.Proposal);
    assert.equal(d.edges.length(), 2);
    assert.equal(d.edges[0].from, "hub#212");
    assert.equal(d.edges[0].to, "hub#203");
    assert.equal(d.edges[0].kind, EdgeKind.Related);
    assert.equal(d.edges[1].to, "hub#200");
    // The derived issue is ready-listed like any other accepted work.
    let ready = ready_issues([d.issue], d.edges);
    assert.equal(ready.length(), 1);
    assert.equal(ready[0].id, "hub#212")
}

// The promoted lane record latches the key with a named resolution.
test "mark_promoted latches the key" {
    let s = mark_promoted(sug_fixture("sug#010", "k-review-digest", SuggestionStatus.Pending, 7));
    assert.equal(s.status, SuggestionStatus.Promoted);
    assert.equal(s.resolution, "promoted");
    assert.equal(is_latched("k-review-digest", [s]), true);
    assert.equal(pending_suggestions([s]).length(), 0)
}
