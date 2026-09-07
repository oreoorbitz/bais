// bais/scripts/reject-audit.mjs — bi#55 no-fail-closed-without-a-named-reason audit proof.
//
// Run from the repo root: node bais/scripts/reject-audit.mjs
// Exits non-zero on any failure. Proves the audit table in NOTES (delivered
// alongside): every reject/exclude/park path in hub + store + reducer yields
// a NAMED reason already visible in oversight --json (storeOversight, the
// exact object the CLI prints) or on the CLI diagnostic channel, and one
// deliberately triggered rejection per path shows its reason there.
//
// Layout: S-drills run fully in-process (node:sqlite + dist imports, no
// sockets — the sync/staging path); H-drills drive a live hub over loopback
// (createHub + fetch, the lease-race.mjs precedent) for the coordinator
// paths whose refusals never touch the sync validator. All state lives under
// mkdtemp dirs — real .bais dirs are never touched.
//
// Reference implementation: bi#48 why-not (S9 pins BlockedBy/DanglingRef/
// Leased over the store projection). Mode-A seed: bi#37's finding that
// oversight rejected_events missed staging exclusions (lease-held /
// not-current lived in `excluded` only) — S1/S2 pin the closed gap.
//
// Red-checks (bi#57) — each safety hunk below must fail FOR THE RIGHT
// REASON when reverted; observations recorded in the delivery NOTES:
//   R-store  revert the store.ts rejected_events third leg (excluded JOIN)
//            → S1/S2/S3/S4/S7/S8 oversight assertions go red with the
//            reason missing from the feed (response/return-code asserts
//            stay green — the park, not the verdict, is load-bearing).
//   R-park   drop one hub.ts parkRefusal call (e.g. claim decide-fail) →
//            the matching H-drill's 409 assert stays green while its
//            oversight assert goes red (refusal fires, nobody reports it).
//   R-cli    drop the warnScanFallback() call in the list branch → S10's
//            stderr assert goes red while stdout truth stays green.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHub, appendForeignEvents, encodeBodyArrays } from "../dist/src/hub.js";
import { eventId } from "../dist/src/ids.js";
import {
	ingestIssues, storeOversight, storeWhyNot, storeLeases, dbPathFor,
} from "../dist/src/store.js";

let failures = 0;
const drillFailures = {};
let drill = "?";
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		drillFailures[drill] = (drillFailures[drill] ?? 0) + 1;
		console.error(`FAIL [R-${drill}]: ${msg}`);
	} else console.log(`ok [R-${drill}]: ${msg}`);
};
process.on("unhandledRejection", (e) => { failures++; console.error(`FAIL [R-${drill}]: UNHANDLED REJECTION: ${(e && e.message) || e}`); });
process.on("uncaughtException", (e) => { failures++; console.error(`FAIL [R-${drill}]: UNCAUGHT: ${(e && e.message) || e}`); process.exit(1); });

const toml = (id, title, extra = "") => `id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "Feat"\nbody = "reject-audit fixture"\n${extra}`;
const mkTree = (tag) => {
	const root = mkdtempSync(join(tmpdir(), `bais-reject-${tag}-`));
	const issues = join(root, ".bais", "issues");
	mkdirSync(issues, { recursive: true });
	writeFileSync(join(root, ".bais", "config.toml"), 'project = "g"\n');
	return { root, issues };
};
// REAL content-hash ids over the encoded body (bi#38): chain links
// reference predecessor ids, never dev labels.
const mkForeign = (o) => {
	const body = encodeBodyArrays(o.body ?? {});
	const base = {
		author: o.author, seq: o.seq, prev: o.prev ?? null, project: o.project ?? "g",
		entity: o.entity, refs: o.refs ?? [], lc: o.lc, ts: o.ts ?? new Date().toISOString(),
		type: o.type, body,
	};
	const id = eventId(base);
	return { ...base, id, sig: null, admitted: true, drop_reason: null };
};
const reasonsOf = (issuesDir) => new Set(storeOversight(issuesDir).rejected_events.map((r) => r.reason));
const hasReason = (issuesDir, want) =>
	storeOversight(issuesDir).rejected_events.some((r) => r.reason === want || r.reason.startsWith(`${want}:`));

