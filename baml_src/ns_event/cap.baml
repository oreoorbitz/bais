// ns_event/cap — capabilities: grant, revoke, and causal-position checks
// (fusion v1, Phase 5, step 15).
//
// Writes require a capability when the hub runs with requireCaps (off by
// default — trusted-local coordinator). A grant authorizes an AUDIENCE
// (did:key) for actions in `can` within `scope` until `expiry_lc`. The
// reducer evaluates grants at each event's causal position (fold order),
// so a grant used before it appears is simply not live yet.
//
// Body contracts (hosts JSON-encode lists before signing — raw arrays
// would break every downstream sig check, SPEC §5.3):
//   CapGrant  { audience: string, can: string (JSON list of actions),
//               scope: string ("*" or a project/entity id),
//               expiry_lc: int, budget_cap_usd?: float,
//               budget_cap_tokens?: int }
//   CapRevoke { grant_ref: string (CapGrant event id) }
//
// Rules:
// - Entity of a grant/revoke is the AUDIENCE (budget-style): the account
//   holder, not the task. Missing/empty audience/can/scope/expiry are
//   excluded, never defaulted.
// - A grant already expired at its own lc is stillborn evidence.
// - Negative budget caps are excluded, never clamped.
// - Revoke needs a known grant; re-revoking is an idempotent no-op.
//   Only the issuer or the audience may revoke (`revoke-denied`
//   otherwise — open revocation would be griefing).
// - Revocation is sticky per grant id: a later revoke in fold order wins,
//   and only a NEW grant event re-enables (the issuer's prerogative, not
//   a replay). Checkpoints carry the folds, so the revocation travels
//   with the state it constrains.
// - `budget_cap_*` is recorded, not gated: the oversight feed flags
//   audiences spending past it (Phase 5, step 16). Caps gate ACTIONS;
//   budgets gate SPEND; the two join in the feed, not the reducer.
//
// Version note: reducer_version stays bais.reduce@1 — caps are a new
// section (empty on old logs) and no existing rule changes outcome, so
// old logs replay identically.

class Cap {
    grant_id: string @description("CapGrant event id — the stable identity revokes reference"),
    issuer: string @description("did:key:... that authored the grant"),
    audience: string @description("did:key:... authorized by the grant"),
    can: string[] @description("authorized actions, e.g. lease.claim, task.write, cap.admin"),
    scope: string @description("\"*\" or a project/entity id the grant is confined to"),
    expiry_lc: int @description("grant is live while expiry_lc > event lc"),
    budget_cap_usd: float? @description("optional spend ceiling, flagged by oversight not gated"),
    budget_cap_tokens: int? @description("optional spend ceiling, flagged by oversight not gated"),
    revoked: bool,
    revoked_by: string?,
}

function find_cap(acc: Acc, grant_id: string) -> Cap? {
    acc.caps.find((c) -> {
        c.grant_id == grant_id
    })
}

function apply_grant(acc: Acc, e: WireEvent) -> void {
    if let audience: string = body_string(e.body, "audience") {
        if let can: string[] = body_string_list(e.body, "can") {
            if let scope: string = body_string(e.body, "scope") {
                if let expiry: int = body_int(e.body, "expiry_lc") {
                    if (audience == "" || can.length() == 0 || scope == "") {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap-field" });
                    } else if (expiry <= 0) {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "bad-expiry" });
                    } else if (expiry <= e.lc) {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "stillborn-grant" });
                    } else if let cap_usd: float = body_float(e.body, "budget_cap_usd") {
                        if (cap_usd < 0.0) {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "bad-budget-cap" });
                        } else {
                            push_grant(acc, e, audience, can, scope, expiry, cap_usd, null);
                        }
                    } else if (e.body.get("budget_cap_usd") != null) {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "bad-budget-cap" });
                    } else if let cap_tokens: int = body_int(e.body, "budget_cap_tokens") {
                        if (cap_tokens < 0) {
                            acc.excluded.push(Excluded { event_id: e.id, reason: "bad-budget-cap" });
                        } else {
                            push_grant(acc, e, audience, can, scope, expiry, null, cap_tokens);
                        }
                    } else if (e.body.get("budget_cap_tokens") != null) {
                        acc.excluded.push(Excluded { event_id: e.id, reason: "bad-budget-cap" });
                    } else {
                        push_grant(acc, e, audience, can, scope, expiry, null, null);
                    }
                } else {
                    acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap-field" });
                }
            } else {
                acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap-field" });
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap-field" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-cap-field" });
    }
}

