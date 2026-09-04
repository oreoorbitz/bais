// ns_event/dispatch — hub event dispatch table (bi#54).
//
// In a swarm, "unhandled message kind silently ignored" is how agents lose
// each other. This file is BAML's half of the hub: a pure dispatch table
// from event type to handler verdict (admit / route / reject). The host
// owns the transport unchanged; it consults this table at two gates:
//
//   - durable log admission: does this type enter the signed per-actor log
//     (and hence the reducers), or is it refused?
//   - ephemeral pub gate: heartbeat/progress NEVER enter the durable DAG
//     (is_ephemeral is the precedent, generalized here).
//
// Exhaustiveness is the point: `dispatch_event` matches on the `EventType`
// enum directly with one explicit arm per variant and NO wildcard. The
// compiler rejects a non-exhaustive enum match, so adding a variant to
// `EventType` without an arm here fails `baml check` — protocol extension
// becomes a compile error, not a runtime surprise. (A wildcard cannot even
// be added for convenience: with all arms present it is an unreachable-arm
// error, so the gate cannot silently rot.)
//
// FFI note: like `event_type_name`, the host-callable boundary takes the
// variant NAME as a plain string (`dispatch_by_name`) — hosts cannot pass
// enums inbound (proposals/05). A string match is open, so the compiler
// demands a `_` arm; ours REJECTS loudly with a named reason
// (`unknown-type: <name>`), which the issue explicitly allows. Each string
// arm delegates to `dispatch_event`, so the enum table stays the single
// source of truth.

enum DispatchRoute {
    AdmitDurable,
    RouteEphemeral,
    RouteCoordinator,
    Reject,
}

class DispatchVerdict {
    route: DispatchRoute,
    reason: string @description(
        "named reason: ok-* owning scope for admitted/routed types, loud cause for Reject",
    ),
}

// The dispatch table: every current EventType variant has an explicit arm.
// Reasons name the owning scope (a second reducer's scope counts —
// Project*/SchemaRegister are admitted for the project/registry projection,
// not the issue reducer).
function dispatch_event(t: EventType) -> DispatchVerdict {
    match (t) {
        EventType.ProjectCreate => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-project-scope" },
        EventType.ProjectPolicy => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-project-scope" },
        EventType.SchemaRegister => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-schema-registry" },
        EventType.TaskCreate => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.TaskSet => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.TaskTransition => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.LabelAdd => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.LabelRemove => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.RelAdd => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.RelRetract => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.CommentPost => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-issue-log" },
        EventType.LeaseClaim => DispatchVerdict { route: DispatchRoute.RouteCoordinator, reason: "ok-coordinator-claim" },
        EventType.LeaseRenew => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-lease-log" },
        EventType.LeaseRelease => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-lease-log" },
        EventType.WorkSubmit => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-work-log" },
        EventType.VerifyRecord => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-work-log" },
        EventType.WorkAccept => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-work-log" },
        EventType.WorkReject => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-work-log" },
        EventType.BudgetAuthorize => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-budget-log" },
        EventType.CostReserve => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-budget-log" },
        EventType.CostIncurred => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-budget-log" },
        EventType.ReceiptAttach => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-budget-log" },
        EventType.CapGrant => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-cap-log" },
        EventType.CapRevoke => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-cap-log" },
        EventType.KeyRotate => DispatchVerdict { route: DispatchRoute.Reject, reason: "unrouted-key-model" },
        EventType.CheckpointPublish => DispatchVerdict { route: DispatchRoute.AdmitDurable, reason: "ok-checkpoint-log" },
        EventType.Heartbeat => DispatchVerdict { route: DispatchRoute.RouteEphemeral, reason: "ok-ephemeral-pub" },
        EventType.Progress => DispatchVerdict { route: DispatchRoute.RouteEphemeral, reason: "ok-ephemeral-pub" },
    }
}

// Host-callable boundary: variant NAME in (FFI plain data), verdict out.
// Every arm delegates to `dispatch_event` so verdicts cannot drift from the
// table. The `_` arm is compiler-mandated for a string match and REJECTS
// loudly with a named reason — never a silent ignore.
function dispatch_by_name(t: string) -> DispatchVerdict {
    match (t) {
        "ProjectCreate" => dispatch_event(EventType.ProjectCreate),
        "ProjectPolicy" => dispatch_event(EventType.ProjectPolicy),
        "SchemaRegister" => dispatch_event(EventType.SchemaRegister),
        "TaskCreate" => dispatch_event(EventType.TaskCreate),
        "TaskSet" => dispatch_event(EventType.TaskSet),
        "TaskTransition" => dispatch_event(EventType.TaskTransition),
        "LabelAdd" => dispatch_event(EventType.LabelAdd),
        "LabelRemove" => dispatch_event(EventType.LabelRemove),
        "RelAdd" => dispatch_event(EventType.RelAdd),
        "RelRetract" => dispatch_event(EventType.RelRetract),
        "CommentPost" => dispatch_event(EventType.CommentPost),
        "LeaseClaim" => dispatch_event(EventType.LeaseClaim),
        "LeaseRenew" => dispatch_event(EventType.LeaseRenew),
        "LeaseRelease" => dispatch_event(EventType.LeaseRelease),
        "WorkSubmit" => dispatch_event(EventType.WorkSubmit),
        "VerifyRecord" => dispatch_event(EventType.VerifyRecord),
        "WorkAccept" => dispatch_event(EventType.WorkAccept),
        "WorkReject" => dispatch_event(EventType.WorkReject),
        "BudgetAuthorize" => dispatch_event(EventType.BudgetAuthorize),
        "CostReserve" => dispatch_event(EventType.CostReserve),
        "CostIncurred" => dispatch_event(EventType.CostIncurred),
        "ReceiptAttach" => dispatch_event(EventType.ReceiptAttach),
        "CapGrant" => dispatch_event(EventType.CapGrant),
        "CapRevoke" => dispatch_event(EventType.CapRevoke),
        "KeyRotate" => dispatch_event(EventType.KeyRotate),
        "CheckpointPublish" => dispatch_event(EventType.CheckpointPublish),
        "Heartbeat" => dispatch_event(EventType.Heartbeat),
        "Progress" => dispatch_event(EventType.Progress),
        _ => DispatchVerdict { route: DispatchRoute.Reject, reason: `unknown-type: ${t}` },
    }
}

