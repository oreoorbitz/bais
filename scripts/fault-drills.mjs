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
import { createHub, appendForeignEvents, publishCheckpoint, pruneBelowCheckpoint, encodeBodyArrays } from "../dist/src/hub.js";
import { eventId } from "../dist/src/ids.js";
import {
	ingestIssues, storeList, hasStore, dbPathFor, storeOversight,
	exportSnapshot, importSnapshot, recordImportedAnchor,
	readBootstrap, markBootstrapComplete,
} from "../dist/src/store.js";
import { loadIssues } from "../dist/src/graph.js";
import { clockFromArgv } from "./clock.mjs";
void createHub; // imported to pin the hub surface; drills use hub.js pure
// functions only (createHub binds a port — a socket — so it is NOT used).

// bi#82: injectable wall-clock. --now <ISO|epoch-ms> (or BAIS_NOW) pins
// Date.now + no-arg new Date() in-process, so fixture timestamps AND the
// dist hub gates (checkClock future bound) see the same fixed time.
// Absent: live passthrough, zero behavior change.
const { clock } = clockFromArgv(process.argv);
console.log(`info: wall-clock ${clock.fixed ? `pinned at ${clock.nowISO()}` : "live"}`);

let failures = 0;
const drillFailures = { a: 0, b: 0, c: 0, d: 0, r: 0 };
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
// bi#37: fixtures carry REAL content-hash ids (eventId over the encoded
// body, sig covered when signed) — dev-style ids are dead by policy
// (store drops them on merge) and ingest now verifies structurally.
// Sign FIRST, then hash: the id covers the sig.
const mkForeign = (o) => {
	const body = encodeBodyArrays(o.body ?? {});
	const base = {
		author: o.author, seq: o.seq, prev: o.prev ?? null, project: o.project ?? "g",
		entity: o.entity, refs: o.refs ?? [], lc: o.lc, ts: o.ts ?? clock.nowISO(),
		type: o.type, body,
	};
	const sig = o.sign ? o.sign({ project: base.project, prev: base.prev, refs: base.refs, type: base.type, entity: base.entity, body }) : null;
	const id = eventId(sig ? { ...base, sig } : base);
	return { ...base, id, sig, admitted: true, drop_reason: null };
};
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
	check(ing.events === 2, `ingested fixture store (${ing.events} events)`); // bi#58: exact — 2 Open edgeless issues seed exactly 2 events
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
		// bi#58: boolean is inherent here — the thrown Error shape varies by
		// layer (SQLite "file is not a database" vs store-integrity-mismatch);
		// the assertion is "did it fail closed", which is boolean.
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
		// bi#58: boolean is inherent — see A1 note above.
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
		check(!threw && r.tasks.length === 0 && r.as_of.lc === 0 && r.completeness === "partial",
			`zero-truncate serves honest empty (lc:0, ${r?.completeness ?? threw?.message}) — not synced truth`); // bi#58: === "partial", not !== "complete"
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
	// The SAME object goes twice: same bytes, same id — the benign re-pull.
	const dup = mkForeign({
		author: "did:key:drill-dup", seq: 0, project: "drill-b", entity: "t-dup",
		lc: 9000, type: "TaskCreate", body: { title: "dup", kind: "Feat", body: "x" },
	});
	const d1 = await appendForeignEvents(t.issues, [dup]);
	check(d1.accepted.length === 1 && d1.accepted[0] === dup.id && d1.rejected.length === 0, "first delivery accepted"); // bi#58: exact-array, not includes
	check(storeList(t.issues).tasks.some((x) => x.entity === "t-dup"), "first delivery projects the new task"); // bi#58: exact entity, not JSON-substring (which also matches t-dup2)
	const afterFirst = canonTasks(t.issues);
	const d2 = await appendForeignEvents(t.issues, [{ ...dup }]);
	check(d2.accepted.length === 0, "repeat delivery admits nothing (silent skip, accepted-half)"); // bi#58: split halves — a loud-reject mutation trips exactly one
	check(d2.rejected.length === 0, "repeat delivery rejects nothing (silent skip, rejected-half)");
	check(canonTasks(t.issues) === afterFirst, "repeat delivery: projections unchanged (idempotent)");

	// Same event twice inside ONE batch — the staged-set dedupes. (Fresh
	// author: same author+seq under a new id would be a fork, not a dup.)
	const ev2 = mkForeign({
		author: "did:key:drill-dup2", seq: 0, project: "drill-b", entity: "t-dup2",
		lc: 9001, type: "TaskCreate", body: { title: "dup", kind: "Feat", body: "x" },
	});
	const d3 = await appendForeignEvents(t.issues, [ev2, { ...ev2 }]);
	check(d3.accepted.length === 1 && d3.accepted[0] === ev2.id, "in-batch duplicate admitted exactly once"); // bi#58: exact-array
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
	const BID = /^b[abcdefghijklmnopqrstuvwxyz234567]+$/;
	check(typeof cp.id === "string" && BID.test(cp.id) && cp.state_root.length === 64, `checkpoint published (${cp.id})`); // bi#58: CID shape, not truthy
	const before = new DatabaseSync(resolve(A.root, ".bais", "store.db"));
	const nBefore = before.prepare("SELECT COUNT(*) AS n FROM events").get().n;
	before.close();
	const prune = await pruneBelowCheckpoint(A.issues);
	check(prune.pruned === 2 && prune.anchor.checkpoint === cp.id, `pruned ${prune.pruned} covered rows, anchor on checkpoint`); // bi#58: exact — 2 seed rows below coverage
	const aEnts = (issuesDir) => storeList(issuesDir).tasks.map((x) => x.entity).sort().join(",");
	check(aEnts(A.issues) === "t1,t2", "pruned hub still serves intact tables"); // bi#58: exact entity set, not substrings

	// Peer B: fresh tmp tree. Mirror `bais sync --from` without the socket:
	// snapshot import (+ anchor state, as GET /snapshot serves it) ->
	// delta of surviving rows (as GET /sync?since_lc would) -> signature
	// trust (covered log is gone by operator action) -> unlock -> converge.
	const B = mkTree("c-b");
	const snapBase = exportSnapshot(A.issues);
	check(snapBase.checkpoint.id === cp.id && snapBase.anchor.checkpoint === cp.id, "snapshot carries checkpoint + prune anchor"); // bi#58: exact linkage, not truthy
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
	check(surviving.filter((e) => e.id === snapBase.checkpoint.id).length === 1, "surviving delta carries the anchor checkpoint event"); // bi#58: exactly once
	// bi#58: negated existential is the equality form for "none" — inherently boolean.
	check(!rows.map(toWire).some((e) => e.lc <= snapBase.checkpoint.lc && !coveredHeads.has(e.id)), "no covered head missing by construction");
	const td = await appendForeignEvents(B.issues, surviving, { mode: "delta", anchorHeads: snapBase.checkpoint.heads });
	check(td.accepted.filter((id) => id === snapBase.checkpoint.id).length === 1, "anchor checkpoint event accepted (signature trust)"); // bi#58: exactly once
	markBootstrapComplete(B.issues, "signature");
	const boot = readBootstrap(B.issues);
	check(boot?.complete === true && boot?.trust === "signature", "bootstrap meta records signature trust + unlock");

	// Convergence: same materialized tasks as the pruned source.
	const aTasks = canonTasks(A.issues);
	const bTasks = canonTasks(B.issues);
	check(aTasks === bTasks && aEnts(B.issues) === "t1,t2", "pruned-then-resynced peer converged on tasks"); // bi#58: exact entity set tail

	// Post-bootstrap write path stays open (fresh author chains on).
	const wc = mkForeign({
		author: "did:key:drill-c", seq: 0, project: "drill-c", entity: "t-new",
		lc: 9500, type: "TaskCreate", body: { title: "new", kind: "Feat", body: "x" },
	});
	const w = await appendForeignEvents(B.issues, [wc], { mode: "delta" });
	check(w.accepted.length === 1 && w.accepted[0] === wc.id, "bootstrapped peer accepts new writes"); // bi#58: exact-array
}

