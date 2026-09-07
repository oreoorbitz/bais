// bais/scripts/sync-adversarial.mjs — adversarial sync refusal suite (bi#37 Mode A).
//
// Run from the repo root: node bais/scripts/sync-adversarial.mjs [--now <ISO|epoch-ms>]
// Exits non-zero on any failure. Fully in-process: node:sqlite + direct
// imports from bais/dist/src/*.js, plain `node`, no sockets, no loopback,
// no child processes. All state lives under mkdtemp dirs — real .bais
// dirs are never touched. BAML owns the verify predicates
// (baml_src/ns_event/sync_verify.baml — pure verdicts + `baml test`
// negatives); this script only executes attacks on the host path and
// asserts the NAMED refusal reasons plus their oversight visibility.
//
// Parity map (BAML predicate -> host-observable reason asserted here):
//   lease_token_verdict expired-lease  -> reducer `not-current` (late renew)
//     + `lease-held: <holder>` (pre-bound rival); sync stages, reducer rules.
//   checkpoint_sync_verdict stale-checkpoint -> prune throws fail-closed
//     ("prune anchors on the latest checkpoint") — a throw, not evidence.
//   sync_poll_verdict unknown-subscriber -> `cap-denied` under a live-grant
//     consult (grant-backed, not stubbed — the consult mirrors BAML
//     cap_live over stored caps; see capCheckFromStore below).
//   replay_verdict replay-tamper/silent-skip -> identical host reasons;
//     tamper parks in rejected_evidence (slice-A collision parking), the
//     benign re-pull is a silent no-op, late arrivals keep first-copy.
//   replay_depth 0 (Done redelivery) -> accepted 0 + rejected 0, projection
//     identical. No-op subscriber (heartbeat-only sync) -> zero leases,
//     zero excluded, tasks unchanged: no phantom claims.
//
// Mode B (signature-required default) is NOT built: requireSigs exists as
// opt-in (drill (d) G-sig pins it); flipping the default needs key plumbing
// across CLI/Hub/MCP — a follow-up issue if this suite triggers it.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendForeignEvents, publishCheckpoint, pruneBelowCheckpoint, encodeBodyArrays } from "../dist/src/hub.js";
import { eventId } from "../dist/src/ids.js";
import {
	ingestIssues, storeList, storeLeases, storeCaps, storeOversight, dbPathFor,
} from "../dist/src/store.js";
import { clockFromArgv } from "./clock.mjs";

// bi#82: injectable wall-clock, same contract as fault-drills.mjs — fixture
// timestamps AND the dist hub gates see the same fixed time under --now.
const { clock } = clockFromArgv(process.argv);
console.log(`info: wall-clock ${clock.fixed ? `pinned at ${clock.nowISO()}` : "live"}`);

let failures = 0;
const drillFailures = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
let drill = "?";
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		drillFailures[drill]++;
		console.error(`FAIL [ADV-${drill}]: ${msg}`);
	} else console.log(`ok [ADV-${drill}]: ${msg}`);
};
process.on("unhandledRejection", (e) => { failures++; console.error(`FAIL [ADV-${drill}]: UNHANDLED REJECTION: ${(e && e.message) || e}`); });
process.on("uncaughtException", (e) => { failures++; console.error(`FAIL [ADV-${drill}]: UNCAUGHT: ${(e && e.message) || e}`); process.exit(1); });

const toml = (id, title) => `id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "Feat"\nbody = "adversarial fixture"\n`;
const canonTasks = (issuesDir) => JSON.stringify(storeList(issuesDir).tasks);
// bi#37: REAL content-hash ids (eventId over the encoded body); sign first
// when signed — the id covers the sig. Unsigned here (requireSigs off);
// the sig-required mode is Mode B, explicitly out of scope.
const mkForeign = (o) => {
	const body = encodeBodyArrays(o.body ?? {});
	const base = {
		author: o.author, seq: o.seq, prev: o.prev ?? null, project: o.project ?? "g",
		entity: o.entity, refs: o.refs ?? [], lc: o.lc, ts: o.ts ?? clock.nowISO(),
		type: o.type, body,
	};
	const id = eventId(base);
	return { ...base, id, sig: null, admitted: true, drop_reason: null };
};
const mkTree = (tag) => {
	const root = mkdtempSync(join(tmpdir(), `bais-adv-${tag}-`));
	const issues = join(root, ".bais", "issues");
	mkdirSync(issues, { recursive: true });
	return { root, issues };
};
// Reducer verdicts for sync-admitted events land in the excluded table
// (admitted=1 rows the reducer rules evidence, not state) — read the named
// reason, or null when the event stands.
const exclReason = (issuesDir, id) => {
	const db = new DatabaseSync(dbPathFor(issuesDir));
	try {
		return db.prepare("SELECT reason FROM excluded WHERE event_id = ?").get(id)?.reason ?? null;
	} finally {
		db.close();
	}
};
const holderOf = (issuesDir, entity) =>
	(storeLeases(issuesDir).find((l) => l.entity === entity) ?? {}).holder ?? null;

