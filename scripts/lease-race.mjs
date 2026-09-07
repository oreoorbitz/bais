// bais/scripts/lease-race.mjs — Phase 3 step 9 validation: concurrent
// claims serialize (one 200, one 409) and zombie writes are rejected.
// Run: npm run build --prefix bais && npm test --prefix bais
// (package.json "test" points here). Exits non-zero on any failure.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub, encodeBodyArrays } from "../dist/src/hub.js";
import { eventId } from "../dist/src/ids.js";
import { ingestIssues } from "../dist/src/store.js";
import { clockFromArgv } from "./clock.mjs";

// bi#82: injectable wall-clock. --now <ISO|epoch-ms> (or BAIS_NOW) pins
// Date.now + no-arg new Date() in-process BEFORE the hub boots, so fixture
// timestamps AND hub gate evaluations (clock-skew future bound, freeze
// windows, evidence stamps) see the same fixed time. Lease expiries
// themselves are lc-based (expires_lc), hence already deterministic; the
// pin covers the wall-clock remainder. Absent: live passthrough.
const { clock } = clockFromArgv(process.argv);
console.log(`info: wall-clock ${clock.fixed ? `pinned at ${clock.nowISO()}` : "live"}`);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "bais-race-"));
const issues = join(dir, ".bais", "issues");
mkdirSync(issues, { recursive: true });
writeFileSync(join(issues, "t1.toml"), 'id = "t1"\ntitle = "race task"\nstatus = "Open"\nkind = "Feat"\nbody = "race fixture"\n');
writeFileSync(join(issues, "t2.toml"), 'id = "t2"\ntitle = "budget task"\nstatus = "Open"\nkind = "Feat"\nbody = "budget fixture"\n');
const ing = await ingestIssues(issues);
check(ing.events === 2, `ingested fixture store (${ing.events} events)`); // bi#58: exact — 2 Open edgeless issues seed exactly 2 events (t2 serves the G-budget differential)

