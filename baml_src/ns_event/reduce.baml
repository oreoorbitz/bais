// ns_event/reduce — deterministic reduction: WireEvent[] -> materialized view.
//
// Pipeline position (fusion-report §5): the host verifies hashes, signatures,
// author-chain sequence, and capabilities-at-position BEFORE calling reduce —
// BAML has no crypto primitives, so those checks cannot live here. The host
// flags rejected events admitted=false; reduce keeps them as evidence in
// excluded[] but applies nothing from them. Ephemeral and out-of-scope types
// are ignored silently (telemetry / another reducer's scope); genuinely
// unknown type names are excluded as evidence (forward-compat review signal).
//
// FFI shape: input is WireEvent (all plain strings/ints/maps), NOT Event —
// hosts cannot pass enums inbound (proposals/05). type carries the variant
// NAME ("TaskSet"), matching SDK outbound serialization.
//
// Ordering: total order by (lc, id-hash) via order_key; per-field reducers see
// one deterministic sequence, so two hosts reduce identical logs identically
// (the divergent-reducer killer is the same-lc tiebreak test below).

function reducer_version() -> string {
    "bais.reduce@1"
}

// Host-admitted event: the plain-data mirror of envelope.Event plus the
// host's pre-pass verdict.
class WireEvent {
    id: string,
    author: string,
    seq: int,
    prev: string?,
    project: string,
    entity: string,
    refs: string[],
    lc: int,
    ts: string,
    type: string @description("variant NAME, e.g. TaskSet — never an encoded enum"),
    body: map<string, unknown> @description("readers MUST-ignore-unknown-fields"),
    admitted: bool,
    drop_reason: string?,
}

class ReducedIssue {
    entity: string,
    title: string,
    status: string,
    kind: string,
    area: string?,
    severity: int?,
    source: string?,
    body: string,
    labels: string[],
    comments: string[],
}

class ReducedRel {
    id: string,
    source: string,
    type: string,
    target: string,
}

class Conflict {
    entity: string,
    field: string,
    options: string[],
    winner: string?,
    event_ids: string[],
    at_lc: int,
}

class Excluded {
    event_id: string,
    reason: string,
}

class Reduction {
    version: string,
    issues: ReducedIssue[],
    rels: ReducedRel[],
    conflicts: Conflict[],
    excluded: Excluded[],
    leases: Lease[],
    submissions: Submission[],
    verifications: Verification[],
    budgets: Budget[],
    costs: CostEntry[],
    checkpoints: Checkpoint[],
}

// Fold accumulator (internal): label ops and transition records are kept raw
// and materialized at the end, so add-wins and conflict grouping see the full
// order rather than one event at a time.
class LabelOp {
    entity: string,
    label: string,
    added: bool,
    lc: int,
    id: string,
}

class TransRec {
    entity: string,
    to: string,
    lc: int,
    id: string,
}

class RelRec {
    rel: ReducedRel,
    retracted: bool,
}

class Acc {
    issues: ReducedIssue[],
    rels: RelRec[],
    label_ops: LabelOp[],
    transitions: TransRec[],
    conflicts: Conflict[],
    excluded: Excluded[],
    leases: Lease[],
    submissions: Submission[],
    verifications: Verification[],
    budgets: Budget[],
    costs: CostEntry[],
    checkpoints: Checkpoint[],
}

function body_string(body: map<string, unknown>, key: string) -> string? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let s: string = v {
        s
    } else {
        null
    }
}

function body_int(body: map<string, unknown>, key: string) -> int? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let n: int = v {
        n
    } else {
        null
    }
}

function is_status(s: string) -> bool {
    match (s) {
        "Open" | "Doing" | "Blocked" | "Done" | "Dropped" => true,
        _ => false,
    }
}

// Total-order key: zero-padded lc (lexicographic == numeric for lc < 10^20)
// plus content id. Two hosts sorting the same set produce the same sequence.
function order_key(e: WireEvent) -> string {
    let s = e.lc.to_string();
    let pad = "";
    let i = s.length();
    while (i < 20) {
        pad = pad + "0";
        i = i + 1;
    }
    `${pad}${s}#${e.id}`
}

