// BAIS — Basically A made-up Issue Standard
// Graph-native, directory-local issue language. One Issue = one file in
// .bais/issues/<id>.toml, git is the hosting for now. Ingredients are
// popular (GitHub Issues model, TOML frontmatter, git file layout,
// JIRA link types, rg as index); recipe (graph + directory-local) is new.
// Defined in BAML so `baml check`/`baml test` + `baml generate` give
// typed Issue/Edge to every consumer (bi, bagl, bais CLI, future bais-* tools).

enum Status {
    Open,
    Doing,
    Blocked,
    Done,
    Dropped,
}

enum Kind {
    Bug,
    Feat,
    Proposal,
    Debt,
    Flake,
    Spike,
}

enum EdgeKind {
    Blocks,
    DependsOn,
    SubtaskOf,
    DuplicateOf,
    Related,
    Fixes,
    Replaces,
}

class Issue {
    id: string @description(
        "directory-scoped, e.g. bi#09 or bagl#03 — sequential is human-friendly, hash is content-addressable",
    ),
    title: string,
    status: Status,
    kind: Kind,
    area: string? @description("e.g. ai/media, bridge/ffi, cli/bi — for bais list --area"),
    severity: int? @description("1-5, optional"),
    source: string? @description("BAML error class, e.g. baml.errors.TypeMismatch"),
    body: string @description("markdown — repro + acceptance criteria, like bi/proposals/09"),
}

class Edge {
    from: string @description("issue id, e.g. bi#09"),
    to: string @description("issue id, e.g. bagl#02"),
    kind: EdgeKind,
}

// Extensibility: consumers add fields via IssueExtension interface, or via
// per-project .bais/config.toml that bais check validates. BAML interfaces
// let bi/.bais and bagl/.bais each add kinds/status without forking.
interface IssueExtension {
    function validate(self, issue: Issue) -> bool throws never
}

// Query helpers — provable via `baml test` on literal Issue[] (no LLM).
function is_blocked(issue: Issue, edges: Edge[], issues: Issue[]) -> bool {
    for (let e in edges) {
        if (e.to == issue.id && e.kind == EdgeKind.Blocks) {
            let resolved = false;
            for (let blocker in issues) {
                if (blocker.id == e.from) {
                    resolved = true;
                    if (blocker.status != Status.Done && blocker.status != Status.Dropped) {
                        return true;
                    }
                }
            }
            // A Blocks edge naming an id we cannot see (cross-project edge, typo,
            // directory not loaded) is unresolvable: we cannot prove the blocker is
            // closed, so the node is not ready. Conservative on purpose — the old
            // behaviour silently treated a dangling blocker as satisfied and handed
            // the node out as work. A typo therefore parks the issue rather than
            // faking readiness — `bais check` does not yet report dangling edges,
            // which is the follow-up that makes the typo case loud.
            if (!resolved) {
                return true;
            }
        }
    }
    false
}

// Epic policy (derived, never stored): an issue is an epic iff at least
// one SubtaskOf edge points at it. Direction: the edge runs from the
// subtask (child) to the epic (parent) — `from` does the work, `to`
// coordinates it. Doing-claims consult is_epic (epic + footprint gate,
// bais/src/cli.ts + bi/src/bais.ts) and route around epics instead of
// reading "(epic)" prose in titles; ready/dispatch consult is_epic too
// (hub#223) — epics leave the ready set and dispatch withholds them with
// a named reason (dispatch_epic_withheld), mirroring the hub#175
// unknown-footprint lane. A big task with no subtasks is not an epic;
// an epic whose subtasks all close stays an epic (Done needs Evidence
// like any other Done).
function is_epic(issue: Issue, edges: Edge[]) -> bool {
    edges.some((e) -> {
        e.to == issue.id && e.kind == EdgeKind.SubtaskOf
    })
}

// The subtask ids coordinated by an epic — the work the epic closes over.
function epic_children(epic: Issue, edges: Edge[]) -> string[] {
    edges
        .filter((e) -> {
            e.to == epic.id && e.kind == EdgeKind.SubtaskOf
        })
        .map((e) -> {
            e.from
        })
}

function ready_issues(issues: Issue[], edges: Edge[]) -> Issue[] {
    issues.filter((issue) -> {
        // Epics coordinate from outside the pack, never inside it (hub#223):
        // an Open epic is not work, so it never reads as ready.
        issue.status == Status.Open && !is_blocked(issue, edges, issues) && !is_epic(issue, edges)
    })
}

test "epic is derived from inbound subtask edges" {
    let epic = Issue {
        id: "bi#26",
        title: "e",
        status: Status.Open,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let child = Issue {
        id: "bi#27",
        title: "c",
        status: Status.Open,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let lone = Issue {
        id: "bi#99",
        title: "l",
        status: Status.Open,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    // No edges at all: nothing is an epic, not even a big Feat.
    assert.is_true(!is_epic(epic, []));
    // A Related edge to the candidate changes nothing.
    assert.is_true(!is_epic(epic, [Edge { from: "bi#27", to: "bi#26", kind: EdgeKind.Related }]));
    // A SubtaskOf edge pointing AT the candidate makes it an epic;
    // the reverse direction does not.
    let sub = [Edge { from: "bi#27", to: "bi#26", kind: EdgeKind.SubtaskOf }];
    assert.is_true(is_epic(epic, sub));
    assert.is_true(!is_epic(child, sub));
    assert.is_true(!is_epic(lone, sub))
}

test "epic children are the inbound subtask sources" {
    let epic = Issue {
        id: "bi#26",
        title: "e",
        status: Status.Open,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let lone = Issue {
        id: "bi#99",
        title: "l",
        status: Status.Open,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#27", to: "bi#26", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#28", to: "bi#26", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#27", to: "bi#26", kind: EdgeKind.Related },
        Edge { from: "bi#26", to: "bi#27", kind: EdgeKind.SubtaskOf },
    ];
    assert.equal(epic_children(epic, edges), ["bi#27", "bi#28"]);
    // A non-epic coordinates nothing, even beside epic edges.
    assert.equal(epic_children(lone, edges), [])
}

// LLM entry: CreateIssue is a typed LLM function — the return type IS the schema.
// Prompt is `${ctx.output_format}` validated by `baml check`, not prose.
function CreateIssue(raw: string) -> Issue {
    client: "openai/gpt-4o-mini"
    prompt: `
        Create a BAIS issue from the raw text below.

        ${ctx.output_format}

        Raw:
        ${raw}
    `
}

function main() -> string {
    "bais"
}

test "ready filters blocked" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks }];
    let ready = ready_issues([a, b], edges);
    assert.equal(ready.length(), 1);
    assert.equal(ready[0].id, "bi#01")
}

test "ready empty when all blocked" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.Blocks },
    ];
    let ready = ready_issues([a, b], edges);
    assert.equal(ready.length(), 0)
}

test "dangling Blocks edge keeps issue out of ready" {
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    // bagl#01 is not in `issues` — a cross-project edge, or a typo. We cannot
    // prove it is closed, so bi#02 is not ready.
    let edges = [Edge { from: "bagl#01", to: "bi#02", kind: EdgeKind.Blocks }];
    assert.equal(is_blocked(b, edges, [b]), true);
    let ready = ready_issues([b], edges);
    assert.equal(ready.length(), 0)
}

test "resolved Done blocker still frees the issue" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Done,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks }];
    assert.equal(is_blocked(b, edges, [a, b]), false);
    let ready = ready_issues([a, b], edges);
    assert.equal(ready.length(), 1);
    assert.equal(ready[0].id, "bi#02")
}

test "Dropped blocker frees the issue" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Dropped,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks }];
    assert.equal(is_blocked(b, edges, [a, b]), false)
}

test "non-Blocks dangling edge does not block" {
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    // Only Blocks carries readiness semantics — a dangling Related/DependsOn
    // edge must not park the issue.
    let edges = [
        Edge { from: "bagl#01", to: "bi#02", kind: EdgeKind.Related },
        Edge { from: "bagl#02", to: "bi#02", kind: EdgeKind.DependsOn },
    ];
    assert.equal(is_blocked(b, edges, [b]), false);
    let ready = ready_issues([b], edges);
    assert.equal(ready.length(), 1)
}

// ── Graph-level validation ────────────────────────────────────────────────
// Per-file parsing (ns_toml) proves each issue is well-formed on its own. It
// cannot see a Blocks edge pointing at an id that does not exist — that is only
// visible once the whole directory is loaded. `bais check` uses this.
//
// This matters because is_blocked treats an unresolvable blocker as blocking:
// safe, but it means a typo'd edge parks an issue indefinitely and silently.
// These functions are what make the typo loud instead.

enum RefStatus {
    // Names an issue in the loaded set.
    Resolved,
    // Prefix belongs to this project, but no such issue was loaded — a typo, a
    // deleted file, or an id that was never created. A defect.
    Missing,
    // Prefix belongs to another project (bi -> bagl#02). Not resolvable from
    // this directory and not a defect; reported so a typo'd prefix is still
    // visible rather than silently excused as "external".
    External,
}

class EdgeRef {
    from: string,
    to: string,
    kind: string @description("EdgeKind rendered via to_string — plain data for hosts"),
    id: string @description("the referenced id being classified — equals from or to"),
    side: string @description("\"from\" or \"to\": which end of the edge `id` came from"),
    status: RefStatus,
}

// Directory scope of an id: "bi#04" -> "bi". An id with no "#" has no scope and
// is treated as local, so a malformed reference reports as Missing rather than
// being waved through as another project's problem.
function id_project(id: string) -> string {
    let idx = id.index_of("#");
    if (idx == null) {
        ""
    } else {
        id.slice(0, idx)
    }
}

function has_issue(id: string, issues: Issue[]) -> bool {
    for (let i in issues) {
        if (i.id == id) {
            return true;
        }
    }
    false
}