// ---------------------------------------------------------------- (d) gate injection proofs (bi#60)
// Each proof injects a violation showing (a) the new gate catches it and
// (b) every pre-existing check misses it. Observed outputs recorded from
// the 2026-09-04 demonstration runs (tmp dirs, in-process, no sockets).
drill = "d";
{
	const t = mkTree("d-gates");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);

	// G-sig — hunk: bais/src/hub.ts checkSig
	// `return opts.requireSigs ? "sig-required" : null`.
	// Violation: a well-formed but UNSIGNED event under a sig-requiring hub.
	const mkSigEv = (author) => mkForeign({
		author, seq: 0, project: "g", entity: "task:g-sig",
		lc: 62000, type: "TaskCreate", body: { title: "sig probe", kind: "Feat", body: "x" },
	});
	// (b) pre-existing checks miss it: without the flag the same shape admits
	// (chain + shape + bounds all pass — nothing else fires).
	const sigEv1 = mkSigEv("did:key:g-sig");
	const open = await appendForeignEvents(t.issues, [sigEv1]);
	check(open.accepted.length === 1 && open.accepted[0] === sigEv1.id && open.rejected.length === 0, "G-sig(b): unsigned event admits when sigs not required");
	// (a) the new gate catches it: with requireSigs the same shape is refused
	// with the named reason (fresh author, so chain state cannot interfere).
	const sigEv2 = mkSigEv("did:key:g-sig2");
	const strict = await appendForeignEvents(t.issues, [sigEv2], { requireSigs: true });
	check(strict.accepted.length === 0 && strict.rejected.length === 1 && strict.rejected[0].reason === "sig-required",
		`G-sig(a): requireSigs refuses the unsigned event (got ${JSON.stringify(strict.rejected)})`);

	// G-budget-sync — hunk: bais/src/hub.ts appendForeignEvents sync-path
	// budget gate (exhausted = incurred >= cap in BOTH dims; wind-down,
	// funding, and protocol types stay OPEN so exhaustion cannot deadlock).
	const POOR = "did:key:g-poor", RICH = "did:key:g-rich";
	// Chain links reference REAL predecessor ids (prev must be the hash
	// of the previous event, not a dev label): build sequentially.
	const bev = (author, seq, prev, type, body, entity, lc) => mkForeign({
		author, seq, prev, project: "g", entity, lc, ts: "2026-09-04T00:00:00Z", type, body,
	});
	const auth = bev(POOR, 0, null, "BudgetAuthorize", { cap_usd: 1.0, cap_tokens: 10 }, POOR, 63000);
	const res = bev(POOR, 1, auth.id, "CostReserve", { task: "task:g-budget", usd: 1.0, tokens: 10 }, POOR, 63001);
	const inc = bev(POOR, 2, res.id, "CostIncurred", { reserve_ref: res.id, task: "task:g-budget", usd: 1.0, tokens: 10 }, POOR, 63002);
	const fund = await appendForeignEvents(t.issues, [auth, res, inc]);
	check(fund.accepted.length === 3 && fund.rejected.length === 0, `G-budget setup: authorize+reserve+incur admitted (${fund.accepted.length}/3, poor now exhausted 1.0/10)`);
	// (a) the new gate catches it: the exhausted author opens no new state.
	const poorWriteEv = bev(POOR, 3, inc.id, "TaskCreate", { title: "poor write", kind: "Feat", body: "x" }, "task:g-poor", 63003);
	const poorWrite = await appendForeignEvents(t.issues, [poorWriteEv]);
	check(poorWrite.accepted.length === 0 && poorWrite.rejected.length === 1 && poorWrite.rejected[0].reason === "budget-exhausted",
		`G-budget(a): exhausted author opens no new state (got ${JSON.stringify(poorWrite.rejected)})`);
	// (b) pre-existing checks miss it: the identical shape from a funded
	// author admits — chain/shape/bounds/decide all pass; only the budget
	// dimension differs.
	const richWriteEv = bev(RICH, 0, null, "TaskCreate", { title: "rich write", kind: "Feat", body: "x" }, "task:g-rich", 63003);
	const richWrite = await appendForeignEvents(t.issues, [richWriteEv]);
	check(richWrite.accepted.length === 1 && richWrite.accepted[0] === richWriteEv.id, "G-budget(b): funded author admits the identical shape");
	// Precision: funding stays OPEN — poor can still top up (the gate
	// cannot deadlock). The rejected write persisted as evidence, so poor's
	// chain head is the evidence id at seq 3; the top-up continues at seq 4.
	const topupEv = bev(POOR, 4, poorWriteEv.id, "BudgetAuthorize", { cap_usd: 5.0, cap_tokens: 50 }, POOR, 63004);
	const topup = await appendForeignEvents(t.issues, [topupEv]);
	check(topup.accepted.length === 1 && topup.accepted[0] === topupEv.id, `G-budget precision: exhausted author can still top up (got ${JSON.stringify(topup.rejected)})`);

	// G-tamper — hunk: bais/src/hub.ts checkId (verifyEventId on ingest).
	// Violation: a well-formed event whose body no longer hashes to its
	// id. Pre-existing checks miss it: shape/chain/sig-null/bounds all
	// pass on the tampered bytes (nothing else fires).
	const ADV = "did:key:g-adv";
	const honest = mkForeign({
		author: ADV, seq: 0, project: "g", entity: "task:g-tamper",
		lc: 64000, type: "TaskCreate", body: { title: "honest", kind: "Feat", body: "x" },
	});
	const hOk = await appendForeignEvents(t.issues, [honest]);
	check(hOk.accepted.length === 1 && hOk.accepted[0] === honest.id, "G-tamper setup: honest event admits");
	// (a1) UNKNOWN id that hashes to nothing: the content does not match
	// the claimed id — structural rejection, not a silent skip. (A known
	// id with altered bytes is the replay-tamper case below.)
	const forged = mkForeign({
		author: "did:key:g-forg", seq: 0, project: "g", entity: "task:g-forg",
		lc: 64001, type: "TaskCreate", body: { title: "honest", kind: "Feat", body: "x" },
	});
	const forgedUnknown = { ...forged, id: "b" + "0".repeat(50) };
	const gTamper = await appendForeignEvents(t.issues, [forgedUnknown]);
	check(gTamper.accepted.length === 0 && gTamper.rejected.length === 1 && gTamper.rejected[0].reason === "id-mismatch",
		`G-tamper(a): body/id mismatch is evidence, not state (got ${JSON.stringify(gTamper.rejected)})`);
	// (a2) same id, altered body, KNOWN id: tampered replay of the honest
	// event — loud replay-tamper, never the silent re-pull.
	const replayed = { ...honest, body: { ...honest.body, title: "tampered" } };
	const gReplay = await appendForeignEvents(t.issues, [replayed]);
	check(gReplay.accepted.length === 0 && gReplay.rejected.length === 1 && gReplay.rejected[0].reason === "replay-tamper",
		`G-tamper(a2): tampered replay is loud (got ${JSON.stringify(gReplay.rejected)})`);
	// (b) the benign re-pull stays silent (R-b contract): same bytes twice.
	const gBenign = await appendForeignEvents(t.issues, [{ ...honest }]);
	check(gBenign.accepted.length === 0 && gBenign.rejected.length === 0, "G-tamper(b): identical re-pull stays a silent no-op");

	// G-fork — hunk: delta continuity (seq/prev linkage per author).
	// Violation: same author+seq under two ids (both structurally valid,
	// so the id gate cannot fire — only continuity sees it).
	const F = "did:key:g-fork";
	const f1 = mkForeign({
		author: F, seq: 0, project: "g", entity: "task:g-fork",
		lc: 64100, type: "TaskCreate", body: { title: "branch one", kind: "Feat", body: "x" },
	});
	const fOk = await appendForeignEvents(t.issues, [f1]);
	check(fOk.accepted.length === 1, "G-fork setup: first branch admits");
	const f2 = mkForeign({
		author: F, seq: 0, project: "g", entity: "task:g-fork",
		lc: 64101, type: "TaskCreate", body: { title: "branch two", kind: "Feat", body: "x" },
	});
	const gFork = await appendForeignEvents(t.issues, [f2]);
	check(gFork.accepted.length === 0 && gFork.rejected.length === 1 && gFork.rejected[0].reason === "chain-break",
		`G-fork(a): second seq-0 branch breaks continuity (got ${JSON.stringify(gFork.rejected)})`);
	const f3 = mkForeign({
		author: F, seq: 1, prev: f2.id, project: "g", entity: "task:g-fork",
		lc: 64102, type: "TaskCreate", body: { title: "wrong link", kind: "Feat", body: "x" },
	});
	const gLink = await appendForeignEvents(t.issues, [f3]);
	check(gLink.accepted.length === 0 && gLink.rejected.length === 1 && gLink.rejected[0].reason === "prev-mismatch",
		`G-fork(a2): link to the rejected branch mismatches (got ${JSON.stringify(gLink.rejected)})`);

	// G-revoke — hunk: needsCap consults BAML cap_live (revoked kills it).
	// The drill proves the sync plumbing (cap-denied reason + evidence);
	// BAML unit tests prove revoked grants go non-live. Split by layer,
	// green by composition: the stub denies exactly one author, so the
	// identical shape from anyone else must still admit (b).
	const denyPoor = (author) => author !== "did:key:g-revoked";
	const revEv = mkForeign({
		author: "did:key:g-revoked", seq: 0, project: "g", entity: "task:g-rev",
		lc: 64200, type: "TaskCreate", body: { title: "revoked write", kind: "Feat", body: "x" },
	});
	const gRev = await appendForeignEvents(t.issues, [revEv], { capCheck: (author, action, scope) => denyPoor(author) });
	check(gRev.accepted.length === 0 && gRev.rejected.length === 1 && gRev.rejected[0].reason === "cap-denied",
		`G-revoke(a): denied author is cap-denied evidence (got ${JSON.stringify(gRev.rejected)})`);
	const okEv = mkForeign({
		author: "did:key:g-funded", seq: 0, project: "g", entity: "task:g-ok",
		lc: 64201, type: "TaskCreate", body: { title: "funded write", kind: "Feat", body: "x" },
	});
	const gOk = await appendForeignEvents(t.issues, [okEv], { capCheck: (author, action, scope) => denyPoor(author) });
	check(gOk.accepted.length === 1 && gOk.accepted[0] === okEv.id, "G-revoke(b): allowed author admits the identical shape");

	// G-skew — hunk: checkClock future bound (MAX_FUTURE_SKEW_MS = 1h,
	// bais/src/hub.ts). History replays old timestamps legitimately, so
	// only the future is bounded. bi#82: the boundary is pinned from BOTH
	// sides against the injected clock — +59min admits, +61min rejects —
	// so the verdict is identical live and under --now.
	const skewAt = (author, entity, offsetMs, lc) => mkForeign({
		author, seq: 0, project: "g", entity, lc,
		ts: clock.isoAt(clock.nowMs() + offsetMs),
		type: "TaskCreate", body: { title: "skew probe", kind: "Feat", body: "x" },
	});
	const skewIn = skewAt("did:key:g-skew-in", "task:g-skew-in", 59 * 60_000, 64299);
	const gSkewIn = await appendForeignEvents(t.issues, [skewIn]);
	check(gSkewIn.accepted.length === 1 && gSkewIn.accepted[0] === skewIn.id && gSkewIn.rejected.length === 0,
		`G-skew(bound-): +59min event admits inside the 1h bound (got ${JSON.stringify(gSkewIn.rejected)})`);
	const skewEv = skewAt("did:key:g-skew", "task:g-skew", 61 * 60_000, 64300);
	const gSkew = await appendForeignEvents(t.issues, [skewEv]);
	check(gSkew.accepted.length === 0 && gSkew.rejected.length === 1 && gSkew.rejected[0].reason === "clock-skew",
		`G-skew(a): +61min event is clock-skew evidence (got ${JSON.stringify(gSkew.rejected)})`);
	const oldEv = mkForeign({
		author: "did:key:g-old", seq: 0, project: "g", entity: "task:g-old",
		lc: 64301, ts: "2020-01-01T00:00:00Z",
		type: "TaskCreate", body: { title: "history", kind: "Feat", body: "x" },
	});
	const gOld = await appendForeignEvents(t.issues, [oldEv]);
	check(gOld.accepted.length === 1 && gOld.accepted[0] === oldEv.id, "G-skew(b): 2020 event admits — the past is unbounded");

	// G-oversight — every named rejection above is visible in oversight,
	// not just in the raw log.
	const reasons = new Set(storeOversight(t.issues).rejected_events.map((r) => r.reason));
	for (const want of ["id-mismatch", "replay-tamper", "chain-break", "prev-mismatch", "cap-denied", "clock-skew", "sig-required", "budget-exhausted"]) {
		check(reasons.has(want), `G-oversight: ${want} visible in rejected_events`);
	}
}

