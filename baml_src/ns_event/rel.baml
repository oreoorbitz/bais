// ns_event/rel — reified edges (fusion v1, Phase 1, step 4).
//
// A dependency is not a field, it is an entity: its own stable id, an author,
// a reason, and an explicit retraction. Retracting one specific edge never
// ambiguously clobbers a concurrent addition the way mutating `[[edge]]` in a
// TOML file does. `Issue.id` stays the human alias (`bi#09`); `Rel` endpoints
// use the stable logical identity (`task:01J...`).

class Rel {
    id: string @description(
        "stable identity: rel:01J... ULID — survives edits, unlike the edge's position in a file",
    ),
    source: string @description("task:01J... that depends / is blocked"),
    type: string @description(
        "EdgeKind variant name (Blocks/DependsOn/...) — plain string at the FFI boundary: enums panic inbound and compare silently-false nested (proposals/05)",
    ),
    target: string @description("task:01J... it points at"),
    author: string @description("did:key:... who added this dependency — 'who added this and why' is free"),
    reason: string?,
    retracted: bool,
}

function rel_add(
    id: string,
    source: string,
    type: string,
    target: string,
    author: string,
    reason: string? = null,
) -> Rel {
    Rel {
        id: id,
        source: source,
        type: type,
        target: target,
        author: author,
        reason: reason,
        retracted: false,
    }
}

// Retraction is a new fact, not a deletion: the row stays as evidence and
// `active_rels` excludes it. Returns a copy — the input is untouched.
function rel_retract(r: Rel) -> Rel {
    Rel { ...r, retracted: true }
}

function active_rels(rels: Rel[]) -> Rel[] {
    rels.filter((r) -> {
        !r.retracted
    })
}

test "rel.add defaults to unretracted with author and reason" {
    let r = rel_add(
        "rel:01JAAA",
        "task:01JA",
        "Blocks",
        "task:01JB",
        "did:key:z6Mk-alice",
        reason = "B blocks A until the FFI bug is fixed",
    );
    assert.equal(r.retracted, false);
    assert.equal(r.author, "did:key:z6Mk-alice");
    assert.equal(r.type, "Blocks")
}

test "rel.retract returns a retracted copy, input untouched" {
    let r = rel_add("rel:01JAAA", "task:01JA", "DependsOn", "task:01JB", "did:key:z6Mk-bob");
    let gone = rel_retract(r);
    assert.equal(gone.retracted, true);
    assert.equal(gone.id, r.id);
    assert.equal(r.retracted, false)
}

test "active_rels excludes retractions but keeps evidence" {
    let a = rel_add("rel:01JAAA", "task:01JA", "Blocks", "task:01JB", "did:key:z6Mk-a");
    let b = rel_retract(rel_add("rel:01JAAB", "task:01JA", "Blocks", "task:01JC", "did:key:z6Mk-b"));
    let active = active_rels([a, b]);
    assert.equal(active.length(), 1);
    assert.equal(active[0].id, "rel:01JAAA")
}

test "concurrent add and retract of different edges do not clobber" {
    // Two writers each add an edge; one retracts only its own. The other
    // survives — impossible with last-writer-wins [[edge]] mutation.
    let keep = rel_add("rel:01JAAA", "task:01JA", "Blocks", "task:01JB", "did:key:z6Mk-a");
    let drop = rel_retract(rel_add("rel:01JAAB", "task:01JA", "Blocks", "task:01JC", "did:key:z6Mk-b"));
    let active = active_rels([keep, drop]);
    assert.equal(active.length(), 1);
    assert.equal(active[0].target, "task:01JB")
}