function classify_ref(id: string, issues: Issue[], project: string) -> RefStatus {
    if (has_issue(id, issues)) {
        RefStatus.Resolved
    } else {
        let scope = id_project(id);
        if (scope != "" && scope != project) {
            RefStatus.External
        } else {
            RefStatus.Missing
        }
    }
}

// Every edge end that does not resolve to a loaded issue. Resolved ends are not
// returned — the caller wants the problems, not the inventory.
function dangling_edge_refs(issues: Issue[], edges: Edge[], project: string) -> EdgeRef[] {
    let out: EdgeRef[] = [];
    for (let e in edges) {
        let from_status = classify_ref(e.from, issues, project);
        if (from_status != RefStatus.Resolved) {
            out.push(
                EdgeRef {
                    from: e.from,
                    to: e.to,
                    kind: e.kind.to_string(),
                    id: e.from,
                    side: "from",
                    status: from_status,
                },
            );
        }
        let to_status = classify_ref(e.to, issues, project);
        if (to_status != RefStatus.Resolved) {
            out.push(
                EdgeRef {
                    from: e.from,
                    to: e.to,
                    kind: e.kind.to_string(),
                    id: e.to,
                    side: "to",
                    status: to_status,
                },
            );
        }
    }
    out
}

test "dangling_edge_refs flags a local id that does not exist" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bi#99", to: "bi#01", kind: EdgeKind.Blocks }];
    let refs = dangling_edge_refs([a], edges, "bi");
    assert.equal(refs.length(), 1);
    assert.equal(refs[0].id, "bi#99");
    assert.equal(refs[0].side, "from");
    assert.equal(refs[0].status, RefStatus.Missing);
    assert.equal(refs[0].kind, "Blocks")
}

test "dangling_edge_refs marks another project as External" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bagl#02", to: "bi#01", kind: EdgeKind.DependsOn }];
    let refs = dangling_edge_refs([a], edges, "bi");
    assert.equal(refs.length(), 1);
    assert.equal(refs[0].id, "bagl#02");
    assert.equal(refs[0].status, RefStatus.External)
}

test "dangling_edge_refs is empty when both ends resolve" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Done,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks }];
    assert.equal(dangling_edge_refs([a, b], edges, "bi").length(), 0)
}

test "dangling_edge_refs reports both ends of a fully dangling edge" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "bi#98", to: "bi#99", kind: EdgeKind.Blocks }];
    let refs = dangling_edge_refs([a], edges, "bi");
    assert.equal(refs.length(), 2);
    assert.equal(refs[0].side, "from");
    assert.equal(refs[1].side, "to")
}

test "an id with no scope is Missing, not excused as External" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [Edge { from: "typo-no-hash", to: "bi#01", kind: EdgeKind.Blocks }];
    let refs = dangling_edge_refs([a], edges, "bi");
    assert.equal(refs.length(), 1);
    assert.equal(refs[0].status, RefStatus.Missing)
}

test "id_project splits the directory scope" {
    assert.equal(id_project("bi#04"), "bi");
    assert.equal(id_project("bagl#02"), "bagl");
    assert.equal(id_project("nohash"), "")
}

// ── Dependency cycles ─────────────────────────────────────────────────────
// ready_issues answers "what can be worked now" and a cycle simply produces an
// empty answer — A blocks B, B blocks A, neither is ever ready, and nothing
// says why. That is the auto-suppression this detects: the graph is broken, but
// the readiness query reports it as "no work available", which is exactly what
// a healthy finished backlog looks like too.

// Both directional kinds normalise to one "must precede" relation:
//   Blocks{from,to}     -> from must close before to
//   DependsOn{from,to}  -> to must close before from  (JIRA sense: A depends on B)
// SubtaskOf/DuplicateOf/Related/Fixes/Replaces carry no ordering and are ignored.
function precedes(e: Edge, before: string, after: string) -> bool {
    if (e.kind == EdgeKind.Blocks) {
        e.from == before && e.to == after
    } else if (e.kind == EdgeKind.DependsOn) {
        e.to == before && e.from == after
    } else {
        false
    }
}

function contains_id(ids: string[], id: string) -> bool {
    for (let x in ids) {
        if (x == id) {
            return true;
        }
    }
    false
}

// Does anything still in `remaining` have to close before `id`?
function has_pending_predecessor(id: string, edges: Edge[], remaining: string[]) -> bool {
    for (let e in edges) {
        for (let other in remaining) {
            if (precedes(e, other, id)) {
                return true;
            }
        }
    }
    false
}

// Kahn's algorithm, keeping the leftovers instead of the topological order.
// Repeatedly drop every issue with no pending predecessor; whatever cannot be
// dropped is in a cycle or downstream of one. Edges naming an id that was never
// loaded do not count as predecessors — those are dangling_edge_refs' job, and
// double-reporting them here would blame a cycle for a typo.
function cyclic_ids(issues: Issue[], edges: Edge[]) -> string[] {
    let remaining: string[] = [];
    for (let i in issues) {
        remaining.push(i.id);
    }
    let changed = true;
    while (changed) {
        changed = false;
        let next: string[] = [];
        for (let id in remaining) {
            if (has_pending_predecessor(id, edges, remaining)) {
                next.push(id);
            } else {
                changed = true;
            }
        }
        remaining = next;
    }
    remaining
}

function has_cycle(issues: Issue[], edges: Edge[]) -> bool {
    cyclic_ids(issues, edges).length() > 0
}

test "DependsOn cycle is flagged, not silently unready" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    // A depends on B, B depends on A.
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.DependsOn },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.DependsOn },
    ];
    let cyclic = cyclic_ids([a, b], edges);
    assert.equal(cyclic.length(), 2);
    assert.equal(has_cycle([a, b], edges), true)
}

test "Blocks cycle is flagged where ready_issues only goes quiet" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.Blocks },
    ];
    // ready_issues says "nothing to do" — indistinguishable from a finished
    // backlog. cyclic_ids says why.
    assert.equal(ready_issues([a, b], edges).length(), 0);
    assert.equal(cyclic_ids([a, b], edges).length(), 2)
}

test "acyclic chain has no cycle" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Done,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let c = Issue {
        id: "bi#03",
        title: "c",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#03", kind: EdgeKind.DependsOn },
    ];
    assert.equal(has_cycle([a, b, c], edges), false)
}

test "three-node cycle is flagged" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let c = Issue {
        id: "bi#03",
        title: "c",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#03", kind: EdgeKind.Blocks },
        Edge { from: "bi#03", to: "bi#01", kind: EdgeKind.Blocks },
    ];
    assert.equal(cyclic_ids([a, b, c], edges).length(), 3)
}

test "a node downstream of a cycle is reported with it" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let d = Issue {
        id: "bi#04",
        title: "downstream of the cycle, not in it",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#04", kind: EdgeKind.Blocks },
    ];
    // Kahn keeps leftovers, so bi#04 rides along. It is genuinely unworkable
    // for the same reason, and separating "in the cycle" from "stuck behind
    // one" needs SCC extraction — not worth it until the report names one.
    assert.equal(cyclic_ids([a, b, d], edges).length(), 3)
}

test "a dangling predecessor is not reported as a cycle" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    // bi#99 was never loaded — dangling_edge_refs' problem, not a cycle.
    let edges = [Edge { from: "bi#99", to: "bi#01", kind: EdgeKind.Blocks }];
    assert.equal(cyclic_ids([a], edges).length(), 0);
    assert.equal(dangling_edge_refs([a], edges, "bi").length(), 1)
}

test "non-ordering edge kinds cannot form a cycle" {
    let a = Issue {
        id: "bi#01",
        title: "a",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let b = Issue {
        id: "bi#02",
        title: "b",
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    };
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Related },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.Related },
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.SubtaskOf },
    ];
    assert.equal(has_cycle([a, b], edges), false)
}

// ── Computed urgency (bi#51) ─────────────────────────────────────────────
// ready_issues answers "what can be worked now" as a SET — every ready issue
// looks equally important and dispatch degrades to arbitrary choice. urgency
// is a PURE function over declared + structural + live signals that returns
// the score WITH its components (never a bare number), e.g.
//   urgency 8 = severity 3 + blocks 4 + stalled 6d
// so `--order urgency` (host CLI, out of scope here) and the bi#48 why-not
// output can answer "why this first" with "why not that".
//
// Signals:
// - Declared: severity 1-5 finally means something. 1-4 count linearly
//   (capped at 4, below the structural max of 6, so graph leverage can
//   outweigh a mid-range declaration); 5 is the override hatch (15, above
//   the max non-override total of 12) that beats any structural score.
//   Derived only — human severity in the files is never rewritten.
// - Structural: Blocks fan-out (issues this one directly unblocks), plus a
//   capped bonus per one-completion-away chain (a downstream blocked SOLELY
//   by this issue — derivable from edges alone, no status reads).
// - Live: days parked with saturating decay (a week per point, capped at 2)
//   so old trivia never outranks fresh breakage.
// - Live/cost (bi#52): metered tokens per task as a capped, saturating
//   component (half the task cap = 1, at/over the cap = 2, max 2). The
//   host meters spend (CostIncurred events); BAML owns this policy. The
//   join reads the `spent` table (task -> admitted incurred tokens);
//   missing or negative entries count as 0: unknown spend never inflates.
//   Burn-to-look-important defense: the component saturates at 2, so the
//   max non-override total is 4 + 6 + 2 + 2 = 14, still below the
//   severity-5 hatch (15) — infinite burn cannot reach override
//   territory. The receipt names cost_part + incurred_tokens, so burn is
//   visible; oversight outlier review (budget_overruns/caps_over_budget
//   feeds) is the second eye. Human severity is never rewritten.
//
// Clocks (bi#42 split): the host owns clocks, BAML owns policy. Issue and
// CostEntry carry no timestamps, so staleness cannot be derived from declared
// data — the host stamps each issue's creation day (whole days, e.g. file
// mtime / git log day) into the live-signal table `costs` and passes
// wall-clock `now` in the same unit. A missing entry — or a creation day in
// the future — counts as fresh (parked 0): unknown age must never inflate
// urgency.
class Urgency {
    issue_id: string,
    score: int @description(
        "severity_part + blocks_part + stalled_part + cost_part — always read with the parts",
    ),
    severity_part: int,
    fan_out: int @description("Blocks edges out of this issue (raw count, pre-cap)"),
    sole_unblocks: int @description("downstream solely blocked by this issue (raw count, pre-cap)"),
    blocks_part: int,
    stalled_days: int @description("parked days actually counted (clamped at 0, uncapped)"),
    stalled_part: int,
    incurred_tokens: int @description("metered spend actually counted (clamped at 0, uncapped — the audit trail)"),
    cost_part: int @description("capped spend component 0-2: burn can nudge, never override"),
}

