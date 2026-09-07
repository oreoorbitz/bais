// bais/scripts/campaign.mjs — bi#137: goal-mode campaign loop (scripts lane).
//
// Manual dispatching works (titans first via blast radius, then a leaf
// batch as they land) but the loop lives in the operator's head. This
// module is the engine that runs it: packs load-bearing issues first
// (dispatch --order blast-radius, consumed — never re-sorted here), and
// as slots free (fold confirmed, claim released) refills from the
// next-highest-relevance ready issues — leaves included — until the
// goal's acceptance criteria are covered.
//
// Grounding (ground-first skill, .agents/skills/ground-first/SKILL.md:
// enumerate before you theorize — observation precedes inference):
// - Pack ORDER is observed, never assumed: the loop consumes the live
//   `dispatch --agents N --json` contract via briefs.mjs buildPack /
//   buildCohorts (same JSON shape pack-review.mjs and reviewer.mjs
//   consume — read-only consumption, code shared only where a lane
//   already exports it). Blast-radius-first + id tie-break is what the
//   dispatcher prints today (dispatch.mjs §§1/5); the loop inherits it.
// - Relevance (bi#133) breaks ties among leaves ONLY through that
//   order: declared RelevanceClaims live in bais/baml_src/main.baml and
//   the scripts-lane recompute is an explicit BAML remainder ("those
//   lanes will call" this derivation). There is no relevance field in
//   dispatch --json today (probed 2026-09-06: slots carry slot/issue/
//   open_downstream/files/files_state only), so this file invents no
//   Relevance: body convention — once dispatch honors claims, the loop
//   inherits the new order with zero changes here.
// - Fold confirmation is observed via handoff-validate.mjs (a baseless
//   diff never counts as landed — bi#91). Verdicts are observed via
//   pack-review.mjs (whole-pack PASS/FAIL + releases feed) seated
//   through reviewer.mjs (fresh-context keep/replace + red-check gate).
// - The lieutenant protocol (bais/spec/lieutenant.md, bi#145) owns
//   plan/squads/system-test — the loop is the engine, not the role: a
//   loop directive in a lieutenant event log is rejected as unknown,
//   and this file never writes event logs. teardown.mjs closes the
//   campaign (TEARDOWN CLOSED is this gate's end state per scenario).
//
// State machine (pure JSON, threaded by the operator/merger):
//   seat -> land (fold confirmed) -> verdict -> close|requeue -> refill
// - seat: buildPack seats slots; each agent claims (Doing --as/--for).
// - land: handoff validates (foldHandoffs); claim still held.
// - verdict: seatReview runs the batch reviewer; reviewPack's releases
//   feeds bi#129's one-pack rule — a released pack authorizes the next
//   (releaseSignal makes the feed explicit).
// - close|requeue: PASS moves members Done (claims released, refill
//   authorized); FAIL moves members Open LOUD (requeue names every red
//   id + reason — never silent, bi#55) and withholds them from the
//   immediate refill (a loop that re-seats just-failed work without
//   operator triage is churn; the skip line names each id + reason so
//   the exclusion is loud, cohort-exclusion precedent).
// - refill: planRefill tops up to budget from fresh dispatch order.
//   Two guards: live-claimed seated slots refuse LOUD via warnReentry
//   (bi#129 — no refill while a pack holds live claims); a full pack
//   (free <= 0, nothing held — e.g. budget shrank mid-campaign) blocks
//   quiet (steady state, bi#126 full-pack precedent).
// - burndown: sampleBurndown appends {t, ready, openRadius}; folds
//   decrement it (ready count + open-radius sum over time). toGoalStatus
//   projects the latest point for /goal status (bi#132) — the renderer
//   wiring is OUT of this lane, same as the CLI wiring below.
//
// CLI WIRING — explicitly OUT of this lane (needs bais/src/cli.ts,
// outside this footprint; briefs.mjs/pack-review.mjs precedent): `bais
// campaign --budget N [--hub <root>] [--json]` mapping seat/land/
// verdict/refill/burndown onto the functions below, exiting 0 on a
// refill, 1 on a held-pack refusal, 2 on usage errors. Until then the
// operator threads the state machine by hand (or the merger calls it).
//
// Red-check 2026-09-06 (bi#57): with the live-claim guard of planRefill
// neutered (`held` forced to []), the gate below failed LOUD with
// `FAIL no refill while a pack holds live claims (refilled
// ["t#01","t#02"] despite live claims)` — the loop re-seated held
// slots, the exact double-dispatch this guard exists to prevent;
// restored, green. A refill guard that cannot go red on held slots is
// camouflage, not coverage.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildPack, buildCohorts, warnReentry } from "./briefs.mjs";
import { reviewPack, formatVerdict } from "./pack-review.mjs";
import { reviewPack as reviewSeated, toVerdictFeed, toAuditTrail } from "./reviewer.mjs";
import { validateHandoffFile } from "./handoff-validate.mjs";
import { checkSwarm } from "./teardown.mjs";

