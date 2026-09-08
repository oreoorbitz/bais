// foundation.baml — hub#219 item 2 (sources hub#186/hub#190): the BAML
// mirror of wave-4's landed-but-dormant derivations. Pure policy over
// plain data, proved by `baml test` on literals (foundation_test.baml) —
// hosts own graph walks and exercise text, BAML owns the rule (the
// dispatch_pack clocks/policy split):
//
//   1. foundation_rank (hub#186): 0 when the issue IS the baseline or a
//      `precedes`-ancestor of it, else 1 — the primary dispatch sort key
//      BEFORE blast radius. Mirrors goal.mjs foundationRank (scripts
//      lane): forward BFS over edges {from, to, kind: "precedes"} — from
//      precedes to. Hosts normalize kind to lowercase at the boundary
//      (goal.mjs lowercases; this mirror matches the canonical form).
//   2. foundation_order: the seating rule hub#219 item 1 wires into
//      dispatch — foundation rank ascending, then blast radius
//      descending, then id ascending (full determinism, the dispatch_pack
//      tie-break idiom). Candidates arrive as plain SeatItem data.
//   3. parse_exercise / oracle_facet_join (hub#190): the join SHAPES of
//      goal.mjs parseExercise/oracleFacetJoin — an exercise decomposes to
//      {command, expect, facets} (assert-true shapes grade vacuously and
//      fail), and every case's facet citations join against the declared
//      surface_spec facets with absent/drifted named reasons (the
//      LLM DECLARES, BAML DERIVES/verifies split, bi#133). Shape mirror,
//      not byte-exact: goal.mjs anchors the facet citation at the string
//      end; this mirror takes the first "facets:" after "=>".

class SketchEdge {
    from: string @description("issue id that must land first"),
    to: string @description("issue id it precedes"),
    kind: string @description(
        "lowercase — hosts normalize at the boundary (goal.mjs lowercases); only \"precedes\" orders the foundation",
    ),
}

class SeatItem {
    id: string,
    blast: int @description("open_downstream — the blast_radii number dispatch sorts on"),
}

class ExerciseShape {
    command: string,
    expect: string,
    facets: string[],
}

class FacetJoinRow {
    case_id: string,
    cited: string[],
    drifted: string[],
    ok: bool,
    reason: string,
}

// THE foundation rank (hub#186, red-check target — see the header of
// foundation_test.baml): 0 for the baseline and its transitive
// precedes-ancestors, 1 for everything else. Forward BFS from issue_id
// over precedes edges; the seen-guard makes cycles terminate.
function foundation_rank(issue_id: string, baseline_id: string, edges: SketchEdge[]) -> int {
    if (issue_id == baseline_id) {
        return 0;
    }
    let seen: string[] = [issue_id];
    let frontier: string[] = [issue_id];
    while (frontier.length() > 0) {
        let next: string[] = [];
        for (let cur in frontier) {
            if (cur == baseline_id) {
                return 0;
            }
            for (let e in edges) {
                if (e.kind == "precedes" && e.from == cur && !seen.includes(e.to)) {
                    seen.push(e.to);
                    next.push(e.to);
                }
            }
        }
        frontier = next;
    }
    1
}

// The seating rule: foundation rank ascending (baseline first), then
// blast radius descending, then id ascending. Greedy best-first (the
// dispatch_pack idiom), deterministic on identical inputs.
function foundation_order(
    candidates: SeatItem[],
    baseline_id: string,
    edges: SketchEdge[],
) -> string[] {
    let pool = candidates;
    let out: string[] = [];
    while (pool.length() > 0) {
        let best: SeatItem? = null;
        for (let c in pool) {
            if let b: SeatItem = best {
                let cr = foundation_rank(c.id, baseline_id, edges);
                let br = foundation_rank(b.id, baseline_id, edges);
                if (
                    cr < br
                        || (cr == br && c.blast > b.blast)
                        || (cr == br && c.blast == b.blast && c.id < b.id)
                ) {
                    best = c;
                }
            } else {
                best = c;
            }
        }
        if let b: SeatItem = best {
            out.push(b.id);
            let bid = b.id;
            pool
                = pool.filter((c) -> {
                    c.id != bid
                });
        }
    }
    out
}

// The {command, expect, facets} decomposition (hub#190 shape mirror of
// goal.mjs parseExercise): "<command> => <expect>" with an optional
// trailing "facets: a, b" citation (parens optional, stripped). null when
// the shape grades vacuously: empty, assert-true (no "=>"), missing
// command, missing expected predicate, or a facet citation that consumed
// the whole predicate.
function parse_exercise(exercise: string) -> ExerciseShape? {
    let raw = exercise.trim();
    if (raw == "") {
        return null;
    }
    let i = raw.index_of("=>");
    if (i == null) {
        return null; // assert-true shape, no expected predicate
    }
    let command = raw.slice(0, i).trim();
    let rest = raw.slice(i + 2, raw.length()).trim();
    if (command == "" || rest == "") {
        return null;
    }
    let facets: string[] = [];
    let fi = rest.index_of("facets:");
    if (fi == null) {
        // No citation: facets empty, the whole tail is the predicate.
        return ExerciseShape { command: command, expect: rest, facets: facets };
    }
    let tail = rest.slice(fi + 7, rest.length()).trim();
    // Parens are optional around the citation; strip a trailing ")".
    if (tail.ends_with(")")) {
        tail = tail.slice(0, tail.length() - 1).trim();
    }
    let expect = rest.slice(0, fi).trim();
    // A trailing "(" left behind by "(facets: ...)" is decoration.
    if (expect.ends_with("(")) {
        expect = expect.slice(0, expect.length() - 1).trim();
    }
    if (tail != "") {
        for (let part in tail.split(",")) {
            let f = part.trim();
            if (f != "") {
                facets.push(f);
            }
        }
    }
    if (expect == "") {
        return null; // the citation consumed the whole expected predicate
    }
    ExerciseShape { command: command, expect: expect, facets: facets }
}

// The oracle-facet join (hub#190 shape mirror of goal.mjs
// oracleFacetJoin): the case DECLARES facet citations in its exercise,
// this DERIVES/verifies them against the declared surface_spec facets.
// A case citing nothing has nothing to check against (oracle_facet_absent);
// a case citing a retired facet reports drift with the stale facet named
// (oracle_facet_drifted); the explicit "waiver" facet is the escape hatch.
function oracle_facet_join(declared: string[], case_id: string, exercise: string) -> FacetJoinRow {
    let shape = parse_exercise(exercise);
    let cited: string[] = [];
    if let s: ExerciseShape = shape {
        cited = s.facets;
    }
    let drifted: string[] = [];
    for (let f in cited) {
        if (f != "waiver" && !declared.includes(f)) {
            drifted.push(f);
        }
    }
    if (cited.length() == 0) {
        return FacetJoinRow {
            case_id: case_id,
            cited: cited,
            drifted: drifted,
            ok: false,
            reason: `oracle_facet_absent: e2e case "${case_id}" cites no surface_spec facet — cite at least one declared facet (or the explicit "waiver" facet) via "facets: ..." in the exercise`,
        };
    }
    if (drifted.length() > 0) {
        FacetJoinRow {
            case_id: case_id,
            cited: cited,
            drifted: drifted,
            ok: false,
            reason: `oracle_facet_drifted: e2e case "${case_id}" cites retired facet "${drifted.at(0) ?? ""}" — re-cite a declared facet or amend surface_spec with a reasoned record`,
        }
    } else {
        FacetJoinRow { case_id: case_id, cited: cited, drifted: drifted, ok: true, reason: "" }
    }
}