function urgency_severity(issue: Issue) -> int {
    if let s: int = issue.severity {
        if (s >= 5) {
            // Override hatch: 5 + 10, above STRUCT_MAX(6) + STALE_MAX(2) +
            // normal severity max(4) = 12, so severity 5 always wins.
            15
        } else if (s <= 0) {
            0
        } else {
            s
        }
    } else {
        0
    }
}

function blocks_fan_out(issue: Issue, edges: Edge[]) -> int {
    let n = 0;
    for (let e in edges) {
        if (e.from == issue.id && e.kind == EdgeKind.Blocks) {
            n = n + 1;
        }
    }
    n
}

// True when no OTHER issue blocks `target` — completing `issue` alone
// unblocks it. Edges only, matching the "derivable from edges today" rule.
function is_sole_blocker(issue: Issue, target: string, edges: Edge[]) -> bool {
    for (let e in edges) {
        if (e.kind == EdgeKind.Blocks && e.to == target && e.from != issue.id) {
            return false;
        }
    }
    true
}

function sole_unblocks(issue: Issue, edges: Edge[]) -> int {
    let n = 0;
    for (let e in edges) {
        if (e.from == issue.id && e.kind == EdgeKind.Blocks && is_sole_blocker(issue, e.to, edges)) {
            n = n + 1;
        }
    }
    n
}

function urgency_blocks(issue: Issue, edges: Edge[]) -> int {
    let fan = blocks_fan_out(issue, edges);
    let capped_fan = if (fan > 4) {
        4
    } else {
        fan
    };
    let sole = sole_unblocks(issue, edges);
    let capped_sole = if (sole > 2) {
        2
    } else {
        sole
    };
    capped_fan + capped_sole
}

function urgency_stalled_days(issue: Issue, costs: map<string, int>, now: int) -> int {
    let created = costs.get(issue.id) ?? now;
    let parked = now - created;
    if (parked < 0) {
        0
    } else {
        parked
    }
}

function urgency_stalled(stalled_days: int) -> int {
    // A week per point, saturating at 2 (int division truncates).
    let pts = stalled_days / 7;
    if (pts > 2) {
        2
    } else {
        pts
    }
}

// Per-task spend cap for the urgency join (bi#52): POLICY, not a budget —
// the spend level at which the cost component saturates. Lives in a
// function (not a literal) so the host mirror names the same constant
// (URGENCY_COST_CAP_TOKENS in bais/src/graph.ts); the two must agree.
function urgency_cost_cap() -> int {
    1000
}

// Capped, saturating spend component: half the cap nudges (+1), at/over
// the cap saturates (+2). Anything above the cap scores the same —
// infinite burn buys nothing past this point.
function urgency_cost(incurred_tokens: int) -> int {
    if (incurred_tokens <= 0) {
        0
    } else if (incurred_tokens >= urgency_cost_cap()) {
        2
    } else if (incurred_tokens >= urgency_cost_cap() / 2) {
        1
    } else {
        0
    }
}

function urgency(
    issue: Issue,
    edges: Edge[],
    costs: map<string, int>,
    now: int,
    spent: map<string, int>,
) -> Urgency {
    let sev = urgency_severity(issue);
    let fan = blocks_fan_out(issue, edges);
    let sole = sole_unblocks(issue, edges);
    let blocks = urgency_blocks(issue, edges);
    let days = urgency_stalled_days(issue, costs, now);
    let stalled = urgency_stalled(days);
    let raw_spent = spent.get(issue.id) ?? 0;
    let incurred = if (raw_spent < 0) {
        0
    } else {
        raw_spent
    };
    let cost = urgency_cost(incurred);
    Urgency {
        issue_id: issue.id,
        score: sev + blocks + stalled + cost,
        severity_part: sev,
        fan_out: fan,
        sole_unblocks: sole,
        blocks_part: blocks,
        stalled_days: days,
        stalled_part: stalled,
        incurred_tokens: incurred,
        cost_part: cost,
    }
}

function urgency_issue(id: string, severity: int?) -> Issue {
    Issue {
        id: id,
        title: id,
        status: Status.Open,
        kind: Kind.Bug,
        area: null,
        severity: severity,
        source: null,
        body: "",
    }
}

test "urgency orders fan-out hub above leaf" {
    let hub = urgency_issue("bi#10", 2);
    let leaves = [
        urgency_issue("bi#11", 2),
        urgency_issue("bi#12", 2),
        urgency_issue("bi#13", 2),
        urgency_issue("bi#14", 2),
    ];
    let edges = [
        Edge { from: "bi#10", to: "bi#11", kind: EdgeKind.Blocks },
        Edge { from: "bi#10", to: "bi#12", kind: EdgeKind.Blocks },
        Edge { from: "bi#10", to: "bi#13", kind: EdgeKind.Blocks },
        Edge { from: "bi#10", to: "bi#14", kind: EdgeKind.Blocks },
    ];
    // No creation days stamped: unknown age counts as fresh (stalled 0).
    let costs: map<string, int> = {};
    let spent: map<string, int> = {};
    let hub_u = urgency(hub, edges, costs, 100, spent);
    assert.equal(hub_u.fan_out, 4);
    assert.equal(hub_u.sole_unblocks, 4);
    assert.equal(hub_u.blocks_part, 6);
    assert.equal(hub_u.score, 8);
    let leaf_u = urgency(leaves[0], edges, costs, 100, spent);
    assert.equal(leaf_u.blocks_part, 0);
    assert.equal(leaf_u.score, 2);
    assert.equal(hub_u.score > leaf_u.score, true)
}

test "severity-5 overrides a high structural score" {
    let hatch = urgency_issue("bi#20", 5);
    let hub = urgency_issue("bi#21", 3);
    let edges = [
        Edge { from: "bi#21", to: "bi#22", kind: EdgeKind.Blocks },
        Edge { from: "bi#21", to: "bi#23", kind: EdgeKind.Blocks },
        Edge { from: "bi#21", to: "bi#24", kind: EdgeKind.Blocks },
        Edge { from: "bi#21", to: "bi#25", kind: EdgeKind.Blocks },
    ];
    // Hub is maximally structural AND 60 days stale: 3 + 6 + 2 = 11.
    let costs: map<string, int> = {};
    let _ = costs.set("bi#21", 40);
    let spent: map<string, int> = {};
    let hub_u = urgency(hub, edges, costs, 100, spent);
    assert.equal(hub_u.score, 11);
    // Fresh severity-5 leaf: the override hatch alone scores 15.
    let hatch_u = urgency(hatch, edges, costs, 100, spent);
    assert.equal(hatch_u.severity_part, 15);
    assert.equal(hatch_u.score, 15);
    assert.equal(hatch_u.score > hub_u.score, true)
}

test "60-day trivia loses to fresh severity-4" {
    let trivia = urgency_issue("bi#30", 1);
    let fresh = urgency_issue("bi#31", 4);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let _ = costs.set("bi#30", 40);
    let spent: map<string, int> = {};
    let old_u = urgency(trivia, edges, costs, 100, spent);
    assert.equal(old_u.stalled_days, 60);
    assert.equal(old_u.stalled_part, 2);
    assert.equal(old_u.score, 3);
    let fresh_u = urgency(fresh, edges, costs, 100, spent);
    assert.equal(fresh_u.stalled_part, 0);
    assert.equal(fresh_u.score, 4);
    assert.equal(old_u.score < fresh_u.score, true)
}

test "staleness saturates: older alone never keeps winning" {
    let a = urgency_issue("bi#40", 2);
    let b = urgency_issue("bi#41", 2);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let _ = costs.set("bi#40", 70);
    let _ = costs.set("bi#41", 10);
    let spent: map<string, int> = {};
    let au = urgency(a, edges, costs, 100, spent);
    let bu = urgency(b, edges, costs, 100, spent);
    assert.equal(au.stalled_days, 30);
    assert.equal(bu.stalled_days, 90);
    assert.equal(au.stalled_part, 2);
    assert.equal(bu.stalled_part, 2);
    assert.equal(au.score, bu.score)
}

test "urgency receipt adds up and names every component" {
    let issue = urgency_issue("bi#50", 3);
    let edges = [Edge { from: "bi#50", to: "bi#51", kind: EdgeKind.Blocks }];
    let costs: map<string, int> = {};
    let _ = costs.set("bi#50", 94);
    let spent: map<string, int> = {};
    let u = urgency(issue, edges, costs, 100, spent);
    // urgency 5 = severity 3 + blocks 2 + stalled 6d (0 pts).
    assert.equal(u.issue_id, "bi#50");
    assert.equal(u.severity_part, 3);
    assert.equal(u.fan_out, 1);
    assert.equal(u.sole_unblocks, 1);
    assert.equal(u.blocks_part, 2);
    assert.equal(u.stalled_days, 6);
    assert.equal(u.stalled_part, 0);
    assert.equal(u.incurred_tokens, 0);
    assert.equal(u.cost_part, 0);
    assert.equal(u.score, u.severity_part + u.blocks_part + u.stalled_part + u.cost_part);
    assert.equal(u.score, 5)
}