// ---------------------------------------------------------------- S1 staging lease-held (bi#37 Mode-A seed)
// Sync stages the rival claim (no lease gate in appendForeignEvents) — the
// REDUCER refuses it lease-held:<holder> into the excluded table, and the
// oversight feed must carry it (the gap: it used to live in excluded only).
drill = "S1";
{
	const t = mkTree("s1");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const DEAD = "did:key:r1-dead", RIVAL = "did:key:r1-rival";
	const c1 = mkForeign({ author: DEAD, seq: 0, entity: "t-x", lc: 9100, type: "LeaseClaim", body: { ttl: 500, epoch: 0, idem: "d1", read_set: [] } });
	check((await appendForeignEvents(t.issues, [c1])).accepted.length === 1, "S1 setup: first claim admitted");
	const rival = mkForeign({ author: RIVAL, seq: 0, entity: "t-x", lc: 9101, type: "LeaseClaim", body: { ttl: 500, epoch: 0, idem: "p1", read_set: [] } });
	const ap = await appendForeignEvents(t.issues, [rival]);
	check(ap.accepted.length === 1, "S1 setup: rival stages (sync admits, reducer rules)");
	check(hasReason(t.issues, `lease-held: ${DEAD}`), `S1 oversight: lease-held:${DEAD} visible in rejected_events`);
}

// ---------------------------------------------------------------- S2 staging not-current (bi#37 Mode-A seed)
// lc-expiry: ttl 5 at lc 9100 dies at 9105; the late renew stages and the
// reducer refuses it not-current — visible in the same feed.
drill = "S2";
{
	const t = mkTree("s2");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const H = "did:key:r2-h";
	const c1 = mkForeign({ author: H, seq: 0, entity: "t-y", lc: 9100, type: "LeaseClaim", body: { ttl: 5, epoch: 0, idem: "d1", read_set: [] } });
	await appendForeignEvents(t.issues, [c1]);
	const late = mkForeign({ author: H, seq: 1, prev: c1.id, entity: "t-y", lc: 9106, type: "LeaseRenew", body: { lease_ref: c1.id } });
	const al = await appendForeignEvents(t.issues, [late]);
	check(al.accepted.length === 1, "S2 setup: late renew stages (sync admits, reducer rules)");
	check(hasReason(t.issues, "not-current"), "S2 oversight: not-current visible in rejected_events");
}

// ---------------------------------------------------------------- S3 staging stale-fence (fencing rejection)
// A task under an active lease moves only on an exact fencing-token echo;
// the bare transition stages and is refused stale-fence.
drill = "S3";
{
	const t = mkTree("s3");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const H = "did:key:r3-h";
	const c1 = mkForeign({ author: H, seq: 0, entity: "t1", lc: 9100, type: "LeaseClaim", body: { ttl: 500, epoch: 0, idem: "d1", read_set: [] } });
	await appendForeignEvents(t.issues, [c1]);
	const bare = mkForeign({ author: H, seq: 1, prev: c1.id, entity: "t1", lc: 9101, type: "TaskTransition", body: { to: "Doing" } });
	const ab = await appendForeignEvents(t.issues, [bare]);
	check(ab.accepted.length === 1, "S3 setup: unfenced transition stages (sync admits, reducer rules)");
	check(hasReason(t.issues, "stale-fence"), "S3 oversight: stale-fence visible in rejected_events");
}

// ---------------------------------------------------------------- S4 staging needs-approval (approval gate)
// A needs-human task cannot transition to Dropped while the flag stands;
// removing the label IS the approval.
drill = "S4";
{
	const t = mkTree("s4");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const H = "did:key:r4-h";
	const mk = (seq, prev, type, body, entity, lc) => mkForeign({ author: H, seq, prev, entity, lc, type, body });
	const e1 = mk(0, null, "TaskCreate", { title: "gated", kind: "Feat", body: "x" }, "t-g", 9100);
	const e2 = mk(1, e1.id, "LabelAdd", { label: "needs-human" }, "t-g", 9101);
	const e3 = mk(2, e2.id, "TaskTransition", { to: "Dropped" }, "t-g", 9102);
	check((await appendForeignEvents(t.issues, [e1, e2, e3])).accepted.length === 3, "S4 setup: create+label+drop-transition stage");
	check(hasReason(t.issues, "needs-approval"), "S4 oversight: needs-approval visible in rejected_events");
}