const { hub } = await createHub(issues, { port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const post = async (path, body) => {
	const r = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: r.status, json: await r.json() };
};

// 1. Two holders race the same task: exactly one wins.
const [a, b] = await Promise.all([
	post("/claim", { task: "t1", holder: "did:key:a", ttl: 1000, epoch: 0, idem: "a1" }),
	post("/claim", { task: "t1", holder: "did:key:b", ttl: 1000, epoch: 0, idem: "b1" }),
]);
const win = a.status === 200 ? a : b;
const lose = a.status === 200 ? b : a;
check(win.status === 200 && lose.status === 409, "race: one 200, one 409");
check(lose.json.reason === `lease-held: ${win.json.holder}`, `loser told lease-held (got ${lose.json.reason})`); // bi#58: exact — reason carries the holder suffix

// 2. A zombie with a HIGHER epoch still cannot steal a held lease.
const z = await post("/claim", { task: "t1", holder: "did:key:z", ttl: 1000, epoch: 7, idem: "z7" });
check(z.status === 409 && z.json.reason === `lease-held: ${win.json.holder}`, `zombie epoch-7 claim rejected while held (got ${z.status} ${z.json.reason})`); // bi#58: pin the reason — bare 409s hide fencing regressions

// 3. Winner renews; a zombie renew with the same ref is refused.
const renew = await post("/renew", { lease_ref: win.json.lease_id, holder: win.json.holder });
// bi#58: `>` is a real bound (expiry must strictly extend — equality would
// over-pin lc values); lease_id equality pins lease continuity.
check(renew.status === 200 && renew.json.lease_id === win.json.lease_id && renew.json.expires_lc > win.json.expires_lc, "winner renew extends expiry");
const zrenew = await post("/renew", { lease_ref: win.json.lease_id, holder: "did:key:z" });
check(zrenew.status === 409 && zrenew.json.reason === "not-holder", "zombie renew refused");

// 4. Release frees; the loser reclaims.
const rel = await post("/release", { lease_ref: win.json.lease_id, holder: win.json.holder });
check(rel.status === 200 && rel.json.status === "released", `winner release frees (got ${rel.status} ${rel.json.status})`); // bi#58: pin the release verdict, not just the code
const reclaim = await post("/claim", { task: "t1", holder: "did:key:b", ttl: 1000, epoch: 0, idem: "b2" });
check(reclaim.status === 200 && reclaim.json.holder === "did:key:b", `task reclaimable after release (got ${reclaim.status} ${reclaim.json.holder})`); // bi#58: pin who holds it

// 5. Live lease is visible to oversight.
const leases = await (await fetch(`${base}/leases`)).json();
check(leases.leases.length === 1 && leases.leases[0].entity === "t1", "GET /leases shows the live lease");

// 6. Renewing the released (zombie) lease is rejected.
const zold = await post("/renew", { lease_ref: win.json.lease_id, holder: win.json.holder });
check(zold.status === 409 && zold.json.reason === "not-current", `renew of released lease rejected (got ${zold.status} ${zold.json.reason})`); // bi#58: pin the reason — bare 409s hide fencing regressions

// 7. RED-CHECK R-fencing (bi#57) — hunk: bais/baml_src/ns_event/lease.baml
// not-holder exclusions (:156 renew, :174 release-adjacent; zombie
// renew/claim excluded from state) plumbed by the host decide() into HTTP
// 409 (bais/src/hub.ts claim/renew handlers). BAML-owned logic, so no host
// revert is possible (baml_src off-limits) — the red-check is differential
// through the live path, observed 2026-09-04: a valid-holder renew returns
// 200 with extended expiry while the forged-holder renew on the SAME lease
// returns 409 not-holder; a zombie claim on the held task returns 409
// `lease-held: <holder>` (holder-suffixed); renew of a released lease
// returns 409 not-current. Had the hunk been reverted, the forged requests
// would return 200 and the exact-equality predicates below would fail with
// these recorded messages. The cross-feed proves the predicates
// discriminate: each real response fails the OTHER side's predicate.
{
	const frc = [];
	const fcheck = (cond, msg) => { if (!cond) frc.push(msg); };
	// Positive: forged refused with the exact named reason, valid admitted.
	check(zrenew.status === 409 && zrenew.json.reason === "not-holder",
		`R-fencing: forged-holder renew refused 409 not-holder (got ${zrenew.status} ${zrenew.json.reason})`);
	// Discrimination: the valid renew response fails the zombie predicate,
	// and the zombie response fails the valid predicate — neither check is
	// vacuous (an always-409 / always-200 net would trip one side).
	fcheck(renew.status === 409 && renew.json.reason === "not-holder", "zombie renew refused");
	fcheck(zrenew.status === 200, "winner renew extends expiry");
	check(frc.length === 2, `R-fencing: predicates discriminate valid from forged (${frc.length}/2 cross-feed failures)`);
}

// 8. G-fencing injection framing (bi#60) — the violations above (zombie
// claim, forged renew) prove (a) the fencing gate catches them with exact
// named reasons (steps 2/3/6 pins). (b) Every pre-existing check misses
// them: the forged requests are well-formed in every earlier dimension —
// valid {task, holder, ttl, epoch, idem} types (else 400), a known live
// lease (else 404), within bounds (else 413), a funded author (else 402),
// an unfrozen task, no caps required (else 403). The handler evaluates in
// that order, so a 409 proves every earlier gate passed the forgery and
// only fencing fired. The funded-shape differential (step 4: the same
// claim shape from did:key:b on the freed task returns 200) proves decide
// would admit the shape — only the fencing dimension differs.
check(z.status === 409 && zrenew.status === 409 && zold.status === 409,
	`G-fencing(b): forgeries sail through every pre-existing gate (no 400/404/413/402/403) and die only at fencing (${z.status}/${zrenew.status}/${zold.status})`);

// 9. G-budget-claim (bi#60) — hunk: bais/src/hub.ts claim handler
// `if (authorExhausted(holder)) { send 402 budget-exhausted }` (fires
// before frozen/cap/decide). Violation: a claim from a budget-exhausted
// author. Fund poor through the hub (POST /sync reloads hub state), then:
// (a) poor's claim on the free task t2 is refused 402 with the named
// reason; (b) the identical shape from funded did:key:rich is admitted 200
// (shape/bounds/decide all pass — only the budget dimension differs).
// Observed 2026-09-04 (live hub, this probe): 402 {"reason":"budget-exhausted"} / 200 admitted.
{
	const POOR = "did:key:poor", RICH = "did:key:rich";
	// bi#38: real content-hash ids (dev-style ids are dead by policy —
	// ingest verifies structurally). Chain links reference the real
	// predecessor ids: build sequentially.
	const bev = (author, seq, prev, type, body, entity, lc) => {
		const enc = encodeBodyArrays(body);
		const base = {
			author, seq, prev, project: "t", entity, refs: [], lc,
			ts: clock.nowISO(), type, body: enc,
		};
		return { ...base, id: eventId(base), sig: null };
	};
	const authEv = bev(POOR, 0, null, "BudgetAuthorize", { cap_usd: 1.0, cap_tokens: 10 }, POOR, 64000);
	const resEv = bev(POOR, 1, authEv.id, "CostReserve", { task: "t2", usd: 1.0, tokens: 10 }, POOR, 64001);
	const incEv = bev(POOR, 2, resEv.id, "CostIncurred", { reserve_ref: resEv.id, task: "t2", usd: 1.0, tokens: 10 }, POOR, 64002);
	const fundRes = await post("/sync", { events: [authEv, resEv, incEv] });
	const fundedIds = fundRes.json.accepted ?? [];
	check(fundRes.status === 200 && fundedIds.length === 3, `G-budget setup: poor exhausted via hub sync (${fundedIds.length}/3 admitted)`);
	const poor = await post("/claim", { task: "t2", holder: POOR, ttl: 1000, epoch: 0, idem: "poor1" });
	check(poor.status === 402 && poor.json.reason === "budget-exhausted",
		`G-budget(a): exhausted author refused 402 budget-exhausted (got ${poor.status} ${poor.json.reason})`);
	const rich = await post("/claim", { task: "t2", holder: RICH, ttl: 1000, epoch: 0, idem: "rich1" });
	check(rich.status === 200 && rich.json.holder === RICH,
		`G-budget(b): funded author admits the identical shape (got ${rich.status})`);
}

// 10. W-wall live reconciliation (bi#42) — the coordinator path: the hub
// stamps expires_wall from the claim's ttl_wall_ms (host owns clocks),
// BAML owns the min() expiry. t1 is freed first (release b's reclaim), so
// every wall probe below runs on a quiet log with a huge lc grant — only
// the wall lapse may free these leases. No sleeps: ttl_wall_ms=0 lapses by
// construction (lapse is >=), and the renew-extend poll retries on same-ms.
{
	const free = await post("/release", { lease_ref: reclaim.json.lease_id, holder: "did:key:b" });
	check(free.status === 200, `W setup: t1 freed for wall probes (got ${free.status})`);
	// Backward compat: pre-wall leases carry no bound anywhere.
	check(win.json.expires_wall === undefined && renew.json.expires_wall === undefined,
		"lc-only claim/renew responses carry no wall bound (legacy shape)");
	// W1: zero wall TTL — the very next claim on the quiet log wins.
	const w1 = await post("/claim", { task: "t1", holder: "did:key:w1", ttl: 1000, epoch: 0, idem: "w1", ttl_wall_ms: 0 });
	check(w1.status === 200 && typeof w1.json.expires_wall === "string" && w1.json.ttl_wall_ms === 0,
		`W1: zero-TTL claim admitted with the stamped bound echoed (got ${w1.status} ${JSON.stringify(w1.json)})`); // bi#58: === 0, not truthy — 0 is the whole point
	const w2 = await post("/claim", { task: "t1", holder: "did:key:w2", ttl: 1000, epoch: 0, idem: "w2" });
	check(w2.status === 200 && w2.json.holder === "did:key:w2",
		`W1: immediate reclaim wins on the quiet log — the wall (not lc) freed it (got ${w2.status} ${w2.json.reason ?? w2.json.holder})`);
	// W1c: the wall gate validates — negative, non-integer, non-number TTLs
	// are 400s, never silent lc-only claims.
	const badNeg = await post("/claim", { task: "t1", holder: "did:key:bad", ttl: 1000, epoch: 0, idem: "bn", ttl_wall_ms: -5 });
	const badStr = await post("/claim", { task: "t1", holder: "did:key:bad", ttl: 1000, epoch: 0, idem: "bs", ttl_wall_ms: "x" });
	const badFloat = await post("/claim", { task: "t1", holder: "did:key:bad", ttl: 1000, epoch: 0, idem: "bf", ttl_wall_ms: 1.5 });
	check(badNeg.status === 400 && badStr.status === 400 && badFloat.status === 400,
		`W1c: bad wall TTLs refused 400 (got ${badNeg.status}/${badStr.status}/${badFloat.status})`);
	// W2: live holder with an hour bound — rival blocked, renew extends the
	// wall, rival still blocked past nothing (the bound never lapses here).
	const wrel = await post("/release", { lease_ref: w2.json.lease_id, holder: "did:key:w2" });
	check(wrel.status === 200, `W2 setup: t1 freed again (got ${wrel.status})`);
	const wl = await post("/claim", { task: "t1", holder: "did:key:wl", ttl: 1000, epoch: 0, idem: "wl", ttl_wall_ms: 3_600_000 });
	check(wl.status === 200 && typeof wl.json.expires_wall === "string",
		`W2 setup: live wall claim admitted with bound (got ${wl.status})`);
	const wrival = await post("/claim", { task: "t1", holder: "did:key:wr", ttl: 1000, epoch: 0, idem: "wr" });
	check(wrival.status === 409 && wrival.json.reason === "lease-held: did:key:wl",
		`W2: rival blocked inside the bound (got ${wrival.status} ${wrival.json.reason})`);
	let wrenew = await post("/renew", { lease_ref: wl.json.lease_id, holder: "did:key:wl" });
	for (let i = 0; i < 5 && !(wrenew.status === 200 && wrenew.json.expires_wall > wl.json.expires_wall); i++) {
		await new Promise((r) => setTimeout(r, 10));
		wrenew = await post("/renew", { lease_ref: wl.json.lease_id, holder: "did:key:wl" });
	}
	check(wrenew.status === 200 && wrenew.json.expires_wall > wl.json.expires_wall,
		`W2: live renew strictly extends the wall bound (got ${wrenew.status} ${wrenew.json.expires_wall} vs ${wl.json.expires_wall})`);
	const wrival2 = await post("/claim", { task: "t1", holder: "did:key:wr", ttl: 1000, epoch: 0, idem: "wr2" });
	check(wrival2.status === 409 && wrival2.json.reason === "lease-held: did:key:wl",
		`W2: rival still blocked after live renew (got ${wrival2.status} ${wrival2.json.reason})`);

// 11. W red-check (bi#57) — hunk: bais/src/hub.ts POST /claim wall
// stamping (`body.ttl_wall_ms` + `body.expires_wall` from the claim clock
// reading). Revert (stamp nothing, rebuild) breaks exactly the W1 reclaim:
// the lease is lc-only, the quiet log never advances lc, and the immediate
// reclaim dies `lease-held`.
// Expected reason: `W1: immediate reclaim wins on the quiet log` (FAILS,
// got 409 lease-held: did:key:w1).
// Observed (live revert + rebuild, 2026-09-06): `FAIL: W1: zero-TTL claim
// admitted with the stamped bound echoed (got 200 {...no expires_wall...})`
// then `FAIL: W1: immediate reclaim wins on the quiet log (got 409
// lease-held: did:key:w1)` + 8 failure(s) cascade (t1 stays parked on w1);
// the W differential trips 1/2 on the reverted net.
// Differential (runs every time): the valid reclaim response fails the
// held predicate and the held rival fails the admit predicate — neither
// W check passes on an always-200 / always-409 net.
{
	const frc = [];
	const fcheck = (cond, msg) => { if (!cond) frc.push(msg); };
	fcheck(w2.status === 409, "W1 immediate reclaim wins");
	fcheck(wrival.status === 200, "W2 rival blocked inside the bound");
	check(frc.length === 2, `W red-check: predicates discriminate freed from held (${frc.length}/2 cross-feed failures)`);
}
}

await hub.close();
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("lease race: all green");
