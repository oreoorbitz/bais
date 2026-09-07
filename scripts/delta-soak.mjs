// bais/scripts/delta-soak.mjs — bi#47 delta-path soak.
//
// What it proves (offline except §6–7, which boot real hubs on tmp dirs):
//   §0 version gate: the checked-in fixture pins reducer_version; a bump
//      fails LOUD here (regenerate with --regen), never silently replays.
//   §1 determinism: regenerate-from-seed is byte-identical to the fixture.
//   §2 three sequential deltas compose to the full log (acceptance, via
//      the host SDK path — mirrors ns_event/delta.baml fixture 1).
//   §3 a pruned-away head returns the re-bootstrap directive, never a
//      partial diff presented as complete (acceptance).
//   §4 delta + snapshot composes to the full-replay fingerprint (ties to
//      bi#35), while the delta alone does not.
//   §5 large-scale soak: 5000 seeded events, 5 sequential deltas compose,
//      steady-state poll is empty-but-complete, inside a time budget.
//   §6 live serve: GET /sync?heads= serves from→to deltas computed by the
//      BAML policy, GET /sync/digest serves the version gate, legacy
//      since_lc/have filters keep working.
//   §7 backup lane: after prune, a snapshot-restored peer carries the
//      anchor forward and its delta degrades loudly (rebootstrap naming
//      the same state_root).
//
// Usage:
//   BAIS_DELTA_BUILD=/tmp/b647-build node bais/scripts/delta-soak.mjs
//   (BUILD defaults to bais/dist once the merger has built; the soak never
//   writes to BUILD — emit stays the merger's job.)
//   node bais/scripts/delta-soak.mjs --regen   # rewrite the fixture from seed
//
// RED-CHECK record (bi#47, run 2026-09-06, observed):
//   hunk: src/sync_delta.ts version gate (`clientVersion !== serverVersion`
//     → complete=false version-skew), reverted to `if (false)` + scratch
//     rebuild. Soak tripped exactly:
//     "FAIL: expected version-skew rebootstrap for a stale client" (§0) and
//     "FAIL: live stale-version delta refuses with version-skew" (§6) —
//     "2 FAILURE(S)". Restored (cmp-identical), rebuilt, full soak green.
//   A passing suite that cannot go red is camouflage; this one goes red
//   for the right reason.
//
// File ownership (bi#47): this script + fixtures/delta/ + sync_delta.ts +
// the /sync heads-mode hunks in hub.ts only. Never verify/dispatch/pub/
// budget/oversight/store/stale/lifecycle asserts — sibling lanes own those.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BAIS = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = process.env.BAIS_DELTA_BUILD ?? join(BAIS, "dist");
const { event } = await import(join(BUILD, "baml_sdk", "index.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Deterministic PRNG (mulberry32): the fixture seed regenerates every
// title/text byte-for-byte; any toolchain drift shows up in §1, not as a
// flaky soak.
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const WORDS = ["alpha", "bravo", "cargo", "delta", "ember", "flare", "granite", "harbor"];

const wireEv = (type, entity, lc, id, body) => ({
	id,
	author: "did:key:z6Mk-test",
	seq: lc,
	prev: null,
	project: "bi",
	entity,
	refs: [],
	lc,
	ts: "2026-09-03T00:00:00Z",
	type,
	body,
	admitted: true,
	drop_reason: null,
});

// Small deterministic log, 12 events over 3 entities. Structure is fixed
// (create-before-use, so reduce() stays valid); the rng only picks words.
function genFixtureEvents(seed) {
	const rnd = mulberry32(seed);
	const pick = () => WORDS[Math.floor(rnd() * WORDS.length)];
	const T = (k, v) => ({ [k]: v });
	return [
		wireEv("TaskCreate", "task:A", 1, "fx-001", { title: pick(), kind: "Feat", body: "fx" }),
		wireEv("TaskTransition", "task:A", 2, "fx-002", T("to", "Doing")),
		wireEv("LabelAdd", "task:A", 3, "fx-003", T("label", "backend")),
		wireEv("TaskTransition", "task:A", 4, "fx-004", T("to", "Done")),
		wireEv("CommentPost", "task:A", 5, "fx-005", T("text", `note-${pick()}`)),
		wireEv("TaskCreate", "task:B", 6, "fx-006", { title: pick(), kind: "Feat", body: "fx" }),
		wireEv("TaskTransition", "task:B", 7, "fx-007", T("to", "Doing")),
		wireEv("CommentPost", "task:B", 8, "fx-008", T("text", `note-${pick()}`)),
		wireEv("TaskCreate", "task:C", 9, "fx-009", { title: pick(), kind: "Feat", body: "fx" }),
		wireEv("TaskSet", "task:C", 10, "fx-010", T("title", `retitled-${pick()}`)),
		wireEv("TaskTransition", "task:C", 11, "fx-011", T("to", "Doing")),
		wireEv("TaskTransition", "task:C", 12, "fx-012", T("to", "Done")),
	];
}

// Large-scale log: N events round-robin over 100 entities, each entity
// created on first touch. Valid for reduce(); ids sort after lc order.
function genScaleEvents(n, seed) {
	const rnd = mulberry32(seed);
	const out = [];
	const seen = new Set();
	for (let i = 1; i <= n; i++) {
		const e = `task:S${(i % 100).toString().padStart(2, "0")}`;
		const id = `soak-${i.toString().padStart(6, "0")}`;
		if (!seen.has(e)) {
			seen.add(e);
			out.push(wireEv("TaskCreate", e, i, id, { title: `t-${Math.floor(rnd() * 1e6)}`, kind: "Feat", body: "soak" }));
		} else if (i % 3 === 0) {
			out.push(wireEv("TaskTransition", e, i, id, { to: "Doing" }));
		} else {
			out.push(wireEv("CommentPost", e, i, id, { text: `m-${Math.floor(rnd() * 1e6)}` }));
		}
	}
	return out;
}

const FIXTURE_PATH = join(BAIS, "scripts", "fixtures", "delta", "v1.json");
const SEED = 47;

// Serve-lane modules load lazily: --regen only needs the BAML version,
// and dist/ has no sync_delta until the merger builds (BUILD override
// points at a scratch build meanwhile).
const deltaServe = process.argv.includes("--regen")
	? null
	: await import(join(BUILD, "src", "sync_delta.js"));
const { createHub } = process.argv.includes("--regen") ? {} : await import(join(BUILD, "src", "hub.js"));
const store = process.argv.includes("--regen") ? null : await import(join(BUILD, "src", "store.js"));

if (process.argv.includes("--regen")) {
	const reducer_version = await event.reducer_version();
	writeFileSync(
		FIXTURE_PATH,
		JSON.stringify({ format: "bais.delta-fixture@1", reducer_version, seed: SEED, events: genFixtureEvents(SEED) }, null, 2) + "\n",
	);
	console.log(`regen: fixture written for ${reducer_version}`);
	process.exit(0);
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const liveVersion = await event.reducer_version();
const noAnchor = await event.no_anchor();
const anchorAt = (lc, root) => event.anchor_at(lc, root);
const ids = (d) => d.events.map((e) => e.id);

// §0 — version gate. The fixture pins the reducer it was generated under;
// a version bump without a fixture regen fails HERE, loudly, before any
// delta is served or compared.
check(
	fixture.reducer_version === liveVersion,
	`fixture version-gated (${fixture.reducer_version} vs live ${liveVersion}) — regen with --regen after a reducer bump`,
);
// The serve lane refuses a stale client with a re-bootstrap directive,
// never a cross-version delta (the load-bearing gate in sync_delta.ts).
{
	const stale = await deltaServe.serveDelta({
		log: fixture.events,
		heads: [],
		anchor: null,
		clientVersion: "bais.reduce@0-stale-probe",
		hubBase: null,
	});
	check(
		stale.complete === false && stale.events.length === 0 && (stale.reason ?? "").startsWith("version-skew"),
		"expected version-skew rebootstrap for a stale client",
	);
}

// §1 — determinism: regenerate-from-seed is byte-identical to the fixture.
check(eq(genFixtureEvents(fixture.seed), fixture.events), "regen-from-seed matches the checked-in fixture");

// §2 — three sequential deltas compose to the full log (host SDK path).
{
	const log = fixture.events;
	const d1 = await event.diff_since([], noAnchor, log.slice(0, 4));
	const d2 = await event.diff_since(d1.heads, noAnchor, log.slice(0, 8));
	const d3 = await event.diff_since(d2.heads, noAnchor, log);
	check(d1.complete && eq(ids(d1), ["fx-001", "fx-002", "fx-003", "fx-004"]), "chunk 1 carries events 1-4");
	check(d2.complete && eq(ids(d2), ["fx-005", "fx-006", "fx-007", "fx-008"]), "chunk 2 carries events 5-8");
	check(d3.complete && eq(ids(d3), ["fx-009", "fx-010", "fx-011", "fx-012"]), "chunk 3 carries events 9-12");
	check(eq([...ids(d1), ...ids(d2), ...ids(d3)], log.map((e) => e.id)), "three sequential deltas compose to the full log");
	const d4 = await event.diff_since(d3.heads, noAnchor, log);
	check(d4.complete === true && d4.events.length === 0, "steady-state poll is empty but complete");
}

// §3 — a pruned-away head demands re-bootstrap, never a partial diff.
{
	const survivors = fixture.events.slice(4); // server pruned lc <= 4
	const anchor = await anchorAt(4, "ab12");
	const gone = await event.diff_since(["fx-001"], anchor, survivors);
	check(gone.complete === false && gone.events.length === 0, "pruned-away head is incomplete with no events");
	check((gone.reason ?? "").includes("ab12"), "rebootstrap directive names the anchor snapshot");
	const ok = await event.diff_since(["fx-005"], anchor, survivors);
	check(ok.complete === true && eq(ids(ok), ["fx-006", "fx-007", "fx-008", "fx-009", "fx-010", "fx-011", "fx-012"]), "surviving head diffs normally");
	const fresh = await event.diff_since([], anchor, survivors);
	check(fresh.complete === true && fresh.events.length === 8, "fresh peer bootstraps the surviving log");
}

// §4 — delta + snapshot composes to the full-replay fingerprint (bi#35).
{
	const full = fixture.events;
	const snap = full.slice(0, 8);
	const snapHeads = await event.current_heads(snap);
	const d = await event.diff_since(snapHeads, noAnchor, full);
	const composed = [...snap, ...d.events];
	check(
		(await event.projection_fingerprint(await event.reduce(composed))) ===
			(await event.projection_fingerprint(await event.reduce(full))),
		"delta + snapshot composes to the full-replay fingerprint",
	);
	check(
		(await event.projection_fingerprint(await event.reduce(d.events))) !==
			(await event.projection_fingerprint(await event.reduce(full))),
		"delta alone is not the full state",
	);
}

// §5 — large-scale soak: 5000 seeded events, 5 sequential deltas compose.
{
	const N = 5000;
	const t0 = Date.now();
	const big = genScaleEvents(N, 4242);
	const step = 1000;
	let heads = [];
	const got = [];
	for (let end = step; end <= N; end += step) {
		const d = await event.diff_since(heads, noAnchor, big.slice(0, end));
		if (!d.complete) check(false, `large-scale chunk to ${end} must stay complete`);
		heads = d.heads;
		got.push(...ids(d));
	}
	check(eq(got, big.map((e) => e.id)), `5000-event log composes over 5 sequential deltas`);
	const steady = await event.diff_since(heads, noAnchor, big);
	check(steady.complete === true && steady.events.length === 0, "large-scale steady-state poll is empty but complete");
	const elapsed = Date.now() - t0;
	console.log(`info: large-scale 5000-event soak took ${(elapsed / 1000).toFixed(1)}s`);
	check(elapsed < 120_000, "large-scale soak inside the 120s budget");
}

// §6 — live serve: GET /sync?heads= serves BAML-computed from→to deltas,
// GET /sync/digest serves the version gate, legacy filters keep working.
{
	const root = mkdtempSync(join(tmpdir(), "bais-delta-"));
	const dirA = join(root, "a", ".bais", "issues");
	mkdirSync(dirA, { recursive: true });
	const toml = (id, title) => `id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "Feat"\nbody = "delta serve fixture"\n`;
	writeFileSync(join(dirA, "t1.toml"), toml("t1", "alpha"));
	writeFileSync(join(dirA, "t2.toml"), toml("t2", "beta"));
	await store.ingestIssues(dirA);
	const { hub: hubA } = await createHub(dirA, { port: 0 });
	const baseA = `http://127.0.0.1:${hubA.port}`;
	const postA = async (path, body) => {
		const r = await fetch(baseA + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, json: await r.json() };
	};
	const getA = async (path) => await (await fetch(baseA + path)).json();
	try {
		const claim = await postA("/claim", { task: "t1", holder: "did:key:delta-soak", ttl: 100000, epoch: 0, idem: "d1" });
		check(claim.status === 200, "serve hub admitted a claim");
		const full = await getA("/sync");
		const allIds = full.events.map((e) => e.id);
		check(allIds.length >= 3, `legacy GET /sync still serves the full log (${allIds.length} events)`);

		const digest = await getA("/sync/digest");
		check(digest.reducer_version === liveVersion && digest.anchor_lc === 0, "digest serves the version gate (version + anchor_lc)");

		const first2 = allIds.slice(0, 2).join(",");
		const delta = await getA(`/sync?heads=${first2}&reducer_version=${liveVersion}`);
		check(
			delta.complete === true && eq(delta.events.map((e) => e.id), allIds.slice(2)),
			"GET /sync?heads= serves the from→to delta",
		);
		check((delta.backup?.cli ?? "").includes("bais sync --from"), "every delta names the backup lane");
		const empty = await getA(`/sync?heads=${allIds.join(",")}&reducer_version=${liveVersion}`);
		check(empty.complete === true && empty.events.length === 0, "live steady-state delta is empty but complete");
		const staleV = await getA(`/sync?heads=${first2}&reducer_version=bais.reduce@0`);
		check(
			staleV.complete === false && staleV.events.length === 0 && (staleV.reason ?? "").startsWith("version-skew"),
			"live stale-version delta refuses with version-skew",
		);
		// Unversioned callers are served optimistically with the version
		// stamped, so they can pin it on the next poll.
		const unversioned = await getA(`/sync?heads=${first2}`);
		check(unversioned.complete === true && unversioned.reducer_version === liveVersion, "unversioned heads call served + version stamped");

		// Prune, then the gone head must re-bootstrap naming the snapshot.
		const cp = await postA("/checkpoint", {});
		check(cp.status === 200, "checkpoint published before prune");
		const prunedId = allIds[0];
		const prune = await postA("/prune", {});
		check(prune.status === 200, "pruned below the checkpoint");
		const digest2 = await getA("/sync/digest");
		check(digest2.anchor_lc > 0, "digest reports the prune anchor floor");
		const gone = await getA(`/sync?heads=${prunedId}&reducer_version=${liveVersion}`);
		check(gone.complete === false && gone.events.length === 0, "pruned-away head over HTTP is incomplete with no events");
		const snap = await getA("/snapshot");
		check(
			(gone.reason ?? "").includes(snap.snapshot.anchor.state_root),
			"live rebootstrap names the snapshot state_root",
		);

		// §7 — backup lane: a snapshot-restored peer carries the anchor
		// forward and degrades loudly on the same head.
		check(snap.snapshot.anchor?.checkpoint === cp.json.checkpoint.id, "snapshot carries the prune anchor");
		const dirC = join(root, "c", ".bais", "issues");
		mkdirSync(dirC, { recursive: true });
		store.importSnapshot(dirC, snap.snapshot, baseA);
		store.recordImportedAnchor(dirC, snap.snapshot.anchor, snap.snapshot.anchor_state, snap.snapshot.cursors);
		// Reseal: recordImportedAnchor seals BEFORE writing author_cursors
		// (the CLI flow reseals via the backfill writes that follow; this
		// script does no writes, so it reseals explicitly — no store.ts
		// change, which is outside bi#47's file ownership).
		{
			const { DatabaseSync } = await import("node:sqlite");
			const { resolve } = await import("node:path");
			const db = new DatabaseSync(resolve(dirC, "..", "store.db"));
			try {
				store.sealProjection(db);
			} finally {
				db.close();
			}
		}
		store.markBootstrapComplete(dirC, "signature");
		const { hub: hubC } = await createHub(dirC, { port: 0 });
		try {
			const baseC = `http://127.0.0.1:${hubC.port}`;
			const goneC = await (await fetch(`${baseC}/sync?heads=${prunedId}&reducer_version=${liveVersion}`)).json();
			check(
				goneC.complete === false && goneC.events.length === 0 && (goneC.reason ?? "").includes(snap.snapshot.anchor.state_root),
				"restored peer re-bootstraps on the same state_root (backup lane proven)",
			);
			const freshC = await (await fetch(`${baseC}/sync?heads=&reducer_version=${liveVersion}`)).json();
			check(freshC.complete === true, "restored peer serves fresh-bootstrap deltas");
		} finally {
			await hubC.close();
		}
	} finally {
		await hubA.close();
	}
}

// §8 — heads-param parsing is strict about empties, trimming, and dupes.
check(eq(deltaServe.parseHeadsParam(null), []), "null heads parses to []");
check(eq(deltaServe.parseHeadsParam(""), []), "empty heads parses to []");
check(eq(deltaServe.parseHeadsParam("a, b,,a"), ["a", "b"]), "heads trim + dedupe");

console.log(failures === 0 ? "delta-soak: ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
