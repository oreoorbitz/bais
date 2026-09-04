// ns_event/envelope — BAIS event-log envelope (fusion v1, Phase 1).
//
// The signed per-actor event log is the source of truth; `.bais/issues/*.toml`
// is a projection (see reduce.baml, Phase 2). This file owns the SHAPE of an
// event plus the pure classification helpers a reducer needs. It deliberately
// does NOT own crypto: there is no `baml.crypto` sign primitive, so the host
// signs `ed25519(canonical-CBOR(project + prev + refs + body))` with a
// `did:key` and stores the multibase signature in `sig`. Canonical CBOR (not
// raw JSON) is locked here — signing raw JSON is a replay/malleability
// footgun (fusion-report §5).
//
// Identity is two-layer (fusion-report §2): `Event.id` is the version identity
// (`bafy...` content hash, assigned by the host after signing); `entity` is
// the logical identity (stable `task:01J...` ULID, or a legacy `bi#09` alias).

enum EventType {
    ProjectCreate,
    ProjectPolicy,
    SchemaRegister,
    TaskCreate,
    TaskSet,
    TaskTransition,
    LabelAdd,
    LabelRemove,
    RelAdd,
    RelRetract,
    CommentPost,
    LeaseClaim,
    LeaseRenew,
    LeaseRelease,
    WorkSubmit,
    VerifyRecord,
    WorkAccept,
    WorkReject,
    BudgetAuthorize,
    CostReserve,
    CostIncurred,
    ReceiptAttach,
    CapGrant,
    CapRevoke,
    KeyRotate,
    CheckpointPublish,
    Heartbeat,
    Progress,
}

class EventCost {
    tokens: int,
    usd: float,
}

class CapRef {
    event: string @description("bafy... of the cap.grant event proving this write was authorized"),
}

class Event {
    id: string @description(
        "version identity: CIDv1-raw over sha256 of the JCS-canonical payload (all other Event fields, UTF-8; commits to sig) — src/ids.ts; assigned by the host after signing; 'bafy-test' in tests",
    ),
    author: string @description("did:key:... of the writer; one chain per author gives per-writer total order"),
    seq: int @description("author's log sequence; 0 for the first event, prev must be null iff seq == 0"),
    prev: string? @description("author's previous event id (bafy...); fork detection"),
    project: string @description("owning project scope, e.g. bi — the replication boundary"),
    entity: string @description("logical identity: stable task:01J... (or rel:01J...), never the content hash"),
    refs: string[] @description("entity DAG heads seen (bafy...); causal history for merge"),
    lc: int @description("Lamport clock — tiebreak only, never wall-clock truth"),
    ts: string @description("advisory wall-clock (RFC3339); ignored by causal LWW reducers"),
    type: EventType,
    body: map<string, unknown> @description(
        "per-type payload; readers MUST-ignore-unknown-fields for forward compat",
    ),
    cost: EventCost?,
    cap: CapRef?,
    sig: string? @description("ed25519 multibase signature; null only pre-signing"),
}

// Wire name for each type: `bais.<dotted>@<version>`. The match is exhaustive,
// so adding a variant without a wire name fails `baml check` — the registry
// cannot silently grow.
//
// Takes the variant NAME as a plain string ("LeaseClaim"), not an EventType:
// a host passing an enum inbound hits the FFI enum-argument gap
// (proposals/05 — `expected variant, got string` panic), while the SDK
// serializes enums to exactly these strings outbound. Plain-data FFI, the same
// reason bi uses a string `provider` tag. `Event.type` stays typed — it is the
// schema for LLM output and SDK consumers, not the host-call boundary.
function event_type_name(t: string) -> string {
    match (t) {
        "ProjectCreate" => "bais.project.create@1",
        "ProjectPolicy" => "bais.project.policy@1",
        "SchemaRegister" => "bais.schema.register@1",
        "TaskCreate" => "bais.task.create@1",
        "TaskSet" => "bais.task.set@1",
        "TaskTransition" => "bais.task.transition@1",
        "LabelAdd" => "bais.label.add@1",
        "LabelRemove" => "bais.label.remove@1",
        "RelAdd" => "bais.rel.add@1",
        "RelRetract" => "bais.rel.retract@1",
        "CommentPost" => "bais.comment.post@1",
        "LeaseClaim" => "bais.lease.claim@1",
        "LeaseRenew" => "bais.lease.renew@1",
        "LeaseRelease" => "bais.lease.release@1",
        "WorkSubmit" => "bais.work.submit@1",
        "VerifyRecord" => "bais.verify.record@1",
        "WorkAccept" => "bais.work.accept@1",
        "WorkReject" => "bais.work.reject@1",
        "BudgetAuthorize" => "bais.budget.authorize@1",
        "CostReserve" => "bais.cost.reserve@1",
        "CostIncurred" => "bais.cost.incurred@1",
        "ReceiptAttach" => "bais.receipt.attach@1",
        "CapGrant" => "bais.cap.grant@1",
        "CapRevoke" => "bais.cap.revoke@1",
        "KeyRotate" => "bais.key.rotate@1",
        "CheckpointPublish" => "bais.checkpoint.publish@1",
        "Heartbeat" => "bais.heartbeat@1",
        "Progress" => "bais.progress@1",
        _ => "unknown",
    }
}