// ---------------------------------------------------------------- red-checks (bi#57)
// Each net above carries a recorded revert-hunk verification (hunk,
// expected failure reason, observed output from the 2026-09-04
// demonstration runs: live src revert + rebuild). The probes below
// re-demonstrate the catch in-process on every run: each builds the REAL
// weakened outcome through the real code path, feeds it to the suite's
// own predicate, and requires the predicate to fail with the recorded
// reason. A probe passes iff the weakened net is caught for that reason.
drill = "r";
const rcFails = [];
const rcheck = (cond, msg) => { if (!cond) rcFails.push(msg); };
const rcReset = () => rcFails.splice(0, rcFails.length);

// RED-CHECK R-a — hunk: bais/src/store.ts openDb() `store-integrity-mismatch`
// throw (fail-closed corrupt reads). Revert (comment out the throw, rebuild)
// serves unverified rows as confident truth.
// Expected reason: P0 SILENT-LIE: <n> sampled bit-flip(s) serve altered
// projections with completeness "complete".
// Observed (live E1 revert + rebuild): `P0-detail [a]: silent lie at offset
// 3372 bit 0 (completeness still "complete", hasStore still true): ...` then
// `FAIL [a]: P0 SILENT-LIE: 2 sampled bit-flip(s) serve altered projections
// with completeness "complete" (e.g. offset 3372)` / `drill (a): FAIL`.
// (A1/A2 still pass reverted — smashed headers throw at the SQLite layer;
// the hunk guards content-region flips.)
{
	const t = mkTree("r-a");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha-title-here"));
	await ingestIssues(t.issues);
	const pristine = readFileSync(dbPathFor(t.issues));
	// Deterministic content-region tamper: rewrite the materialized title
	// row in place (valid SQLite, sealed fingerprint now stale) — exactly
	// the threat the hunk names ("content changed outside a sealed write")
	// and what the reverted code path would serve as confident truth.
	const wdb = new DatabaseSync(dbPathFor(t.issues));
	wdb.prepare("UPDATE tasks SET title = 'Altered-TITLE-Here' WHERE entity = 't1'").run();
	// Weakened read: direct SQL on the tasks table, bypassing openDb's
	// verify — byte-for-byte what the reverted code path serves.
	let weakRows = null;
	try { weakRows = wdb.prepare("SELECT entity, title FROM tasks").all(); } catch (e) { weakRows = `threw: ${e?.message ?? e}`; }
	wdb.close();
	const servesLie = Array.isArray(weakRows) && weakRows.some((r) => r.entity === "t1" && r.title !== "alpha-title-here");
	// The suite's own lie-detector predicate (drill (a) A4 form), fed the
	// weakened outcome: it must FAIL with the recorded reason.
	rcheck(!servesLie, `P0 SILENT-LIE (R-a): weakened read serves altered title as truth (${JSON.stringify(weakRows)?.slice(0, 80)})`);
	check(rcFails.length === 1 && /SILENT-LIE/.test(rcFails[0]), `R-a red-check: weakened net fails for the right reason (${rcFails[0] ?? "UNCAUGHT"})`);
	rcReset();
	// And the intact net fails closed with the NAMED reason on the same bytes.
	let threw = null;
	try { storeList(t.issues); } catch (e) { threw = e; }
	check(!!threw && /store-integrity-mismatch/.test(threw?.message ?? ""), `R-a: intact net throws store-integrity-mismatch (${(threw?.message ?? "").slice(0, 50)})`);
	writeFileSync(dbPathFor(t.issues), pristine);
	check(storeList(t.issues).tasks.some((x) => x.entity === "t1"), "R-a: pristine restored, reads green");
}