test "missing or future creation day counts as fresh" {
    let missing = urgency_issue("bi#60", 2);
    let future = urgency_issue("bi#61", 2);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let _ = costs.set("bi#61", 105);
    let spent: map<string, int> = {};
    let mu = urgency(missing, edges, costs, 100, spent);
    assert.equal(mu.stalled_days, 0);
    assert.equal(mu.stalled_part, 0);
    let fu = urgency(future, edges, costs, 100, spent);
    assert.equal(fu.stalled_days, 0);
    assert.equal(fu.stalled_part, 0)
}

test "null severity contributes nothing" {
    let issue = urgency_issue("bi#80", null);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let spent: map<string, int> = {};
    let u = urgency(issue, edges, costs, 100, spent);
    assert.equal(u.severity_part, 0);
    assert.equal(u.score, 0)
}

test "shared blockers split the one-away bonus but keep fan-out" {
    let hub = urgency_issue("bi#70", 2);
    let edges = [
        Edge { from: "bi#70", to: "bi#71", kind: EdgeKind.Blocks },
        Edge { from: "bi#70", to: "bi#72", kind: EdgeKind.Blocks },
        Edge { from: "bi#99", to: "bi#72", kind: EdgeKind.Blocks },
    ];
    let costs: map<string, int> = {};
    let spent: map<string, int> = {};
    let u = urgency(hub, edges, costs, 100, spent);
    assert.equal(u.fan_out, 2);
    // bi#72 has a second blocker, so only bi#71 is one-completion-away.
    assert.equal(u.sole_unblocks, 1);
    assert.equal(u.blocks_part, 3)
}

test "cost component rises with spend and saturates below override territory" {
    let issue = urgency_issue("bi#90", 2);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    // No metered spend: no component, unknown spend never inflates.
    let none: map<string, int> = {};
    let u0 = urgency(issue, edges, costs, 100, none);
    assert.equal(u0.incurred_tokens, 0);
    assert.equal(u0.cost_part, 0);
    assert.equal(u0.score, 2);
    // Below half the cap: still nothing.
    let low: map<string, int> = {};
    let _ = low.set("bi#90", 499);
    let u1 = urgency(issue, edges, costs, 100, low);
    assert.equal(u1.cost_part, 0);
    // Half the cap nudges; at the cap it saturates.
    let half: map<string, int> = {};
    let _ = half.set("bi#90", 500);
    let u2 = urgency(issue, edges, costs, 100, half);
    assert.equal(u2.cost_part, 1);
    assert.equal(u2.score, 3);
    let cap: map<string, int> = {};
    let _ = cap.set("bi#90", 1000);
    let u3 = urgency(issue, edges, costs, 100, cap);
    assert.equal(u3.incurred_tokens, 1000);
    assert.equal(u3.cost_part, 2);
    // Infinite burn buys nothing past the cap: 1M tokens scores the same.
    let whale: map<string, int> = {};
    let _ = whale.set("bi#90", 1000000);
    let u4 = urgency(issue, edges, costs, 100, whale);
    assert.equal(u4.incurred_tokens, 1000000);
    assert.equal(u4.cost_part, 2);
    assert.equal(u4.score, 4);
    // Receipt still adds up with the cost component named.
    assert.equal(u4.score, u4.severity_part + u4.blocks_part + u4.stalled_part + u4.cost_part);
    // Negative spend clamps to 0 — it can never deflate or inflate.
    let neg: map<string, int> = {};
    let _ = neg.set("bi#90", 0 - 50);
    let u5 = urgency(issue, edges, costs, 100, neg);
    assert.equal(u5.incurred_tokens, 0);
    assert.equal(u5.cost_part, 0)
}

test "severity stays 2 while cost crosses its cap: urgency rises, hatch untouched" {
    // Acceptance fixture (bi#52): one task's incurred cost crosses its cap
    // while its human severity stays 2. Computed urgency must rise WITH
    // the cost component named, capped below severity-5-override
    // territory, and the human severity must be untouched.
    let cheap = urgency_issue("bi#91", 2);
    let pricey = urgency_issue("bi#92", 2);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let spent: map<string, int> = {};
    let _ = spent.set("bi#92", 1200);
    let cheap_u = urgency(cheap, edges, costs, 100, spent);
    let pricey_u = urgency(pricey, edges, costs, 100, spent);
    assert.equal(cheap_u.cost_part, 0);
    assert.equal(cheap_u.score, 2);
    assert.equal(pricey_u.incurred_tokens, 1200);
    assert.equal(pricey_u.cost_part, 2);
    assert.equal(pricey_u.score, 4);
    assert.equal(pricey_u.score > cheap_u.score, true);
    // Human severity is never rewritten: both inputs still declare 2, and
    // the declared part still counts exactly 2.
    assert.equal(cheap.severity, 2);
    assert.equal(pricey.severity, 2);
    assert.equal(pricey_u.severity_part, 2);
    // Even maximally structural + stale + burnt, a non-override issue
    // (4 + 6 + 2 + 2 = 14) stays below the severity-5 hatch (15).
    let hub = urgency_issue("bi#93", 4);
    let hub_edges = [
        Edge { from: "bi#93", to: "bi#94", kind: EdgeKind.Blocks },
        Edge { from: "bi#93", to: "bi#95", kind: EdgeKind.Blocks },
        Edge { from: "bi#93", to: "bi#96", kind: EdgeKind.Blocks },
        Edge { from: "bi#93", to: "bi#97", kind: EdgeKind.Blocks },
    ];
    let stale: map<string, int> = {};
    let _ = stale.set("bi#93", 40);
    let burnt: map<string, int> = {};
    let _ = burnt.set("bi#93", 1000000);
    let hub_u = urgency(hub, hub_edges, stale, 100, burnt);
    assert.equal(hub_u.score, 14);
    let hatch = urgency_issue("bi#98", 5);
    let hatch_u = urgency(hatch, [], stale, 100, burnt);
    assert.equal(hatch_u.score, 15);
    assert.equal(hatch_u.score > hub_u.score, true)
}

// ── ready --why-not ─────────────────────────────────────────────────────────
// `ready` omits blocked issues silently — "nothing ready" is indistinguishable
// from "everything parked behind one stuck node". why_not shapes the existing
// classifiers (is_blocked, dangling_edge_refs/classify_ref, cyclic_ids, and
// the lease state current_lease derives) into one reason per omission, so
// every Open-but-unready issue carries the exact edge/lease/cycle.
//
// Scope: only Open issues are reasoned about, and only when they are omitted
// from ready — every omission carries its reason, and every reason marks an
// omission. Done/Dropped are finished, not jammed (an all-Done backlog reports
// empty with no reasons); Doing/Blocked are worker states whose status is
// self-describing in `list`. An Open issue that is still listed as ready
// carries no reason even when it sits in a dependency cycle (a DependsOn-only
// cycle never blocks, so both members stay ready): `check` remains the cycle
// diagnosis there, and why-not stays purely omission-explaining.
//
// Leases arrive as plain IssueLease data, not via ns_event: namespaces do not
// import each other, and the host's leases table already materializes what
// current_lease derives. The scan path (no store, no leases) passes [].
//
// Epics are out of scope here by design (hub#223): an Open epic leaves the
// ready set via ready_issues but carries no WhyNot — there is no edge, lease,
// or cycle to name, and WhyNotKind grows only where the CLI can render it.
// The epic omission is diagnosed via is_epic / dispatch_epic_withheld, the
// same split as a DependsOn-only cycle (both stay ready there, so `check`
// stays the diagnosis).
enum WhyNotKind {
    BlockedBy,
    DanglingRef,
    InCycle,
    Leased,
}

class IssueLease {
    entity: string @description("issue id under lease, e.g. bi#09"),
    holder: string @description("did:key:... holding the lease"),
    expires_lc: int? @description("lease expiry in lc ticks, null when unknown"),
}

// One omission, one reason. Exactly the fields for `kind` are set; the rest
// are null. Field names are the host JSON contract (`--json` reasons
// round-trip through the generated SDK types unchanged).
class WhyNot {
    id: string @description("the Open-but-unready issue"),
    kind: WhyNotKind,
    blocker: string? @description("BlockedBy: the blocking issue id"),
    blocker_status: string? @description("BlockedBy: blocker status via to_string"),
    edge_from: string? @description("BlockedBy/DanglingRef: the exact edge"),
    edge_to: string? @description("BlockedBy/DanglingRef: the exact edge"),
    edge_kind: string? @description("BlockedBy/DanglingRef: the exact edge"),
    ref_id: string? @description("DanglingRef: the unresolvable id"),
    ref_side: string? @description("\"from\" or \"to\": which end `ref_id` came from"),
    ref_status: string? @description("DanglingRef: Missing or External via to_string"),
    cycle: string[]? @description("InCycle: the leftover members naming the cycle"),
    holder: string? @description("Leased: lease holder"),
    expires_lc: int? @description("Leased: lease expiry in lc ticks"),
}

// Test helper: the verbose literal is the spec, this is just brevity.
function mk_issue(id: string, status: Status) -> Issue {
    Issue {
        id: id,
        title: id,
        status: status,
        kind: Kind.Bug,
        area: null,
        severity: null,
        source: null,
        body: "",
    }
}

function lease_for(entity: string, leases: IssueLease[]) -> IssueLease? {
    for (let l in leases) {
        if (l.entity == entity) {
            return l;
        }
    }
    null
}