// ---------------------------------------------------------------- ADV-1 expired leases refused, reclaim wins
// Sync stages lease-tied events without a liveness consult (no lease gate
// in appendForeignEvents) — the REDUCER refuses with the named reason.
// That split is the surface this section pins: every refusal below names
// its reason in excluded + oversight.
drill = "1";
{
	const t = mkTree("adv1");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);

	// lc-expiry: ttl 5 at lc 9100 dies at 9105.
	const DEAD = "did:key:adv1-dead", RIVAL = "did:key:adv1-rival", NEXT = "did:key:adv1-next";
	const c1 = mkForeign({
		author: DEAD, seq: 0, prev: null, entity: "t-adv1-lc",
		lc: 9100, type: "LeaseClaim", body: { ttl: 5, epoch: 0, idem: "d1", read_set: [] },
	});
	const a1 = await appendForeignEvents(t.issues, [c1]);
	check(a1.accepted.length === 1 && a1.accepted[0] === c1.id, "ADV-1 setup: short lease admitted");
	check(holderOf(t.issues, "t-adv1-lc") === DEAD, "ADV-1 setup: dead holder holds");

	// Pre-expiry rival: staged by sync, refused lease-held by the reducer.
	const probe = mkForeign({
		author: RIVAL, seq: 0, prev: null, entity: "t-adv1-lc",
		lc: 9101, type: "LeaseClaim", body: { ttl: 5, epoch: 0, idem: "p1", read_set: [] },
	});
	const ap = await appendForeignEvents(t.issues, [probe]);
	check(ap.accepted.length === 1, "ADV-1 pre-expiry rival stages (sync admits, reducer rules)");
	check(exclReason(t.issues, probe.id) === `lease-held: ${DEAD}`, `ADV-1 pre-expiry rival excluded lease-held (got ${exclReason(t.issues, probe.id)})`);
	check(holderOf(t.issues, "t-adv1-lc") === DEAD, "ADV-1 pre-expiry rival wins nothing");

	// Post-expiry reclaim: the wall/lc freed the task, the claim stands.
	const c2 = mkForeign({
		author: NEXT, seq: 0, prev: null, entity: "t-adv1-lc",
		lc: 9106, type: "LeaseClaim", body: { ttl: 5, epoch: 0, idem: "n1", read_set: [] },
	});
	const a2 = await appendForeignEvents(t.issues, [c2]);
	check(a2.accepted.length === 1 && a2.accepted[0] === c2.id, "ADV-1 post-expiry reclaim admitted");
	check(exclReason(t.issues, c2.id) === null, "ADV-1 post-expiry reclaim not excluded (expiry freed it)");
	check(holderOf(t.issues, "t-adv1-lc") === NEXT, "ADV-1 post-expiry reclaim wins the task");

	// Wall-expiry: million-tick lc grant with a 60s wall bound (lc can
	// never free it — only the wall lapse may). Late renew is refused
	// not-current; a live renew inside the bound stands.
	const base = clock.nowMs();
	const iso = (ms) => clock.isoAt(ms);
	const bound = iso(base + 60_000);
	const WDEAD = "did:key:adv1-wdead", WLIVE = "did:key:adv1-wlive";
	const w1 = mkForeign({
		author: WDEAD, seq: 0, prev: null, entity: "t-adv1-wall",
		lc: 9200, ts: iso(base), type: "LeaseClaim",
		body: { ttl: 1000000, epoch: 0, idem: "w1", read_set: [], ttl_wall_ms: 60_000, expires_wall: bound },
	});
	await appendForeignEvents(t.issues, [w1]);
	const late = mkForeign({
		author: WDEAD, seq: 1, prev: w1.id, entity: "t-adv1-wall",
		lc: 9201, ts: iso(base + 61_000), type: "LeaseRenew", body: { lease_ref: w1.id },
	});
	const al = await appendForeignEvents(t.issues, [late]);
	check(al.accepted.length === 1, "ADV-1 late renew stages (sync admits, reducer rules)");
	check(exclReason(t.issues, late.id) === "not-current", `ADV-1 late renew past the bound refused not-current (got ${exclReason(t.issues, late.id)})`);
	const l1 = mkForeign({
		author: WLIVE, seq: 0, prev: null, entity: "t-adv1-live",
		lc: 9300, ts: iso(base), type: "LeaseClaim",
		body: { ttl: 1000000, epoch: 0, idem: "l1", read_set: [], ttl_wall_ms: 60_000, expires_wall: bound },
	});
	await appendForeignEvents(t.issues, [l1]);
	const rn = mkForeign({
		author: WLIVE, seq: 1, prev: l1.id, entity: "t-adv1-live",
		lc: 9301, ts: iso(base + 30_000), type: "LeaseRenew",
		body: { lease_ref: l1.id, expires_wall: iso(base + 90_000) },
	});
	const ar = await appendForeignEvents(t.issues, [rn]);
	check(ar.accepted.length === 1 && exclReason(t.issues, rn.id) === null, "ADV-1 live renew inside the bound stands");

	// Reducer exclusions of staged (admitted=1) rows live in the excluded
	// table; oversight's rejected_events unions only admitted=0 rows +
	// rejected_evidence (store.ts storeOversight), so lease-held /
	// not-current are NOT in that feed today — recorded as a follow-up
	// for the oversight lane in NOTES.md (gap, not camouflage: asserted
	// here at the home that actually holds them).
	const excld = (id) => {
		const db = new DatabaseSync(dbPathFor(t.issues));
		try {
			return db.prepare("SELECT reason FROM excluded WHERE event_id = ?").get(id)?.reason ?? null;
		} finally {
			db.close();
		}
	};
	check(excld(probe.id) === `lease-held: ${DEAD}`, "ADV-1 evidence: lease-held named in excluded");
	check(excld(late.id) === "not-current", "ADV-1 evidence: not-current named in excluded");
}

