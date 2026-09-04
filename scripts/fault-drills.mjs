// bais/scripts/fault-drills.mjs — offline fault-injection drills (bi#36).
//
// Run from the repo root: node bais/scripts/fault-drills.mjs
// Exits non-zero on any failure. Fully in-process: node:sqlite + direct
// imports from bais/dist/src/*.js, plain `node`, no sockets, no loopback,
// no child processes. All state lives under mkdtemp dirs — real .bais
// dirs are never touched. BAML owns admission/verification policy; this
// script only executes attacks.
//
// Drills:
//  (a) corrupt a COPY of store.db (bit-flip / truncate) and confirm reads
//      fall back to the directory scan instead of serving lies.
//  (b) deliver the same event twice / ingest twice and confirm idempotent
//      projections.
//  (c) prune then re-sync a new peer in-process and confirm convergence.
//      (sync-test.mjs notes localhost-IPC steps stall in sandboxes; this
//      variant mirrors `bais sync --from` step-for-step via store/hub
//      imports, with peer reads done as direct DB reads — no sockets.)

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, appendForeignEvents, publishCheckpoint, pruneBelowCheckpoint } from "../dist/src/hub.js";
import {
	ingestIssues, storeList, hasStore, dbPathFor,
	exportSnapshot, importSnapshot, recordImportedAnchor,
	readBootstrap, markBootstrapComplete,
} from "../dist/src/store.js";
import { loadIssues } from "../dist/src/graph.js";
void createHub; // imported to pin the hub surface; drills use hub.js pure
// functions only (createHub binds a port — a socket — so it is NOT used).

let failures = 0;
const drillFailures = { a: 0, b: 0, c: 0 };
let drill = "?";
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		drillFailures[drill]++;
		console.error(`FAIL [${drill}]: ${msg}`);
	} else console.log(`ok [${drill}]: ${msg}`);
};
process.on("unhandledRejection", (e) => { failures++; console.error(`FAIL [${drill}]: UNHANDLED REJECTION: ${(e && e.message) || e}`); });
process.on("uncaughtException", (e) => { failures++; console.error(`FAIL [${drill}]: UNCAUGHT: ${(e && e.message) || e}`); process.exit(1); });

const toml = (id, title) => `id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "Feat"\nbody = "fault-drill fixture"\n`;
const canonTasks = (issuesDir) => JSON.stringify(storeList(issuesDir).tasks);
const mkTree = (tag) => {
	const root = mkdtempSync(join(tmpdir(), `bais-fault-${tag}-`));
	const issues = join(root, ".bais", "issues");
	mkdirSync(issues, { recursive: true });
	return { root, issues };
};