function why_not(
    issues: Issue[],
    edges: Edge[],
    project: string,
    leases: IssueLease[],
) -> WhyNot[] {
    let out: WhyNot[] = [];
    let cyclic = cyclic_ids(issues, edges);
    for (let issue in issues) {
        // Omission gate: ready on every path is Open + unblocked (+ unleased
        // where the store knows leases — the scan path passes []). An issue
        // that survives it is listed as ready and carries no reason.
        if (
            issue.status == Status.Open
                && (is_blocked(issue, edges, issues) || lease_for(issue.id, leases) != null)
        ) {
            // Each still-blocking Blocks edge contributes its own reason: a
            // resolved-but-unclosed blocker names the blocker + its status, an
            // unresolvable blocker names the dangling end + Missing/External.
            for (let e in edges) {
                if (e.to == issue.id && e.kind == EdgeKind.Blocks) {
                    let resolved = false;
                    for (let b in issues) {
                        if (b.id == e.from) {
                            resolved = true;
                            if (b.status != Status.Done && b.status != Status.Dropped) {
                                out.push(
                                    WhyNot {
                                        id: issue.id,
                                        kind: WhyNotKind.BlockedBy,
                                        blocker: b.id,
                                        blocker_status: b.status.to_string(),
                                        edge_from: e.from,
                                        edge_to: e.to,
                                        edge_kind: e.kind.to_string(),
                                        ref_id: null,
                                        ref_side: null,
                                        ref_status: null,
                                        cycle: null,
                                        holder: null,
                                        expires_lc: null,
                                    },
                                );
                            }
                        }
                    }
                    if (!resolved) {
                        out.push(
                            WhyNot {
                                id: issue.id,
                                kind: WhyNotKind.DanglingRef,
                                blocker: null,
                                blocker_status: null,
                                edge_from: e.from,
                                edge_to: e.to,
                                edge_kind: e.kind.to_string(),
                                ref_id: e.from,
                                ref_side: "from",
                                ref_status: classify_ref(e.from, issues, project).to_string(),
                                cycle: null,
                                holder: null,
                                expires_lc: null,
                            },
                        );
                    }
                }
            }
            if (contains_id(cyclic, issue.id)) {
                out.push(
                    WhyNot {
                        id: issue.id,
                        kind: WhyNotKind.InCycle,
                        blocker: null,
                        blocker_status: null,
                        edge_from: null,
                        edge_to: null,
                        edge_kind: null,
                        ref_id: null,
                        ref_side: null,
                        ref_status: null,
                        cycle: cyclic,
                        holder: null,
                        expires_lc: null,
                    },
                );
            }
            if let l: IssueLease = lease_for(issue.id, leases) {
                out.push(
                    WhyNot {
                        id: issue.id,
                        kind: WhyNotKind.Leased,
                        blocker: null,
                        blocker_status: null,
                        edge_from: null,
                        edge_to: null,
                        edge_kind: null,
                        ref_id: null,
                        ref_side: null,
                        ref_status: null,
                        cycle: null,
                        holder: l.holder,
                        expires_lc: l.expires_lc,
                    },
                );
            }
        }
    }
    out
}

test "why-not blocked-by names the blocker, its status, and the edge" {
    let issues = [mk_issue("bi#01", Status.Open), mk_issue("bi#02", Status.Open)];
    let edges = [Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks }];
    let reasons = why_not(issues, edges, "bi", []);
    assert.equal(reasons.length(), 1);
    assert.equal(reasons[0].id, "bi#02");
    assert.equal(reasons[0].kind, WhyNotKind.BlockedBy);
    assert.equal(reasons[0].blocker, "bi#01");
    assert.equal(reasons[0].blocker_status, "Open");
    assert.equal(reasons[0].edge_from, "bi#01");
    assert.equal(reasons[0].edge_to, "bi#02");
    assert.equal(reasons[0].edge_kind, "Blocks");
    // The blocker itself is ready, so it carries no reason.
    assert.equal(
        contains_id(
            reasons.map((r) -> {
                r.id
            }),
            "bi#01",
        ),
        false,
    )
}

test "why-not is empty for ready issues and resolved blockers free silently" {
    let issues = [mk_issue("bi#01", Status.Done), mk_issue("bi#02", Status.Open)];
    let edges = [Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks }];
    assert.equal(why_not(issues, edges, "bi", []).length(), 0);
    assert.equal(why_not([mk_issue("bi#03", Status.Open)], [], "bi", []).length(), 0)
}

test "why-not dangling blocker names the end and Missing vs External" {
    let issues = [mk_issue("bi#02", Status.Open)];
    let missing_edges = [Edge { from: "bi#99", to: "bi#02", kind: EdgeKind.Blocks }];
    let missing = why_not(issues, missing_edges, "bi", []);
    assert.equal(missing.length(), 1);
    assert.equal(missing[0].kind, WhyNotKind.DanglingRef);
    assert.equal(missing[0].ref_id, "bi#99");
    assert.equal(missing[0].ref_side, "from");
    assert.equal(missing[0].ref_status, "Missing");
    assert.equal(missing[0].edge_to, "bi#02");
    let ext_edges = [Edge { from: "bagl#02", to: "bi#02", kind: EdgeKind.Blocks }];
    let ext = why_not(issues, ext_edges, "bi", []);
    assert.equal(ext.length(), 1);
    assert.equal(ext[0].ref_id, "bagl#02");
    assert.equal(ext[0].ref_status, "External")
}

test "why-not in-cycle names the cycle alongside blocked-by" {
    let issues = [mk_issue("bi#01", Status.Open), mk_issue("bi#02", Status.Open)];
    // A Blocks cycle parks both members, so each carries the blocker and the
    // cycle it is stuck in.
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.Blocks },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.Blocks },
    ];
    let reasons = why_not(issues, edges, "bi", []);
    assert.equal(reasons.length(), 4);
    assert.equal(reasons[0].kind, WhyNotKind.BlockedBy);
    assert.equal(reasons[0].blocker, "bi#02");
    assert.equal(reasons[1].kind, WhyNotKind.InCycle);
    assert.equal(reasons[1].cycle, ["bi#01", "bi#02"]);
    assert.equal(reasons[2].id, "bi#02");
    assert.equal(reasons[2].kind, WhyNotKind.BlockedBy);
    assert.equal(reasons[3].kind, WhyNotKind.InCycle);
    assert.equal(reasons[3].cycle, ["bi#01", "bi#02"])
}

test "why-not is silent for a DependsOn-only cycle: both stay ready" {
    let issues = [mk_issue("bi#01", Status.Open), mk_issue("bi#02", Status.Open)];
    // DependsOn carries ordering but never blocks, so the pair is still listed
    // as ready — no omission, no reason. `check` stays the cycle diagnosis.
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.DependsOn },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.DependsOn },
    ];
    assert.equal(ready_issues(issues, edges).length(), 2);
    assert.equal(why_not(issues, edges, "bi", []).length(), 0)
}

test "why-not leased names the holder and expiry" {
    let issues = [mk_issue("bi#09", Status.Open)];
    let leases = [IssueLease { entity: "bi#09", holder: "did:key:z6Mk-alice", expires_lc: 42 }];
    let reasons = why_not(issues, [], "bi", leases);
    assert.equal(reasons.length(), 1);
    assert.equal(reasons[0].kind, WhyNotKind.Leased);
    assert.equal(reasons[0].holder, "did:key:z6Mk-alice");
    assert.equal(reasons[0].expires_lc, 42);
    // A lease on another issue is not this issue's reason.
    assert.equal(why_not(issues, [], "bi", []).length(), 0)
}

test "why-not all-Done backlog is empty with no reasons" {
    let issues = [mk_issue("bi#01", Status.Done), mk_issue("bi#02", Status.Dropped)];
    assert.equal(why_not(issues, [], "bi", []).length(), 0)
}

test "why-not skips non-Open issues: status is self-describing" {
    // Doing/Blocked are worker states visible in `list`, not omissions that
    // need an edge/lease/cycle to justify them.
    let issues = [mk_issue("bi#01", Status.Doing), mk_issue("bi#02", Status.Blocked)];
    assert.equal(why_not(issues, [], "bi", []).length(), 0)
}

// ── Blast radius (bi#122) ───────────────────────────────────────────────────
// ready_issues answers "what can be worked now" as a SET, and urgency (bi#51)
// scores one issue at a time with only DIRECT Blocks fan-out. Neither shows
// that closing one node unblocks a whole transitive fan-out through DependsOn
// chains (bi#32 holds 13 Open issues behind it, almost all via bi#69).
// blast_radii closes that gap: per issue, the TRANSITIVE dependents through
// the two ordering kinds (DependsOn/Blocks, same `precedes` relation the
// cycle detector uses), split into open_downstream (work actually held —
// the load-bearing number dispatchers sort on) and total_downstream (every
// declared dependent, including Done ones already freed).
//
// Deliberately status-blind about the hub itself: a Done anchor with a live
// Open fan-out still reports it (the edge may be stale — that is
// dangling_edge_refs' or a follow-up's problem, not a reason to hide the
// shape). A dependent naming an id that was never loaded counts in total
// but never in open: we can see the declaration, we cannot prove it is work.
// No declared override field: derivation from edges is the mechanism, and a
// human label the issue body can already carry stays out of the pure function.
class BlastRadius {
    id: string,
    open_downstream: int @description("transitive Open dependents — the load-bearing number"),
    total_downstream: int @description("every transitive dependent, including Done/Dropped/unseen"),
}

function direct_dependents(id: string, edges: Edge[]) -> string[] {
    let out: string[] = [];
    for (let e in edges) {
        if ((e.kind == EdgeKind.DependsOn || e.kind == EdgeKind.Blocks) && e.to == id) {
            if (!contains_id(out, e.from)) {
                out.push(e.from);
            }
        }
    }
    out
}

function is_open_status(id: string, issues: Issue[]) -> bool {
    for (let i in issues) {
        if (i.id == id) {
            return i.status == Status.Open;
        }
    }
    false
}