// Load-bearing hunk (bi#137/bi#57 red-check target): the live-claim
// guard below. Forcing `held` to [] must trip the gate with "no refill
// while a pack holds live claims". Never reorder the guards: held Loud
// first, full-pack quiet second — a quiet full pack must never swallow
// a loud held pack.
//
// Caller contract: `fresh` is the priority-ordered candidate set. Pass
// a WIDER list than the free slots (free + expected skips, e.g.
// buildPack(hub, free + requeued.length + withheld.length)) so withheld
// work has spares behind it — a budget-tight fresh list starves the
// refill after skips, which is caller starvation, not a loop refusal.
export function planRefill({ seated = [], leased = [], fresh = [], budget = 0, requeued = [], withheld = [] } = {}) {
	const held = seated.filter((id) => leased.includes(id));
	if (held.length) return { refills: [], refused: warnReentry(held), skips: [] };
	const free = budget - seated.length;
	if (free <= 0) return { refills: [], refused: null, skips: [] };
	const skipWhy = new Map();
	for (const id of requeued) skipWhy.set(id, "red verdict this round (operator triage before re-pack)");
	for (const id of withheld) if (!skipWhy.has(id)) skipWhy.set(id, "cohort-partitioned to a sequential slot (not swipe)");
	const skips = [];
	const refills = [];
	for (const id of fresh) {
		if (refills.length >= free) break;
		if (seated.includes(id)) continue;
		if (skipWhy.has(id)) {
			skips.push(warnRefillSkip(id, skipWhy.get(id)));
			continue;
		}
		refills.push(id);
	}
	return { refills, refused: null, skips };
}

// Loud skip line (pinned by the gate below): every refill exclusion
// names its id + reason — never silent (bi#55).
export function warnRefillSkip(id, reason) {
	return `[bais] refill skips ${id}: ${reason}`;
}

// Loud requeue line (pinned by the gate below): every FAIL verdict
// returns each member to Open with its reason on the line.
export function warnRequeue(id, reason) {
	return `[bais] requeue ${id}: ${reason}`;
}

export function newCampaign(budget) {
	return { budget, seated: [], done: [], requeued: [], burndown: [] };
}

// bi#129 feed: fold confirmation releases the pack and authorizes the
// next; anything else holds it. The reason reuses the pack-verdict line
// so the refusal already names every red id + member.
export function releaseSignal(verdict) {
	if (verdict?.releases === true) return { released: true, reason: null };
	return { released: false, reason: formatVerdict(verdict) };
}

// Close or requeue per verdict (pure state transition; the caller moves
// the issue files to Done/Open to match). PASS closes every member and
// releases the pack (refill authorized). FAIL requeues every member
// LOUD — red ids carry their pack-review reasons, innocent members name
// the red pack that holds them (whole-pack verdict, pack-review.mjs:
// one red item reds the pack). Either way the seated set clears: held
// slots are valid in-flight work, settled slots are not.
export function applyVerdict(state, verdict) {
	const members = verdict?.members ?? [];
	const lines = [formatVerdict(verdict)];
	if (verdict?.verdict === "PASS") {
		return {
			state: {
				...state,
				seated: state.seated.filter((id) => !members.includes(id)),
				done: [...state.done, ...members],
			},
			lines,
			released: true,
		};
	}
	const failed = new Set(verdict?.failed ?? []);
	const reasons = new Map();
	for (const r of verdict?.reasons ?? []) {
		const m = /item (\S+) /.exec(r);
		if (m) reasons.set(m[1], r);
	}
	const requeued = members.map((id) => ({
		id,
		reason: reasons.get(id) ?? `held by red pack ${verdict?.pack ?? "(missing pack)"} (red: ${[...failed].join(", ") || "pack"})`,
	}));
	for (const { id, reason } of requeued) lines.push(warnRequeue(id, reason));
	return {
		state: {
			...state,
			seated: state.seated.filter((id) => !members.includes(id)),
			requeued: [...state.requeued, ...requeued],
		},
		lines,
		released: false,
	};
}