// Minimal test constructor: positional (type, entity, lc, id, body), the rest
// defaulted. admitted/drop_reason model the host pre-pass.
function wire(
    t: string,
    entity: string,
    lc: int,
    id: string,
    body: map<string, unknown>,
    admitted: bool = true,
    drop_reason: string? = null,
    author: string = "did:key:z6Mk-test",
) -> WireEvent {
    WireEvent {
        id: id,
        author: author,
        seq: lc,
        prev: null,
        project: "bi",
        entity: entity,
        refs: [],
        lc: lc,
        ts: "2026-09-03T00:00:00Z",
        type: t,
        body: body,
        admitted: admitted,
        drop_reason: drop_reason,
    }
}

function str_body(key: string, val: string) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set(key, val);
    b
}

function find_issue(acc: Acc, entity: string) -> ReducedIssue? {
    acc.issues.find((i) -> {
        i.entity == entity
    })
}

function apply_create(acc: Acc, e: WireEvent) -> void {
    if (find_issue(acc, e.entity) != null) {
        acc.excluded.push(Excluded { event_id: e.id, reason: "duplicate-create" });
    } else {
        acc.issues.push(
            ReducedIssue {
                entity: e.entity,
                title: body_string(e.body, "title") ?? "untitled",
                status: "Open",
                kind: body_string(e.body, "kind") ?? "Feat",
                area: body_string(e.body, "area"),
                severity: body_int(e.body, "severity"),
                source: body_string(e.body, "source"),
                body: body_string(e.body, "body") ?? "",
                labels: [],
                comments: [],
            },
        );
    }
}

// Causal LWW per field: the input is already in total (lc, id) order, so the
// last write seen is the causal winner. Unknown entity is evidence, not state.
function apply_set(acc: Acc, e: WireEvent) -> void {
    if let iss: ReducedIssue = find_issue(acc, e.entity) {
        if let t: string = body_string(e.body, "title") {
            iss.title = t;
        }
        if let b: string = body_string(e.body, "body") {
            iss.body = b;
        }
        if let a: string = body_string(e.body, "area") {
            iss.area = a;
        }
        if let n: int = body_int(e.body, "severity") {
            iss.severity = n;
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-entity" });
    }
}

// Validated state machine: known statuses only, Dropped is terminal.
// Concurrent same-lc transitions to different targets are conflicts as values
// (Jujutsu model): state takes the (lc, id) winner, the conflict is recorded.
function apply_transition(acc: Acc, e: WireEvent) -> void {
    // Fencing gate (Phase 3): a task under an active lease only moves on an
    // exact fencing-token echo; otherwise the write is evidence, not state.
    if (!lease_fence_ok(acc, e.entity, e.lc, body_int(e.body, "fencing"))) {
        acc.excluded.push(Excluded { event_id: e.id, reason: "stale-fence" });
    } else if let to: string = body_string(e.body, "to") {
        if (!is_status(to)) {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-status" });
        } else if let iss: ReducedIssue = find_issue(acc, e.entity) {
            if (iss.status == "Dropped") {
                acc.excluded.push(Excluded { event_id: e.id, reason: "terminal-transition" });
            } else {
                for (let t in acc.transitions) {
                    if (t.entity == e.entity && t.lc == e.lc && t.to != to) {
                        note_transition_conflict(acc, e, to, t);
                    }
                }
                acc.transitions.push(TransRec { entity: e.entity, to: to, lc: e.lc, id: e.id });
                iss.status = to;
            }
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-entity" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-status" });
    }
}

