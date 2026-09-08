// ── curator tests (hub#212) ──
// Specification of the scripts/curator.mjs host mirror: every boundary the
// mirror implements is pinned here on literal records (no LLM, no clocks —
// `now` is a literal day number).
//
// Red-check record (bi#57): the stale-boundary hunk is
// `idle >= curator_stale_days()` in curator.baml CuratorTransition. Flipping
// it to `>` must fail exactly "30 days idle is Stale, not Active".
// Observed 2026-09-07: flipped -> FAIL that test (1 fail, 75 pass);
// restored -> 76 green.

function cur_issue(id: string, status: Status, idle: int, now: int) -> CuratorIssue {
    CuratorIssue {
        id: id,
        status: status,
        last_activity_day: now - idle,
        pinned: false,
        live_lease: false,
    }
}

test "29 days idle is Active" {
    let t = CuratorTransition(cur_issue("hub#01", Status.Open, 29, 1000), 1000);
    assert.equal(t, CuratorState.Active)
}

test "30 days idle is Stale, not Active" {
    let t = CuratorTransition(cur_issue("hub#02", Status.Open, 30, 1000), 1000);
    assert.equal(t, CuratorState.Stale);
    let a = curator_action(cur_issue("hub#02", Status.Open, 30, 1000), 1000);
    assert.equal(a.action, CuratorActionKind.MarkStale);
    assert.equal(a.idle_days, 30)
}

test "89 days idle is Stale, not Archived" {
    let t = CuratorTransition(cur_issue("hub#03", Status.Open, 89, 1000), 1000);
    assert.equal(t, CuratorState.Stale)
}

test "90 days idle is Archived" {
    let t = CuratorTransition(cur_issue("hub#04", Status.Open, 90, 1000), 1000);
    assert.equal(t, CuratorState.Archived);
    let a = curator_action(cur_issue("hub#04", Status.Open, 90, 1000), 1000);
    assert.equal(a.action, CuratorActionKind.Archive);
    assert.equal(a.idle_days, 90)
}

test "pinned issue is exempt at any age" {
    let i = cur_issue("hub#05", Status.Open, 200, 1000);
    i.pinned = true;
    assert.equal(CuratorTransition(i, 1000), CuratorState.Active);
    let a = curator_action(i, 1000);
    assert.equal(a.action, CuratorActionKind.Keep);
    assert.equal(a.reason, "pinned: exempt from lifecycle sweep (idle 200d ignored)")
}

test "live lease exempts a claimed issue at any age" {
    let i = cur_issue("hub#06", Status.Doing, 200, 1000);
    i.live_lease = true;
    assert.equal(CuratorTransition(i, 1000), CuratorState.Active);
    let a = curator_action(i, 1000);
    assert.equal(a.action, CuratorActionKind.Keep);
    assert.equal(a.reason, "live lease: claimed issue is in use (idle 200d ignored)")
}

test "first-run defers every transition one interval" {
    let issues = [cur_issue("hub#07", Status.Open, 45, 1000), cur_issue("hub#08", Status.Open, 200, 1000)];
    let actions = curator_sweep(issues, 1000, null);
    assert.equal(actions.length(), 2);
    assert.equal(actions[0].action, CuratorActionKind.Keep);
    assert.equal(actions[1].action, CuratorActionKind.Keep);
    assert.equal(
        actions[0].reason,
        "first-run: baseline recorded, transitions deferred one interval",
    );
    assert.equal(actions[1].idle_days, 200)
}

test "second sweep transitions what first-run deferred" {
    let issues = [cur_issue("hub#07", Status.Open, 45, 1000), cur_issue("hub#08", Status.Open, 200, 1000)];
    let actions = curator_sweep(issues, 1000, 990);
    assert.equal(actions[0].action, CuratorActionKind.MarkStale);
    assert.equal(actions[0].state, CuratorState.Stale);
    assert.equal(actions[1].action, CuratorActionKind.Archive);
    assert.equal(actions[1].state, CuratorState.Archived)
}

test "archive never deletes: 300 days idle is still a move, not a removal" {
    let issues = [cur_issue("hub#09", Status.Open, 300, 1000)];
    let actions = curator_sweep(issues, 1000, 990);
    assert.equal(actions.length(), 1);
    // CuratorActionKind has no Delete variant — the strongest statement the
    // type system lets a test make is that even the oldest issue maps to
    // Archive (a reversible move) with its full record intact.
    assert.equal(actions[0].action, CuratorActionKind.Archive);
    assert.equal(actions[0].state, CuratorState.Archived);
    assert.equal(actions[0].id, "hub#09");
    assert.equal(actions[0].idle_days, 300)
}

test "activity in the future clamps to fresh" {
    let i = cur_issue("hub#10", Status.Open, 0, 1000);
    i.last_activity_day = 1010;
    assert.equal(curator_idle_days(i, 1000), 0);
    assert.equal(CuratorTransition(i, 1000), CuratorState.Active)
}

test "non-Open statuses are exempt from the sweep" {
    let done = cur_issue("hub#11", Status.Done, 200, 1000);
    assert.equal(CuratorTransition(done, 1000), CuratorState.Active);
    assert.equal(curator_action(done, 1000).reason, "status Done: only Open issues are curated");
    let dropped = cur_issue("hub#12", Status.Dropped, 200, 1000);
    assert.equal(CuratorTransition(dropped, 1000), CuratorState.Active);
    // A dead lease is reap's job first: Doing without a live lease is not
    // curated here — it becomes Open via `bais reap`, then curatable.
    let dead_lease = cur_issue("hub#13", Status.Doing, 200, 1000);
    assert.equal(CuratorTransition(dead_lease, 1000), CuratorState.Active)
}

test "policy constants pin the hermes intervals" {
    assert.equal(curator_stale_days(), 30);
    assert.equal(curator_archive_days(), 90)
}

test "stale reason names the numbers behind the rule" {
    let a = curator_action(cur_issue("hub#14", Status.Open, 45, 1000), 1000);
    assert.equal(a.reason, "idle 45d >= 30d: mark stale");
    let b = curator_action(cur_issue("hub#15", Status.Open, 120, 1000), 1000);
    assert.equal(b.reason, "idle 120d >= 90d: archive (move to .bais/archive/, never delete)");
    let c = curator_action(cur_issue("hub#16", Status.Open, 3, 1000), 1000);
    assert.equal(c.reason, "idle 3d < 30d: active")
}