// ---------------------------------------------------------------- S5 sync chain-break (continuity gate)
// A seq gap against the author's head breaks before the reducer ever sees
// the event; the rejection persists as evidence with its reason.
drill = "S5";
{
	const t = mkTree("s5");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const gap = mkForeign({ author: "did:key:r5-h", seq: 7, entity: "t-z", lc: 9100, type: "TaskCreate", body: { title: "gap", kind: "Feat", body: "x" } });
	const rg = await appendForeignEvents(t.issues, [gap]);
	check(rg.accepted.length === 0 && rg.rejected.length === 1 && rg.rejected[0].reason === "chain-break",
		`S5 sync: seq gap refused chain-break (got ${JSON.stringify(rg.rejected)})`);
	check(hasReason(t.issues, "chain-break"), "S5 oversight: chain-break visible in rejected_events");
}

// ---------------------------------------------------------------- S6 sync cap-denied (capability gate)
// An author with no live cap for the action+scope is refused before bounds;
// the stranger's write lands as cap-denied evidence.
drill = "S6";
{
	const t = mkTree("s6");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const denyAll = () => false;
	const stranger = mkForeign({ author: "did:key:r6-stranger", seq: 0, entity: "t-s", lc: 9100, type: "TaskCreate", body: { title: "s", kind: "Feat", body: "x" } });
	const rs = await appendForeignEvents(t.issues, [stranger], { capCheck: denyAll });
	check(rs.accepted.length === 0 && rs.rejected.length === 1 && rs.rejected[0].reason === "cap-denied",
		`S6 sync: unknown author refused cap-denied (got ${JSON.stringify(rs.rejected)})`);
	check(hasReason(t.issues, "cap-denied"), "S6 oversight: cap-denied visible in rejected_events");
}

// ---------------------------------------------------------------- S7 sync budget-exhausted (spam lever)
// Exhausted in BOTH dimensions (incurred >= cap on usd AND tokens) opens no
// new state; wind-down/funding/protocol stay open. The refused write is
// budget-exhausted evidence.
drill = "S7";
{
	const t = mkTree("s7");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const POOR = "did:key:r7-poor";
	const bev = (seq, prev, type, body, entity, lc) => mkForeign({ author: POOR, seq, prev, entity, lc, type, body });
	const auth = bev(0, null, "BudgetAuthorize", { cap_usd: 1.0, cap_tokens: 10 }, POOR, 9100);
	const res = bev(1, auth.id, "CostReserve", { task: "t1", usd: 1.0, tokens: 10 }, POOR, 9101);
	const inc = bev(2, res.id, "CostIncurred", { reserve_ref: res.id, task: "t1", usd: 1.0, tokens: 10 }, POOR, 9102);
	check((await appendForeignEvents(t.issues, [auth, res, inc])).accepted.length === 3, "S7 setup: authorize+reserve+incur admitted (poor exhausted 1.0/10)");
	const write = bev(3, inc.id, "TaskCreate", { title: "poor write", kind: "Feat", body: "x" }, "t-poor", 9103);
	const rw = await appendForeignEvents(t.issues, [write]);
	check(rw.accepted.length === 0 && rw.rejected.length === 1 && rw.rejected[0].reason === "budget-exhausted",
		`S7 sync: exhausted author opens no new state (got ${JSON.stringify(rw.rejected)})`);
	check(hasReason(t.issues, "budget-exhausted"), "S7 oversight: budget-exhausted visible in rejected_events");
}

// ---------------------------------------------------------------- S8 stalled lease + chain-break evidence (stall feed)
// The sweep expires over max ADMITTED lc only; a high-lc evidence row
// advances as_of past a live lease's expires_lc, so the lease reads
// stalled (active in projection, past its bound) — the exception feed,
// not silence. The evidence row itself is the chain-break surface.
drill = "S8";
{
	const t = mkTree("s8");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	await ingestIssues(t.issues);
	const H = "did:key:r8-h";
	const c1 = mkForeign({ author: H, seq: 0, entity: "t-stall", lc: 9100, type: "LeaseClaim", body: { ttl: 2, epoch: 0, idem: "d1", read_set: [] } });
	await appendForeignEvents(t.issues, [c1]);
	const gap = mkForeign({ author: "did:key:r8-noisy", seq: 9, entity: "t-noise", lc: 9200, type: "TaskCreate", body: { title: "n", kind: "Feat", body: "x" } });
	const rg = await appendForeignEvents(t.issues, [gap]);
	check(rg.rejected.length === 1 && rg.rejected[0].reason === "chain-break", "S8 setup: high-lc gap stored as chain-break evidence");
	const ov = storeOversight(t.issues);
	check(ov.stalled_leases.some((l) => l.task === "t-stall" && l.holder === H && l.expires_lc === 9102),
		`S8 oversight: lease past its bound reads stalled (got ${JSON.stringify(ov.stalled_leases)})`);
	check(ov.rejected_events.some((r) => r.reason === "chain-break"), "S8 oversight: chain-break evidence visible in rejected_events");
}