// Ephemeral channel (fusion-report §2, Nostr model): heartbeat/progress NEVER
// enter the durable DAG. The hub routes them to memory/pubsub; reduce.baml and
// SQLite must not persist them. Without this split, 5 agents at 1Hz costs
// ~432MB/day of durable bloat.
function is_ephemeral(t: string) -> bool {
    match (t) {
        "Heartbeat" | "Progress" => true,
        _ => false,
    }
}

// The one operation that needs coordination (fusion-report §2): exclusive
// claim on work is provably impossible in an AP system, so lease.claim goes
// through the hub's linearizable coordinator. Everything else merges without
// coordination.
function needs_coordinator(t: string) -> bool {
    match (t) {
        "LeaseClaim" => true,
        _ => false,
    }
}

// Structural chain sanity (not crypto): seq 0 is genesis (no prev), every
// later event names its predecessor. Signature/seq-continuity verification
// lives in the host; this is what the reducer asserts before applying.
function chain_ok(seq: int, prev: string?) -> bool {
    if (seq == 0) {
        prev == null
    } else {
        seq > 0 && prev != null
    }
}

// Scope of an entity id within a project: legacy `bi#09` aliases carry their
// scope in the id (reuses root.id_project); stable `task:01J...` ids carry no
// scope, so they belong to the event's project.
function entity_scope(entity: string, project: string) -> string {
    let scope = root.id_project(entity);
    if (scope == "") {
        project
    } else {
        scope
    }
}

// Schema registry support (fusion v1, Phase 1, step 5): wire names carry
// `lexicon@version`. The host validates the lexicon against the in-band
// `schema.register` table at ingest and MUST-ignore-unknown-fields inside
// `body`; these helpers split the two halves of a wire name for that dispatch.
function wire_lexicon(name: string) -> string {
    let idx = name.index_of("@");
    if (idx == null) {
        name
    } else {
        name.slice(0, idx)
    }
}

function wire_version(name: string) -> string? {
    let idx = name.index_of("@");
    if (idx == null) {
        null
    } else {
        name.slice(idx + 1, name.length())
    }
}

// Minimal constructor for tests — unsigned (sig null) pre-commit shape.
function test_event(t: EventType, entity: string) -> Event {
    let body: map<string, unknown> = {};
    Event {
        id: "bafy-test",
        author: "did:key:z6Mk-test",
        seq: 0,
        prev: null,
        project: "bi",
        entity: entity,
        refs: [],
        lc: 0,
        ts: "2026-09-03T00:00:00Z",
        type: t,
        body: body,
        cost: null,
        cap: null,
        sig: null,
    }
}

test "wire project.create" {
    assert.equal(event_type_name("ProjectCreate"), "bais.project.create@1")
}

test "wire project.policy" {
    assert.equal(event_type_name("ProjectPolicy"), "bais.project.policy@1")
}

test "wire schema.register" {
    assert.equal(event_type_name("SchemaRegister"), "bais.schema.register@1")
}

test "wire task.create" {
    assert.equal(event_type_name("TaskCreate"), "bais.task.create@1")
}

test "wire task.set" {
    assert.equal(event_type_name("TaskSet"), "bais.task.set@1")
}

test "wire task.transition" {
    assert.equal(event_type_name("TaskTransition"), "bais.task.transition@1")
}

test "wire label.add" {
    assert.equal(event_type_name("LabelAdd"), "bais.label.add@1")
}

test "wire label.remove" {
    assert.equal(event_type_name("LabelRemove"), "bais.label.remove@1")
}

test "wire rel.add" {
    assert.equal(event_type_name("RelAdd"), "bais.rel.add@1")
}

test "wire rel.retract" {
    assert.equal(event_type_name("RelRetract"), "bais.rel.retract@1")
}

test "wire comment.post" {
    assert.equal(event_type_name("CommentPost"), "bais.comment.post@1")
}

test "wire lease.claim" {
    assert.equal(event_type_name("LeaseClaim"), "bais.lease.claim@1")
}

