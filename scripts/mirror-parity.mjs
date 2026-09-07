// bais/scripts/mirror-parity.mjs — bi#64: host-mirror parity for BAML-owned policy.
//
// AUDIT TABLE (mirror x canonical BAML source x verdict). Standing rule: the
// host executes, never decides. Every row below is either a justified mirror
// pinned HERE, a mirror pinned by a named companion suite, or a site audited
// clean with its reason. precedent: hub#163 brief-parity.mjs (single-source
// proof + line-naming FAILs) and bi#62 ready-shape.mjs (shape conformance).
//
// Biamese twins (TWO host copies + BAML definition — pinned HERE, bi vs bais):
//   M-bi1/bais1  bi filterReadyIssues / bais readyIssues  <- ready_issues/is_blocked (bais/baml_src/main.baml:63,90)
//   M-bi2/bais2  bi/bais blastRadii                      <- blast_radii (main.baml:1390)
//   M-bi3/bais3  bi/bais parseFileClaims                 <- parse_file_claims (main.baml:1517)
//   M-bi4/bais4  bi/bais dispatchPack                    <- dispatch_pack (main.baml:1556)
//   M-bi5/bais5  bi/bais danglingRefsIn                   <- dangling_edge_refs (main.baml:330)
//   M-bi6/bais6  bi cyclicIssueIds / bais cyclicIds       <- cyclic_ids (main.baml:514)
//   M-bi7/bais7  bi precedesEdge+precedencePath / bais precedes <- precedes (main.baml:478)
//   M-bi8/bais8  bi idProject / bais idProject            <- id_project (main.baml:297)
// Mode-B core (bi#37): §D-blocked pins dispatchPack blocked-skip end to
// end on BOTH hosts — a blocked issue landing in a slot is silently ready,
// and an unresolvable (dangling) blocker must park, never pack, even with
// free budget. Cases live in scripts/fixtures/mirror/blocked-pack.mjs
// (plain data, BAML test names cited per case); §S grows the
// scannedBlockers edges (Open blocks, Dropped frees, DependsOn ignored).
//   (FFI reason, same for all eight: proposals/05 — enums nested in class
//   fields encode as bare strings inbound, so == against enum literals is
//   silently false inside the VM; BAML owns the definition proved by
//   `baml test`, hosts mirror it. bais header + bi header say the same.)
// Bais-only mirrors (no second host copy — pinned HERE against hand-computed
// expectations lifted from the BAML baml-test cases, test names cited):
//   M-bais9   whyNotIn (+WhyNot shape)  <- why_not (main.baml:1131; tests "why-not ...")
//   M-bais10  parseCloseEvidence/closeEvidenceIn <- NO BAML source: host-owned
//             bi#83 check policy (Done-only gate, drill/verdict refs). Companion:
//             bi/scripts/check-evidence.mjs (delegation) + drill-registry.mjs (live).
// Bais-only, pinned by companion suites (not re-pinned here):
//   M-bais11  storeReady SQL (bais/src/store.ts:522) <- ready_issues/is_blocked,
//             independent SQL re-implementation; pinned by cross-check.mjs §§2-3
//             (scan-vs-store agreement on the live hub).
//   M-bais12  storeLeases/storeWhyNot <- why_not/lease (ns_event/lease.baml
//             current_lease); storeWhyNot reuses whyNotIn over projection rows.
// Claim predicates (host owns the clock; BAML has no wall time):
//   M-c1  bi parseClaimDuration/toLeaseIso/leaseExpiredMs (bi/src/bais.ts:544-558)
//         vs bais/src/cli.ts parseDuration/toLeaseIso/leaseExpired (private,
//         verbatim same bodies) — pinned HERE on the bi side; bais side covered
//         by claim.mjs + lease-race.mjs. Unparseable lease reads as expired.
//   M-c2  move/renew/reap state machines exist twice (bi/src/bais.ts +
//         bais/src/cli.ts move/renew/reap paths): lease-aware transitions.
//         Pinned by claim.mjs + lease-race.mjs + move-unblocked.mjs; no new
//         pins here (CLI-private on the bais side, same as M-c1).
// Audited clean (decision-shaped code that is NOT a BAML-policy mirror):
//   A1  bi/src/diff-render.ts diffLineRole — line-prefix -> style role; the
//       STYLE itself is single-sourced (style_segment_async in baml_sdk), the
//       prefix mapping mirrors pi's renderDiff, not BAML (BAML owns the
//       unified_diff SHAPE in render.baml). Presentation, no policy.
//   A2  bi/src/tools.ts:464 status filter + bi/src/cli.ts:1140 /issues Open
//       filter + bais/bi check-command Missing/External counters — display
//       plumbing over mirror outputs, no re-decision of readiness.
//   A3  bi/src/bais.ts scanBaisHeaders + loadStagedIssues mtime memo — perf
//       paths; the scan NEVER marks parseable files ready by itself (edges
//       dropped for unparseable files; scannedBlockers re-applies the Blocks
//       rule, pinned §S).
//   A4  bi#51 urgency serving: BAML urgency_* EXISTS + baml-tested
//       (main.baml:795-1079) but NO host serving exists (--order is
//       blast-radius only) — no mirror to pin; serving lands with bi#51.
//   A5  bi refuse_* (tools.ts imports refuse_bash_blocked_async etc. from
//       baml_sdk) — already single-sourced SDK calls, not mirrors.
//   A6  bais/src/graph.ts projectName + bi baisProjectName — config.toml is
//       not the Issue shape (justified in situ); not policy.
// OFF-LIMITS mirrors (packer territory — REPORTED, not touched):
//   O1  bais/scripts/briefs.mjs parseFiles — mirror of graph.parseFileClaims
//       EXTENDED with declared/unknown (packs-free-but-flagged). brief-parity
//       pins brief BYTES, not parseFiles vs parseFileClaims agreement.
//   O2  bais/scripts/briefs.mjs cohortCandidates/buildPack/cohort scoring —
//       status/kind decision branches (Open gate, doneish, DependsOn/Blocks
//       guards) + brief lines + warn strings (warnPartial pinned in
//       brief-parity; warnCohortSplit/warnReentry/warnCohortExclude live here).
//   O3  dispatch.mjs consumes briefs.mjs (buildPack et al.) — pack conformance
//       §§1-8 pins the CLI surface, not the pure graph.dispatchPack fn.
//
// Fixtures are self-contained literals; expectations are hand-computed from
// the BAML tests (names cited per section). bi dist vs bais dist must AGREE
// and match the pins: a drifted mirror fails loud naming the section + line.
//
// Red-check record (bi#57, observed live 2026-09-06):
//   $ cp bais/src/graph.ts /tmp/mirror64-graph-backup.ts
//   $ neuter the DependsOn arm of blastRadii directDependents (graph.ts:100:
//     drop `e.kind === "DependsOn" ||`), rebuild bais, run probe
//     => FAIL: blast: bi vs bais agree (bais hub open_downstream 1 vs bi 3)
//     => FAIL: blast hub pins (open=1 want 3, total=1 want 4)
//     => FAIL: blast dangling-dependent pin (open=0 total=0)
//     => mirror-parity: 3 failure(s), exit 1
//   $ cp /tmp/mirror64-graph-backup.ts bais/src/graph.ts (cmp-identical),
//     rebuild, probe green (36 checks, exit 0). A passing gate that cannot
//   go red is camouflage, not coverage — the three FAIL lines are the proof.
//
// Red-check record (bi#37 Mode B, observed live 2026-09-06, agent b637r):
//   $ cp bi/dist/src/bais.js /tmp/b637r-bais-dist-backup.js
//   $ neuter the dangling arm of filterReadyIssues (dist bais.js:312:
//     `!blocker ||` -> `blocker &&`, i.e. dangling edges skipped again),
//     run probe (no rebuild — dist is the executed artifact)
//     => FAIL: ready: bi vs bais agree (...)
//     => FAIL: pack dangling-blocker-never-packs: bi vs bais agree (["q#02"])
//     => mirror-parity: 2 failure(s), exit 1
//   $ cp /tmp/b637r-bais-dist-backup.js bi/dist/src/bais.js (cmp-identical),
//     probe green (59 checks, exit 0). The new §D-blocked dangling pin is
//   the tripwire: the literal pins read the bais side, the agree() checks
//   catch a regression on EITHER side.
//
// Run: node bais/scripts/mirror-parity.mjs (offline, tmpdirs only, read-only
// against the live hubs — imports both dists, so rebuild first if .ts moved).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const bais = await import(join(HERE, "..", "dist", "src", "graph.js"));
const bi = await import(join(HERE, "..", "..", "bi", "dist", "src", "bais.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const E = (from, to, kind) => ({ from, to, kind });
const F = (id, status = "Open", edges = [], body = "b") => ({
	issue: { id, title: `${id} t`, status, kind: "Feat", area: null, severity: null, source: null, body },
	edges,
	holder: null,
	lease: null,
});
const ids = (files) => files.map((f) => f.issue.id).sort();
const agree = (label, a, b) =>
	check(JSON.stringify(a) === JSON.stringify(b), `${label}: bi vs bais agree (${JSON.stringify(a)})`);

// ---- §R ready (M-bi1/bais1 <- ready_issues/is_blocked) ----
// BAML spec: "dangling Blocks edge keeps issue out of ready",
// "resolved Done blocker still frees the issue", "Dropped blocker frees
// the issue", "non-Blocks dangling edge does not block".
{
	const all = [
		F("r#01"), // Open hub
		F("r#02", "Open", [E("r#02", "r#01", "DependsOn")]), // DependsOn never blocks
		F("r#03", "Open", [E("r#04", "r#03", "Blocks")]), // blocked by Done -> free
		F("r#04", "Done"),
		F("r#05", "Open", [E("r#06", "r#05", "Blocks")]), // blocked by Dropped -> free
		F("r#06", "Dropped"),
		F("r#07", "Open", [E("r#08", "r#07", "Blocks")]), // blocked by Open
		F("r#08", "Open"),
		F("r#09", "Open", [E("r#ZZ", "r#09", "Blocks")]), // dangling blocker parks
		F("r#10", "Open", [E("r#10", "r#ZY", "DependsOn")]), // non-Blocks dangle: ready
		F("r#11", "Doing"),
		F("r#12", "Dropped"),
	];
	const want = ["r#01", "r#02", "r#03", "r#05", "r#08", "r#10"];
	const a = ids(bais.readyIssues(all));
	const b = ids(bi.filterReadyIssues(all));
	agree("ready", a, b);
	check(JSON.stringify(a) === JSON.stringify(want), `ready pins hold (got ${a.join(",")})`);
}

// ---- §B blast radii (M-bi2/bais2 <- blast_radii) ----
// BAML spec: "blast radius counts transitive open dependents through mixed
// kinds", "ignores Related and terminates on cycles", "counts a dangling
// dependent in total, never in open".
{
	const all = [
		F("c#01"),
		F("c#02", "Open", [E("c#02", "c#01", "DependsOn")]),
		F("c#03", "Open", [E("c#03", "c#02", "DependsOn")]),
		F("c#04", "Done", [E("c#04", "c#01", "DependsOn")]), // total, never open
		F("c#05", "Open", [E("c#05", "c#01", "Related")]), // ignored kind
		F("c#06", "Open", [E("c#06", "c#01", "Blocks")]), // downstream via Blocks
		F("c#09", "Open", [E("c#99", "c#09", "DependsOn")]), // dangling dependent
	];
	const A = new Map(bais.blastRadii(all).map((r) => [r.id, r]));
	const B = new Map(bi.blastRadii(all).map((r) => [r.id, r]));
	agree("blast", [...A.entries()], [...B.entries()]);
	const hub = A.get("c#01");
	check(hub.open_downstream === 3 && hub.total_downstream === 4,
		`blast hub pins (open=${hub.open_downstream} want 3, total=${hub.total_downstream} want 4)`);
	const dd = A.get("c#09");
	check(dd.open_downstream === 0 && dd.total_downstream === 1,
		`blast dangling-dependent pin (open=${dd.open_downstream} total=${dd.total_downstream})`);
	const cyc = [F("y#01", "Open", [E("y#02", "y#01", "Blocks")]), F("y#02", "Open", [E("y#01", "y#02", "Blocks")])];
	const Y = new Map(bais.blastRadii(cyc).map((r) => [r.id, r]));
	check(Y.get("y#01").open_downstream === 1 && Y.get("y#01").total_downstream === 1,
		`blast cycle terminates without self-credit (open=${Y.get("y#01").open_downstream} total=${Y.get("y#01").total_downstream})`);
	agree("blast cycle", [...Y.entries()], [...new Map(bi.blastRadii(cyc).map((r) => [r.id, r])).entries()]);
}

// ---- §P file claims (M-bi3/bais3 <- parse_file_claims) ----
// BAML spec: "parse_file_claims reads Files lines, strips comments, unions".
{
	const body = "b\nFiles: a.ts b.ts # shared\nnotes\nFiles: b.ts c.ts\nFiles:   # empty claim";
	const a = bais.parseFileClaims(body);
	const b = bi.parseFileClaims(body);
	agree("claims", a, b);
	check(JSON.stringify(a) === JSON.stringify(["a.ts", "b.ts", "c.ts"]), `claims pins (got ${a.join(",")})`);
}

// ---- §D dispatch pack (M-bi4/bais4 <- dispatch_pack) ----
// BAML spec: "packs the hub before leaves and caps by budget", "skips
// leased and blocked issues", "packs around file conflicts", "tie-breaks
// on id ascending", "empty on zero budget or fully leased backlog".
{
	// hub#175: these pins exercise clash/ordering with DECLARED footprints
	// (Files: lines in the bodies — the dispatchPack exclusion reads bodies,
	// the clash predicate reads the fp map, same split as the live call
	// sites). Unknown-footprint pins live in the block below.
	const base = () => [
		F("k#01", "Open", [], "b\nFiles: k01.ts"),
		F("k#02", "Open", [E("k#02", "k#01", "DependsOn")], "b\nFiles: k02.ts"),
		F("k#03", "Open", [E("k#03", "k#01", "DependsOn")], "b\nFiles: k03.ts"),
		F("k#04", "Open", [], "b\nFiles: k04.ts"),
	];
	const fp = new Map([["k#01", ["a.ts"]], ["k#02", ["a.ts"]], ["k#03", ["a.ts"]], ["k#04", ["b.ts"]]]);
	const slotIds = (slots) => slots.map((s) => s.issue_id);
	const a1 = slotIds(bais.dispatchPack(base(), [], fp, 2));
	const b1 = slotIds(bi.dispatchPack(base(), [], fp, 2));
	agree("pack hub-first+capped", a1, b1);
	check(JSON.stringify(a1) === JSON.stringify(["k#01", "k#04"]),
		`pack hub-first pin (k#02/k#03 clash on a.ts; got ${a1.join(",")})`);
	const a2 = slotIds(bais.dispatchPack(base(), ["k#01", "k#02", "k#03", "k#04"], fp, 3));
	check(JSON.stringify(a2) === JSON.stringify([]) && JSON.stringify(slotIds(bi.dispatchPack(base(), ["k#01", "k#02", "k#03", "k#04"], fp, 3))) === JSON.stringify([]),
		`pack fully-leased pin (got ${a2.join(",")})`);
	const a3 = slotIds(bais.dispatchPack(base(), [], fp, 0));
	check(JSON.stringify(a3) === JSON.stringify([]), `pack zero-budget pin`);
	const lone = [F("m#02", "Open", [], "b\nFiles: m02.ts"), F("m#01", "Open", [], "b\nFiles: m01.ts")];
	const a4 = slotIds(bais.dispatchPack(lone, [], new Map(), 2));
	const b4 = slotIds(bi.dispatchPack(lone, [], new Map(), 2));
	agree("pack tie-break", a4, b4);
	check(JSON.stringify(a4) === JSON.stringify(["m#01", "m#02"]), `pack id-ascending pin`);
	const leased = slotIds(bais.dispatchPack(base(), ["k#01"], new Map(), 3));
	check(!leased.includes("k#01") && JSON.stringify(leased) === JSON.stringify(["k#02", "k#03", "k#04"]) &&
		JSON.stringify(slotIds(bi.dispatchPack(base(), ["k#01"], new Map(), 3))) === JSON.stringify(leased),
		`pack leased-skip pin (got ${leased.join(",")})`);
}

// ---- §D-hub175 unknown-footprint mutual exclusion (M-bi4/bais4) ----
// hub#175: bodies WITHOUT a Files: line are unknown — two unknowns never
// share a swipe pack (first in slot order keeps it). A bare `Files:` line
// is declared touches-nothing and still packs freely. Warn shapes are
// pinned here against the scripts-lane canonical (briefs.mjs owns them);
// dispatch.mjs §13 pins the same shapes through the operator path.
{
	const slotIds = (slots) => slots.map((s) => s.issue_id);
	const briefs = await import(join(HERE, "briefs.mjs"));
	const two = () => [F("u#01"), F("u#02")]; // no Files: lines — both unknown
	const aa = slotIds(bais.dispatchPack(two(), [], new Map(), 2));
	const ab = slotIds(bi.dispatchPack(two(), [], new Map(), 2));
	agree("pack unknown-exclusion", aa, ab);
	check(JSON.stringify(aa) === JSON.stringify(["u#01"]), `pack first unknown keeps the slot (got ${aa.join(",")})`);
	const du = () => [F("d#01", "Open", [], "b\nFiles: alpha.ts"), F("u#01")];
	const da = slotIds(bais.dispatchPack(du(), [], new Map([["d#01", ["alpha.ts"]], ["u#01", []]]), 2));
	const db = slotIds(bi.dispatchPack(du(), [], new Map([["d#01", ["alpha.ts"]], ["u#01", []]]), 2));
	agree("pack declared+unknown", da, db);
	check(JSON.stringify(da) === JSON.stringify(["d#01", "u#01"]), `pack declared+unknown coexists (got ${da.join(",")})`);
	const bare = () => [F("e#01", "Open", [], "b\nFiles:"), F("e#02", "Open", [], "b\nFiles:")];
	const ea = slotIds(bais.dispatchPack(bare(), [], new Map(), 2));
	agree("pack declared-empty", ea, slotIds(bi.dispatchPack(bare(), [], new Map(), 2)));
	check(JSON.stringify(ea) === JSON.stringify(["e#01", "e#02"]), `pack bare Files: packs freely (got ${ea.join(",")})`);
	for (const [label, mod] of [["bais", bais], ["bi", bi]]) {
		check(mod.warnUnknownWithheld(["u#02"]) === briefs.warnUnknownWithheld(["u#02"]),
			`${label} withheld shape matches scripts canonical`);
		check(mod.warnUnknownShared("u#01", ["d#01"]) === briefs.warnUnknownShared("u#01", ["d#01"]),
			`${label} shared shape matches scripts canonical`);
		check(mod.isDeclaredFootprint("b\nFiles: alpha.ts") === true && mod.isDeclaredFootprint("b\nFiles:") === true &&
			mod.isDeclaredFootprint("no claim here") === false, `${label} declared test (bare Files: counts)`);
	}
}

// ---- §D-blocked dispatch never hands out blocked work (M-bi4/bais4, bi#37 Mode B) ----
// BAML spec: "dispatch skips leased and blocked issues" (main.baml:1785)
// plus "dangling Blocks edge keeps issue out of ready" (main.baml:170).
// The pack surface is where "ready" becomes assigned work — a blocked
// issue landing in a slot is silently ready. Cases are fixture data
// (fixtures/mirror/blocked-pack.mjs); every body declares a disjoint
// footprint so the hub#175 unknown-exclusion rule stays out of these pins.
{
	const { blockedPackCases } = await import(join(HERE, "fixtures", "mirror", "blocked-pack.mjs"));
	const slotIds = (slots) => slots.map((s) => s.issue_id);
	for (const c of blockedPackCases()) {
		const all = c.issues.map((s) => F(s.id, s.status, s.edges.map(([f, t, k]) => E(f, t, k)), s.body));
		const fp = new Map(c.fp);
		const a = slotIds(bais.dispatchPack(all, c.leased, fp, c.budget));
		const b = slotIds(bi.dispatchPack(all, c.leased, fp, c.budget));
		agree(`pack ${c.name}`, a, b);
		check(JSON.stringify(a) === JSON.stringify(c.want),
			`pack ${c.name} pin (got ${a.join(",")} want ${c.want.join(",")})`);
	}
}

// ---- §G dangling refs (M-bi5/bais5 <- dangling_edge_refs) ----
// BAML spec: "flags a local id that does not exist", "marks another project
// as External", "empty when both ends resolve", "reports both ends of a
// fully dangling edge", "an id with no scope is Missing, not External".
{
	const all = [
		F("g#01", "Open", [E("g#01", "g#ZZ", "Blocks"), E("g#01", "x#09", "Related"), E("g#01", "g#02", "Blocks")]),
		F("g#02", "Open", [E("ZZZ", "g#02", "Blocks"), E("nope", "g#02", "Related")]),
	];
	const key = (r) => `${r.id}|${r.side}|${r.status}`;
	const a = bais.danglingRefsIn(all, "g").map(key).sort();
	const b = bi.danglingRefsIn(all, "g").map(key).sort();
	agree("dangling", a, b);
	const want = ["ZZZ|from|Missing", "g#ZZ|to|Missing", "nope|from|Missing", "x#09|to|External"].sort();
	check(JSON.stringify(a) === JSON.stringify(want), `dangling pins (got ${a.join(",")})`);
	const clean = [F("h#01", "Open", [E("h#01", "h#02", "Blocks")]), F("h#02", "Done")];
	check(bais.danglingRefsIn(clean, "h").length === 0, `dangling empty when both ends resolve`);
}

// ---- §C cycles (M-bi6/bais6 <- cyclic_ids; M-bi7/bais7 <- precedes) ----
// BAML spec: "DependsOn cycle is flagged, not silently unready", "Blocks
// cycle is flagged where ready_issues only goes quiet", "acyclic chain has
// no cycle", "three-node cycle is flagged", "a node downstream of a cycle
// is reported with it", "a dangling predecessor is not reported as a
// cycle", "non-ordering edge kinds cannot form a cycle".
{
	const all = [
		F("f#01", "Open", [E("f#02", "f#01", "Blocks")]),
		F("f#02", "Open", [E("f#01", "f#02", "Blocks")]), // Blocks 2-cycle
		F("f#03", "Open", [E("f#03", "f#04", "DependsOn")]),
		F("f#04", "Open", [E("f#04", "f#03", "DependsOn")]), // DependsOn 2-cycle
		F("f#05", "Open", [E("f#05", "f#06", "DependsOn")]),
		F("f#06", "Done"), // acyclic chain
		F("f#07", "Open", [E("f#07", "f#08", "Related")]),
		F("f#08", "Open", [E("f#08", "f#07", "Related")]), // non-ordering: clean
		F("f#09", "Open", [E("f#ZZ", "f#09", "Blocks")]), // dangling predecessor: clean
	];
	const a = [...bais.cyclicIds(all)].sort();
	const b = [...bi.cyclicIssueIds(all)].sort();
	agree("cyclic", a, b);
	const want = ["f#01", "f#02", "f#03", "f#04"].sort();
	check(JSON.stringify(a) === JSON.stringify(want), `cyclic pins (got ${a.join(",")})`);
}

// ---- §I ids (M-bi8/bais8 <- id_project) ----
// bi's copy is module-private (bi/src/bais.ts:665) — unimportable — but §G
// already proves it agrees: the Missing/External split routes through
// idProject on both sides. Here the literal pins.
{
	check(bais.idProject("bi#04") === "bi" && bais.idProject("bagl#02") === "bagl" && bais.idProject("nohash") === "",
		`id_project pins`);
}

// ---- §W why-not (M-bais9 <- why_not; bais-only, literal pins) ----
// BAML spec: "why-not blocked-by names the blocker, its status, and the
// edge", "why-not is empty for ready issues", "dangling blocker names the
// end and Missing vs External", "in-cycle names the cycle alongside
// blocked-by", "silent for a DependsOn-only cycle", "leased names the
// holder and expiry", "skips non-Open issues".
{
	const all = [
		F("w#01", "Open", [E("w#02", "w#01", "Blocks")]),
		F("w#02", "Open"),
		F("w#03", "Open", [E("w#ZZ", "w#03", "Blocks")]),
		F("w#04", "Open"),
		F("w#05", "Open"), // ready: no reasons
		F("w#06", "Done"), // finished: skipped
		F("w#07", "Open", [E("w#07", "w#08", "DependsOn")]),
		F("w#08", "Open", [E("w#08", "w#07", "DependsOn")]), // DependsOn-only cycle: silent
	];
	const leases = [{ entity: "w#04", holder: "a1", expires_lc: null }];
	const R = bais.whyNotIn(all, "w", leases);
	const byId = new Map(R.map((r) => [r.id + "|" + r.kind, r]));
	const bb = byId.get("w#01|BlockedBy");
	check(bb?.blocker === "w#02" && bb?.blocker_status === "Open" && bb?.edge_from === "w#02" &&
		bb?.edge_to === "w#01" && bb?.edge_kind === "Blocks" && bb?.cycle === null && bb?.holder === null,
		`why-not BlockedBy names blocker+status+edge (got ${JSON.stringify(bb)})`);
	const dr = byId.get("w#03|DanglingRef");
	check(dr?.ref_id === "w#ZZ" && dr?.ref_side === "from" && dr?.ref_status === "Missing",
		`why-not DanglingRef names end+Missing (got ${JSON.stringify(dr)})`);
	const ls = byId.get("w#04|Leased");
	check(ls?.holder === "a1" && ls?.expires_lc === null, `why-not Leased names holder (got ${JSON.stringify(ls)})`);
	check(!R.some((r) => r.id === "w#05" || r.id === "w#06" || r.id === "w#07" || r.id === "w#08"),
		`why-not silent for ready/finished/DependsOn-cycle (got ${R.map((r) => r.id + "|" + r.kind).join(",")})`);
	// InCycle rides alongside BlockedBy on a Blocks cycle (BAML "in-cycle
	// names the cycle alongside blocked-by").
	const cyc = [
		F("z#01", "Open", [E("z#02", "z#01", "Blocks")]),
		F("z#02", "Open", [E("z#01", "z#02", "Blocks")]),
	];
	const Z = bais.whyNotIn(cyc, "z", []);
	const zk = Z.map((r) => `${r.id}|${r.kind}`).sort();
	check(JSON.stringify(zk) === JSON.stringify(["z#01|BlockedBy", "z#01|InCycle", "z#02|BlockedBy", "z#02|InCycle"]),
		`why-not cycle carries both reasons (got ${zk.join(",")})`);
	check(Z.find((r) => r.kind === "InCycle")?.cycle?.length === 2,
		`why-not InCycle names the leftover members`);
}

// ---- §V close evidence (M-bais10 — host-owned bi#83 policy, literal pins) ----
// No BAML source: Done-only gate, drill()/verdict() refs, External verdicts
// advisory-never-fatal. Companions: bi check-evidence.mjs (bi consumes,
// never reimplements) + drill-registry.mjs (live registry).
{
	const entries = [
		{ id: "v#01", status: "Done", body: "Evidence: drill(b)" },
		{ id: "v#02", status: "Done", body: "just prose, no refs" },
		{ id: "v#03", status: "Done", body: "Evidence: drill(nonexistent)" },
		{ id: "v#04", status: "Open", body: "just prose, no refs" }, // Open: no requirement
		{ id: "v#05", status: "Done", body: "Evidence: verdict(v#01)" },
		{ id: "v#06", status: "Done", body: "Evidence: verdict(x#09)" }, // cross-project: External, advisory
	];
	const P = bais.closeEvidenceIn(entries, "v", ["a", "b", "c", "d", "r"]);
	const key = (p) => `${p.id}|${p.reason}|${p.status}`;
	const got = P.map(key).sort();
	const want = ["v#02|missing-close-evidence|Missing", "v#03|unresolvable-drill|Missing", "v#06|unresolvable-verdict|External"].sort();
	check(JSON.stringify(got) === JSON.stringify(want), `close-evidence pins (got ${got.join(",")})`);
	check(bais.parseCloseEvidence("Evidence: drill(b) # comment\nprose Evidence: drill(x) never counts").length === 1,
		`parseCloseEvidence: prose never counts, trailing comments strip`);
}

// ---- §L claim predicates (M-c1 — host owns the clock; bi side pinned) ----
// bais/src/cli.ts carries verbatim-private copies (parseDuration/
// toLeaseIso/leaseExpired); bais side covered by claim.mjs + lease-race.mjs.
{
	check(bi.parseClaimDuration("30s") === 30000 && bi.parseClaimDuration("5m") === 300000 &&
		bi.parseClaimDuration("3h") === 10800000 && bi.parseClaimDuration("2d") === 172800000 &&
		bi.parseClaimDuration("4h ") === null && bi.parseClaimDuration("") === null,
		`claim duration grammar pins`);
	check(bi.toLeaseIso(Date.parse("2026-09-06T12:00:00.123Z")) === "2026-09-06T12:00:00Z",
		`lease ISO is millis-stripped (BAML 20-char shape)`);
	const at = Date.parse("2026-09-06T12:00:00Z");
	check(bi.leaseExpiredMs(null, at) === true && bi.leaseExpiredMs("not-a-date", at) === true &&
		bi.leaseExpiredMs("2026-09-06T12:00:00Z", at) === true && bi.leaseExpiredMs("2099-01-01T00:00:00Z", at) === false,
		`lease expiry edges (null/unparseable/at-or-past = expired)`);
}

// ---- §S scanned blockers (A3 — the /issues fast path re-applies Blocks) ----
{
	const scan = bi.scanBaisHeaders(undefined); // live hub: agreement shape only
	check(Array.isArray(scan.headers) && Array.isArray(scan.edges), `scanBaisHeaders shape`);
	const all = [
		F("s#01", "Open", [E("s#02", "s#01", "Blocks")]),
		F("s#02", "Done"),
		F("s#03", "Open", [E("s#ZZ", "s#03", "Blocks")]),
		F("s#04", "Open", [E("s#05", "s#04", "Blocks")]),
		F("s#05", "Open"),
		F("s#06", "Open", [E("s#07", "s#06", "Blocks")]),
		F("s#07", "Dropped"),
		F("s#08", "Open", [E("s#ZZ", "s#08", "DependsOn")]),
	];
	const fake = { headers: all.map((f) => ({ id: f.issue.id, status: f.issue.status })), edges: all.flatMap((f) => f.edges) };
	const byId = new Map(fake.headers.map((h) => [h.id, h]));
	check(JSON.stringify(bi.scannedBlockers("s#01", fake, byId)) === JSON.stringify([]),
		`scannedBlockers: Done blocker frees`);
	check(JSON.stringify(bi.scannedBlockers("s#03", fake, byId)) === JSON.stringify(["s#ZZ"]),
		`scannedBlockers: unresolvable blocker blocks (never silently ready)`);
	check(JSON.stringify(bi.scannedBlockers("s#04", fake, byId)) === JSON.stringify(["s#05"]),
		`scannedBlockers: Open blocker blocks`);
	check(JSON.stringify(bi.scannedBlockers("s#06", fake, byId)) === JSON.stringify([]),
		`scannedBlockers: Dropped blocker frees`);
	check(JSON.stringify(bi.scannedBlockers("s#08", fake, byId)) === JSON.stringify([]),
		`scannedBlockers: DependsOn never blocks, even dangling`);
}

if (failures) {
	console.error(`mirror-parity: ${failures} failure(s) — land rule changes in BAML first, then mirror them in BOTH hosts`);
	process.exit(1);
}
console.log("mirror-parity: all green (bi vs bais agree, BAML-spec pins hold)");