function blast_radii(issues: Issue[], edges: Edge[]) -> BlastRadius[] {
    let out: BlastRadius[] = [];
    for (let hub in issues) {
        // Fixpoint over direct_dependents; the seen-guard makes cycles and
        // diamonds terminate, and the root is excluded so a cycle never
        // counts the hub as its own downstream.
        let seen: string[] = [];
        let frontier = direct_dependents(hub.id, edges);
        while (frontier.length() > 0) {
            let next: string[] = [];
            for (let id in frontier) {
                if (!contains_id(seen, id)) {
                    seen.push(id);
                    for (let d in direct_dependents(id, edges)) {
                        if (!contains_id(seen, d)) {
                            next.push(d);
                        }
                    }
                }
            }
            frontier = next;
        }
        let open = 0;
        let total = 0;
        for (let id in seen) {
            if (id != hub.id) {
                total = total + 1;
                if (is_open_status(id, issues)) {
                    open = open + 1;
                }
            }
        }
        out.push(BlastRadius { id: hub.id, open_downstream: open, total_downstream: total });
    }
    out
}

function blast_of(id: string, rows: BlastRadius[]) -> BlastRadius {
    for (let r in rows) {
        if (r.id == id) {
            return r;
        }
    }
    BlastRadius { id: id, open_downstream: 0, total_downstream: 0 }
}

test "blast radius counts transitive open dependents through mixed kinds" {
    let issues = [
        mk_issue("bi#10", Status.Open),
        mk_issue("bi#11", Status.Open),
        mk_issue("bi#12", Status.Open),
        mk_issue("bi#13", Status.Open),
        mk_issue("bi#14", Status.Done),
    ];
    let edges = [
        Edge { from: "bi#11", to: "bi#10", kind: EdgeKind.DependsOn },
        Edge { from: "bi#12", to: "bi#10", kind: EdgeKind.Blocks },
        Edge { from: "bi#13", to: "bi#11", kind: EdgeKind.DependsOn },
        Edge { from: "bi#14", to: "bi#10", kind: EdgeKind.DependsOn },
    ];
    let rows = blast_radii(issues, edges);
    // bi#10 holds three Open issues (11, 12, and 13 transitively) plus one
    // Done dependent counted in total only.
    let hub = blast_of("bi#10", rows);
    assert.equal(hub.open_downstream, 3);
    assert.equal(hub.total_downstream, 4);
    // Mid-chain bi#11 holds only bi#13.
    let mid = blast_of("bi#11", rows);
    assert.equal(mid.open_downstream, 1);
    assert.equal(mid.total_downstream, 1);
    // Leaves and Done dependents hold nothing.
    assert.equal(blast_of("bi#13", rows).open_downstream, 0);
    assert.equal(blast_of("bi#14", rows).total_downstream, 0)
}

test "blast radius ignores Related and terminates on cycles" {
    let issues = [mk_issue("bi#01", Status.Open), mk_issue("bi#02", Status.Open), mk_issue("bi#03", Status.Open)];
    let edges = [
        Edge { from: "bi#01", to: "bi#02", kind: EdgeKind.DependsOn },
        Edge { from: "bi#02", to: "bi#01", kind: EdgeKind.DependsOn },
        Edge { from: "bi#03", to: "bi#01", kind: EdgeKind.Related },
    ];
    let rows = blast_radii(issues, edges);
    // The pair holds each other and nothing else; neither counts itself.
    assert.equal(blast_of("bi#01", rows).open_downstream, 1);
    assert.equal(blast_of("bi#01", rows).total_downstream, 1);
    assert.equal(blast_of("bi#02", rows).open_downstream, 1);
    // Related-only bi#03 holds nothing and is held by nothing.
    assert.equal(blast_of("bi#03", rows).open_downstream, 0);
    assert.equal(blast_of("bi#03", rows).total_downstream, 0)
}

test "blast radius counts a dangling dependent in total, never in open" {
    let issues = [mk_issue("bi#02", Status.Open)];
    // bi#99 was never loaded: the declaration is visible, the work is not.
    let edges = [Edge { from: "bi#99", to: "bi#02", kind: EdgeKind.DependsOn }];
    let rows = blast_radii(issues, edges);
    assert.equal(blast_of("bi#02", rows).open_downstream, 0);
    assert.equal(blast_of("bi#02", rows).total_downstream, 1)
}

// ── Swarm dispatch pack (bi#123) ────────────────────────────────────────────
// Asking for "a batch of agents on the backlog" picks arbitrarily unless the
// pack is workload-aware: load-bearing issues first, live claims never
// double-assigned, file footprints never shared between slots. dispatch_pack
// is that pack as a PURE function — the CLI dry-runs it, the operator spawns
// agents from the printout, and each agent claims for itself (proxy claims
// would break the lease model, so dispatch never mutates).
//
// Inputs follow the clocks/policy split (bi#42): the host owns clocks and
// body parsing, BAML owns the packing rule. `leased` is the precomputed
// live-claim set (host compares holder/lease against the wall clock);
// `footprints` is the parsed `Files:` body convention (BAIS.md) as plain
// data. An issue with no FileClaim packs freely but the CLI flags it
// `files: unknown` — undeclared footprints are operator-confirmed, never
// silently safe. Greedy by open blast radius (ties: id ascending), skipping
// packed/leased/unready issues and file clashes with already-packed slots.
class FileClaim {
    issue_id: string,
    files: string[],
}

class AgentSlot {
    slot: int,
    issue_id: string,
}

function parse_file_claims(body: string) -> string[] {
    let out: string[] = [];
    for (let line in body.lines()) {
        let t = line.trim();
        if (t.starts_with("Files:")) {
            let rest = t.slice(6, t.length()).trim();
            let hash = rest.index_of("#");
            if (hash != null) {
                rest = rest.slice(0, hash).trim();
            }
            for (let part in rest.split(" ")) {
                let p = part.trim();
                if (p != "" && !contains_id(out, p)) {
                    out.push(p);
                }
            }
        }
    }
    out
}

function files_for(id: string, footprints: FileClaim[]) -> string[] {
    for (let fc in footprints) {
        if (fc.issue_id == id) {
            return fc.files;
        }
    }
    []
}

function files_clash(a: string[], b: string[]) -> bool {
    for (let x in a) {
        if (contains_id(b, x)) {
            return true;
        }
    }
    false
}

function dispatch_pack(
    issues: Issue[],
    edges: Edge[],
    leased: string[],
    footprints: FileClaim[],
    budget: int,
) -> AgentSlot[] {
    let slots: AgentSlot[] = [];
    if (budget <= 0) {
        return slots;
    }
    let radii = blast_radii(issues, edges);
    let ready = ready_issues(issues, edges);
    let packed: string[] = [];
    let packed_files: string[] = [];
    while (slots.length() < budget) {
        let best_id = "";
        let best_open = -1;
        for (let c in ready) {
            if (!contains_id(packed, c.id) && !contains_id(leased, c.id)) {
                let r = blast_of(c.id, radii);
                let clash = files_clash(files_for(c.id, footprints), packed_files);
                if (
                    !clash
                        && (
                            r.open_downstream > best_open
                                || (
                                    r.open_downstream == best_open
                                        && (best_id == "" || c.id < best_id)
                                )
                        )
                ) {
                    best_id = c.id;
                    best_open = r.open_downstream;
                }
            }
        }
        if (best_id == "") {
            break;
        }
        packed.push(best_id);
        for (let f in files_for(best_id, footprints)) {
            if (!contains_id(packed_files, f)) {
                packed_files.push(f);
            }
        }
        slots.push(AgentSlot { slot: slots.length(), issue_id: best_id });
    }
    slots
}

function slot_issue(slots: AgentSlot[], slot: int) -> string {
    for (let s in slots) {
        if (s.slot == slot) {
            return s.issue_id;
        }
    }
    ""
}

test "dispatch packs the hub before leaves and caps by budget" {
    let issues = [
        mk_issue("t#01", Status.Open),
        mk_issue("t#02", Status.Open),
        mk_issue("t#03", Status.Open),
        mk_issue("t#04", Status.Open),
    ];
    let edges = [
        Edge { from: "t#02", to: "t#01", kind: EdgeKind.DependsOn },
        Edge { from: "t#03", to: "t#01", kind: EdgeKind.DependsOn },
    ];
    let slots = dispatch_pack(issues, edges, [], [], 2);
    assert.equal(slots.length(), 2);
    assert.equal(slot_issue(slots, 0), "t#01");
    // Leaves tie at 0 — id ascending.
    assert.equal(slot_issue(slots, 1), "t#02")
}

test "dispatch skips leased and blocked issues" {
    let issues = [
        mk_issue("t#01", Status.Open),
        mk_issue("t#02", Status.Open),
        mk_issue("t#03", Status.Open),
        mk_issue("t#04", Status.Open),
    ];
    let edges = [
        Edge { from: "t#02", to: "t#01", kind: EdgeKind.DependsOn },
        Edge { from: "t#03", to: "t#04", kind: EdgeKind.Blocks },
    ];
    // t#01 holds the most work but is live-claimed; t#04 is parked behind an
    // open blocker. Neither is packed.
    let slots = dispatch_pack(issues, edges, ["t#01"], [], 4);
    assert.equal(slots.length(), 2);
    assert.equal(slot_issue(slots, 0), "t#02");
    assert.equal(slot_issue(slots, 1), "t#03")
}

test "dispatch packs around file conflicts" {
    let issues = [mk_issue("t#01", Status.Open), mk_issue("t#02", Status.Open), mk_issue("t#03", Status.Open)];
    let edges = [Edge { from: "t#02", to: "t#01", kind: EdgeKind.DependsOn }];
    let footprints = [
        FileClaim { issue_id: "t#01", files: ["a.ts"] },
        FileClaim { issue_id: "t#02", files: ["a.ts"] },
        FileClaim { issue_id: "t#03", files: [] },
    ];
    // t#01 first (radius 1); t#02 shares a.ts so the slot goes to t#03.
    let slots = dispatch_pack(issues, edges, [], footprints, 3);
    assert.equal(slots.length(), 2);
    assert.equal(slot_issue(slots, 0), "t#01");
    assert.equal(slot_issue(slots, 1), "t#03")
}