// Fold handoffs: validate every *.handoff in a dir (read-only — the
// merger folds, i.e. removes, validated files; the gate simulates the
// fold by deleting on ok). A baseless diff never counts as landed.
export function foldHandoffs(dir, opts = {}) {
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".handoff")).sort();
	} catch {
		return { ok: true, folded: [], errors: [] };
	}
	const folded = [];
	const errors = [];
	for (const f of files) {
		const res = validateHandoffFile(join(dir, f), opts);
		if (res.ok) folded.push(join(dir, f));
		else for (const e of res.errors) errors.push(`${f}: error ${e.line} ${e.message}`);
	}
	return { ok: errors.length === 0, folded, errors };
}

// Seat the batch reviewer: whole-pack reviewPack through the
// fresh-context reviewer (bi#59) — decision keep/replace plus the hero
// verdict feed (bi#135) and audit trail (bi#142) projections.
export function seatReview(pack, { hero = "", redcheck = null } = {}) {
	const review = reviewSeated(pack, { heroName: hero, redcheck });
	return { review, feed: toVerdictFeed(review), trail: toAuditTrail(review) };
}

// Goal burndown (bi#137 need 3, bi#132 consumer): ready count +
// open-radius sum over time. sampleBurndown appends one point;
// burndownDecrements is true when any later point sits strictly below
// an earlier one on either leg (folds decrement it); formatBurndown
// renders the status lines; toGoalStatus projects the latest point for
// /goal status (renderer wiring OUT — same shape, no code sharing).
export function sampleBurndown({ t, ready, openRadius }) {
	return { t, ready, openRadius };
}

export function formatBurndown(points) {
	return points.map((p) => `burndown t=${p.t} ready=${p.ready} open_radius=${p.openRadius}`).join("\n");
}

export function burndownDecrements(points) {
	for (let i = 1; i < points.length; i++) {
		if (points[i].ready < points[i - 1].ready || points[i].openRadius < points[i - 1].openRadius) return true;
	}
	return false;
}

export function toGoalStatus(points) {
	const last = points[points.length - 1] ?? { ready: 0, openRadius: 0 };
	return { ready: last.ready, open_radius: last.openRadius };
}

// hub#199: goal progress consumes e2e verdicts — burndown reports
// e2e-cases-green alongside issues-closed, never issues-closed alone
// when the campaign carries an oracle. Verdicts are BITS-graded records
// (bits/baml_src/main.baml Verdict/GradedCase {case_id, outcome}); the
// bits-t2 ledger's {id, outcome} lowercase shape reads the same.
// goal.mjs e2eVerdictProgress owns the goal-side join (committed case
// ids vs verdicts); this owns the campaign burndown line.
export function e2eProgress(verdicts) {
	const vs = (verdicts ?? []).map((v) => ({ id: v.case_id ?? v.id, outcome: String(v.outcome ?? "").toLowerCase() }));
	return {
		green: vs.filter((v) => v.outcome === "pass").length,
		total: vs.length,
		red: vs.filter((v) => v.outcome === "fail").map((v) => v.id),
	};
}

export function formatGoalProgress({ issuesDone = 0, issuesTotal = 0, e2e = null } = {}) {
	const base = `goal progress: issues-closed ${issuesDone}/${issuesTotal}`;
	if (!e2e) return base;
	return `${base} e2e-cases-green ${e2e.green}/${e2e.total}${e2e.red.length ? ` (red: ${e2e.red.join(", ")})` : ""}`;
}

// ── Fixture gate (acceptance for bi#137) ─────────────────────────────
// End-to-end over hermetic tmp hubs (far-future leases, fixed --now, so
// every run prints byte-identical verdicts). Four scenarios mirror the
// issue's acceptance bullets plus a pure unit section:
//
// S1 landing-refill — full pack blocks refill LOUD while held; landed
//   agents refill from ready in dispatch order; burndown decrements on
//   folds; teardown CLOSED.
// S2 red-requeue — FAIL verdict requeues LOUD naming every red id +
//   reason; refill withholds requeued work and seats clean work;
//   budget respected; teardown CLOSED.
// S3 budget — budget 1 seats exactly one per round, never more.
// S4 cohort-withheld — cohort-partitioned issues stay out of swipe
//   refill (hub#162 partition rule), named loud.
// S5 unit — quiet full-pack block, pool-exhausted quiet, release feed,
//   fold refusal, burndown/shape formats.
//
// Usage (run from bais/):
//   node scripts/campaign.mjs            # all scenarios, exit 0 iff each behaves
//   node scripts/campaign.mjs --all      # same (teardown check.mjs precedent)
//   node scripts/campaign.mjs --selftest # same (pack-review.mjs precedent)

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const NOW = "2026-09-06T12:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const REDCHECK = { hunk: "campaign-gate load-bearing branch", observed: "reverted -> gate red FOR THE RIGHT REASON, restored -> green" };

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const cliJson = (hub, args) => JSON.parse(execFileSync("node", [CLI, ...args], { cwd: hub, encoding: "utf8", timeout: 60000 }));

