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
    score: int @description("severity_part + blocks_part + stalled_part — always read with the parts"),
    severity_part: int,
    fan_out: int @description("Blocks edges out of this issue (raw count, pre-cap)"),
    sole_unblocks: int @description("downstream solely blocked by this issue (raw count, pre-cap)"),
    blocks_part: int,
    stalled_days: int @description("parked days actually counted (clamped at 0, uncapped)"),
    stalled_part: int,
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

function urgency(issue: Issue, edges: Edge[], costs: map<string, int>, now: int) -> Urgency {
    let sev = urgency_severity(issue);
    let fan = blocks_fan_out(issue, edges);
    let sole = sole_unblocks(issue, edges);
    let blocks = urgency_blocks(issue, edges);
    let days = urgency_stalled_days(issue, costs, now);
    let stalled = urgency_stalled(days);
    Urgency {
        issue_id: issue.id,
        score: sev + blocks + stalled,
        severity_part: sev,
        fan_out: fan,
        sole_unblocks: sole,
        blocks_part: blocks,
        stalled_days: days,
        stalled_part: stalled,
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
    let hub_u = urgency(hub, edges, costs, 100);
    assert.equal(hub_u.fan_out, 4);
    assert.equal(hub_u.sole_unblocks, 4);
    assert.equal(hub_u.blocks_part, 6);
    assert.equal(hub_u.score, 8);
    let leaf_u = urgency(leaves[0], edges, costs, 100);
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
    let hub_u = urgency(hub, edges, costs, 100);
    assert.equal(hub_u.score, 11);
    // Fresh severity-5 leaf: the override hatch alone scores 15.
    let hatch_u = urgency(hatch, edges, costs, 100);
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
    let old_u = urgency(trivia, edges, costs, 100);
    assert.equal(old_u.stalled_days, 60);
    assert.equal(old_u.stalled_part, 2);
    assert.equal(old_u.score, 3);
    let fresh_u = urgency(fresh, edges, costs, 100);
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
    let au = urgency(a, edges, costs, 100);
    let bu = urgency(b, edges, costs, 100);
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
    let u = urgency(issue, edges, costs, 100);
    // urgency 5 = severity 3 + blocks 2 + stalled 6d (0 pts).
    assert.equal(u.issue_id, "bi#50");
    assert.equal(u.severity_part, 3);
    assert.equal(u.fan_out, 1);
    assert.equal(u.sole_unblocks, 1);
    assert.equal(u.blocks_part, 2);
    assert.equal(u.stalled_days, 6);
    assert.equal(u.stalled_part, 0);
    assert.equal(u.score, u.severity_part + u.blocks_part + u.stalled_part);
    assert.equal(u.score, 5)
}

test "missing or future creation day counts as fresh" {
    let missing = urgency_issue("bi#60", 2);
    let future = urgency_issue("bi#61", 2);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let _ = costs.set("bi#61", 105);
    let mu = urgency(missing, edges, costs, 100);
    assert.equal(mu.stalled_days, 0);
    assert.equal(mu.stalled_part, 0);
    let fu = urgency(future, edges, costs, 100);
    assert.equal(fu.stalled_days, 0);
    assert.equal(fu.stalled_part, 0)
}

test "null severity contributes nothing" {
    let issue = urgency_issue("bi#80", null);
    let edges: Edge[] = [];
    let costs: map<string, int> = {};
    let u = urgency(issue, edges, costs, 100);
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
    let u = urgency(hub, edges, costs, 100);
    assert.equal(u.fan_out, 2);
    // bi#72 has a second blocker, so only bi#71 is one-completion-away.
    assert.equal(u.sole_unblocks, 1);
    assert.equal(u.blocks_part, 3)
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

function why_not(issues: Issue[], edges: Edge[], project: string, leases: IssueLease[]) -> WhyNot[] {
    let out: WhyNot[] = [];
    let cyclic = cyclic_ids(issues, edges);
    for (let issue in issues) {
        // Omission gate: ready on every path is Open + unblocked (+ unleased
        // where the store knows leases — the scan path passes []). An issue
        // that survives it is listed as ready and carries no reason.
        if (issue.status == Status.Open && (is_blocked(issue, edges, issues) || lease_for(issue.id, leases) != null)) {
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
    assert.equal(contains_id(reasons.map((r) -> { r.id }), "bi#01"), false)
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