function note_transition_conflict(acc: Acc, e: WireEvent, to: string, prior: TransRec) -> void {
    if let c: Conflict = acc.conflicts.find((x) -> {
        x.entity == e.entity && x.field == "status" && x.at_lc == e.lc
    }) {
        if (!c.options.includes(prior.to)) {
            c.options.push(prior.to);
        }
        if (!c.options.includes(to)) {
            c.options.push(to);
        }
        if (!c.event_ids.includes(prior.id)) {
            c.event_ids.push(prior.id);
        }
        if (!c.event_ids.includes(e.id)) {
            c.event_ids.push(e.id);
        }
        c.winner = to;
    } else {
        acc.conflicts.push(
            Conflict {
                entity: e.entity,
                field: "status",
                options: [prior.to, to],
                winner: to,
                event_ids: [prior.id, e.id],
                at_lc: e.lc,
            },
        );
    }
}

function apply_label(acc: Acc, e: WireEvent, added: bool) -> void {
    if let label: string = body_string(e.body, "label") {
        if (find_issue(acc, e.entity) == null) {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-entity" });
        } else {
            acc.label_ops.push(
                LabelOp { entity: e.entity, label: label, added: added, lc: e.lc, id: e.id },
            );
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-label" });
    }
}

function apply_comment(acc: Acc, e: WireEvent) -> void {
    if let iss: ReducedIssue = find_issue(acc, e.entity) {
        iss.comments.push(body_string(e.body, "text") ?? "");
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-entity" });
    }
}

function apply_rel_add(acc: Acc, e: WireEvent) -> void {
    if let target: string = body_string(e.body, "target") {
        let rel_id = body_string(e.body, "rel_id") ?? e.id;
        if (
            acc.rels.find((r) -> {
                r.rel.id == rel_id
            })
                != null
        ) {
            acc.excluded.push(Excluded { event_id: e.id, reason: "duplicate-rel" });
        } else {
            acc.rels.push(
                RelRec {
                    rel: ReducedRel {
                        id: rel_id,
                        source: body_string(e.body, "source") ?? e.entity,
                        type: body_string(e.body, "type") ?? "Related",
                        target: target,
                    },
                    retracted: false,
                },
            );
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-target" });
    }
}

function apply_rel_retract(acc: Acc, e: WireEvent) -> void {
    if let rel_id: string = body_string(e.body, "rel_id") {
        if let rec: RelRec = acc.rels.find((r) -> {
            r.rel.id == rel_id
        }) {
            rec.retracted = true;
        } else {
            acc.excluded.push(Excluded { event_id: e.id, reason: "unknown-rel" });
        }
    } else {
        acc.excluded.push(Excluded { event_id: e.id, reason: "missing-rel_id" });
    }
}

function dispatch(acc: Acc, e: WireEvent) -> void {
    if (!e.admitted) {
        acc.excluded.push(
            Excluded { event_id: e.id, reason: `not-admitted: ${e.drop_reason ?? "unspecified"}` },
        );
    } else if (e.type == "TaskCreate") {
        apply_create(acc, e);
    } else if (e.type == "TaskSet") {
        apply_set(acc, e);
    } else if (e.type == "TaskTransition") {
        apply_transition(acc, e);
    } else if (e.type == "LabelAdd") {
        apply_label(acc, e, true);
    } else if (e.type == "LabelRemove") {
        apply_label(acc, e, false);
    } else if (e.type == "CommentPost") {
        apply_comment(acc, e);
    } else if (e.type == "RelAdd") {
        apply_rel_add(acc, e);
    } else if (e.type == "RelRetract") {
        apply_rel_retract(acc, e);
    } else if (e.type == "LeaseClaim") {
        apply_claim(acc, e);
    } else if (e.type == "LeaseRenew") {
        apply_renew(acc, e);
    } else if (e.type == "LeaseRelease") {
        apply_release(acc, e);
    } else if (e.type == "WorkSubmit") {
        apply_submit(acc, e);
    } else if (e.type == "VerifyRecord") {
        apply_verify(acc, e);
    } else if (e.type == "WorkAccept") {
        apply_accept(acc, e);
    } else if (e.type == "WorkReject") {
        apply_reject(acc, e);
    } else if (e.type == "BudgetAuthorize") {
        apply_authorize(acc, e);
    } else if (e.type == "CostReserve") {
        apply_reserve(acc, e);
    } else if (e.type == "CostIncurred") {
        apply_incurred(acc, e);
    } else if (e.type == "ReceiptAttach") {
        apply_receipt(acc, e);
    } else if (e.type == "CheckpointPublish") {
        apply_checkpoint(acc, e);
    } else if (event_type_name(e.type) == "unknown" && !is_ephemeral(e.type)) {
        acc.excluded.push(Excluded { event_id: e.id, reason: `unknown-type: ${e.type}` });
    }
}

// Known-but-out-of-scope types (Phase 3: verify,budget,caps) and ephemeral
// telemetry fall through the chain above with no arm: neither state nor
// evidence for this reducer.

// Add-wins OR-Set per (entity, label): the max (lc, id) op decides, except a
// remove concurrent with the winning add (same lc) loses to the add. Removes
// with strictly greater lc win — that is causal dominance in total order.
function label_present(ops: LabelOp[], entity: string, label: string) -> bool {
    let best_add_lc = -1;
    let best_add_id = "";
    let best_rem_lc = -1;
    for (let o in ops) {
        if (o.entity == entity && o.label == label) {
            if (o.added) {
                if (o.lc > best_add_lc || (o.lc == best_add_lc && o.id > best_add_id)) {
                    best_add_lc = o.lc;
                    best_add_id = o.id;
                }
            } else if (o.lc > best_rem_lc) {
                best_rem_lc = o.lc;
            }
        }
    }
    if (best_add_lc == -1) {
        false
    } else {
        best_rem_lc <= best_add_lc
    }
}

function present_labels(ops: LabelOp[], entity: string) -> string[] {
    let out: string[] = [];
    for (let o in ops) {
        if (o.entity == entity && !out.includes(o.label) && label_present(ops, entity, o.label)) {
            out.push(o.label);
        }
    }
    out
}

function reduce(events: WireEvent[]) -> Reduction {
    // Copy before sorting: sort_by_key reorders the receiver in place.
    let ordered = events
        .map((e) -> {
            e
        })
        .sort_by_key((e) -> {
            order_key(e)
        });
    let acc = Acc {
        issues: [],
        rels: [],
        label_ops: [],
        transitions: [],
        conflicts: [],
        excluded: [],
        leases: [],
        submissions: [],
        verifications: [],
        budgets: [],
        costs: [],
        checkpoints: [],
    };
    let max_lc = 0;
    for (let e in ordered) {
        dispatch(acc, e);
        if (e.admitted && e.lc > max_lc) {
            max_lc = e.lc;
        }
    }
    // Derived expiry (Phase 3): expire is never written, only swept here.
    sweep_expiry(acc, max_lc);
    for (let iss in acc.issues) {
        iss.labels = present_labels(acc.label_ops, iss.entity);
    }
    let out_rels: ReducedRel[] = [];
    for (let r in acc.rels) {
        if (!r.retracted) {
            out_rels.push(r.rel);
        }
    }
    Reduction {
        version: reducer_version(),
        issues: acc.issues,
        rels: out_rels,
        conflicts: acc.conflicts,
        excluded: acc.excluded,
        leases: acc.leases,
        submissions: acc.submissions,
        verifications: acc.verifications,
        budgets: acc.budgets,
        costs: acc.costs,
        checkpoints: acc.checkpoints,
    }
}

function only_issue(r: Reduction) -> ReducedIssue {
    assert.equal(r.issues.length(), 1);
    r.issues[0]
}

test "create materializes with defaults" {
    let r = reduce([wire("TaskCreate", "task:A", 1, "e1", {})]);
    assert.equal(r.version, "bais.reduce@1");
    let iss = only_issue(r);
    assert.equal(iss.title, "untitled");
    assert.equal(iss.status, "Open");
    assert.equal(iss.kind, "Feat");
    assert.equal(r.excluded.length(), 0)
}

test "create reads title kind area severity source body" {
    let b: map<string, unknown> = {};
    let _ = b.set("title", "Fix it");
    let _ = b.set("kind", "Bug");
    let _ = b.set("area", "bridge/ffi");
    let _ = b.set("severity", 2);
    let _ = b.set("source", "baml.errors.TypeMismatch");
    let _ = b.set("body", "repro here");
    let iss = only_issue(reduce([wire("TaskCreate", "task:A", 1, "e1", b)]));
    assert.equal(iss.title, "Fix it");
    assert.equal(iss.kind, "Bug");
    assert.equal(iss.area, "bridge/ffi");
    assert.equal(iss.severity, 2);
    assert.equal(iss.source, "baml.errors.TypeMismatch");
    assert.equal(iss.body, "repro here")
}

test "set is LWW by lc, not array position" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("TaskSet", "task:A", 5, "e2", str_body("title", "newer")),
        wire("TaskSet", "task:A", 2, "e3", str_body("title", "older")),
    ];
    assert.equal(only_issue(reduce(events)).title, "newer")
}

