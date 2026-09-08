// foundation_test.baml — hub#219 item 2: literal tests for the wave-4
// BAML mirror (foundation.baml). T0 policy on literals, no LLM.
//
// Red-check (bi#57) — target: the precedes-ancestor return of
// foundation_rank (foundation.baml: the BFS `return 0` when the walk
// reaches the baseline).
// Hunk: BFS `return 0` flipped to `return 1` (ancestors no longer rank
// foundation). Expected reason: precedes-ancestors stop seating first —
// the walking skeleton loses its foundation tier. Observed (2026-09-08):
// `baml test --project bais` failed LOUD with 2 failures FOR THE RIGHT
// REASON —
//   FAIL root::foundation_rank: 0 for baseline and precedes-ancestors, 1 otherwise
//     (assertion failed: left = 1, right = 0 — core's rank flipped)
//   FAIL root::foundation_order seats the baseline tier before higher-blast enhancements
//     (left = ["baseline","enh-a","enh-b","core"], right =
//     ["baseline","core","enh-a","enh-b"] — core lost its foundation
//     tier and seated behind the blast-9 enhancements)
// Restored, re-ran green (259 passed). A rank rule that cannot go red on
// an ancestor is camouflage, not coverage.

function mk_edge(from: string, to: string) -> SketchEdge {
    SketchEdge { from: from, to: to, kind: "precedes" }
}

test "foundation_rank: 0 for baseline and precedes-ancestors, 1 otherwise" {
    let edges = [
        mk_edge("core", "baseline"),
        mk_edge("tooling", "core"), // transitive ancestor
        mk_edge("baseline", "hero"),
    ];
    assert.equal(foundation_rank("baseline", "baseline", edges), 0);
    assert.equal(foundation_rank("core", "baseline", edges), 0);
    assert.equal(foundation_rank("tooling", "baseline", edges), 0);
    assert.equal(foundation_rank("unrelated", "baseline", edges), 1);
    assert.equal(foundation_rank("enhancement", "baseline", edges), 1);
    // Non-precedes kinds never order the foundation.
    let dep = [SketchEdge { from: "x", to: "baseline", kind: "DependsOn" }];
    assert.equal(foundation_rank("x", "baseline", dep), 1);
    // Cycle-safe: a precedes loop terminates and stays rank 1 off-baseline.
    let cycle = [mk_edge("a", "b"), mk_edge("b", "a")];
    assert.equal(foundation_rank("a", "baseline", cycle), 1)
}

test "foundation_order seats the baseline tier before higher-blast enhancements" {
    let edges = [mk_edge("core", "baseline")];
    let pack = [
        SeatItem { id: "enh-b", blast: 9 }, // highest blast, enhancement
        SeatItem { id: "baseline", blast: 1 },
        SeatItem { id: "core", blast: 0 }, // rank 0 via precedes
        SeatItem { id: "enh-a", blast: 9 }, // ties enh-b on blast -> id ascending
    ];
    // Rank 0 tier first (baseline's blast 1 outranks core's 0 inside the
    // tier); the enhancements wait despite blast 9.
    assert.equal(foundation_order(pack, "baseline", edges), ["baseline", "core", "enh-a", "enh-b"]);
    // Rank ties fall to blast descending, then id ascending.
    assert.equal(
        foundation_order([SeatItem { id: "t#09", blast: 0 }, SeatItem { id: "t#02", blast: 0 }], "baseline", []),
        ["t#02", "t#09"],
    )
}

test "parse_exercise decomposes command, expect, facets" {
    let s = parse_exercise("node .bais/e2e/flow.mjs => exits 0 (facets: pure, cli-args)");
    assert.is_true(s != null);
    assert.equal(s?.command ?? "", "node .bais/e2e/flow.mjs");
    assert.equal(s?.expect ?? "", "exits 0");
    assert.equal(s?.facets ?? [], ["pure", "cli-args"]);
    // Bare "facets: ..." without parens cites the same way.
    let bare = parse_exercise("run it => passes facets: waiver");
    assert.equal(bare?.expect ?? "", "passes");
    assert.equal(bare?.facets ?? [], ["waiver"]);
    // No citation: facets empty, the whole tail is the predicate.
    let plain = parse_exercise("run it => passes");
    assert.equal(plain?.facets ?? ["x"], [])
}

test "parse_exercise refuses assert-true and vacuous shapes" {
    assert.is_true(parse_exercise("") == null);
    assert.is_true(parse_exercise("just run the suite") == null); // assert-true, no =>
    assert.is_true(parse_exercise("=> passes") == null); // missing command
    assert.is_true(parse_exercise("run it =>") == null); // missing expected predicate
    // A facet citation that consumes the whole predicate grades vacuously.
    assert.is_true(parse_exercise("run it => (facets: pure)") == null)
}

test "oracle_facet_join: absent, drifted, waiver, declared" {
    let declared = ["pure", "cli-args"];
    let absent = oracle_facet_join(declared, "flow", "run it => passes");
    assert.is_true(!absent.ok);
    assert.is_true(absent.reason.index_of("oracle_facet_absent") == 0);
    assert.is_true(absent.reason.includes("flow"));
    let drifted = oracle_facet_join(declared, "flow", "run it => passes (facets: retired-facet)");
    assert.is_true(!drifted.ok);
    assert.equal(drifted.drifted, ["retired-facet"]);
    assert.is_true(drifted.reason.index_of("oracle_facet_drifted") == 0);
    assert.is_true(drifted.reason.includes("retired-facet"));
    // The explicit waiver facet is the escape hatch — cited, never drifted.
    assert.is_true(oracle_facet_join(declared, "flow", "run it => passes (facets: waiver)").ok);
    // A declared facet joins clean, cited recorded.
    let clean = oracle_facet_join(declared, "flow", "run it => passes (facets: pure)");
    assert.is_true(clean.ok);
    assert.equal(clean.cited, ["pure"]);
    assert.equal(clean.reason, "")
}
