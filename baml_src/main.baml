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

function ready_issues(issues: Issue[], edges: Edge[]) -> Issue[] {
    issues.filter((issue) -> {
        issue.status == Status.Open && !is_blocked(issue, edges, issues)
    })
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
