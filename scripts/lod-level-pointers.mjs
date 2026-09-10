// bais/scripts/lod-level-pointers.mjs — hub#236 drill: Files: lines point
// at LOD levels, not whole files.
//
// Fixture board pins: level claims parse (`path#L0|#L1|#L2`, bare = whole
// file, comments still strip, bare-path behavior byte-identical);
// clash-check narrows (same-file different-level = no clash, overlapping
// = clash) through dispatchPack AND the `dispatch` CLI surface; unknown /
// unindexed levels warn naming the file and fall back to whole-file
// (never silent, never fail-closed); the Doing-claim gate still reads a
// level-pointer body as a declared footprint.
//
// Run: node bais/scripts/lod-level-pointers.mjs (offline, tmpdir hubs
// only, read-only against the live hubs — imports built graph.js, so
// rebuild bais first if src moved).
//
// Red-check (bi#57, observed live 2026-09-10) — each safety net names its
// FAIL reason; a net that cannot go red is camouflage:
//   narrow-clash: claimsOverlap's level arm (`la == "" || ...` -> `true`,
//     i.e. base-only whole-file semantics). Rebuild, probe ->
//     FAIL lvl.pack-narrows (got v#01), FAIL lvl.noclash-diff-level,
//     FAIL lvl.cli-pack-narrows (got v#01); parity §L 2 FAIL
//     (overlap narrows, dispatch seats disjoint sketches). Drill: 3
//     failure(s), 23 pass. Restored cmp-identical -> 26 green.
//     (A bare-equality neuter instead trips only lvl.clash-whole-vs-level —
//     weaker tripwire, recorded but not relied on.)
//   fallback-warn: unresolvedLevelFiles' push guard (`false && ...` ->
//     always []). Rebuild, probe -> FAIL lvl.warn-names-file,
//     FAIL lvl.fallback-unknown-level, while the resolve pins still pass
//     (the silent-fallback camouflage this net exists to catch). Drill: 2
//     failure(s), 24 pass. Restored cmp-identical -> 26 green.
//   BAML-side: claims_overlap's level arm (`la == ...` -> `true`) ->
//     baml test FAIL root::files_clash narrows... + FAIL root::dispatch
//     packs same-file... (267 passed, 2 failed). Restored -> 269 green.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const graph = await import(join(HERE, "..", "dist", "src", "graph.js"));
const CLI = join(HERE, "..", "dist", "src", "cli.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`ok: ${name}`); }
	else { fail++; console.log(`FAIL: ${name} ${extra}`); }
};
const J = (v) => JSON.stringify(v);

// ---- §1 parse: level pointers kept, comments strip, bare identical ----
{
	check("parse.lvl-three", J(graph.parseFileClaims("Files: a.ts#L0 b.ts#L1 c.ts#L2 d.ts")) === J(["a.ts#L0", "b.ts#L1", "c.ts#L2", "d.ts"]));
	check("parse.lvl-lower", J(graph.parseFileClaims("Files: a.ts#l1")) === J(["a.ts#l1"]));
	check("parse.lvl-trailing-comment", J(graph.parseFileClaims("Files: a.ts#L1 # note")) === J(["a.ts#L1"]));
	check("parse.lvl-mixed", J(graph.parseFileClaims("Files: a.ts#L1 b.ts # note")) === J(["a.ts#L1", "b.ts"]));
	check("parse.lvl-unknown-kept", J(graph.parseFileClaims("Files: a.ts#L9")) === J(["a.ts#L9"]));
	check("parse.lvl-nonlevel-is-comment", J(graph.parseFileClaims("Files: a.ts#frag c.ts")) === J(["a.ts"]));
	check("parse.lvl-bare-identical",
		J(graph.parseFileClaims("b\nFiles: a.ts b.ts # shared\nnotes\nFiles: b.ts c.ts\nFiles:   # empty claim")) === J(["a.ts", "b.ts", "c.ts"]));
	check("parse.lvl-split", graph.claimBase("a.ts#L1") === "a.ts" && graph.claimLevel("a.ts#L1") === "L1" &&
		graph.claimLevel("a.ts#l2") === "L2" && graph.claimLevel("a.ts#L9") === "L9" &&
		graph.claimLevel("a.ts") === "" && graph.claimBase("a.ts") === "a.ts");
	check("parse.lvl-known", graph.knownFileLevel("L0") && graph.knownFileLevel("L2") && !graph.knownFileLevel("L9") && !graph.knownFileLevel(""));
}