// ---------------------------------------------------------------- ADV-2 expired checkpoints refused
// A checkpoint below the prune floor is expired coverage: re-anchoring on
// it rewinds history the operator already truncated. The host refuses
// fail-closed (throw, not evidence); the BAML stale-checkpoint predicate
// names the same verdict for consults.
drill = "2";
{
	const t = mkTree("adv2");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const cp1 = await publishCheckpoint(t.issues);
	const w = mkForeign({
		author: "did:key:adv2-w", seq: 0, prev: null, entity: "t-new",
		lc: 9500, type: "TaskCreate", body: { title: "new", kind: "Feat", body: "x" },
	});
	const aw = await appendForeignEvents(t.issues, [w]);
	check(aw.accepted.length === 1, "ADV-2 setup: post-checkpoint write admitted");
	const cp2 = await publishCheckpoint(t.issues);
	check(cp2.id !== cp1.id, "ADV-2 setup: second checkpoint supersedes the first");
	let threw = null;
	try {
		await pruneBelowCheckpoint(t.issues, cp1.id);
	} catch (e) {
		threw = e;
	}
	check(!!threw && /latest checkpoint/.test(threw?.message ?? ""), `ADV-2 stale re-anchor refused fail-closed (got ${(threw?.message ?? "ADMITTED").slice(0, 60)})`);
}

