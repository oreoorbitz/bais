// bais/scripts/reducer-determinism.mjs — bi#35: prove the BAML event
// reducer is deterministic. BAML owns reduction policy; this script only
// executes/drives through the compiled host (dist/, no rebuild) and
// compares projections.
//
// Run from the repo root: node bais/scripts/reducer-determinism.mjs
// (plain node; dist/ is already current). Offline; everything in tmp dirs.
// Exits non-zero on any failure.
//
// Covers:
// (a) ingest-from-TOML vs replay-from-log: same event set seeded by
//     ingestIssues, replayed verbatim through appendForeignEvents
//     (backfill mode re-reduces the whole log in BAML) into a fresh dir,
//     must yield identical task/edge projections.
// (b) commuting reorderings: fixed permutations (reverse, rotate,
//     swap-halves) of the same log replayed into fresh dirs converge to
//     identical tables (reducer total order is (lc, id), never input order).
// (c) seeded fuzz: FUZZ_SEED interleavings of a synthetic log with heavy
//     lc collisions (same-lc conflicting transitions, concurrent
//     label add/remove, rel add/retract, unknown types, duplicate creates)
//     all converge to identical tables.
//
// A divergence is a P0 finding: it is reported exactly, never worked around.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	ingestIssues,
	storeList,
	storeEdges,
	exportSnapshot,
	dbPathFor,
} from "../dist/src/store.js";
import { appendForeignEvents, encodeBodyArrays } from "../dist/src/hub.js";
import { eventId } from "../dist/src/ids.js";

