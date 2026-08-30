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
    function validate(self, issue: Issue) -> bool
}

// Query helpers — provable via `baml test` on literal Issue[] (no LLM).
function is_blocked(issue: Issue, edges: Edge[], issues: Issue[]) -> bool {
    for (let e in edges) {
        if (e.to == issue.id && e.kind == EdgeKind.Blocks) {
            for (let blocker in issues) {
                if (
                    blocker.id == e.from
                        && blocker.status != Status.Done
                        && blocker.status != Status.Dropped
                ) {
                    return true;
                }
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