test "dispatch tie-breaks on id ascending" {
    let issues = [mk_issue("t#09", Status.Open), mk_issue("t#02", Status.Open)];
    let slots = dispatch_pack(issues, [], [], [], 1);
    assert.equal(slots.length(), 1);
    assert.equal(slot_issue(slots, 0), "t#02")
}

test "dispatch is empty on zero budget or fully leased backlog" {
    let issues = [mk_issue("t#01", Status.Open)];
    assert.equal(dispatch_pack(issues, [], [], [], 0).length(), 0);
    assert.equal(dispatch_pack(issues, [], ["t#01"], [], 4).length(), 0);
    assert.equal(dispatch_pack([], [], [], [], 4).length(), 0)
}

// ── Epic exclusion from work queues (hub#223) ─────────────────────────────
// An epic in a work queue is a mistargeted agent: the Doing-claim gate
// catches it late (at claim time) instead of never offering it. So epics
// leave the ready set and dispatch withholds them with a named reason,
// mirroring the hub#175 unknown-footprint lane. The reason is a constant —
// BAML `+` is numeric-only, so no composed message; the host names the
// coordinated children beside it (graph.ts epicWithheldIn).
class EpicHold {
    issue_id: string,
    reason: string @description("epic_hold_reason() — constant, never composed"),
}

function epic_hold_reason() -> string {
    "epic: coordinates subtasks from outside the pack; claim a child instead"
}

// Every Open + unblocked + unleased epic: the pack seats everything else,
// this names what the exclusion cost. Blocked/leased epics are out for
// those reasons (why-not BlockedBy / --json leased), never double-counted
// here.
function dispatch_epic_withheld(issues: Issue[], edges: Edge[], leased: string[]) -> EpicHold[] {
    let out: EpicHold[] = [];
    for (let issue in issues) {
        if (
            issue.status == Status.Open
                && !is_blocked(issue, edges, issues)
                && !contains_id(leased, issue.id)
                && is_epic(issue, edges)
        ) {
            out.push(EpicHold { issue_id: issue.id, reason: epic_hold_reason() });
        }
    }
    out
}

