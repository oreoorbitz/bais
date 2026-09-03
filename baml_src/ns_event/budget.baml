// ns_event/budget — budgets and cost attribution (fusion v1, Phase 3,
// step 11).
//
// Budgets are the spam lever (fusion-report: priced writes beat
// proof-of-work for agent swarms). Every costed write attributes to
// task + lease + principal; oversight (Phase 5) samples the trail.
//
// Body contracts:
//   BudgetAuthorize { cap_usd: float, cap_tokens: int }
//   CostReserve     { task: string, lease_ref: string?, usd: float,
//                     tokens: int }
//   CostIncurred    { reserve_ref: string (CostReserve event id),
//                     task: string, usd: float, tokens: int }
//   ReceiptAttach   { cost_ref: string (CostIncurred event id),
//                     receipt: string (content cid / invoice ref) }
//
// Rules:
// - Entity of authorize/reserve/incurred is the PRINCIPAL (did:key:...),
//   not the task: the budget account lives with who spends. Task travels
//   in the body for attribution; lease_ref is optional context.
// - Authorize upserts the cap (causal LWW: latest authorize wins).
//   Missing or negative caps are excluded, never defaulted.
// - Reserve needs an authorized budget and must fit the remaining cap in
//   BOTH dimensions (usd and tokens), else `over-cap` / `no-budget`.
// - Incurred draws down an explicit reserve: same principal, same task,
//   amount within remaining, else `over-reserve` / `unknown-reserve` /
//   `task-mismatch`. The reserve's consumed counters move; the cap was
//   checked at reserve time, so lowering a cap later never rewrites
//   history (oversight flags it instead — Phase 5).
// - Receipts attach to incurred entries only (`not-incurred` otherwise);
//   re-attaching amends.

class Budget {
    principal: string,
    cap_usd: float,
    cap_tokens: int,
    reserved_usd: float,
    reserved_tokens: int,
    incurred_usd: float,
    incurred_tokens: int,
}

class CostEntry {
    entry_id: string,
    principal: string,
    task: string,
    lease_ref: string?,
    kind: string @description("reserve | incurred"),
    usd: float,
    tokens: int,
    consumed_usd: float @description("reserves only: drawn down by incurred"),
    consumed_tokens: int @description("reserves only: drawn down by incurred"),
    receipt: string? @description("incurred only: attached audit receipt"),
}

function body_float(body: map<string, unknown>, key: string) -> float? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let f: float = v {
        f
    } else {
        null
    }
}

function find_budget(acc: Acc, principal: string) -> Budget? {
    acc.budgets.find((b) -> {
        b.principal == principal
    })
}

function find_cost(acc: Acc, entry_id: string) -> CostEntry? {
    acc.costs.find((c) -> {
        c.entry_id == entry_id
    })
}

function apply_authorize(acc: Acc, e: WireEvent) -> void {
    if let cap_usd: float = body_float(e.body, "cap_usd") {
        if let cap_tokens: int = body_int(e.body, "cap_tokens") {
            if (cap_usd < 0.0 || cap_tokens < 0) {
                acc.excluded.push(Excluded { event_id: e.id, reason: "negative-cap" });
            } else if let b: Budget = find_budget(acc, e.entity) {
                b.cap_usd = cap_usd;
                b.cap_tokens = cap_tokens;
            } else {
                acc.budgets.push(
                    Budget {
                        principal: e.entity,
                        cap_usd: cap_usd,
                        cap_tokens: cap_tokens,
                        reserved_usd: 0.0,
                        reserved_tokens: 0,
                        incurred_usd: 0.0,
                        incurred_tokens: 0,
                    },
                );
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap" });
    }
}

function apply_reserve(acc: Acc, e: WireEvent) -> void {
    if let task: string = body_string(e.body, "task") {
        if let usd: float = body_float(e.body, "usd") {
            if let tokens: int = body_int(e.body, "tokens") {
                if (usd < 0.0 || tokens < 0) {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "negative-cost" });
                } else if let b: Budget = find_budget(acc, e.entity) {
                    if (b.reserved_usd + b.incurred_usd + usd > b.cap_usd || b.reserved_tokens + b.incurred_tokens + tokens > b.cap_tokens) {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "over-cap" });
                    } else {
                        b.reserved_usd = b.reserved_usd + usd;
                        b.reserved_tokens = b.reserved_tokens + tokens;
                        acc.costs.push(
                            CostEntry {
                                entry_id: e.id,
                                principal: e.entity,
                                task: task,
                                lease_ref: body_string(e.body, "lease_ref"),
                                kind: "reserve",
                                usd: usd,
                                tokens: tokens,
                                consumed_usd: 0.0,
                                consumed_tokens: 0,
                                receipt: null,
                            },
                        );
                    }
                } else {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "no-budget" });
                }
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cost" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cost" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-task" });
    }
}