function mkHub(fixtureDir) {
	const hub = mkdtempSync(join(tmpdir(), "campaign-"));
	mkdirSync(join(hub, ".bais", "issues"), { recursive: true });
	writeFileSync(join(hub, ".bais", "config.toml"), 'project = "t"\n');
	for (const f of readdirSync(fixtureDir)) {
		if (!f.endsWith(".toml")) continue;
		writeFileSync(join(hub, ".bais", "issues", f), readFileSync(join(fixtureDir, f), "utf8"));
	}
	const drops = join(hub, "drops");
	mkdirSync(drops, { recursive: true });
	return { hub, drops };
}

const issuePath = (hub, id) => join(hub, ".bais", "issues", `${id}.toml`);
// Claims are top-level TOML keys: insert before the first table header
// (appending after [[edge]] blocks would file the claim on the edge).
const claim = (hub, id, owner) => {
	const lines = readFileSync(issuePath(hub, id), "utf8").split("\n");
	let at = lines.findIndex((l) => l.trim().startsWith("["));
	if (at === -1) at = lines.length;
	lines.splice(at, 0, `holder = "${owner}"`, `lease = "${FUTURE}"`);
	writeFileSync(issuePath(hub, id), lines.join("\n"));
};
const settle = (hub, id, status) =>
	writeFileSync(issuePath(hub, id), readFileSync(issuePath(hub, id), "utf8").split("\n")
		.filter((l) => !/^(holder|lease) *=/.test(l.trim()))
		.map((l) => (l.startsWith("status = ") ? `status = "${status}"` : l)).join("\n"));

// Burndown sample from observed state: ready count from `ready --json`,
// open-radius sum from a saturating dispatch (budget 8 >= every fixture
// pool, so the sum covers all packable work exactly).
const sample = (hub, t) => {
	const ready = cliJson(hub, ["ready", "--json"]).ready.length;
	const saturating = cliJson(hub, ["dispatch", "--agents", "8", "--json"]);
	return sampleBurndown({ t, ready, openRadius: saturating.slots.reduce((n, s) => n + s.open_downstream, 0) });
};

const diffFor = (file) =>
	`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`;

const land = (drops, seq, from, file) => {
	const name = `00_20260906T020000_${seq}_from_${from}.handoff`;
	writeFileSync(join(drops, name),
		`id: handoff-${seq}\nfrom: ${from}\nto: merger\npriority: 00\ntype: diff\ncreated_at: 2026-09-06T02:00:00Z\n\nbase: ${BASE}\n${diffFor(file)}\nEvidence: drill(campaign-${seq})\n`);
	return join(drops, name);
};

// Fold every validated handoff (merger fold = gone from the dir, so the
// teardown handoffs line stays clean), then check teardown CLOSED.
const foldAll = (drops) => {
	const r = foldHandoffs(drops);
	if (r.ok) for (const f of r.folded) rmSync(f);
	return r;
};
const closed = (hub, drops, tag) => {
	const r = checkSwarm({ hub, handoffs: [drops], pids: [], nowMs: Date.parse(NOW) });
	check(`${tag} teardown CLOSED`, r.code === 0 && r.lines.at(-1).startsWith("TEARDOWN CLOSED"), JSON.stringify(r.lines.at(-1)));
};

