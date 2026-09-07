// bais/scripts/fixtures/mirror/blocked-pack.mjs — fixtures for
// mirror-parity §D-blocked (bi#37 Mode B: dispatch never hands out blocked
// work, bi<->bais parity that never goes silently ready on unresolvable
// blockers).
//
// Plain data only, no logic: each case carries spec records
// { id, status, edges: [[from, to, kind]], body } plus leased/footprint/
// budget inputs and the hand-computed slot order. The suite materializes
// specs with its own F/E constructors, so this file pins INPUTS while the
// .mjs section pins BEHAVIOUR. Every body declares a footprint (Files:
// line) disjoint from the rest, so the hub#175 unknown-exclusion rule
// stays out of these pins — blocked-skip is proved alone.
//
// Expectations are hand-computed from the BAML tests (names cited):
//   "dispatch skips leased and blocked issues" (main.baml:1785) — the pack
//     iterates ready_issues only, so Open-blocked issues never take a slot
//     while Done/Dropped-blocked issues pack freely.
//   "dangling Blocks edge keeps issue out of ready" (main.baml:170) — an
//     unresolvable blocker is still a blocker at the pack surface: the
//     issue never lands in a slot even with free budget.
// ordering within a case follows the pack rule (open_downstream desc,
// id ascending) — cf. "dispatch packs the hub before leaves" (main.baml:1767).
export function blockedPackCases() {
	return [
		{
			// BAML "dispatch skips leased and blocked issues", verbatim shape:
			// t#01 holds the most work but is live-claimed; t#04 is parked
			// behind an open blocker. Neither is packed.
			name: "leased-and-blocked",
			issues: [
				{ id: "t#01", status: "Open", edges: [], body: "b\nFiles: t01.ts" },
				{ id: "t#02", status: "Open", edges: [["t#02", "t#01", "DependsOn"]], body: "b\nFiles: t02.ts" },
				{ id: "t#03", status: "Open", edges: [], body: "b\nFiles: t03.ts" },
				{ id: "t#04", status: "Open", edges: [["t#03", "t#04", "Blocks"]], body: "b\nFiles: t04.ts" },
			],
			leased: ["t#01"],
			fp: [["t#01", ["t01.ts"]], ["t#02", ["t02.ts"]], ["t#03", ["t03.ts"]], ["t#04", ["t04.ts"]]],
			budget: 4,
			want: ["t#02", "t#03"],
		},
		{
			// Unresolvable blocker at the pack surface: q#01 names a blocker
			// that does not exist. Free budget must NOT silently ready it —
			// only the unblocked sibling packs.
			name: "dangling-blocker-never-packs",
			issues: [
				{ id: "q#01", status: "Open", edges: [["q#ZZ", "q#01", "Blocks"]], body: "b\nFiles: q01.ts" },
				{ id: "q#02", status: "Open", edges: [], body: "b\nFiles: q02.ts" },
			],
			leased: [],
			fp: [["q#01", ["q01.ts"]], ["q#02", ["q02.ts"]]],
			budget: 2,
			want: ["q#02"],
		},
		{
			// Resolved blockers free the issue (BAML "resolved Done blocker
			// still frees the issue" + "Dropped blocker frees the issue"):
			// both parked issues pack, id ascending at tied radius 0.
			name: "resolved-blockers-free",
			issues: [
				{ id: "d#01", status: "Open", edges: [["d#02", "d#01", "Blocks"]], body: "b\nFiles: d01.ts" },
				{ id: "d#02", status: "Done", edges: [], body: "b\nFiles: d02.ts" },
				{ id: "p#01", status: "Open", edges: [["p#02", "p#01", "Blocks"]], body: "b\nFiles: p01.ts" },
				{ id: "p#02", status: "Dropped", edges: [], body: "b\nFiles: p02.ts" },
			],
			leased: [],
			fp: [["d#01", ["d01.ts"]], ["d#02", ["d02.ts"]], ["p#01", ["p01.ts"]], ["p#02", ["p02.ts"]]],
			budget: 4,
			want: ["d#01", "p#01"],
		},
		{
			// Blocked hub excludes itself but not its leaves: h#01 is parked
			// behind open h#00, so the pack takes the blocker (radius 1)
			// then the ready leaves in id order — never the parked hub.
			name: "blocked-hub-leaves-pack",
			issues: [
				{ id: "h#00", status: "Open", edges: [], body: "b\nFiles: h00.ts" },
				{ id: "h#01", status: "Open", edges: [["h#00", "h#01", "Blocks"]], body: "b\nFiles: h01.ts" },
				{ id: "h#02", status: "Open", edges: [["h#02", "h#01", "DependsOn"]], body: "b\nFiles: h02.ts" },
				{ id: "h#03", status: "Open", edges: [["h#03", "h#01", "DependsOn"]], body: "b\nFiles: h03.ts" },
			],
			leased: [],
			fp: [["h#00", ["h00.ts"]], ["h#01", ["h01.ts"]], ["h#02", ["h02.ts"]], ["h#03", ["h03.ts"]]],
			budget: 3,
			want: ["h#00", "h#02", "h#03"],
		},
	];
}