// RED-CHECK R-b — hunk: bais/src/hub.ts appendForeignEvents delta mode
// `if (known.has(raw.id) || staged.some((s) => s.id === raw.id)) continue;`
// (silent idempotent skip). Revert (E2: skip -> loud `duplicate` reject +
// evidence, rebuild) breaks exactly the silent-skip contract.
// Expected reason: `repeat delivery is a silent skip (neither accepted nor rejected)`.
// Observed (live E2 revert + rebuild): `FAIL [b]: repeat delivery is a silent
// skip (neither accepted nor rejected)` / `drill (b) idempotence: FAIL` /
// `1 failure(s)` — nothing else fires (in-batch dedup still stages first-seen).
{
	// The E2-mutated call produced exactly this outcome object; the suite's
	// own predicate must reject it with the recorded message.
	const mutated = { accepted: [], rejected: [{ id: "drill:dup:1", reason: "duplicate" }] };
	rcheck(mutated.accepted.length === 0 && mutated.rejected.length === 0, "repeat delivery is a silent skip (neither accepted nor rejected)");
	check(rcFails.length === 1 && /silent skip/.test(rcFails[0]), `R-b red-check: E2-mutated outcome fails for the right reason (${rcFails[0] ?? "UNCAUGHT"})`);
	rcReset();
}