// S1: landing agent refills from ready; burndown decrements on folds.
function scenarioRefill() {
	const { hub, drops } = mkHub(join(HERE, "fixtures", "campaign", "refill"));
	let st = newCampaign(2);
	const B0 = sample(hub, "t0");
	check("S1 burndown opens with 4 ready", B0.ready === 4, JSON.stringify(B0));
	const pack = buildPack(hub, 2);
	const ids = pack.slots.map((s) => s.issue.id);
	check("S1 pack seats hub first (blast-radius)", JSON.stringify(ids) === '["t#01","t#02"]', JSON.stringify(ids));
	st.seated = ids;
	for (const [i, id] of ids.entries()) claim(hub, id, `titan-${i + 1}`);
	const held = buildPack(hub, 2);
	const blocked = planRefill({ seated: st.seated, leased: held.leased, fresh: held.slots.map((s) => s.issue.id), budget: st.budget });
	check("S1 no refill while a pack holds live claims",
		blocked.refills.length === 0 && blocked.refused !== null && blocked.refused.includes("t#01") && blocked.refused.includes("t#02"),
		JSON.stringify(blocked));
	land(drops, "001", "titan-1", "titan.ts");
	land(drops, "002", "titan-2", "leaf-two.ts");
	const folds = foldAll(drops);
	check("S1 landed handoffs fold", folds.ok && folds.folded.length === 2, JSON.stringify(folds.errors));
	const batch = reviewPack({ pack: "t-first", suite: "pass", slots: ids.map((id, i) => ({ id, item: "pass", diff: diffFor(i ? "leaf-two.ts" : "titan.ts") })) });
	const seated = seatReview({ pack: "t-first", suite: "pass", slots: ids.map((id, i) => ({ id, item: "pass", diff: diffFor(i ? "leaf-two.ts" : "titan.ts") })) }, { hero: "general", redcheck: REDCHECK });
	check("S1 batch reviewer keeps green pack", seated.review.decision === "keep" && batch.verdict === "PASS" && batch.releases === true, seated.review.decision);
	check("S1 release signal authorizes the next pack", releaseSignal(batch).released === true, JSON.stringify(releaseSignal(batch)));
	check("S1 verdict feed projects hero + trail", seated.feed.general?.decision === "keep" && seated.trail.length === ids.length + 2, JSON.stringify(Object.keys(seated.feed)));
	const applied = applyVerdict(st, batch);
	st = applied.state;
	check("S1 PASS closes every member", JSON.stringify(st.done) === '["t#01","t#02"]' && st.seated.length === 0, JSON.stringify(st.done));
	for (const id of ids) settle(hub, id, "Done");
	const B1 = sample(hub, "t1");
	check("S1 burndown decrements on folds (ready 4->2)", B1.ready === 2 && B0.ready === 4, `B0=${B0.ready} B1=${B1.ready}`);
	check("S1 burndown decrements on folds (radius leg strictly down)", B1.openRadius < B0.openRadius, `B0=${B0.openRadius} B1=${B1.openRadius}`);
	st.burndown = [B0, B1];
	check("S1 burndown reads as decremented", burndownDecrements(st.burndown) === true, formatBurndown(st.burndown));
	const refill = buildPack(hub, 2);
	const next = planRefill({ seated: st.seated, leased: refill.leased, fresh: refill.slots.map((s) => s.issue.id), budget: st.budget });
	check("S1 released slot refills with next dispatch order", JSON.stringify(next.refills) === '["t#03","t#04"]', JSON.stringify(next));
	st.seated = next.refills;
	for (const [i, id] of st.seated.entries()) claim(hub, id, `leaf-${i + 3}`);
	land(drops, "003", "leaf-3", "leaf-three.ts");
	land(drops, "004", "leaf-4", "leaf-four.ts");
	check("S1 second wave folds", foldAll(drops).ok, "");
	const batch2 = reviewPack({ pack: "t-second", suite: "pass", slots: st.seated.map((id) => ({ id, item: "pass", diff: diffFor(`${id}.ts`) })) });
	st = applyVerdict(st, batch2).state;
	for (const id of ["t#03", "t#04"]) settle(hub, id, "Done");
	const B2 = sample(hub, "t2");
	check("S1 burndown drains to zero ready", B2.ready === 0, JSON.stringify(B2));
	st.burndown.push(B2);
	check("S1 budget never exceeded", st.seated.length <= st.budget && next.refills.length <= st.budget, `${st.seated.length}/${st.budget}`);
	closed(hub, drops, "S1");
}