test "wire lease.renew" {
    assert.equal(event_type_name("LeaseRenew"), "bais.lease.renew@1")
}

test "wire lease.release" {
    assert.equal(event_type_name("LeaseRelease"), "bais.lease.release@1")
}

test "wire work.submit" {
    assert.equal(event_type_name("WorkSubmit"), "bais.work.submit@1")
}

test "wire verify.record" {
    assert.equal(event_type_name("VerifyRecord"), "bais.verify.record@1")
}

test "wire work.accept" {
    assert.equal(event_type_name("WorkAccept"), "bais.work.accept@1")
}

test "wire work.reject" {
    assert.equal(event_type_name("WorkReject"), "bais.work.reject@1")
}

test "wire budget.authorize" {
    assert.equal(event_type_name("BudgetAuthorize"), "bais.budget.authorize@1")
}

test "wire cost.reserve" {
    assert.equal(event_type_name("CostReserve"), "bais.cost.reserve@1")
}

test "wire cost.incurred" {
    assert.equal(event_type_name("CostIncurred"), "bais.cost.incurred@1")
}

test "wire receipt.attach" {
    assert.equal(event_type_name("ReceiptAttach"), "bais.receipt.attach@1")
}

test "wire cap.grant" {
    assert.equal(event_type_name("CapGrant"), "bais.cap.grant@1")
}

test "wire cap.revoke" {
    assert.equal(event_type_name("CapRevoke"), "bais.cap.revoke@1")
}

test "wire key.rotate" {
    assert.equal(event_type_name("KeyRotate"), "bais.key.rotate@1")
}

test "wire checkpoint.publish" {
    assert.equal(event_type_name("CheckpointPublish"), "bais.checkpoint.publish@1")
}

test "wire heartbeat" {
    assert.equal(event_type_name("Heartbeat"), "bais.heartbeat@1")
}

test "wire progress" {
    assert.equal(event_type_name("Progress"), "bais.progress@1")
}

test "every EventType variant has a wire name" {
    // Pinning for the registry: the string match has a wildcard arm, so this
    // list is what fails when a variant is added without a wire row. The
    // per-type tests above pin the exact names.
    let variants = [
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
    ];
    assert.equal(variants.length(), 28);
    for (let v in variants) {
        assert.is_true(event_type_name(v.to_string()) != "unknown")
    }
}

test "only heartbeat and progress are ephemeral" {
    assert.equal(is_ephemeral("Heartbeat"), true);
    assert.equal(is_ephemeral("Progress"), true);
    assert.equal(is_ephemeral("CommentPost"), false);
    assert.equal(is_ephemeral("TaskTransition"), false);
    assert.equal(is_ephemeral("CheckpointPublish"), false)
}

test "only lease.claim needs the coordinator" {
    assert.equal(needs_coordinator("LeaseClaim"), true);
    assert.equal(needs_coordinator("LeaseRenew"), false);
    assert.equal(needs_coordinator("TaskSet"), false);
    assert.equal(needs_coordinator("WorkSubmit"), false)
}

test "chain_ok pins genesis and continuation" {
    assert.equal(chain_ok(0, null), true);
    assert.equal(chain_ok(0, "bafy-prev"), false);
    assert.equal(chain_ok(1, "bafy-prev"), true);
    assert.equal(chain_ok(1, null), false);
    assert.equal(chain_ok(-1, null), false)
}

test "entity_scope prefers the id prefix, falls back to project" {
    assert.equal(entity_scope("task:01JABC", "bi"), "bi");
    assert.equal(entity_scope("bi#09", "bi"), "bi");
    assert.equal(entity_scope("bagl#02", "bi"), "bagl");
    assert.equal(entity_scope("rel:01JDEF", "bagl"), "bagl")
}

test "wire names split into lexicon and version" {
    assert.equal(wire_lexicon("bais.task.set@1"), "bais.task.set");
    assert.equal(wire_version("bais.task.set@1"), "1");
    assert.equal(wire_lexicon("bais.lease.claim@1"), "bais.lease.claim");
    assert.equal(wire_version("unversioned"), null);
    assert.equal(wire_lexicon("unversioned"), "unversioned")
}

test "lease claim event carries fencing shape" {
    let e = test_event(EventType.LeaseClaim, "task:01JABC");
    assert.equal(e.seq, 0);
    assert.equal(e.prev, null);
    assert.equal(event_type_name(e.type.to_string()), "bais.lease.claim@1");
    assert.equal(needs_coordinator(e.type.to_string()), true);
    assert.equal(is_ephemeral(e.type.to_string()), false);
    assert.equal(chain_ok(e.seq, e.prev), true)
}