test "ready excludes epics but keeps their children" {
    let epic = mk_issue("bi#189", Status.Open);
    let c1 = mk_issue("bi#192", Status.Open);
    let c2 = mk_issue("bi#193", Status.Open);
    let edges = [
        Edge { from: "bi#192", to: "bi#189", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#193", to: "bi#189", kind: EdgeKind.SubtaskOf },
    ];
    let ready = ready_issues([epic, c1, c2], edges);
    assert.equal(ready.length(), 2);
    assert.equal(ready[0].id, "bi#192");
    assert.equal(ready[1].id, "bi#193")
}

test "dispatch seats leaves only and names the epic withheld with reason" {
    let epic = mk_issue("bi#189", Status.Open);
    let c1 = mk_issue("bi#192", Status.Open);
    let c2 = mk_issue("bi#193", Status.Open);
    let lone = mk_issue("bi#99", Status.Open);
    let edges = [
        Edge { from: "bi#192", to: "bi#189", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#193", to: "bi#189", kind: EdgeKind.SubtaskOf },
    ];
    let issues = [epic, c1, c2, lone];
    let slots = dispatch_pack(issues, edges, [], [], 4);
    assert.equal(slots.length(), 3);
    assert.equal(slot_issue(slots, 0), "bi#192");
    assert.equal(slot_issue(slots, 1), "bi#193");
    assert.equal(slot_issue(slots, 2), "bi#99");
    let held = dispatch_epic_withheld(issues, edges, []);
    assert.equal(held.length(), 1);
    assert.equal(held[0].issue_id, "bi#189");
    assert.equal(held[0].reason, epic_hold_reason())
}

test "epic withheld skips blocked, leased, and non-Open epics" {
    let open_epic = mk_issue("bi#189", Status.Open);
    let child = mk_issue("bi#192", Status.Open);
    let blocked_epic = mk_issue("bi#26", Status.Open);
    let blocker = mk_issue("bi#01", Status.Open);
    let leased_epic = mk_issue("bi#40", Status.Open);
    let done_epic = mk_issue("bi#41", Status.Done);
    let edges = [
        Edge { from: "bi#192", to: "bi#189", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#01", to: "bi#26", kind: EdgeKind.Blocks },
        Edge { from: "bi#27", to: "bi#26", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#42", to: "bi#40", kind: EdgeKind.SubtaskOf },
        Edge { from: "bi#43", to: "bi#41", kind: EdgeKind.SubtaskOf },
    ];
    let issues = [open_epic, child, blocked_epic, blocker, leased_epic, done_epic];
    // The blocked epic is out behind its blocker, the leased one behind its
    // claim, the Done one is finished — only the plain Open epic is withheld
    // for being an epic.
    let held = dispatch_epic_withheld(issues, edges, ["bi#40"]);
    assert.equal(held.length(), 1);
    assert.equal(held[0].issue_id, "bi#189");
    // And the pack still seats the non-epic work around all of them.
    let slots = dispatch_pack(issues, edges, ["bi#40"], [], 4);
    assert.equal(slots.length(), 2);
    assert.equal(slot_issue(slots, 0), "bi#01");
    assert.equal(slot_issue(slots, 1), "bi#192")
}

test "parse_file_claims reads Files lines, strips comments, unions" {
    assert.equal(parse_file_claims("no refs here"), []);
    assert.equal(parse_file_claims("Files: a.ts b/c.ts"), ["a.ts", "b/c.ts"]);
    assert.equal(parse_file_claims("  Files: a.ts  a.ts # dup + comment"), ["a.ts"]);
    assert.equal(parse_file_claims("Files: a.ts\nprose\nFiles: b.ts"), ["a.ts", "b.ts"]);
    assert.equal(parse_file_claims("Files:"), []);
    assert.equal(parse_file_claims("NotFiles: a.ts"), [])
}

// ── Goal-conditioned relevance (bi#133) ─────────────────────────────────────
// Blast radius is goal-blind: the biggest hub outranks everything no matter
// what the goal is. relevance(node, goal) fixes that with the same
// declare/derive split as urgency (bi#51): the LLM (or operator) DECLARES
// relevance + receipts as plain data — a Goal listing its clause ids and one
// RelevanceClaim per node naming which goal clauses it serves — and BAML
// DERIVES priority = f(relevance, blast_radius, severity) as a pure function
// that returns the score WITH its parts (never a bare number).
//
// Parsing the goal statement into clause ids is declare-side work (host/LLM);
// BAML only derives membership: a cited clause counts when it is a member of
// the CURRENT goal's clause list. Re-alignment is therefore continuous, not
// one-shot: every dispatch recomputes against the current goal and flags
// drift — a claim whose cited clauses are ALL retired from the current goal
// scores relevance 0 and carries drifted=true with the stale clause ids as
// the reason (structured string[] — `+` is numeric-only, so no composed
// message). A partially stale claim keeps alignment on its surviving
// receipts; a node with no claim scores structural-only and is never drifted
// (nothing to drift from).
//
// Weights (all bounded so every input can actually move the order):
// - Relevance: declared level clamped 0..3, scaled x2 (max 6, above the
//   blast cap, so goal alignment beats goal-blind leverage).
// - Blast: open_downstream capped at 4 (the load-bearing structural signal).
// - Severity: 1..4 linear, capped at 4 — deliberately WITHOUT urgency's
//   severity-5 override hatch, which would reintroduce goal-blind dominance.
// - Tie-breaks are structural all the way down (score, open_downstream,
//   severity_part, id ascending) so equal declarations cannot promote pet
//   work: an inflated declared level only wins ties it already tied.
//
// Out of scope (remainder): the scripts-lane recompute (relevance refresh per
// dispatch) and merger verification of landed nodes against cited clauses —
// this section is the pure derivation those lanes will call.
class Goal {
    statement: string @description(
        "current goal text, e.g. ship the CLI — declare-side, BAML only reads the clause list",
    ),
    clauses: string[] @description("clause ids receipts may cite, e.g. [ship-cli, fix-flakes]"),
}

class RelevanceClaim {
    issue_id: string,
    level: int @description(
        "declared 0-3: how directly the node serves the goal — clamped, never trusted raw",
    ),
    clauses: string[] @description("receipts: which goal clause ids this node serves"),
}

class GoalPriority {
    issue_id: string,
    score: int @description("relevance_part + blast_part + severity_part — always read with the parts"),
    declared: int @description("raw declared level, pre-clamp — audit trail"),
    relevance_part: int,
    blast_part: int,
    severity_part: int,
    receipts: string[] @description("cited clauses surviving in the current goal"),
    stale: string[] @description("cited clauses retired from the current goal — the drift reason"),
    drifted: bool @description("claim exists and NO cited clause survives"),
    open_downstream: int @description("structural tie-break signal, echoed for the sort receipt"),
}

function clamp_relevance(level: int) -> int {
    if (level < 0) {
        0
    } else if (level > 3) {
        3
    } else {
        level
    }
}

function claim_for(issue_id: string, claims: RelevanceClaim[]) -> RelevanceClaim? {
    for (let c in claims) {
        if (c.issue_id == issue_id) {
            return c;
        }
    }
    null
}

function surviving_receipts(claim: RelevanceClaim, goal: Goal) -> string[] {
    let out: string[] = [];
    for (let c in claim.clauses) {
        if (contains_id(goal.clauses, c) && !contains_id(out, c)) {
            out.push(c);
        }
    }
    out
}

function stale_receipts(claim: RelevanceClaim, goal: Goal) -> string[] {
    let out: string[] = [];
    for (let c in claim.clauses) {
        if (!contains_id(goal.clauses, c) && !contains_id(out, c)) {
            out.push(c);
        }
    }
    out
}

function priority_severity(issue: Issue) -> int {
    if let s: int = issue.severity {
        if (s <= 0) {
            0
        } else if (s >= 4) {
            4
        } else {
            s
        }
    } else {
        0
    }
}

function priority_blast(open_downstream: int) -> int {
    if (open_downstream > 4) {
        4
    } else if (open_downstream < 0) {
        0
    } else {
        open_downstream
    }
}

function goal_priority(
    issue: Issue,
    goal: Goal,
    claims: RelevanceClaim[],
    radii: BlastRadius[],
) -> GoalPriority {
    let blast_open = blast_of(issue.id, radii).open_downstream;
    let sev = priority_severity(issue);
    let blast = priority_blast(blast_open);
    if let c: RelevanceClaim = claim_for(issue.id, claims) {
        let keep = surviving_receipts(c, goal);
        let stale = stale_receipts(c, goal);
        // Drifted = receipts no longer match the goal AT ALL: the declared
        // level is untrusted once its backing clauses are gone.
        let rel = if (keep.length() == 0) {
            0
        } else {
            clamp_relevance(c.level) * 2
        };
        GoalPriority {
            issue_id: issue.id,
            score: rel + blast + sev,
            declared: c.level,
            relevance_part: rel,
            blast_part: blast,
            severity_part: sev,
            receipts: keep,
            stale: stale,
            drifted: keep.length() == 0 && c.clauses.length() > 0,
            open_downstream: blast_open,
        }
    } else {
        GoalPriority {
            issue_id: issue.id,
            score: blast + sev,
            declared: 0,
            relevance_part: 0,
            blast_part: blast,
            severity_part: sev,
            receipts: [],
            stale: [],
            drifted: false,
            open_downstream: blast_open,
        }
    }
}

// Structural ordering over derived priorities: score, then open blast, then
// severity, then id ascending. Declared data never breaks a tie by itself.
function priority_ranks_above(a: GoalPriority, b: GoalPriority) -> bool {
    if (a.score == b.score) {
        if (a.open_downstream == b.open_downstream) {
            if (a.severity_part == b.severity_part) {
                a.issue_id < b.issue_id
            } else {
                a.severity_part > b.severity_part
            }
        } else {
            a.open_downstream > b.open_downstream
        }
    } else {
        a.score > b.score
    }
}

test "goal switch reorders the pack" {
    let cli = mk_issue("bi#60", Status.Open);
    let flake = mk_issue("bi#61", Status.Open);
    let edges: Edge[] = [];
    let radii = blast_radii([cli, flake], edges);
    let claims = [
        RelevanceClaim { issue_id: "bi#60", level: 3, clauses: ["ship-cli"] },
        RelevanceClaim { issue_id: "bi#61", level: 3, clauses: ["fix-flakes"] },
    ];
    let ship = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let stab = Goal { statement: "stabilize flakes", clauses: ["fix-flakes"] };
    let cli_ship = goal_priority(cli, ship, claims, radii);
    let flake_ship = goal_priority(flake, ship, claims, radii);
    assert.equal(cli_ship.relevance_part, 6);
    assert.equal(flake_ship.relevance_part, 0);
    assert.equal(flake_ship.drifted, true);
    assert.equal(priority_ranks_above(cli_ship, flake_ship), true);
    // Same declarations, new goal: the order flips.
    let cli_stab = goal_priority(cli, stab, claims, radii);
    let flake_stab = goal_priority(flake, stab, claims, radii);
    assert.equal(flake_stab.relevance_part, 6);
    assert.equal(cli_stab.drifted, true);
    assert.equal(priority_ranks_above(flake_stab, cli_stab), true);
    assert.equal(priority_ranks_above(cli_stab, flake_stab), false)
}

test "goal alignment outweighs goal-blind blast" {
    // bi#26-style hub: four Open dependents (blast capped at 4), zero goal
    // relevance. A fully relevant leaf (3 x 2 = 6) still outranks it.
    let hub = mk_issue("bi#63", Status.Open);
    let leaf = mk_issue("bi#64", Status.Open);
    let issues = [
        hub,
        leaf,
        mk_issue("bi#65", Status.Open),
        mk_issue("bi#66", Status.Open),
        mk_issue("bi#67", Status.Open),
        mk_issue("bi#68", Status.Open),
    ];
    let edges = [
        Edge { from: "bi#65", to: "bi#63", kind: EdgeKind.DependsOn },
        Edge { from: "bi#66", to: "bi#63", kind: EdgeKind.DependsOn },
        Edge { from: "bi#67", to: "bi#63", kind: EdgeKind.DependsOn },
        Edge { from: "bi#68", to: "bi#63", kind: EdgeKind.DependsOn },
    ];
    let radii = blast_radii(issues, edges);
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let claims = [RelevanceClaim { issue_id: "bi#64", level: 3, clauses: ["ship-cli"] }];
    let hub_p = goal_priority(hub, goal, claims, radii);
    let leaf_p = goal_priority(leaf, goal, claims, radii);
    assert.equal(hub_p.blast_part, 4);
    assert.equal(hub_p.relevance_part, 0);
    assert.equal(leaf_p.score, 6);
    assert.equal(priority_ranks_above(leaf_p, hub_p), true)
}

test "drifted node flagged with stale receipts as the reason" {
    let node = mk_issue("bi#62", Status.Open);
    let radii = blast_radii([node], []);
    let claims = [RelevanceClaim { issue_id: "bi#62", level: 3, clauses: ["old-push"] }];
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let p = goal_priority(node, goal, claims, radii);
    assert.equal(p.drifted, true);
    assert.equal(p.stale, ["old-push"]);
    assert.equal(p.receipts, []);
    assert.equal(p.relevance_part, 0);
    assert.equal(p.score, p.blast_part + p.severity_part)
}

test "partial receipts keep alignment and list the stale rest" {
    let node = mk_issue("bi#69", Status.Open);
    let radii = blast_radii([node], []);
    let claims = [RelevanceClaim { issue_id: "bi#69", level: 2, clauses: ["ship-cli", "old-push"] }];
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let p = goal_priority(node, goal, claims, radii);
    assert.equal(p.drifted, false);
    assert.equal(p.receipts, ["ship-cli"]);
    assert.equal(p.stale, ["old-push"]);
    assert.equal(p.relevance_part, 4)
}

test "structural signals break ties so gaming cannot promote pet work" {
    // Pet declares the max level 3 (6 pts) with no structural backing; the
    // worker declares 2 (4 pts) but holds two Open dependents. Tied at 6 —
    // the structural tie-break ranks the worker above despite the pet's
    // higher declaration.
    let pet = mk_issue("bi#70", Status.Open);
    let worker = mk_issue("bi#71", Status.Open);
    let issues = [pet, worker, mk_issue("bi#72", Status.Open), mk_issue("bi#73", Status.Open)];
    let edges = [
        Edge { from: "bi#72", to: "bi#71", kind: EdgeKind.DependsOn },
        Edge { from: "bi#73", to: "bi#71", kind: EdgeKind.DependsOn },
    ];
    let radii = blast_radii(issues, edges);
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let claims = [
        RelevanceClaim { issue_id: "bi#70", level: 3, clauses: ["ship-cli"] },
        RelevanceClaim { issue_id: "bi#71", level: 2, clauses: ["ship-cli"] },
    ];
    let pet_p = goal_priority(pet, goal, claims, radii);
    let worker_p = goal_priority(worker, goal, claims, radii);
    assert.equal(pet_p.score, worker_p.score);
    assert.equal(priority_ranks_above(worker_p, pet_p), true);
    assert.equal(priority_ranks_above(pet_p, worker_p), false)
}

test "identical priorities tie-break on id ascending" {
    let a = mk_issue("bi#75", Status.Open);
    let b = mk_issue("bi#74", Status.Open);
    let radii = blast_radii([a, b], []);
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let claims = [
        RelevanceClaim { issue_id: "bi#75", level: 1, clauses: ["ship-cli"] },
        RelevanceClaim { issue_id: "bi#74", level: 1, clauses: ["ship-cli"] },
    ];
    let pa = goal_priority(a, goal, claims, radii);
    let pb = goal_priority(b, goal, claims, radii);
    assert.equal(pa.score, pb.score);
    assert.equal(priority_ranks_above(pb, pa), true)
}

test "undeclared node scores structural only and never drifts" {
    let hub = mk_issue("bi#76", Status.Open);
    let issues = [hub, mk_issue("bi#77", Status.Open)];
    let edges = [Edge { from: "bi#77", to: "bi#76", kind: EdgeKind.DependsOn }];
    let radii = blast_radii(issues, edges);
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let p = goal_priority(hub, goal, [], radii);
    assert.equal(p.relevance_part, 0);
    assert.equal(p.blast_part, 1);
    assert.equal(p.drifted, false);
    assert.equal(p.receipts, []);
    assert.equal(p.stale, []);
    assert.equal(p.score, p.blast_part + p.severity_part)
}

test "declared level clamps to 0..3 before scaling" {
    let hi = mk_issue("bi#78", Status.Open);
    let lo = mk_issue("bi#79", Status.Open);
    let radii = blast_radii([hi, lo], []);
    let goal = Goal { statement: "ship the CLI", clauses: ["ship-cli"] };
    let claims = [
        RelevanceClaim { issue_id: "bi#78", level: 99, clauses: ["ship-cli"] },
        RelevanceClaim { issue_id: "bi#79", level: -2, clauses: ["ship-cli"] },
    ];
    let hi_p = goal_priority(hi, goal, claims, radii);
    let lo_p = goal_priority(lo, goal, claims, radii);
    // Raw declaration kept for audit, scaled part clamped.
    assert.equal(hi_p.declared, 99);
    assert.equal(hi_p.relevance_part, 6);
    assert.equal(lo_p.relevance_part, 0);
    assert.equal(lo_p.drifted, false)
}