function push_grant(
    acc: Acc,
    e: WireEvent,
    audience: string,
    can: string[],
    scope: string,
    expiry: int,
    cap_usd: float?,
    cap_tokens: int?,
) -> void {
    acc.caps.push(
        Cap {
            grant_id: e.id,
            issuer: e.author,
            audience: audience,
            can: can,
            scope: scope,
            expiry_lc: expiry,
            budget_cap_usd: cap_usd,
            budget_cap_tokens: cap_tokens,
            revoked: false,
            revoked_by: null,
        },
    );
}

function apply_revoke(acc: Acc, e: WireEvent) -> void {
    if let ref: string = body_string(e.body, "grant_ref") {
        if let c: Cap = find_cap(acc, ref) {
            if (c.revoked) {
                // Idempotent: re-revoking is a no-op, not an error.
            } else if (e.author != c.issuer && e.author != c.audience) {
                acc.excluded.push(Excluded { event_id: e.id, reason: "revoke-denied" });
            } else {
                c.revoked = true;
                c.revoked_by = e.author;
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-grant" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-grant-ref" });
    }
}

// Causal-position check: is this grant usable for (action, scope) at lc?
function cap_covers(c: Cap, action: string, scope: string, at_lc: int) -> bool {
    if (c.revoked) {
        false
    } else if (c.expiry_lc <= at_lc) {
        false
    } else if (!c.can.includes(action)) {
        false
    } else {
        c.scope == "*" || c.scope == scope
    }
}

// Live capability at a causal position: any covering grant. Takes the
// caps list (not Acc) so tests and hosts call it on a Reduction too.
function cap_live(caps: Cap[], audience: string, action: string, scope: string, at_lc: int) -> bool {
    caps.find((c) -> {
        c.audience == audience && cap_covers(c, action, scope, at_lc)
    }) != null
}

function grant_body(audience: string, can_json: string, scope: string, expiry: int) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("audience", audience);
    let _ = b.set("can", can_json);
    let _ = b.set("scope", scope);
    let _ = b.set("expiry_lc", expiry);
    b
}

function only_cap(r: Reduction) -> Cap {
    assert.equal(r.caps.length(), 1);
    r.caps[0]
}

test "grant materializes with actions, scope, expiry" {
    let r = reduce([wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", grant_body("did:key:z6Mk-bob", "[\"lease.claim\",\"task.write\"]", "*", 100), author = "did:key:z6Mk-alice")]);
    assert.equal(r.excluded.length(), 0);
    let c = only_cap(r);
    assert.equal(c.issuer, "did:key:z6Mk-alice");
    assert.equal(c.audience, "did:key:z6Mk-bob");
    assert.equal(c.can.length(), 2);
    assert.equal(c.revoked, false);
    assert.equal(cap_live(r.caps, "did:key:z6Mk-bob", "lease.claim", "task:X", 50), true);
    assert.equal(cap_live(r.caps, "did:key:z6Mk-bob", "cap.admin", "task:X", 50), false);
    assert.equal(cap_live(r.caps, "did:key:z6Mk-bob", "lease.claim", "task:X", 100), false);
    assert.equal(cap_live(r.caps, "did:key:z6Mk-bob", "lease.claim", "task:X", 101), false);
}