test "transition moves status, unknown status excluded" {
    let b: map<string, unknown> = {};
    let _ = b.set("to", "Doing");
    let r = reduce([wire("TaskCreate", "task:A", 1, "e1", {}), wire("TaskTransition", "task:A", 2, "e2", b)]);
    assert.equal(only_issue(r).status, "Doing");
    assert.equal(r.excluded.length(), 0);
    let bad: map<string, unknown> = {};
    let _ = bad.set("to", "Working");
    let r2 = reduce([wire("TaskCreate", "task:A", 1, "e1", {}), wire("TaskTransition", "task:A", 2, "e2", bad)]);
    assert.equal(only_issue(r2).status, "Open");
    assert.equal(r2.excluded.length(), 1);
    assert.equal(r2.excluded[0].reason, "unknown-status")
}

test "concurrent same-lc transitions conflict, greater id wins" {
    let to_doing = str_body("to", "Doing");
    let to_blocked = str_body("to", "Blocked");
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("TaskTransition", "task:A", 2, "e2", to_doing),
        wire("TaskTransition", "task:A", 2, "e3", to_blocked),
    ];
    let r = reduce(events);
    // e3 > e2, so Blocked is the deterministic winner; the conflict is a value.
    assert.equal(only_issue(r).status, "Blocked");
    assert.equal(r.conflicts.length(), 1);
    assert.equal(r.conflicts[0].field, "status");
    assert.equal(r.conflicts[0].winner, "Blocked");
    assert.equal(r.conflicts[0].event_ids.length(), 2)
}