// ---------------------------------------------------------------- (a)
drill = "a";
{
	const src = mkTree("a-src");
	writeFileSync(join(src.issues, "t1.toml"), toml("t1", "alpha-title-here"));
	writeFileSync(join(src.issues, "t2.toml"), toml("t2", "beta"));
	const ing = await ingestIssues(src.issues);
	check(ing.events > 0, `ingested fixture store (${ing.events} events)`);
	const baseline = canonTasks(src.issues);
	const pristine = readFileSync(dbPathFor(src.issues));

	// Corrupt a COPY: same TOML files + a copy of store.db in a sibling
	// tmp tree. The pristine original is never written to.
	const cpy = mkTree("a-copy");
	cpSync(src.issues, cpy.issues, { recursive: true });
	const copyDb = dbPathFor(cpy.issues);
	copyFileSync(join(src.root, ".bais", "store.db"), copyDb);
	const restore = () => copyFileSync(join(src.root, ".bais", "store.db"), copyDb);
	check(readFileSync(copyDb).equals(pristine), "copy starts identical to pristine store.db");

	// A1: bit-flip in the file magic — must fail closed (throw), never read.
	{
		const b = Buffer.from(pristine);
		b[0] ^= 0xff;
		writeFileSync(copyDb, b);
		let threw = null;
		try { storeList(cpy.issues); } catch (e) { threw = e; }
		check(!!threw, `header bit-flip fails closed (threw: ${(threw?.message ?? "").slice(0, 60)})`);
		if (!threw) {
			const r = canonTasks(cpy.issues);
			check(r !== baseline, "P0 SILENT-LIE: smashed header still serves baseline data as truth");
		}
		restore();
	}

	// A2: truncate to half — must fail closed (throw), never read.
	{
		writeFileSync(copyDb, pristine.subarray(0, Math.floor(pristine.length / 2)));
		let threw = null;
		try { storeList(cpy.issues); } catch (e) { threw = e; }
		check(!!threw, `half-truncate fails closed (threw: ${(threw?.message ?? "").slice(0, 60)})`);
		if (!threw) check(canonTasks(cpy.issues) !== baseline, "P0 SILENT-LIE: truncated store serves altered data as truth");
		restore();
	}

	// A3: truncate to zero — SQLite treats it as an empty DB and the schema
	// is recreated, so reads RETURN (empty, lc:0, partial). Assert it does
	// not masquerade as synced truth; the fail-open below is a finding.
	{
		writeFileSync(copyDb, Buffer.alloc(0));
		let r = null, threw = null;
		try { r = storeList(cpy.issues); } catch (e) { threw = e; }
		check(!threw && r.tasks.length === 0 && r.as_of.lc === 0 && r.completeness !== "complete",
			`zero-truncate serves honest empty (lc:0, ${r?.completeness ?? threw?.message}) — not synced truth`);
		if (hasStore(cpy.issues)) {
			console.log(`warn [a]: hasStore() is existence-only, so a 0-byte store.db counts as "present" and the CLI store path serves confident empty instead of falling back to the scan (fail-open note, not P0 — as_of.lc:0 distinguishes it)`);
		}
		restore();
	}

	// A4: single-bit sweep across the whole copy — every flip must throw or
	// leave reads identical. A confident altered read is a P0 silent lie.
	{
		let threw = 0, same = 0;
		const lies = [];
		for (let off = 100; off < pristine.length; off += 409) {
			for (const bit of [0, 5]) {
				const b = Buffer.from(pristine);
				b[off] ^= (1 << bit);
				writeFileSync(copyDb, b);
				try {
					const r = canonTasks(cpy.issues);
					if (r === baseline) same++;
					else if (lies.length < 5) lies.push({ off, bit, got: r.slice(0, 160) });
				} catch { threw++; }
			}
		}
		restore();
		check(canonTasks(cpy.issues) === baseline, "copy restored to pristine after sweep");
		console.log(`info [a]: sweep ${threw} threw / ${same} identical / ${lies.length} silent-diff (sampled ${Math.ceil((pristine.length - 100) / 409) * 2} flips)`);
		for (const l of lies) console.error(`P0-detail [a]: silent lie at offset ${l.off} bit ${l.bit} (completeness still "complete", hasStore still true): ${l.got}`);
		check(lies.length === 0, lies.length ? `P0 SILENT-LIE: ${lies.length} sampled bit-flip(s) serve altered projections with completeness "complete" (e.g. offset ${lies[0].off})` : "no sampled bit-flip serves altered data");
	}

	// Fallback: with the store file gone, the directory scan serves truth
	// (mirrors the CLI useStore=false path).
	rmSync(copyDb);
	check(!hasStore(cpy.issues), "store absent after removing corrupt copy");
	const scan = await loadIssues(cpy.issues);
	const scanIds = scan.issues.map((f) => f.issue.id).sort().join(",");
	check(scan.failures.length === 0 && scanIds === "t1,t2", `directory scan serves truth without the store (${scanIds})`);
}

// ---------------------------------------------------------------- (b)
drill = "b";
{
	const t = mkTree("b-idem");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	const first = await ingestIssues(t.issues);
	const tasks1 = canonTasks(t.issues);
	const second = await ingestIssues(t.issues);
	check(second.events === first.events, `re-ingest replays same event count (${second.events})`);
	check(canonTasks(t.issues) === tasks1, "ingest twice: projections identical (idempotent rebuild)");

	// Same foreign event delivered twice, in-process via appendForeignEvents
	// (the POST /sync handler shares this function — no sockets here).
	const proj = "drill-b";
	const mkDup = (lc) => ({
		id: "drill:dup:1", author: "did:key:drill-dup", seq: 0, prev: null,
		project: proj, entity: "t-dup", refs: [], lc, ts: new Date().toISOString(),
		type: "TaskCreate", body: { title: "dup", kind: "Feat", body: "x" },
		sig: null, admitted: true, drop_reason: null,
	});
	const d1 = await appendForeignEvents(t.issues, [mkDup(9000)]);
	check(d1.accepted.includes("drill:dup:1") && d1.rejected.length === 0, "first delivery accepted");
	check(canonTasks(t.issues).includes("t-dup"), "first delivery projects the new task");
	const afterFirst = canonTasks(t.issues);
	const d2 = await appendForeignEvents(t.issues, [mkDup(9000)]);
	check(d2.accepted.length === 0 && d2.rejected.length === 0, "repeat delivery is a silent skip (neither accepted nor rejected)");
	check(canonTasks(t.issues) === afterFirst, "repeat delivery: projections unchanged (idempotent)");

	// Same event twice inside ONE batch — the staged-set dedupes. (Fresh
	// author: same author+seq under a new id would be a fork, not a dup.)
	const mkDup2 = () => ({ ...mkDup(9001), id: "drill:dup:2", author: "did:key:drill-dup2", entity: "t-dup2" });
	const ev2 = mkDup2();
	const d3 = await appendForeignEvents(t.issues, [ev2, { ...ev2 }]);
	check(d3.accepted.filter((id) => id === "drill:dup:2").length === 1, "in-batch duplicate admitted exactly once");
	const ids = storeList(t.issues).tasks.filter((x) => x.entity === "t-dup2");
	check(ids.length === 1, "in-batch duplicate projects exactly one row");
}