function apply_incurred(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "reserve_ref") {
        if let task: string = body_string(e.body, "task") {
            if let usd: float = body_float(e.body, "usd") {
                if let tokens: int = body_int(e.body, "tokens") {
                    if let r: CostEntry = find_cost(acc, ref) {
                        if (r.kind != "reserve" || r.principal != e.entity) {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-reserve" });
                        } else if (r.task != task) {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "task-mismatch" });
                        } else if (r.consumed_usd + usd > r.usd || r.consumed_tokens + tokens > r.tokens) {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "over-reserve" });
                        } else if let b: Budget = find_budget(acc, e.entity) {
                            r.consumed_usd = r.consumed_usd + usd;
                            r.consumed_tokens = r.consumed_tokens + tokens;
                            b.incurred_usd = b.incurred_usd + usd;
                            b.incurred_tokens = b.incurred_tokens + tokens;
                            acc.costs.push(
                                CostEntry {
                                    entry_id: e.id,
                                    principal: e.entity,
                                    task: task,
                                    lease_ref: r.lease_ref,
                                    kind: "incurred",
                                    usd: usd,
                                    tokens: tokens,
                                    consumed_usd: 0.0,
                                    consumed_tokens: 0,
                                    receipt: null,
                                },
                            );
                        } else {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "no-budget" });
                        }
                    } else {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-reserve" });
                    }
                } else {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cost" });
                }
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cost" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-task" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-reserve-ref" });
    }
}

function apply_receipt(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "cost_ref") {
        if let receipt: string = body_string(e.body, "receipt") {
            if let c: CostEntry = find_cost(acc, ref) {
                if (c.kind != "incurred") {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "not-incurred" });
                } else {
                    c.receipt = receipt;
                }
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-cost" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-receipt" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cost-ref" });
    }
}

function auth_body(usd: float, tokens: int) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("cap_usd", usd);
    let _ = b.set("cap_tokens", tokens);
    b
}

function reserve_body(task: string, usd: float, tokens: int) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("task", task);
    let _ = b.set("usd", usd);
    let _ = b.set("tokens", tokens);
    b
}

function incurred_body(reserve_ref: string, task: string, usd: float, tokens: int) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("reserve_ref", reserve_ref);
    let _ = b.set("task", task);
    let _ = b.set("usd", usd);
    let _ = b.set("tokens", tokens);
    b
}

function only_budget(r: Reduction) -> Budget {
    assert.equal(r.budgets.length(), 1);
    r.budgets[0]
}

test "authorize sets the cap, latest wins, bad caps excluded" {
    let r = reduce([wire("BudgetAuthorize", "did:key:z6Mk-alice", 1, "e1", auth_body(10.0, 1000))]);
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_budget(r).cap_usd, 10.0);
    assert.equal(only_budget(r).cap_tokens, 1000);
    let lww = reduce(
        [
            wire("BudgetAuthorize", "did:key:z6Mk-alice", 1, "e1", auth_body(10.0, 1000)),
            wire("BudgetAuthorize", "did:key:z6Mk-alice", 2, "e2", auth_body(5.0, 500)),
        ],
    );
    assert.equal(only_budget(lww).cap_usd, 5.0);
    let neg = reduce([wire("BudgetAuthorize", "did:key:z6Mk-alice", 1, "e1", auth_body(-1.0, 100))]);
    assert.equal(neg.budgets.length(), 0);
    assert.equal(neg.excluded[0].reason, "negative-cap");
    let missing: map<string, unknown> = {};
    let _ = missing.set("cap_usd", 1.0);
    let mis = reduce([wire("BudgetAuthorize", "did:key:z6Mk-alice", 1, "e1", missing)]);
    assert.equal(mis.excluded[0].reason, "missing-cap")
}