// S2: red verdict requeues loud; refill withholds requeued work, seats
// clean work; budget respected; teardown CLOSED.
function scenarioRed() {
	const { hub, drops } = mkHub(join(HERE, "fixtures", "campaign", "red"));
	let st = newCampaign(2);
	const pack = buildPack(hub, 2);
	const ids = pack.slots.map((s) => s.issue.id);
	check("S2 pack seats hub first (blast-radius)", JSON.stringify(ids) === '["r#01","r#02"]', JSON.stringify(ids));
	st.seated = ids;
	for (const [i, id] of ids.entries()) claim(hub, id, `red-${i + 1}`);
	land(drops, "011", "red-1", "red-hub.ts");
	land(drops, "012", "red-2", "red-leaf.ts");
	check("S2 red-wave handoffs validate", foldAll(drops).ok, "");
	// r#01 lands with no diff under review — the pack-review load-bearing
	// guard reds the whole pack, naming r#01.
	const red = {
		pack: "r-first", suite: "pass",
		slots: [{ id: "r#01", item: "pass", diff: "   \n" }, { id: "r#02", item: "pass", diff: diffFor("red-leaf.ts") }],
	};
	const batch = reviewPack(red);
	const seated = seatReview(red, { hero: "general", redcheck: REDCHECK });
	check("S2 empty diff reds the pack naming the item",
		batch.verdict === "FAIL" && JSON.stringify(batch.failed) === '["r#01"]' && batch.releases === false, JSON.stringify(batch.failed));
	check("S2 reviewer replaces on red", seated.review.decision === "replace" && seated.review.evidence.includes("r#01"), seated.review.decision);
	const sig = releaseSignal(batch);
	check("S2 held pack authorizes nothing", sig.released === false && sig.reason.includes("r#01"), JSON.stringify(sig));
	const applied = applyVerdict(st, batch);
	st = applied.state;
	check("S2 FAIL verdict still names every member",
		applied.lines[0].includes("r#01") && applied.lines[0].includes("r#02"), applied.lines[0]);
	check("S2 requeue is loud with id + reason",
		applied.lines.some((l) => l.includes("[bais] requeue r#01:") && l.includes("no diff")) &&
		applied.lines.some((l) => l.includes("[bais] requeue r#02:") && l.includes("red pack r-first")), JSON.stringify(applied.lines));
	check("S2 requeued pair tracked", st.requeued.map((r) => r.id).join(",") === "r#01,r#02" && st.seated.length === 0, JSON.stringify(st.requeued));
	for (const id of ids) settle(hub, id, "Open");
	// Wide fresh list (planRefill caller contract): free slots + skipped
	// requeued work, so the refill has spares behind the withholds.
	const refill = buildPack(hub, st.budget + st.requeued.length);
	const next = planRefill({
		seated: st.seated, leased: refill.leased, fresh: refill.slots.map((s) => s.issue.id),
		budget: st.budget, requeued: st.requeued.map((r) => r.id),
	});
	check("S2 refill withholds requeued work, seats clean work",
		JSON.stringify(next.refills) === '["r#03"]' && next.skips.length === 2 &&
		next.skips.every((l) => l.includes("refill skips") && l.includes("operator triage")), JSON.stringify(next));
	st.seated = next.refills;
	claim(hub, "r#03", "red-3");
	land(drops, "013", "red-3", "red-refill.ts");
	check("S2 clean wave folds", foldAll(drops).ok, "");
	const batch2 = reviewPack({ pack: "r-second", suite: "pass", slots: [{ id: "r#03", item: "pass", diff: diffFor("red-refill.ts") }] });
	const seated2 = seatReview({ pack: "r-second", suite: "pass", slots: [{ id: "r#03", item: "pass", diff: diffFor("red-refill.ts") }] }, { hero: "general", redcheck: REDCHECK });
	check("S2 clean wave keeps", seated2.review.decision === "keep" && batch2.releases === true, seated2.review.decision);
	st = applyVerdict(st, batch2).state;
	settle(hub, "r#03", "Done");
	check("S2 budget respected (1 refill on budget 2, requeued withheld)",
		next.refills.length === 1 && st.seated.length === 0, JSON.stringify(next.refills));
	closed(hub, drops, "S2");
}