// Checked-in fuzz seed — do not change. The determinism proof must
// reproduce byte-identically on every run.
const FUZZ_SEED = 20260904;
const FUZZ_ROUNDS = 25;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Deterministic PRNG (mulberry32) — the only randomness source; seeded.
function rng32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled(arr, rand) {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// Canonical fingerprint of the materialized projection. Wall-clock fields
// (as_of.wall_ts, exported_at) are excluded — they are not reducer output.
function fingerprint(issuesDir) {
	const snap = exportSnapshot(issuesDir);
	const tables = snap.tables;
	const stable = (v) => {
		if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
		if (v && typeof v === "object") {
			return `{${Object.keys(v)
				.sort()
				.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
				.join(",")}}`;
		}
		return JSON.stringify(v) ?? "null";
	};
	const body = stable({ tasks: tables.tasks, edges: storeEdges(issuesDir), tables });
	return createHash("sha256").update(body, "utf8").digest("hex");
}

function readLogEvents(issuesDir) {
	const db = new DatabaseSync(dbPathFor(issuesDir));
	try {
		return db
			.prepare("SELECT * FROM events ORDER BY id")
			.all()
			.map((r) => ({
				id: r.id,
				author: r.author,
				seq: r.seq,
				prev: r.prev,
				project: r.project,
				entity: r.entity,
				refs: JSON.parse(r.refs),
				lc: r.lc,
				ts: r.ts,
				type: r.type,
				body: JSON.parse(r.body),
				sig: r.sig ?? null,
			}));
	} finally {
		db.close();
	}
}

async function replayInto(freshIssuesDir, events) {
	mkdirSync(freshIssuesDir, { recursive: true });
	const res = await appendForeignEvents(freshIssuesDir, events, { mode: "backfill" });
	return res;
}

const root = mkdtempSync(join(tmpdir(), "bais-determinism-"));

// --- fixture: TOML seed with statuses, edges, dangling refs, metadata ---
const seedDir = join(root, "seed", ".bais", "issues");
mkdirSync(seedDir, { recursive: true });
const toml = (id, title, status, kind, extra = "", edges = "") =>
	`id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "${kind}"\n${extra}body = "determinism fixture"\n${edges}`;
writeFileSync(
	join(seedDir, "bi#01.toml"),
	toml("bi#01", "alpha", "Open", "Feat", 'area = "cli/bi"\nseverity = 2\n', '[[edge]]\nfrom = "bi#01"\nto = "bi#02"\nkind = "Blocks"\n'),
);
writeFileSync(join(seedDir, "bi#02.toml"), toml("bi#02", "beta", "Open", "Bug"));
writeFileSync(
	join(seedDir, "bi#03.toml"),
	toml("bi#03", "gamma", "Done", "Feat", 'source = "baml.errors.TypeMismatch"\n'),
);
writeFileSync(
	join(seedDir, "bi#04.toml"),
	toml(
		"bi#04",
		"delta",
		"Blocked",
		"Debt",
		"",
		'[[edge]]\nfrom = "bi#04"\nto = "bi#missing"\nkind = "Blocks"\n[[edge]]\nfrom = "bi#04"\nto = "bagl#02"\nkind = "Related"\n',
	),
);
const ing = await ingestIssues(seedDir);
check(ing.events === 9, `ingested TOML fixture (${ing.events} seed events)`); // bi#58: exact — 2+1+2+4 from the four fixture files
const seedEvents = readLogEvents(seedDir);
check(seedEvents.length === ing.events, `log holds every seeded event (${seedEvents.length})`);

const base = fingerprint(seedDir);
console.log(`base projection: ${base}`);

// --- (a) ingest-from-TOML vs replay-from-log ---
{
	const dir = join(root, "replay", ".bais", "issues");
	const res = await replayInto(dir, seedEvents);
	check(res.rejected.length === 0, `replay admitted whole log (${res.accepted.length}/${seedEvents.length})`);
	const fp = fingerprint(dir);
	check(fp === base, `(a) ingest-from-TOML == replay-from-log (${fp.slice(0, 12)}…)`);
	if (fp !== base) {
		console.error(`DIVERGENCE (a): ingest ${base} vs replay ${fp}`);
		console.error(`ingest tasks: ${JSON.stringify(storeList(seedDir).tasks.map((t) => t.entity))}`);
		console.error(`replay tasks: ${JSON.stringify(storeList(dir).tasks.map((t) => t.entity))}`);
	}
}

// --- (b) commuting reorderings converge ---
{
	const n = seedEvents.length;
	const perms = {
		reverse: [...seedEvents].reverse(),
		rotate: [...seedEvents.slice(n - 2), ...seedEvents.slice(0, n - 2)],
		"swap-halves": [...seedEvents.slice(Math.floor(n / 2)), ...seedEvents.slice(0, Math.floor(n / 2))],
	};
	for (const [name, order] of Object.entries(perms)) {
		const dir = join(root, `perm-${name}`, ".bais", "issues");
		const res = await replayInto(dir, order);
		check(res.rejected.length === 0, `(b) ${name}: admitted whole log`);
		const fp = fingerprint(dir);
		check(fp === base, `(b) ${name} converges (${fp.slice(0, 12)}…)`);
		if (fp !== base) console.error(`DIVERGENCE (b/${name}): ${base} vs ${fp}`);
	}
}

// --- (c) seeded fuzz over interleavings ---
// Chain-legal synthetic log (per-author seq/prev chains, so backfill
// admission is order-independent): heavy lc collisions to stress the
// (lc, id) tiebreak, conflicts, add-wins labels, rel add/retract, and
// evidence paths (unknown type, duplicate create, unknown entity).
function buildFuzzLog() {
	const evs = [];
	const cursor = {};
	// bi#38: real content-hash ids (dev-style ids are dead by policy).
	// Conflict winners are still deterministic — same content hashes
	// to the same id on every run — only WHICH hash is greater changed.
	const emit = (author, entity, lc, type, body) => {
		const seq = cursor[author]?.seq ?? -1;
		const enc = encodeBodyArrays(body);
		const base = {
			author,
			seq: seq + 1,
			prev: cursor[author]?.id ?? null,
			project: "bi",
			entity,
			refs: [],
			lc,
			ts: "2026-09-04T00:00:00Z",
			type,
			body: enc,
		};
		const id = eventId(base);
		evs.push({ ...base, id, sig: null });
		cursor[author] = { seq: seq + 1, id };
	};
	const A = "did:key:fuzz-a";
	const B = "did:key:fuzz-b";
	const T = (o) => o;
	emit(A, "task:f0", 1, "TaskCreate", T({ title: "f0", kind: "Feat", body: "x" }));
	emit(B, "task:f1", 1, "TaskCreate", T({ title: "f1", kind: "Bug", body: "y" }));
	emit(A, "task:f2", 1, "TaskCreate", T({ title: "f2", kind: "Feat", body: "z" }));
	emit(A, "task:f0", 2, "LabelAdd", T({ label: "backend" }));
	emit(B, "task:f0", 2, "LabelRemove", T({ label: "backend" })); // same lc: add wins
	emit(A, "task:f0", 2, "RelAdd", T({ rel_id: "rel:fz-r1", source: "task:f0", type: "Blocks", target: "task:f1" }));
	emit(B, "task:f1", 3, "RelAdd", T({ rel_id: "rel:fz-r2", source: "task:f1", type: "DependsOn", target: "task:f2" }));
	emit(A, "task:f0", 3, "CommentPost", T({ text: "first" }));
	emit(B, "task:f0", 4, "CommentPost", T({ text: "second" }));
	emit(A, "task:f0", 5, "TaskTransition", T({ to: "Doing" }));
	emit(B, "task:f0", 5, "TaskTransition", T({ to: "Blocked" })); // same lc: conflict, greater id wins
	emit(A, "task:f0", 5, "Teleport", T({})); // unknown type: evidence
	emit(B, "task:f1", 5, "TaskSet", T({ title: "f1-renamed" }));
	emit(A, "task:f1", 4, "TaskSet", T({ title: "f1-stale" })); // lower lc loses (LWW)
	emit(B, "task:f1", 3, "RelRetract", T({ rel_id: "rel:fz-r2" }));
	emit(A, "task:f0", 6, "TaskCreate", T({ title: "dup", kind: "Feat", body: "x" })); // duplicate create: evidence
	emit(B, "task:ghost", 6, "TaskSet", T({ title: "x" })); // unknown entity: evidence
	emit(A, "task:f1", 6, "TaskTransition", T({ to: "Working" })); // unknown status: evidence
	emit(B, "task:f0", 7, "TaskTransition", T({ to: "Done" }));
	emit(A, "task:f2", 7, "LabelAdd", T({ label: "frontend" }));
	emit(B, "task:f2", 8, "LabelRemove", T({ label: "frontend" })); // strictly greater lc: removed
	return evs;
}

{
	const fuzzLog = buildFuzzLog();
	const probeDir = join(root, "fuzz-probe", ".bais", "issues");
	const probe = await replayInto(probeDir, fuzzLog);
	check(probe.rejected.length === 0, `fuzz log chain-legal as a set (0 host rejects)`);
	const snap = exportSnapshot(probeDir);
	// bi#58: exact counts — the fuzz log is deterministic, so 1 conflict /
	// 5 excluded is the equality form; `> 0` would still pass if a reducer
	// change silently dropped half the evidence paths. The 5th (vs 4 under
	// dev ids) is unknown-rel: content-hash ids re-sort the lc-3
	// RelAdd/RelRetract tiebreak so the retract applies first — the (lc,
	// id) tiebreak is id-sensitive by design, and the unknown-rel record
	// is the reducer handling that order correctly, not a divergence.
	if (!Array.isArray(snap.tables.conflicts) || !Array.isArray(snap.tables.excluded)) {
		failures++;
		console.error(`FAIL: fuzz tables missing conflicts/excluded arrays`);
	}
	check(snap.tables.conflicts.length === 1, `fuzz hits the conflict path (${snap.tables.conflicts.length} conflict(s))`);
	check(snap.tables.excluded.length === 5, `fuzz hits evidence paths (${snap.tables.excluded.length} excluded)`);
	const fuzzBase = fingerprint(probeDir);
	console.log(`fuzz projection: ${fuzzBase}`);
	const rand = rng32(FUZZ_SEED);
	let convergedCount = 0; // bi#58: count, not boolean — every round must converge, and the count says how many did
	for (let r = 0; r < FUZZ_ROUNDS; r++) {
		const dir = join(root, `fuzz-${r}`, ".bais", "issues");
		const order = shuffled(fuzzLog, rand);
		const res = await replayInto(dir, order);
		if (res.rejected.length !== 0) {
			failures++;
			console.error(`FAIL: (c) round ${r}: ${res.rejected.length} host rejects (${JSON.stringify(res.rejected)})`);
			continue;
		}
		const fp = fingerprint(dir);
		if (fp !== fuzzBase) {
			console.error(`DIVERGENCE (c/round ${r}, seed ${FUZZ_SEED}): ${fuzzBase} vs ${fp}`);
			continue;
		}
		convergedCount++;
	}
	check(convergedCount === FUZZ_ROUNDS, `(c) ${convergedCount}/${FUZZ_ROUNDS} seeded interleavings (seed ${FUZZ_SEED}) converge`);
}

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("reducer determinism: all green");