test "reserve fits the cap in both dimensions or is excluded" {
    let principal = "did:key:z6Mk-alice";
    let auth = wire("BudgetAuthorize", principal, 1, "e1", auth_body(10.0, 1000));
    let r = reduce([auth, wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 6.0, 600))]);
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_budget(r).reserved_usd, 6.0);
    assert.equal(r.costs.length(), 1);
    assert.equal(r.costs[0].kind, "reserve");
    let over_usd = reduce(
        [auth, wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 60.0, 10))],
    );
    assert.equal(over_usd.excluded[0].reason, "over-cap");
    let over_tokens = reduce(
        [auth, wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 1.0, 6000))],
    );
    assert.equal(over_tokens.excluded[0].reason, "over-cap");
    let nobody = reduce([wire("CostReserve", "did:key:z6Mk-ghost", 2, "e2", reserve_body("task:A", 1.0, 10))]);
    assert.equal(nobody.excluded[0].reason, "no-budget")
}

test "reserve plus incurred roll up against the cap" {
    let principal = "did:key:z6Mk-alice";
    let r = reduce(
        [
            wire("BudgetAuthorize", principal, 1, "e1", auth_body(10.0, 1000)),
            wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 6.0, 600)),
            wire("CostIncurred", principal, 3, "e3", incurred_body("e2", "task:A", 4.0, 400)),
            wire("CostReserve", principal, 4, "e4", reserve_body("task:B", 4.0, 100)),
        ],
    );
    // 6 reserved + 4 incurred + 4 new > 10 cap: the last reserve fails.
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "over-cap");
    assert.equal(only_budget(r).incurred_usd, 4.0);
    assert.equal(only_budget(r).incurred_tokens, 400)
}

test "incurred draws down its reserve or is excluded" {
    let principal = "did:key:z6Mk-alice";
    let auth = wire("BudgetAuthorize", principal, 1, "e1", auth_body(10.0, 1000));
    let res = wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 6.0, 600));
    let r = reduce([auth, res, wire("CostIncurred", principal, 3, "e3", incurred_body("e2", "task:A", 4.0, 400))]);
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.costs.length(), 2);
    assert.equal(r.costs[1].kind, "incurred");
    // Lease context carries from reserve to incurred (null here: none given).
    assert.is_true(r.costs[1].lease_ref is null);
    let over = reduce(
        [auth, res, wire("CostIncurred", principal, 3, "e3", incurred_body("e2", "task:A", 9.0, 10))],
    );
    assert.equal(over.excluded[0].reason, "over-reserve");
    let mismatch = reduce(
        [auth, res, wire("CostIncurred", principal, 3, "e3", incurred_body("e2", "task:B", 1.0, 10))],
    );
    assert.equal(mismatch.excluded[0].reason, "task-mismatch");
    let ghost = reduce(
        [auth, wire("CostIncurred", principal, 3, "e3", incurred_body("nope", "task:A", 1.0, 10))],
    );
    assert.equal(ghost.excluded[0].reason, "unknown-reserve")
}

test "receipts attach to incurred entries only" {
    let principal = "did:key:z6Mk-alice";
    let r = reduce(
        [
            wire("BudgetAuthorize", principal, 1, "e1", auth_body(10.0, 1000)),
            wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 6.0, 600)),
            wire("CostIncurred", principal, 3, "e3", incurred_body("e2", "task:A", 4.0, 400)),
            wire("ReceiptAttach", principal, 4, "e4", receipt_body("e3", "cid:invoice-1")),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.costs[1].receipt, "cid:invoice-1");
    let on_reserve = reduce(
        [
            wire("BudgetAuthorize", principal, 1, "e1", auth_body(10.0, 1000)),
            wire("CostReserve", principal, 2, "e2", reserve_body("task:A", 6.0, 600)),
            wire("ReceiptAttach", principal, 3, "e3", receipt_body("e2", "cid:x")),
        ],
    );
    assert.equal(on_reserve.excluded[0].reason, "not-incurred");
    let ghost = reduce(
        [wire("ReceiptAttach", principal, 1, "e1", receipt_body("nope", "cid:x"))],
    );
    assert.equal(ghost.excluded[0].reason, "unknown-cost")
}

function receipt_body(cost_ref: string, receipt: string) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("cost_ref", cost_ref);
    let _ = b.set("receipt", receipt);
    b
}