// ---- §2 clash: narrower-or-equal through dispatchPack ----
{
	const F = (id, body) => ({
		issue: { id, title: `${id} t`, status: "Open", kind: "Feat", area: null, severity: null, source: null, body },
		edges: [], holder: null, lease: null,
	});
	const slotIds = (slots) => slots.map((s) => s.issue_id);
	// Same-file different-level issues seat together (finer granularity,
	// fewer false conflicts); a third issue sharing one's level is held out.
	const trio = [
		F("v#01", "b\nFiles: store.ts#L0"),
		F("v#02", "b\nFiles: store.ts#L1"),
		F("v#03", "b\nFiles: store.ts#L1"),
	];
	const fp = new Map([["v#01", ["store.ts#L0"]], ["v#02", ["store.ts#L1"]], ["v#03", ["store.ts#L1"]]]);
	const got = slotIds(graph.dispatchPack(trio, [], fp, 3));
	check("lvl.pack-narrows", J(got) === J(["v#01", "v#02"]), `got ${got.join(",")}`);
	// Overlapping: whole-file vs level clashes; same level clashes.
	const clash = (a, b) => {
		// Declared bodies (Files: lines): the fp map drives clash, bodies
		// only drive the hub#175 unknown-exclusion — bare "b" bodies would
		// withhold the second slot regardless of clash.
		const all = [F("w#01", "b\nFiles: x.ts"), F("w#02", "b\nFiles: y.ts")];
		const m = new Map([["w#01", [a]], ["w#02", [b]]]);
		return graph.dispatchPack(all, [], m, 2).length === 1;
	};
	check("lvl.clash-whole-vs-level", clash("store.ts", "store.ts#L0"));
	check("lvl.clash-same-level", clash("store.ts#L1", "store.ts#L1"));
	check("lvl.clash-bare", clash("store.ts", "store.ts"));
	check("lvl.noclash-diff-level", !clash("store.ts#L0", "store.ts#L2"));
	check("lvl.noclash-diff-file", !clash("store.ts#L0", "other.ts#L0"));
	// Claim gate: a level-pointer body is a declared footprint.
	check("lvl.declared", graph.isDeclaredFootprint("b\nFiles: store.ts#L1") === true);
}

// ---- §3 fallback: warn naming the file, serve whole-file ----
{
	const indexed = ["store.ts"];
	check("lvl.resolve-narrow",
		J(graph.resolveFileClaims(["store.ts#L0", "store.ts#L1"], indexed)) === J(["store.ts#L0", "store.ts#L1"]));
	check("lvl.resolve-clean", J(graph.unresolvedLevelFiles(["store.ts#L0"], indexed)) === J([]));
	check("lvl.fallback-unindexed",
		J(graph.resolveFileClaims(["fresh.ts#L0"], indexed)) === J(["fresh.ts"]));
	check("lvl.warn-names-file",
		J(graph.unresolvedLevelFiles(["fresh.ts#L0", "fresh.ts#L1"], indexed)) === J(["fresh.ts"]));
	check("lvl.fallback-unknown-level",
		J(graph.resolveFileClaims(["store.ts#L9"], indexed)) === J(["store.ts"]) &&
		J(graph.unresolvedLevelFiles(["store.ts#L9"], indexed)) === J(["store.ts"]));
	check("lvl.nowarn-whole",
		J(graph.unresolvedLevelFiles(["store.ts", "fresh.ts"], indexed)) === J([]));
	check("lvl.warn-shape",
		graph.warnLevelFallback(["fresh.ts"]) === "[bais] level pointer with no built index fall back to whole-file: fresh.ts (rebuild BAGL levels for the file, or drop the #Ln suffix)");
	check("lvl.warn-shape-plural",
		graph.warnLevelFallback(["a.ts", "b.ts"]) === "[bais] level pointers with no built index fall back to whole-file: a.ts, b.ts (rebuild BAGL levels for the file, or drop the #Ln suffix)");
}

// ---- §4 CLI: dispatch seats same-file different-level issues ----
{
	const d = mkdtempSync(join(tmpdir(), "lod-lvl-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "v"\n');
	const issue = (id, files) =>
		`id = "${id}"\ntitle = "${id} t"\nstatus = "Open"\nkind = "Feat"\nbody = """\nb\nFiles: ${files}\n"""\n`;
	writeFileSync(join(d, ".bais", "issues", "v#01.toml"), issue("v#01", "store.ts#L0"));
	writeFileSync(join(d, ".bais", "issues", "v#02.toml"), issue("v#02", "store.ts#L1"));
	writeFileSync(join(d, ".bais", "issues", "v#03.toml"), issue("v#03", "store.ts#L1"));
	let packed = [];
	try {
		const out = execFileSync("node", [CLI, "dispatch", "--agents", "3", "--json"], { cwd: d, encoding: "utf8", timeout: 60000 });
		packed = JSON.parse(out).slots.map((s) => s.issue.id);
	} catch (e) {
		packed = [`ERROR:${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(0, 200)];
	}
	check("lvl.cli-pack-narrows", J(packed) === J(["v#01", "v#02"]), `got ${packed.join(",")}`);
	// Doing-claim gate: a level-pointer footprint is declared, not refused.
	try {
		execFileSync("node", [CLI, "move", "v#01", "Doing", "--as", "lane-t-probe", "--for", "5m"], { cwd: d, encoding: "utf8", timeout: 60000 });
		check("lvl.cli-claim-declared", true);
	} catch (e) {
		check("lvl.cli-claim-declared", false, String((e.stdout ?? "") + (e.stderr ?? "")).slice(0, 200));
	}
}

if (fail > 0) { console.log(`lod-level-pointers: ${fail} failure(s), ${pass} pass`); process.exit(1); }
console.log(`lod-level-pointers: ${pass} green`);