test "sequential transitions to different targets are not conflicts" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("TaskTransition", "task:A", 2, "e2", str_body("to", "Doing")),
        wire("TaskTransition", "task:A", 3, "e3", str_body("to", "Done")),
    ];
    let r = reduce(events);
    assert.equal(only_issue(r).status, "Done");
    assert.equal(r.conflicts.length(), 0)
}

test "Dropped is terminal" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("TaskTransition", "task:A", 2, "e2", str_body("to", "Dropped")),
        wire("TaskTransition", "task:A", 3, "e3", str_body("to", "Open")),
    ];
    let r = reduce(events);
    assert.equal(only_issue(r).status, "Dropped");
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "terminal-transition")
}

test "labels add-wins, remove needs strictly greater lc" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("LabelAdd", "task:A", 2, "e2", str_body("label", "backend")),
        wire("LabelRemove", "task:A", 3, "e3", str_body("label", "backend")),
        wire("LabelAdd", "task:A", 4, "e4", str_body("label", "frontend")),
    ];
    assert.equal(only_issue(reduce(events)).labels, ["frontend"])
}

test "concurrent add and remove at same lc keeps the label" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("LabelAdd", "task:A", 2, "e2", str_body("label", "backend")),
        wire("LabelRemove", "task:A", 2, "e3", str_body("label", "backend")),
    ];
    assert.equal(only_issue(reduce(events)).labels, ["backend"])
}