// ---------------------------------------------------------------- ADV-3 unknown subscribers refused (grant-backed)
// The consult mirrors BAML cap_live over STORED caps (not a stub): audience
// match, unrevoked, expiry_lc > at_lc, action covered, scope exact-or-wild.
// Hub action/scope mapping mirrors actionForType (hub.ts): task.* writes
// need task.write on the entity scope. Unknown authors have no grant —
// they are unknown subscribers, and the write is cap-denied evidence.
drill = "3";
{
	const t = mkTree("adv3");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const ISSUER = "did:key:adv3-issuer", AUD = "did:key:adv3-aud";
	const capCheckFromStore = (author, action, scope, atLc) => storeCaps(t.issues).some((c) =>
		c.audience === author && !c.revoked && c.expiry_lc > atLc &&
		c.can.includes(action) && (c.scope === "*" || c.scope === scope));
	const grant = mkForeign({
		author: ISSUER, seq: 0, prev: null, entity: AUD, lc: 9100, type: "CapGrant",
		body: { audience: AUD, can: ["task.write"], scope: "*", expiry_lc: 99999 },
	});
	const ag = await appendForeignEvents(t.issues, [grant]);
	check(ag.accepted.length === 1, "ADV-3 setup: grant admitted");
	check(storeCaps(t.issues).some((c) => c.audience === AUD && !c.revoked), "ADV-3 setup: grant live in projection");
	const stranger = mkForeign({
		author: "did:key:adv3-stranger", seq: 0, prev: null, entity: "t-s",
		lc: 9101, type: "TaskCreate", body: { title: "s", kind: "Feat", body: "x" },
	});
	const rs = await appendForeignEvents(t.issues, [stranger], {
		capCheck: (author, action, scope, atLc) => action !== null && capCheckFromStore(author, action, scope, atLc),
	});
	check(rs.accepted.length === 0 && rs.rejected.length === 1 && rs.rejected[0].reason === "cap-denied",
		`ADV-3 unknown subscriber refused cap-denied (got ${JSON.stringify(rs.rejected)})`);
	const funded = mkForeign({
		author: AUD, seq: 0, prev: null, entity: "t-a",
		lc: 9102, type: "TaskCreate", body: { title: "a", kind: "Feat", body: "x" },
	});
	const rf = await appendForeignEvents(t.issues, [funded], {
		capCheck: (author, action, scope, atLc) => action !== null && capCheckFromStore(author, action, scope, atLc),
	});
	check(rf.accepted.length === 1 && rf.accepted[0] === funded.id, "ADV-3 granted author admits the identical shape");
	check(storeOversight(t.issues).rejected_events.some((r) => r.reason === "cap-denied"),
		"ADV-3 oversight: cap-denied visible in rejected_events");
}

// ---------------------------------------------------------------- ADV-4 collision-parked + replayed for late arrivals
// Same-id-different-bytes collides with the stored id PK: slice-A parks the
// full wire copy in rejected_evidence instead of swallowing it. Late
// arrivals keep the first copy — benign re-pulls stay silent no-ops, repeat
// tamper stays loud without duplicating the park.
drill = "4";
{
	const t = mkTree("adv4");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const H = "did:key:adv4-h";
	const honest = mkForeign({
		author: H, seq: 0, prev: null, entity: "t-honest",
		lc: 9000, type: "TaskCreate", body: { title: "honest", kind: "Feat", body: "x" },
	});
	const ah = await appendForeignEvents(t.issues, [honest]);
	check(ah.accepted.length === 1 && ah.accepted[0] === honest.id, "ADV-4 setup: honest event admitted");
	const tampered = { ...honest, body: { ...honest.body, title: "tampered" } };
	const rt = await appendForeignEvents(t.issues, [tampered]);
	check(rt.accepted.length === 0 && rt.rejected.length === 1 && rt.rejected[0].reason === "replay-tamper",
		`ADV-4 tampered replay is loud replay-tamper (got ${JSON.stringify(rt.rejected)})`);
	const parked = () => {
		const db = new DatabaseSync(dbPathFor(t.issues));
		try {
			return db.prepare("SELECT event_id, reason FROM rejected_evidence").all();
		} finally {
			db.close();
		}
	};
	const p1 = parked();
	check(p1.length === 1 && p1[0].event_id === honest.id && p1[0].reason === "replay-tamper",
		`ADV-4 attack parked with full wire copy (got ${JSON.stringify(p1)})`);
	const benign = await appendForeignEvents(t.issues, [{ ...honest }]);
	check(benign.accepted.length === 0 && benign.rejected.length === 0, "ADV-4 benign re-pull stays a silent no-op");
	const late = await appendForeignEvents(t.issues, [{ ...tampered }]);
	check(late.accepted.length === 0 && late.rejected.length === 1 && late.rejected[0].reason === "replay-tamper",
		"ADV-4 late tampered arrival stays loud (first copy stands)");
	check(parked().length === 1, "ADV-4 park not duplicated by the late arrival");
	check(canonTasks(t.issues).includes("t-honest"), "ADV-4 projection still the honest task");
	check(storeOversight(t.issues).rejected_events.some((r) => r.id === honest.id && r.reason === "replay-tamper"),
		"ADV-4 oversight: replay-tamper visible in rejected_events");
}

