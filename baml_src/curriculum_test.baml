// curriculum_test.baml — hub#217: literal-tally tests for the curriculum
// scheduling rule (curriculum.baml). T0 policy on literals, no LLM.
//
// Red-check (bi#57) 2026-09-07 — target: the green-threshold comparison of
// tier_green (curriculum.baml: `t.pass * 100 >= threshold_pct * observations(t)`).
// Hunk: `>=` flipped to `>`. Expected reason: a tier at EXACTLY the
// threshold goes red, so the radius stops at that frontier and harder
// tiers above it are held. Observed: `baml test --project bais` failed
// LOUD with 3 failures FOR THE RIGHT REASON —
//   FAIL root::tier green: boundary inclusive, unmeasured and skips never green
//     (assertion failed: expected true — exactly-80% no longer green)
//   FAIL root::curriculum green frontier expands the radius
//     (left = ["t#b","t#a"], right = ["t#b","t#a","t#c"] — the 80% frontier
//     tier turned red and gated tier 2)
//   FAIL root::curriculum threshold boundary is green at exactly the threshold
//     (left = ["t#x1","t#x0"], right = ["t#x1","t#x0","t#x2"] — boundary
//     tier red, t#x2 held behind it).
// Restored, re-ran green. A threshold comparison that cannot go red at the
// boundary is camouflage, not coverage.

function mk_tally(p: int, f: int) -> SuiteTally {
    SuiteTally { pass: p, fail: f, skip: 0 }
}

function mk_item(id: string, tier: int, rank: int) -> ReadyItem {
    ReadyItem { id: id, tier: tier, foundation_rank: rank }
}

test "tier green: boundary inclusive, unmeasured and skips never green" {
    assert.is_true(tier_green(mk_tally(4, 1), 80)); // exactly 80% is green
    assert.is_true(tier_green(SuiteTally { pass: 4, fail: 1, skip: 3 }, 80)); // skips ignored
    assert.is_true(!tier_green(mk_tally(3, 2), 80)); // 60% is red
    assert.is_true(!tier_green(mk_tally(0, 0), 80)); // unmeasured is never green
    assert.is_true(!tier_green(SuiteTally { pass: 0, fail: 0, skip: 5 }, 80)); // skips are not observations
    assert.equal(pass_rate_pct(mk_tally(1, 3)), 25);
    assert.equal(pass_rate_pct(mk_tally(0, 0)), 0)
}

test "dispatchable tiers never skip a red frontier" {
    let red = [TierTally { tier: 0, tally: mk_tally(1, 1) }, TierTally { tier: 1, tally: mk_tally(4, 0) }];
    // Tier 1 is green but sits behind the red frontier tier 0: the radius
    // covers the frontier only, never skips ahead.
    assert.equal(dispatchable_tiers(red, 80), [0]);
    let green = [TierTally { tier: 1, tally: mk_tally(4, 0) }, TierTally { tier: 0, tally: mk_tally(9, 1) }];
    assert.equal(dispatchable_tiers(green, 80), [0, 1]); // unordered input walks easiest-first
    assert.equal(dispatchable_tiers([], 80), [])
}

test "curriculum red frontier blocks radius expansion" {
    let tiers = [
        TierTally { tier: 0, tally: mk_tally(9, 1) }, // 90% green
        TierTally { tier: 1, tally: mk_tally(1, 1) }, // 50% red frontier
        TierTally { tier: 2, tally: mk_tally(4, 0) }, // 100% but gated behind tier 1
    ];
    let ready = [mk_item("t#a", 0, 1), mk_item("t#b", 1, 0), mk_item("t#c", 2, 0)];
    let sched = curriculum_schedule(ready, tiers, 80);
    // Weakest measured tier first: t#b (50%) before t#a (90%).
    assert.equal(sched.dispatch, ["t#b", "t#a"]);
    assert.equal(sched.held.length(), 1);
    assert.equal(sched.held.at(0)?.id ?? "", "t#c");
    assert.equal(
        sched.held.at(0)?.reason ?? "",
        "tier 2 held: frontier tier 1 pass-rate 50% below 80% threshold (1/2 arms passing)",
    )
}

test "curriculum green frontier expands the radius" {
    let tiers = [
        TierTally { tier: 0, tally: mk_tally(9, 1) }, // 90%
        TierTally { tier: 1, tally: mk_tally(4, 1) }, // 80% — green, radius expands
        TierTally { tier: 2, tally: mk_tally(4, 0) }, // 100%
    ];
    let ready = [mk_item("t#a", 0, 1), mk_item("t#b", 1, 0), mk_item("t#c", 2, 0)];
    let sched = curriculum_schedule(ready, tiers, 80);
    // Pass-rate ascending across all three tiers: 80, 90, 100.
    assert.equal(sched.dispatch, ["t#b", "t#a", "t#c"]);
    assert.equal(sched.held, [])
}

test "curriculum threshold boundary is green at exactly the threshold" {
    let tiers = [
        TierTally { tier: 0, tally: mk_tally(4, 0) }, // 100%
        TierTally { tier: 1, tally: mk_tally(4, 1) }, // exactly 80% — green iff >=
        TierTally { tier: 2, tally: mk_tally(4, 0) }, // 100%
    ];
    let ready = [mk_item("t#x0", 0, 0), mk_item("t#x1", 1, 0), mk_item("t#x2", 2, 0)];
    let sched = curriculum_schedule(ready, tiers, 80);
    // t#x1 (80%) first; t#x0/t#x2 tie at 100% + rank 0 -> id ascending.
    assert.equal(sched.dispatch, ["t#x1", "t#x0", "t#x2"]);
    assert.equal(sched.held, [])
}

test "curriculum ties fall to foundation_rank then id ascending" {
    let tiers = [TierTally { tier: 0, tally: mk_tally(4, 0) }];
    let ready = [
        mk_item("t#e1", 0, 1),
        mk_item("t#09", 0, 1),
        mk_item("t#base", 0, 0), // hub#186 baseline rides first
        mk_item("t#02", 0, 1),
    ];
    let sched = curriculum_schedule(ready, tiers, 80);
    assert.equal(sched.dispatch, ["t#base", "t#02", "t#09", "t#e1"]);
    assert.equal(sched.held, [])
}

test "curriculum unmeasured tiers hold fail-closed with a named reason" {
    let tiers = [TierTally { tier: 0, tally: mk_tally(4, 0) }];
    let ready = [mk_item("t#m", 5, 0), mk_item("t#a", 0, 0)];
    let sched = curriculum_schedule(ready, tiers, 80);
    assert.equal(sched.dispatch, ["t#a"]);
    assert.equal(sched.held.length(), 1);
    assert.equal(
        sched.held.at(0)?.reason ?? "",
        "tier 5 unmeasured — no tally record, fail-closed (declare measurements first)",
    );
    // No measurements at all: everything held, nothing dispatched blind.
    let blind = curriculum_schedule(ready, [], 80);
    assert.equal(blind.dispatch, []);
    assert.equal(blind.held.length(), 2)
}