function dispatch_variants() -> EventType[] {
    [
        EventType.ProjectCreate,
        EventType.ProjectPolicy,
        EventType.SchemaRegister,
        EventType.TaskCreate,
        EventType.TaskSet,
        EventType.TaskTransition,
        EventType.LabelAdd,
        EventType.LabelRemove,
        EventType.RelAdd,
        EventType.RelRetract,
        EventType.CommentPost,
        EventType.LeaseClaim,
        EventType.LeaseRenew,
        EventType.LeaseRelease,
        EventType.WorkSubmit,
        EventType.VerifyRecord,
        EventType.WorkAccept,
        EventType.WorkReject,
        EventType.BudgetAuthorize,
        EventType.CostReserve,
        EventType.CostIncurred,
        EventType.ReceiptAttach,
        EventType.CapGrant,
        EventType.CapRevoke,
        EventType.KeyRotate,
        EventType.CheckpointPublish,
        EventType.Heartbeat,
        EventType.Progress,
    ]
}

test "issue writes admit to the durable issue log" {
    for (let t in [EventType.TaskCreate, EventType.TaskSet, EventType.TaskTransition]) {
        let v = dispatch_event(t);
        assert.is_true(v.route == DispatchRoute.AdmitDurable);
        assert.equal(v.reason, "ok-issue-log");
    }
    let rel = dispatch_event(EventType.RelAdd);
    assert.is_true(rel.route == DispatchRoute.AdmitDurable);
    assert.equal(rel.reason, "ok-issue-log")
}

test "lease claim routes via coordinator, renew and release admit" {
    let claim = dispatch_event(EventType.LeaseClaim);
    assert.is_true(claim.route == DispatchRoute.RouteCoordinator);
    assert.equal(claim.reason, "ok-coordinator-claim");
    for (let t in [EventType.LeaseRenew, EventType.LeaseRelease]) {
        let v = dispatch_event(t);
        assert.is_true(v.route == DispatchRoute.AdmitDurable);
        assert.equal(v.reason, "ok-lease-log")
    }
}

test "heartbeat and progress route ephemeral, never durable" {
    for (let t in [EventType.Heartbeat, EventType.Progress]) {
        let v = dispatch_event(t);
        assert.is_true(v.route == DispatchRoute.RouteEphemeral);
        assert.equal(v.reason, "ok-ephemeral-pub")
    }
}

test "key rotation rejects loudly with a named reason" {
    let v = dispatch_event(EventType.KeyRotate);
    assert.is_true(v.route == DispatchRoute.Reject);
    assert.equal(v.reason, "unrouted-key-model")
}

test "unknown wire names reject loudly, never admit or route" {
    for (let name in ["Teleport", "", "task.create"]) {
        let v = dispatch_by_name(name);
        assert.is_true(v.route == DispatchRoute.Reject);
        assert.equal(v.reason, `unknown-type: ${name}`)
    }
}

test "string boundary agrees with the enum table on all variants" {
    let variants = dispatch_variants();
    assert.equal(variants.length(), 28);
    for (let v in variants) {
        let by_enum = dispatch_event(v);
        let by_name = dispatch_by_name(v.to_string());
        assert.is_true(by_name.route == by_enum.route);
        assert.equal(by_name.reason, by_enum.reason)
    }
}

test "verdicts agree with is_ephemeral and needs_coordinator" {
    for (let v in dispatch_variants()) {
        let route = dispatch_event(v).route;
        assert.equal(route == DispatchRoute.RouteEphemeral, is_ephemeral(v.to_string()));
        assert.equal(route == DispatchRoute.RouteCoordinator, needs_coordinator(v.to_string()))
    }
}

test "every EventType variant has a dispatch arm" {
    // Pinning for the hub table: the enum match itself is what fails
    // `baml check` when a variant is added without an arm. This list keeps
    // the string boundary and the consistency tests above in step — a
    // variant missing here fails here too.
    let variants = dispatch_variants();
    assert.equal(variants.length(), 28);
    for (let v in variants) {
        assert.is_true(dispatch_event(v).reason != "")
    }
}