// S3: budget 1 seats exactly one per round, never more.
function scenarioBudget() {
	const { hub, drops } = mkHub(join(HERE, "fixtures", "campaign", "budget"));
	let st = newCampaign(1);
	let maxSeated = 0;
	for (const round of [["b#01", "c1"], ["b#02", "c2"]]) {
		const [want] = round;
		const pack = buildPack(hub, 1);
		check(`S3 round seats exactly one (${want})`,
			pack.slots.length === 1 && pack.slots[0].issue.id === want, JSON.stringify(pack.slots.map((s) => s.issue.id)));
		st.seated = [want];
		maxSeated = Math.max(maxSeated, st.seated.length);
		claim(hub, want, `solo-${want}`);
		const heldPack = buildPack(hub, 1);
		const blocked = planRefill({ seated: st.seated, leased: heldPack.leased, fresh: [], budget: st.budget });
		check(`S3 no second seat while ${want} held`, blocked.refills.length === 0 && blocked.refused?.includes(want), JSON.stringify(blocked));
		land(drops, round[1] === "c1" ? "021" : "022", `solo-${round[1]}`, `${want}.ts`);
		check(`S3 ${want} folds`, foldAll(drops).ok, "");
		const batch = reviewPack({ pack: `b-${want}`, suite: "pass", slots: [{ id: want, item: "pass", diff: diffFor(`${want}.ts`) }] });
		check(`S3 ${want} releases`, batch.releases === true, batch.verdict);
		st = applyVerdict(st, batch).state;
		settle(hub, want, "Done");
	}
	check("S3 budget never exceeded across rounds", maxSeated === 1, `${maxSeated}/1`);
	closed(hub, drops, "S3");
}

// S4: cohort-partitioned issues stay out of swipe refill (hub#162
// partition rule — cohort members belong to their sequential slot, NOT
// to parallel packs), each skip named loud.
function scenarioCohort() {
	const { hub } = mkHub(join(HERE, "fixtures", "cohort", "trio"));
	const { cohorts } = buildCohorts(hub);
	check("S4 trio cohorts to one sequential slot", cohorts.length === 1 && cohorts[0].members.length === 3, JSON.stringify(cohorts.map((c) => c.members)));
	const swipe = buildPack(hub, 3);
	// Fresh is the priority-ordered candidate set (ready set sourcing),
	// not the clash-filtered swipe pack — every withheld member is
	// offered and refused loud, none leaks into the refill.
	const fresh = [...new Set([...swipe.slots.map((s) => s.issue.id), ...cohorts[0].members])];
	const next = planRefill({
		seated: [], leased: swipe.leased, fresh,
		budget: 3, withheld: cohorts[0].members,
	});
	const leaked = next.refills.filter((id) => cohorts[0].members.includes(id));
	check("S4 swipe refill withholds cohort members", leaked.length === 0, JSON.stringify(next.refills));
	check("S4 every withheld member named loud",
		cohorts[0].members.every((id) => next.skips.some((l) => l.includes(`refill skips ${id}`) && l.includes("cohort-partitioned"))),
		JSON.stringify(next.skips));
}