// ---------------------------------------------------------------- S9 ready parks (bi#48 why-not reference)
// BlockedBy (live blocker), DanglingRef (Missing end), Leased (projection
// lease) — each omission carries the exact edge/lease behind it.
drill = "S9";
{
	const t = mkTree("s9");
	writeFileSync(join(t.issues, "a1.toml"), toml("a1", "blocked", '[[edge]]\nfrom = "a2"\nto = "a1"\nkind = "Blocks"\n'));
	writeFileSync(join(t.issues, "a2.toml"), toml("a2", "blocker"));
	writeFileSync(join(t.issues, "b1.toml"), toml("b1", "dangling", '[[edge]]\nfrom = "b-missing"\nto = "b1"\nkind = "Blocks"\n'));
	writeFileSync(join(t.issues, "c1.toml"), toml("c1", "leased"));
	await ingestIssues(t.issues);
	const H = "did:key:r9-h";
	const c1 = mkForeign({ author: H, seq: 0, entity: "c1", lc: 9100, type: "LeaseClaim", body: { ttl: 500, epoch: 0, idem: "d1", read_set: [] } });
	await appendForeignEvents(t.issues, [c1]);
	const { reasons } = storeWhyNot(t.issues);
	const byId = new Map(reasons.map((r) => [r.id, r]));
	check(byId.get("a1")?.kind === "BlockedBy" && byId.get("a1")?.blocker === "a2",
		`S9 why-not: a1 parked BlockedBy a2 (got ${JSON.stringify(byId.get("a1"))})`);
	check(byId.get("b1")?.kind === "DanglingRef" && byId.get("b1")?.ref_id === "b-missing" && byId.get("b1")?.ref_status === "Missing",
		`S9 why-not: b1 parked DanglingRef b-missing/Missing (got ${JSON.stringify(byId.get("b1"))})`);
	check(byId.get("c1")?.kind === "Leased" && byId.get("c1")?.holder === H,
		`S9 why-not: c1 parked Leased to holder (got ${JSON.stringify(byId.get("c1"))})`);
}

// ---------------------------------------------------------------- S10 hasStore fallback (named reason on stderr)
// Storeless reads fall back to the directory scan — the fallback names
// itself on the diagnostic channel; stdout truth is byte-identical.
drill = "S10";
{
	const t = mkTree("s10");
	writeFileSync(join(t.issues, "t1.toml"), toml("t1", "alpha"));
	writeFileSync(join(t.issues, "t2.toml"), toml("t2", "beta"));
	const CLI = join(new URL(".", import.meta.url).pathname, "..", "dist", "src", "cli.js");
	const run = (args) => spawnSync("node", [CLI, ...args], { cwd: t.root, encoding: "utf8" });
	const li = run(["list", "--json"]);
	const lj = JSON.parse(li.stdout);
	check(li.status === 0 && lj.issues.map((f) => f.issue.id).sort().join(",") === "t1,t2",
		"S10 list: storeless stdout still serves truth");
	check(/no store\.db — directory scan/.test(li.stderr), `S10 list: fallback names its reason on stderr (got ${JSON.stringify(li.stderr.slice(0, 120))})`);
	const rd = run(["ready", "--json"]);
	check(rd.status === 0 && /no store\.db — directory scan/.test(rd.stderr), "S10 ready: fallback names its reason on stderr");
}

// ---------------------------------------------------------------- live-hub helpers (lease-race.mjs precedent)
const mkHubTree = async (tag, files) => {
	const t = mkTree(tag);
	for (const [name, content] of files) writeFileSync(join(t.issues, name), content);
	await ingestIssues(t.issues);
	return t;
};
const serve = async (t, limits) => {
	const { hub } = await createHub(t.issues, { port: 0, limits });
	const base = `http://127.0.0.1:${hub.port}`;
	const post = async (path, body) => {
		const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, json: await r.json() };
	};
	const get = async (path) => {
		const r = await fetch(base + path);
		return { status: r.status, json: await r.json() };
	};
	return { hub, post, get };
};