test "grant missing fields are excluded, never defaulted" {
    let b: map<string, unknown> = {};
    let _ = b.set("audience", "did:key:z6Mk-bob");
    let r = reduce([wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", b)]);
    assert.equal(r.caps.length(), 0);
    assert.equal(r.excluded[0].reason, "missing-cap-field");
}

test "stillborn and bad-expiry grants are evidence" {
    let r1 = reduce([wire("CapGrant", "did:key:z6Mk-bob", 50, "g1", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 50))]);
    assert.equal(r1.excluded[0].reason, "stillborn-grant");
    let r2 = reduce([wire("CapGrant", "did:key:z6Mk-bob", 1, "g2", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 0))]);
    assert.equal(r2.excluded[0].reason, "bad-expiry");
}

test "revoke by issuer sticks, re-revoke is a no-op" {
    let g = wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 100), author = "did:key:z6Mk-alice");
    let rb: map<string, unknown> = {};
    let _ = rb.set("grant_ref", "g1");
    let r = reduce(
        [
            g,
            wire("CapRevoke", "did:key:z6Mk-bob", 2, "r1", rb, author = "did:key:z6Mk-alice"),
            wire("CapRevoke", "did:key:z6Mk-bob", 3, "r2", rb, author = "did:key:z6Mk-alice"),
        ],
    );
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_cap(r).revoked, true);
    assert.equal(only_cap(r).revoked_by, "did:key:z6Mk-alice");
}

test "revoke by audience works, by stranger is denied" {
    let g = wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 100), author = "did:key:z6Mk-alice");
    let rb: map<string, unknown> = {};
    let _ = rb.set("grant_ref", "g1");
    let self = reduce([g, wire("CapRevoke", "did:key:z6Mk-bob", 2, "r1", rb, author = "did:key:z6Mk-bob")]);
    assert.equal(self.excluded.length(), 0);
    assert.equal(only_cap(self).revoked, true);
    let rb2: map<string, unknown> = {};
    let _ = rb2.set("grant_ref", "g1");
    let mallory = reduce([g, wire("CapRevoke", "did:key:z6Mk-bob", 2, "r9", rb2, author = "did:key:z6Mk-mallory")]);
    assert.equal(mallory.excluded[0].reason, "revoke-denied");
    assert.equal(only_cap(mallory).revoked, false);
}

test "revoke of unknown grant is evidence" {
    let rb: map<string, unknown> = {};
    let _ = rb.set("grant_ref", "nope");
    let r = reduce([wire("CapRevoke", "did:key:z6Mk-bob", 1, "r1", rb)]);
    assert.equal(r.excluded[0].reason, "unknown-grant");
}

test "new grant after revoke re-enables (per-id stickiness)" {
    let g1 = wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 100), author = "did:key:z6Mk-alice");
    let rb: map<string, unknown> = {};
    let _ = rb.set("grant_ref", "g1");
    let r1 = wire("CapRevoke", "did:key:z6Mk-bob", 2, "r1", rb, author = "did:key:z6Mk-alice");
    let g2 = wire("CapGrant", "did:key:z6Mk-bob", 3, "g2", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 100), author = "did:key:z6Mk-alice");
    let r = reduce([g1, r1, g2]);
    assert.equal(r.caps.length(), 2);
    assert.equal(cap_live(r.caps, "did:key:z6Mk-bob", "task.write", "*", 50), true);
}

test "scope narrows: exact or wildcard only" {
    let r = reduce([wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "task:A", 100))]);
    let acc = r.caps;
    assert.equal(cap_live(acc, "did:key:z6Mk-bob", "task.write", "task:A", 50), true);
    assert.equal(cap_live(acc, "did:key:z6Mk-bob", "task.write", "task:B", 50), false);
}

test "budget caps record without gating" {
    let b = grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 100);
    let _ = b.set("budget_cap_usd", 25);
    let r = reduce([wire("CapGrant", "did:key:z6Mk-bob", 1, "g1", b)]);
    assert.equal(r.excluded.length(), 0);
    assert.equal(only_cap(r).budget_cap_usd, 25.0);
    let bad = grant_body("did:key:z6Mk-bob", "[\"task.write\"]", "*", 100);
    let _ = bad.set("budget_cap_usd", 0 - 5);
    let r2 = reduce([wire("CapGrant", "did:key:z6Mk-bob", 1, "g9", bad)]);
    assert.equal(r2.excluded[0].reason, "bad-budget-cap");
}