test "comments append in lc order" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("CommentPost", "task:A", 3, "e2", str_body("text", "second")),
        wire("CommentPost", "task:A", 2, "e3", str_body("text", "first")),
    ];
    assert.equal(only_issue(reduce(events)).comments, ["first", "second"])
}

test "rel add then retract leaves no rel but keeps evidence" {
    let add_b: map<string, unknown> = {};
    let _ = add_b.set("rel_id", "rel:1");
    let _ = add_b.set("target", "task:B");
    let _ = add_b.set("type", "Blocks");
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("RelAdd", "task:A", 2, "e2", add_b),
        wire("RelRetract", "task:A", 3, "e3", str_body("rel_id", "rel:1")),
    ];
    let r = reduce(events);
    assert.equal(r.rels.length(), 0);
    assert.equal(r.excluded.length(), 0)
}

test "rel retract of unknown id is excluded" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("RelRetract", "task:A", 2, "e2", str_body("rel_id", "rel:nope")),
    ];
    let r = reduce(events);
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "unknown-rel")
}

test "unadmitted events are evidence, never state" {
    let b: map<string, unknown> = {};
    let _ = b.set("to", "Doing");
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("TaskTransition", "task:A", 2, "e2", b, admitted = false, drop_reason = "bad-sig"),
    ];
    let r = reduce(events);
    assert.equal(only_issue(r).status, "Open");
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "not-admitted: bad-sig")
}

test "ephemeral and unrouted Phase-4/5 types leave no trace" {
    // Leases, verify, budget, and checkpoints reduce; caps/keys still fall
    // through with no arm until Phase 5 lands.
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("Heartbeat", "task:A", 2, "e2", {}),
        wire("CapGrant", "task:A", 3, "e3", {}),
        wire("KeyRotate", "task:A", 4, "e4", {}),
        wire("Progress", "task:A", 5, "e5", {}),
    ];
    let r = reduce(events);
    assert.equal(only_issue(r).status, "Open");
    assert.equal(r.excluded.length(), 0);
    assert.equal(r.conflicts.length(), 0);
    assert.equal(r.leases.length(), 0);
    assert.equal(r.submissions.length(), 0);
    assert.equal(r.budgets.length(), 0);
    assert.equal(r.checkpoints.length(), 0)
}

test "unknown type is excluded evidence" {
    let events = [wire("TaskCreate", "task:A", 1, "e1", {}), wire("Teleport", "task:A", 2, "e2", {})];
    let r = reduce(events);
    assert.equal(r.excluded.length(), 1);
    assert.equal(r.excluded[0].reason, "unknown-type: Teleport")
}

test "duplicate create and unknown-entity set are excluded" {
    let events = [
        wire("TaskCreate", "task:A", 1, "e1", {}),
        wire("TaskCreate", "task:A", 2, "e2", {}),
        wire("TaskSet", "task:ghost", 3, "e3", str_body("title", "x")),
    ];
    let r = reduce(events);
    assert.equal(r.issues.length(), 1);
    assert.equal(r.excluded.length(), 2)
}

test "same events in different input order reduce identically" {
    let mk = (flip: bool) -> Reduction {
        let create = wire("TaskCreate", "task:A", 1, "e1", str_body("title", "t"));
        let a = wire("TaskTransition", "task:A", 2, "e2", str_body("to", "Doing"));
        let b = wire("TaskTransition", "task:A", 2, "e3", str_body("to", "Blocked"));
        if (flip) {
            reduce([b, a, create])
        } else {
            reduce([create, a, b])
        }
    };
    let r1 = mk(false);
    let r2 = mk(true);
    assert.equal(only_issue(r1).status, only_issue(r2).status);
    assert.equal(r1.conflicts.length(), r2.conflicts.length());
    assert.equal(r1.conflicts[0].winner, r2.conflicts[0].winner)
}

test "empty log reduces to empty versioned reduction" {
    let r = reduce([]);
    assert.equal(r.version, "bais.reduce@1");
    assert.equal(r.issues.length(), 0);
    assert.equal(r.excluded.length(), 0)
}