// ---------------------------------------------------------------- H1 hub fencing refusal parks (lease-held)
// A holds the task; B's identical-shape claim dies at decide — the 409
// names lease-held:<holder> AND the park lands in oversight (before bi#55
// the response was the only record).
drill = "H1";
{
	const t = await mkHubTree("h1", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post } = await serve(t);
	const A = "did:key:rh1-a", B = "did:key:rh1-b";
	const w = await post("/claim", { task: "t1", holder: A, ttl: 1000, epoch: 0, idem: "w1" });
	check(w.status === 200, "H1 setup: first claim admitted");
	const lo = await post("/claim", { task: "t1", holder: B, ttl: 1000, epoch: 0, idem: "l1" });
	check(lo.status === 409 && String(lo.json.reason).startsWith("lease-held:"),
		`H1 hub: rival refused 409 lease-held (got ${lo.status} ${lo.json.reason})`);
	check(hasReason(t.issues, `lease-held: ${A}`), "H1 oversight: parked lease-held visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- H2 hub cap-denied parks (capability gate)
// Under requireCaps a stranger's claim is 403 — parked, not just answered.
drill = "H2";
{
	const t = await mkHubTree("h2", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post } = await serve(t, { requireCaps: true });
	const r = await post("/claim", { task: "t1", holder: "did:key:rh2-stranger", ttl: 100, epoch: 0, idem: "s1" });
	check(r.status === 403 && r.json.reason === "cap-denied",
		`H2 hub: stranger refused 403 cap-denied (got ${r.status} ${r.json.reason})`);
	check(hasReason(t.issues, "cap-denied"), "H2 oversight: parked cap-denied visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- H3 hub budget-exhausted parks (402 spam lever)
// Poor is funded to exhaustion through the hub's own sync; the claim is
// 402 with the named reason — parked.
drill = "H3";
{
	const t = await mkHubTree("h3", [["t2.toml", toml("t2", "budget task")]]);
	const { hub, post } = await serve(t);
	const POOR = "did:key:rh3-poor";
	const bev = (seq, prev, type, body, entity, lc) => {
		const enc = encodeBodyArrays(body);
		const base = { author: POOR, seq, prev, project: "t", entity, refs: [], lc, ts: new Date().toISOString(), type, body: enc };
		return { ...base, id: eventId(base), sig: null };
	};
	const authEv = bev(0, null, "BudgetAuthorize", { cap_usd: 1.0, cap_tokens: 10 }, POOR, 64000);
	const resEv = bev(1, authEv.id, "CostReserve", { task: "t2", usd: 1.0, tokens: 10 }, POOR, 64001);
	const incEv = bev(2, resEv.id, "CostIncurred", { reserve_ref: resEv.id, task: "t2", usd: 1.0, tokens: 10 }, POOR, 64002);
	const fund = await post("/sync", { events: [authEv, resEv, incEv] });
	check(fund.status === 200 && (fund.json.accepted ?? []).length === 3, "H3 setup: poor exhausted via hub sync");
	const poor = await post("/claim", { task: "t2", holder: POOR, ttl: 1000, epoch: 0, idem: "poor1" });
	check(poor.status === 402 && poor.json.reason === "budget-exhausted",
		`H3 hub: exhausted author refused 402 budget-exhausted (got ${poor.status} ${poor.json.reason})`);
	check(hasReason(t.issues, "budget-exhausted"), "H3 oversight: parked budget-exhausted visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- H4 hub frozen parks (hysteresis freeze)
// maxChangesPerWindow 1: claim + release trips the freeze; the next claim
// is 409 frozen — parked, and the freeze itself stays listed on /leases.
drill = "H4";
{
	const t = await mkHubTree("h4", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post, get } = await serve(t, { maxChangesPerWindow: 1, windowMs: 60000 });
	const A = "did:key:rh4-a", B = "did:key:rh4-b";
	const w = await post("/claim", { task: "t1", holder: A, ttl: 1000, epoch: 0, idem: "w1" });
	check(w.status === 200, "H4 setup: first claim admitted");
	const rel = await post("/release", { lease_ref: w.json.lease_id, holder: A });
	check(rel.status === 200, "H4 setup: release admitted (second change trips the freeze)");
	const fz = await post("/claim", { task: "t1", holder: B, ttl: 1000, epoch: 0, idem: "f1" });
	check(fz.status === 409 && fz.json.reason === "frozen",
		`H4 hub: post-freeze claim refused 409 frozen (got ${fz.status} ${fz.json.reason})`);
	check(hasReason(t.issues, "frozen"), "H4 oversight: parked frozen visible in rejected_events");
	const le = await get("/leases");
	check(le.json.frozen.some((f) => f.task === "t1"), "H4 leases: freeze listed on GET /leases");
	await hub.close();
}

// ---------------------------------------------------------------- H5 hub retry-budget-exhausted parks
// maxRenewsPerLease 0: the first renew is 409 — parked.
drill = "H5";
{
	const t = await mkHubTree("h5", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post } = await serve(t, { maxRenewsPerLease: 0 });
	const A = "did:key:rh5-a";
	const w = await post("/claim", { task: "t1", holder: A, ttl: 1000, epoch: 0, idem: "w1" });
	check(w.status === 200, "H5 setup: claim admitted");
	const rn = await post("/renew", { lease_ref: w.json.lease_id, holder: A });
	check(rn.status === 409 && rn.json.reason === "retry-budget-exhausted",
		`H5 hub: over-budget renew refused 409 (got ${rn.status} ${rn.json.reason})`);
	check(hasReason(t.issues, "retry-budget-exhausted"), "H5 oversight: parked retry-budget-exhausted visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- H6 hub unknown-lease parks (404 lookup miss)
// A renew for a lease the log never saw is 404 — the synthetic refused
// shape parks it in oversight too (no stored entity to commit to).
drill = "H6";
{
	const t = await mkHubTree("h6", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post } = await serve(t);
	const rn = await post("/renew", { lease_ref: "bafkrei-never-existed", holder: "did:key:rh6-a" });
	check(rn.status === 404 && rn.json.reason === "unknown-lease",
		`H6 hub: phantom renew refused 404 unknown-lease (got ${rn.status} ${rn.json.reason})`);
	check(hasReason(t.issues, "unknown-lease"), "H6 oversight: parked unknown-lease visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- H7 hub not-holder parks (fencing at decide)
// A stranger's renew of A's live lease sails through shape/cap gates and
// dies only at fencing — 409 not-holder, parked.
drill = "H7";
{
	const t = await mkHubTree("h7", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post } = await serve(t);
	const A = "did:key:rh7-a", Z = "did:key:rh7-zombie";
	const w = await post("/claim", { task: "t1", holder: A, ttl: 1000, epoch: 0, idem: "w1" });
	check(w.status === 200, "H7 setup: claim admitted");
	const z = await post("/renew", { lease_ref: w.json.lease_id, holder: Z });
	check(z.status === 409 && z.json.reason === "not-holder",
		`H7 hub: zombie renew refused 409 not-holder (got ${z.status} ${z.json.reason})`);
	check(hasReason(t.issues, "not-holder"), "H7 oversight: parked not-holder visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- H8 hub lease-active-at-anchor parks (prune fence)
// Checkpoint + prune, then a rival claim: the truncated decide cannot see
// the anchor lease, so the anchor fence refuses 409 — parked.
drill = "H8";
{
	const t = await mkHubTree("h8", [["t1.toml", toml("t1", "alpha")]]);
	const { hub, post } = await serve(t);
	const A = "did:key:rh8-a", B = "did:key:rh8-b";
	const w = await post("/claim", { task: "t1", holder: A, ttl: 100000, epoch: 0, idem: "w1" });
	check(w.status === 200, "H8 setup: anchor claim admitted");
	const cp = await post("/checkpoint", {});
	check(cp.status === 200, "H8 setup: checkpoint published");
	const pr = await post("/prune", {});
	check(pr.status === 200 && pr.json.pruned > 0, `H8 setup: pruned below checkpoint (${pr.json.pruned} rows)`);
	const ri = await post("/claim", { task: "t1", holder: B, ttl: 100, epoch: 0, idem: "r1" });
	check(ri.status === 409 && ri.json.reason === "lease-active-at-anchor",
		`H8 hub: post-prune rival refused 409 lease-active-at-anchor (got ${ri.status} ${ri.json.reason})`);
	check(hasReason(t.issues, "lease-active-at-anchor"), "H8 oversight: parked lease-active-at-anchor visible in rejected_events");
	await hub.close();
}

// ---------------------------------------------------------------- summary
const names = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8"];
for (const n of names) console.log(`reject-audit ${n}: ${drillFailures[n] ? "FAIL" : "PASS"}`);
console.log("loopback needed: PARTIAL — S-drills fully in-process (node:sqlite + dist imports); H-drills drive a live hub over 127.0.0.1 (lease-race.mjs precedent); no child processes except the S10 CLI probe.");
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("reject audit: all green — every fail-closed path names its reason in oversight --json (or the CLI channel for S9/S10)");