// ---------------------------------------------------------------- (c)
drill = "c";
{
	// Peer A: fixtures -> ingest -> checkpoint -> prune (all in-process).
	const A = mkTree("c-a");
	writeFileSync(join(A.issues, "t1.toml"), toml("t1", "alpha"));
	writeFileSync(join(A.issues, "t2.toml"), toml("t2", "beta"));
	await ingestIssues(A.issues);
	const cp = await publishCheckpoint(A.issues);
	check(!!cp.id && cp.state_root.length === 64, `checkpoint published (${cp.id})`);
	const before = new DatabaseSync(resolve(A.root, ".bais", "store.db"));
	const nBefore = before.prepare("SELECT COUNT(*) AS n FROM events").get().n;
	before.close();
	const prune = await pruneBelowCheckpoint(A.issues);
	check(prune.pruned > 0 && prune.anchor.checkpoint === cp.id, `pruned ${prune.pruned} covered rows, anchor on checkpoint`);
	check(canonTasks(A.issues).includes("t1") && canonTasks(A.issues).includes("t2"), "pruned hub still serves intact tables");

	// Peer B: fresh tmp tree. Mirror `bais sync --from` without the socket:
	// snapshot import (+ anchor state, as GET /snapshot serves it) ->
	// delta of surviving rows (as GET /sync?since_lc would) -> signature
	// trust (covered log is gone by operator action) -> unlock -> converge.
	const B = mkTree("c-b");
	const snapBase = exportSnapshot(A.issues);
	check(!!snapBase.checkpoint && !!snapBase.anchor, "snapshot carries checkpoint + prune anchor");
	const adb = new DatabaseSync(resolve(A.root, ".bais", "store.db"));
	const anchorState = JSON.parse(adb.prepare("SELECT v FROM meta WHERE k = 'anchor_reduction'").get().v);
	const floors = JSON.parse(adb.prepare("SELECT v FROM meta WHERE k = 'author_cursors'").get().v);
	const rows = adb.prepare("SELECT * FROM events ORDER BY lc, id").all();
	adb.close();
	const cursors = Object.entries(floors).map(([author, c]) => ({ author, seq: c.seq, id: c.id }));
	const toWire = (r) => ({
		id: r.id, author: r.author, seq: r.seq, prev: r.prev, project: r.project,
		entity: r.entity, refs: JSON.parse(r.refs), lc: r.lc, ts: r.ts, type: r.type,
		body: JSON.parse(r.body), sig: r.sig ?? null, admitted: r.admitted === 1, drop_reason: r.drop_reason,
	});
	importSnapshot(B.issues, { ...snapBase, anchor_state: anchorState, cursors }, "in-process");
	recordImportedAnchor(B.issues, snapBase.anchor, anchorState, cursors);
	const coveredHeads = new Set(snapBase.checkpoint.heads);
	const surviving = rows.map(toWire).filter((e) => e.lc > snapBase.checkpoint.lc);
	check(surviving.some((e) => e.id === snapBase.checkpoint.id), "surviving delta carries the anchor checkpoint event");
	check(!rows.map(toWire).some((e) => e.lc <= snapBase.checkpoint.lc && !coveredHeads.has(e.id)), "no covered head missing by construction");
	const td = await appendForeignEvents(B.issues, surviving, { mode: "delta", anchorHeads: snapBase.checkpoint.heads });
	check(td.accepted.includes(snapBase.checkpoint.id), "anchor checkpoint event accepted (signature trust)");
	markBootstrapComplete(B.issues, "signature");
	const boot = readBootstrap(B.issues);
	check(boot?.complete === true && boot?.trust === "signature", "bootstrap meta records signature trust + unlock");

	// Convergence: same materialized tasks as the pruned source.
	const aTasks = canonTasks(A.issues);
	const bTasks = canonTasks(B.issues);
	check(aTasks === bTasks && bTasks.includes("t1") && bTasks.includes("t2"), "pruned-then-resynced peer converged on tasks");

	// Post-bootstrap write path stays open (fresh author chains on).
	const w = await appendForeignEvents(B.issues, [{
		id: "drill:c:1", author: "did:key:drill-c", seq: 0, prev: null,
		project: "drill-c",
		entity: "t-new", refs: [], lc: 9500, ts: new Date().toISOString(),
		type: "TaskCreate", body: { title: "new", kind: "Feat", body: "x" },
		sig: null, admitted: true, drop_reason: null,
	}], { mode: "delta" });
	check(w.accepted.includes("drill:c:1"), "bootstrapped peer accepts new writes");
}

// ---------------------------------------------------------------- summary
const verdict = (k) => (drillFailures[k] ? "FAIL" : "PASS");
console.log(`drill (a) corruption-fallback: ${verdict("a")}`);
console.log(`drill (b) idempotence: ${verdict("b")}`);
console.log(`drill (c) prune-resync convergence: ${verdict("c")}`);
console.log("loopback needed: NO — all drills fully in-process (node:sqlite + dist imports); no sockets opened, no child processes spawned.");
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("fault drills: all green");