// ---------------------------------------------------------------- ADV-5 done redelivery has replay depth zero
// A settled task's full event set redelivered: every id is known, bytes
// identical — the benign re-pull path skips each silently. Depth 0 means
// nothing admitted, nothing refused, projection byte-identical.
drill = "5";
{
	const t = mkTree("adv5");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const A = "did:key:adv5-a";
	const e1 = mkForeign({
		author: A, seq: 0, prev: null, entity: "t-done",
		lc: 9000, type: "TaskCreate", body: { title: "done-task", kind: "Feat", body: "x" },
	});
	const e2 = mkForeign({
		author: A, seq: 1, prev: e1.id, entity: "t-done",
		lc: 9001, type: "TaskTransition", body: { to: "Doing" },
	});
	const e3 = mkForeign({
		author: A, seq: 2, prev: e2.id, entity: "t-done",
		lc: 9002, type: "TaskTransition", body: { to: "Done" },
	});
	const settled = [e1, e2, e3];
	const as = await appendForeignEvents(t.issues, settled);
	check(as.accepted.length === 3, "ADV-5 setup: done-task log admitted");
	check(storeList(t.issues).tasks.some((x) => x.entity === "t-done" && x.status === "Done"), "ADV-5 setup: task settled Done");
	const before = canonTasks(t.issues);
	const replay = await appendForeignEvents(t.issues, settled.map((e) => ({ ...e })));
	check(replay.accepted.length === 0, "ADV-5 redelivery admits nothing (replay depth 0)");
	check(replay.rejected.length === 0, "ADV-5 redelivery refuses nothing (silent re-pull, not evidence)");
	check(canonTasks(t.issues) === before, "ADV-5 projection identical after redelivery");
}

// ---------------------------------------------------------------- ADV-6 no-op subscriber creates no phantom claims
// A subscriber that only syncs ephemeral noise (heartbeats, one per fresh
// author) stages events the reducer ignores by design: zero leases, zero
// submissions, zero excluded, tasks unchanged. Polling must never mint
// standing.
drill = "6";
{
	const t = mkTree("adv6");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const before = canonTasks(t.issues);
	const noise = [0, 1, 2].map((i) => mkForeign({
		author: `did:key:adv6-noise${i}`, seq: 0, prev: null, entity: "t1",
		lc: 9000 + i, type: i % 2 ? "Progress" : "Heartbeat", body: { note: "alive" },
	}));
	const an = await appendForeignEvents(t.issues, noise);
	check(an.accepted.length === 3 && an.rejected.length === 0, "ADV-6 setup: ephemeral noise stages");
	check(storeLeases(t.issues).length === 0, `ADV-6 no phantom claims (leases ${storeLeases(t.issues).length})`);
	const db = new DatabaseSync(dbPathFor(t.issues));
	let excl = -1;
	try {
		excl = db.prepare("SELECT COUNT(*) n FROM excluded").get().n;
	} finally {
		db.close();
	}
	check(excl === 0, `ADV-6 no phantom evidence (excluded ${excl})`);
	check(canonTasks(t.issues) === before, "ADV-6 tasks unchanged by subscriber noise");
}

// ---------------------------------------------------------------- summary
const verdict = (k) => (drillFailures[k] ? "FAIL" : "PASS");
console.log(`adversarial (1) expired leases: ${verdict("1")}`);
console.log(`adversarial (2) expired checkpoints: ${verdict("2")}`);
console.log(`adversarial (3) unknown subscribers: ${verdict("3")}`);
console.log(`adversarial (4) collision-park + replay: ${verdict("4")}`);
console.log(`adversarial (5) done replay depth 0: ${verdict("5")}`);
console.log(`adversarial (6) no-op subscriber: ${verdict("6")}`);
console.log("loopback needed: NO — fully in-process (node:sqlite + dist imports); no sockets opened, no child processes spawned.");
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("adversarial sync: all green");