// S5: pure unit asserts — guards, feed, fold refusal, formats.
function scenarioUnit() {
	const full = planRefill({ seated: ["a", "b"], leased: [], fresh: ["c"], budget: 2 });
	check("S5 full pack blocks refill quiet", full.refills.length === 0 && full.refused === null && full.skips.length === 0, JSON.stringify(full));
	const dry = planRefill({ seated: [], leased: [], fresh: [], budget: 2 });
	check("S5 exhausted pool refills quiet (dispatch warnPartial owns loud)", dry.refills.length === 0 && dry.refused === null, JSON.stringify(dry));
	const held = planRefill({ seated: ["a"], leased: ["a"], fresh: ["b"], budget: 2 });
	check("S5 held slot refuses loud, seats nothing",
		held.refills.length === 0 && held.refused === warnReentry(["a"]), JSON.stringify(held));
	const cap = planRefill({ seated: [], leased: [], fresh: ["a", "b", "c"], budget: 2 });
	check("S5 refill caps at free budget", JSON.stringify(cap.refills) === '["a","b"]', JSON.stringify(cap.refills));
	check("S5 reentry format exact",
		warnReentry(["t#02"]) === "[bais] reentry: 1 held slot still claimed (t#02); next pack after the merger confirms the fold", warnReentry(["t#02"]));
	const ok = releaseSignal({ releases: true });
	check("S5 PASS releases", ok.released === true && ok.reason === null, JSON.stringify(ok));
	const samplePack = readFileSync(join(HERE, "fixtures", "campaign", "sample-pack.json"), "utf8");
	const green = reviewPack(JSON.parse(samplePack));
	check("S5 sample pack shape reviews PASS", green.verdict === "PASS" && green.ref === "verdict-t-sample", green.ref);
	const sampleHandoff = validateHandoffFile(join(HERE, "fixtures", "campaign", "00_20260906T020000_001_from_titan-1.handoff"));
	check("S5 sample handoff shape validates", sampleHandoff.ok === true, JSON.stringify(sampleHandoff.errors));
	const badDir = mkdtempSync(join(tmpdir(), "campaign-bad-"));
	writeFileSync(join(badDir, "00_20260906T020000_009_from_x.handoff"),
		`id: handoff-009\nfrom: x\nto: merger\npriority: 00\ntype: diff\ncreated_at: 2026-09-06T02:00:00Z\n\nno base here\n`);
	const refused = foldHandoffs(badDir);
	check("S5 baseless diff never counts as landed", refused.ok === false && refused.folded.length === 0 && refused.errors.length > 0, JSON.stringify(refused.errors));
	const pts = [sampleBurndown({ t: "t0", ready: 4, openRadius: 6 }), sampleBurndown({ t: "t1", ready: 2, openRadius: 1 })];
	check("S5 burndown format exact",
		formatBurndown(pts) === "burndown t=t0 ready=4 open_radius=6\nburndown t=t1 ready=2 open_radius=1", formatBurndown(pts));
	check("S5 burndown decrements on the fold leg", burndownDecrements(pts) === true, "");
	check("S5 flat burndown reads flat", burndownDecrements([pts[0], { ...pts[0], t: "t9" }]) === false, "");
	check("S5 goal-status projection is latest-only",
		JSON.stringify(toGoalStatus(pts)) === '{"ready":2,"open_radius":1}', JSON.stringify(toGoalStatus(pts)));
	check("S5 skip format exact",
		warnRefillSkip("r#01", "red verdict this round (operator triage before re-pack)") === "[bais] refill skips r#01: red verdict this round (operator triage before re-pack)",
		warnRefillSkip("r#01", "x"));
	check("S5 requeue format exact",
		warnRequeue("r#02", "held by red pack r-first (red: r#01)") === "[bais] requeue r#02: held by red pack r-first (red: r#01)",
		warnRequeue("r#02", "x"));
}

// S6: goal progress consumes e2e verdicts (hub#199) — a fixture campaign
// reports e2e-cases-green alongside issues-closed, and an oracle-less
// campaign keeps the issues-only line.
function scenarioE2eProgress() {
	const verdicts = [
		{ case_id: "green-exercise-passes", outcome: "Pass" },
		{ case_id: "red-scaffold-grades-fail", outcome: "Fail" },
	];
	const p = e2eProgress(verdicts);
	check("S6 e2e progress counts green over total naming red",
		p.green === 1 && p.total === 2 && JSON.stringify(p.red) === '["red-scaffold-grades-fail"]', JSON.stringify(p));
	const line = formatGoalProgress({ issuesDone: 2, issuesTotal: 4, e2e: p });
	check("S6 burndown reports e2e-cases-green alongside issues-closed",
		line === "goal progress: issues-closed 2/4 e2e-cases-green 1/2 (red: red-scaffold-grades-fail)", line);
	check("S6 bits-t2 ledger-shaped verdicts read the same",
		e2eProgress([{ id: "green-exercise-passes", outcome: "pass" }]).green === 1, "");
	check("S6 oracle-less campaign keeps the issues-only line",
		formatGoalProgress({ issuesDone: 1, issuesTotal: 3 }) === "goal progress: issues-closed 1/3",
		formatGoalProgress({ issuesDone: 1, issuesTotal: 3 }));
	check("S6 all-green oracle reports no red list",
		formatGoalProgress({ issuesDone: 4, issuesTotal: 4, e2e: e2eProgress([{ case_id: "a", outcome: "Pass" }]) }) ===
			"goal progress: issues-closed 4/4 e2e-cases-green 1/1",
		formatGoalProgress({ issuesDone: 4, issuesTotal: 4, e2e: e2eProgress([{ case_id: "a", outcome: "Pass" }]) }));
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const argv = process.argv.slice(2);
	if (argv.length && !["--all", "--selftest"].includes(argv[0])) {
		console.error("usage: campaign.mjs [--all|--selftest]");
		process.exit(2);
	}
	scenarioRefill();
	scenarioRed();
	scenarioBudget();
	scenarioCohort();
	scenarioUnit();
	scenarioE2eProgress();
	if (fail) {
		console.error(`${fail} failure(s), ${pass} pass`);
		process.exit(1);
	}
	console.log(`campaign: all green (${pass} pass)`);
}