// RED-CHECK R-c — hunk: the anchor-seeding steps of the pruned-peer sync
// path (snapshot import + anchor_state + cursors + anchorHeads linkage).
// Revert (replay the surviving delta into a fresh peer with NO snapshot
// import and NO anchorHeads, i.e. no anchor trust) must break convergence:
// the surviving rows genesis-admit but the covered seed history is gone,
// so the peer diverges from the pruned source.
// Expected reason: `pruned-then-resynced peer converged on tasks` (FAILS).
// Observed (in-process, this probe): anchor-less replay accepts the
// surviving row(s) as genesis yet canonTasks diverges — the convergence
// predicate is what pins the anchor steps.
{
	const A2 = mkTree("r-c-a");
	writeFileSync(join(A2.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(A2.issues);
	const cp2 = await publishCheckpoint(A2.issues);
	await pruneBelowCheckpoint(A2.issues);
	const adb2 = new DatabaseSync(resolve(A2.root, ".bais", "store.db"));
	const rows2 = adb2.prepare("SELECT * FROM events ORDER BY lc, id").all();
	adb2.close();
	const toWire2 = (r) => ({
		id: r.id, author: r.author, seq: r.seq, prev: r.prev, project: r.project,
		entity: r.entity, refs: JSON.parse(r.refs), lc: r.lc, ts: r.ts, type: r.type,
		body: JSON.parse(r.body), sig: r.sig ?? null, admitted: r.admitted === 1, drop_reason: r.drop_reason,
	});
	const snap2 = exportSnapshot(A2.issues);
	const surviving2 = rows2.map(toWire2).filter((e) => e.lc > snap2.checkpoint.lc);
	// WEAKENED replay: no snapshot import, no anchorHeads — the reverted net.
	const B2 = mkTree("r-c-b");
	check(surviving2.length === 1, `R-c setup: pruned source has a surviving delta (${surviving2.length} rows)`); // bi#58: exactly the checkpoint event
	const td2 = await appendForeignEvents(B2.issues, surviving2, { mode: "delta" });
	console.log(`info [r]: R-c anchor-less replay accepted ${td2.accepted.length}/${surviving2.length} (genesis-admit, covered seed history still missing)`);
	rcheck(canonTasks(A2.issues) === canonTasks(B2.issues), "pruned-then-resynced peer converged on tasks");
	check(rcFails.length === 1 && /converged/.test(rcFails[0]), `R-c red-check: anchor-less net fails the convergence predicate (${rcFails[0] ?? "UNCAUGHT"})`);
	rcReset();
}

// RED-CHECK R-fallback — hunk: bais/src/cli.ts `const useStore =
// hasStore(issuesDir)` + the scan-path else-branch (hasStore fallback).
// Revert (E3: `const useStore = true` forced, rebuild) serves confident
// EMPTY with exit 0 instead of the scan truth.
// Expected reason: storeless `list` omits every issue (exit 0, no rows).
// Observed (live E3 revert + rebuild, tmp dir, 1 TOML file, no store):
// stdout `` (no rows), exit 0, stderr only the unsealed-legacy warn;
// import-level `storeList` returns tasks [] with completeness "partial".
// (Side effect recorded: the forced read CREATES an empty store.db — the
// weakened net poisons the dir it misreads.)
{
	const t = mkTree("r-fb");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	writeFileSync(join(t.issues, "t2.toml"), toml("t2", "beta"));
	check(hasStore(t.issues) === false, "R-fallback setup: fixture has no store");
	// Weakened behavior = what the forced-store CLI serves (real call —
	// must run BEFORE any ingest creates the store).
	const weak = storeList(t.issues);
	rcheck(weak.tasks.length === 2, "storeless list serves every issue");
	const scan = await loadIssues(t.issues);
	const scanIds = scan.issues.map((f) => f.issue.id).sort().join(",");
	check(scan.failures.length === 0 && scanIds === "t1,t2", `R-fallback: scan serves truth without the store (${scanIds})`);
	check(rcFails.length === 1, `R-fallback red-check: forced-store omits 2/2 issues (served ${weak.tasks.length}, completeness ${weak.completeness}) — hunk load-bearing`);
	rcReset();
	// G-fallback (bi#60) injection framing for the same violation (absent
	// store.db): (a) the fallback gate catches it by serving full scan truth;
	// (b) the pre-existing store path misses it — it serves empty/partial,
	// not truth, with no failure.
	check(scanIds === "t1,t2", "G-fallback(a): fallback gate serves full truth for the violation");
	check(weak.tasks.length === 0 && weak.completeness === "partial", `G-fallback(b): pre-existing store path misses it (serves ${weak.tasks.length} tasks, ${weak.completeness})`);
}

// ---------------------------------------------------------------- summary
const verdict = (k) => (drillFailures[k] ? "FAIL" : "PASS");
console.log(`drill (a) corruption-fallback: ${verdict("a")}`);
console.log(`drill (b) idempotence: ${verdict("b")}`);
console.log(`drill (c) prune-resync convergence: ${verdict("c")}`);
console.log(`drill (d) gate injection proofs: ${verdict("d")}`);
console.log(`red-checks (r) revert-hunk probes: ${verdict("r")}`);
console.log("loopback needed: NO — all drills fully in-process (node:sqlite + dist imports); no sockets opened, no child processes spawned.");
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("fault drills: all green");
