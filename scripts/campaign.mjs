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
// Fold gates (hub#187/hub#192/hub#197 — sections below):
// - hub#187 oracle-continuity: after every fold the goal's deterministic
//   e2e gates re-run through hub#213's runGoalGate (imported, never
//   edited); a fold landing while the oracle is red refuses the next
//   refill LOUD naming red cases, unless the folding issue names the
//   case (the fold IS the fix). Warn-first-then-fail, phases in
//   CAMPAIGN_BUDGETS.
// - hub#192 fold-scope: fold diff paths must be a subset of the issue's
//   declared Files: footprint (pure diffPaths/foldScope over diff text +
//   issue body), plus a per-fold diff-size budget — both warn-first.
// - hub#197 measurement: the burndown gains an e2e_passing leg
//   (divergence + flat-then-cliff named loud), per-issue requeue cycles
//   are counted and held past budget for operator triage, and red-checks
//   are verified empirically at fold (verifyRedCheck, warn-first).
//
// WIRING SPECS (outside this lane's footprint — never edited here):
// - bais/baml_src/main.baml (hub#187 Files:): the "is the goal green"
//   derivation belongs in BAML, proved by `baml test` on literals; this
//   lane consumes gate results (host owns execution, exit-code
//   contract). Remainder for the BAML lane.
// - bais/scripts/handoff-validate.mjs (hub#192 Files:): call foldScope()
//   with the handoff's diff body + the folding issue's body at fold
//   time; excess/overBudget refusals reject the fold there.
// - bais/scripts/reviewer.mjs (hub#197 Files:): extend the red-check
//   gate (reviewer.mjs:52-60) from shape to execution by calling
//   verifyRedCheck() with a host executor that reverts the named hunk
//   and re-runs the suite.
// - tiers T0/T1 composition (hub#187): the CLI/operator prepends the
//   tiers suites to the gate list passed to oracleContinuity (tiers.mjs
//   is another lane); the gate list shape is hub#213's {name, argv}.
// - bais/src/cli.ts: `bais campaign --budget N` (below) plus surfacing
//   oracleContinuity/foldScope/verifyRedCheck verdicts on fold.
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
import { buildPack, buildCohorts, warnReentry, parseFiles } from "./briefs.mjs";
import { reviewPack, formatVerdict } from "./pack-review.mjs";
import { reviewPack as reviewSeated, toVerdictFeed, toAuditTrail } from "./reviewer.mjs";
import { validateHandoffFile } from "./handoff-validate.mjs";
import { checkSwarm } from "./teardown.mjs";
import { runGoalGate, goalGates, defaultGateRun } from "./goal.mjs";

// hub#187/hub#192/hub#197 thresholds — data, never scattered literals
// (budgets.toml precedent; the briefs.mjs COHORT idiom). Every phase
// follows warn-first-then-fail (hub#158): the default "warn" phase prints
// the pinned warning and never breaks the current hub; after the named
// milestone the phase flips to "fail" and the refusal binds.
export const CAMPAIGN_BUDGETS = {
	oraclePhase: "warn", // hub#187 oracle-continuity fold gate
	oracleBindsAfter: "campaign#3 of the e2e-oracle rollout",
	foldScopePhase: "warn", // hub#192 Files:-subset check
	foldBudgetPhase: "warn", // hub#192 per-fold diff-size budget
	foldScopeBindsAfter: "campaign#3 of the e2e-oracle rollout",
	foldMaxPaths: 5, // echoes COHORT.MAX_FILES (briefs.mjs:302) — cohort caps become fold caps
	foldMaxHunks: 12,
	requeueMaxCycles: 2, // hub#197 — >2 Open→Doing→Open cycles holds for operator triage
	redCheckPhase: "warn", // hub#197 empirical red-check at fold
	redCheckBindsAfter: "campaign#3 of the e2e-oracle rollout",
};

// Load-bearing hunk (bi#137/bi#57 red-check target): the live-claim
// guard below. Forcing `held` to [] must trip the gate with "no refill
// while a pack holds live claims". Never reorder the guards: held Loud
// first, oracle-continuity refusal Loud second (hub#187 — a red oracle
// must never be swallowed by a quiet full pack), full-pack quiet last —
// a quiet full pack must never swallow a loud held pack or a loud red
// oracle.
//
// Caller contract: `fresh` is the priority-ordered candidate set. Pass
// a WIDER list than the free slots (free + expected skips, e.g.
// buildPack(hub, free + requeued.length + withheld.length)) so withheld
// work has spares behind it — a budget-tight fresh list starves the
// refill after skips, which is caller starvation, not a loop refusal.
export function planRefill({ seated = [], leased = [], fresh = [], budget = 0, requeued = [], withheld = [], oracle = null, requeueCounts = {}, maxRequeueCycles = CAMPAIGN_BUDGETS.requeueMaxCycles } = {}) {
	const held = seated.filter((id) => leased.includes(id));
	if (held.length) return { refills: [], refused: warnReentry(held), skips: [] };
	// hub#187: a fold that landed while the e2e oracle is red refuses the
	// next refill LOUD, naming the red cases (the oracleContinuity result
	// carries the pinned refusal line). Loud second, before the quiet
	// full-pack block — see the guard-order note above.
	if (oracle?.refusal) return { refills: [], refused: oracle.refusal, skips: [] };
	const free = budget - seated.length;
	if (free <= 0) return { refills: [], refused: null, skips: [] };
	const skipWhy = new Map();
	// hub#197: per-issue requeue budget — an issue cycling Open→Doing→Open
	// more than maxRequeueCycles times is withheld from refill with the
	// triage-hold reason (warnRefillSkip shape verbatim). Load-bearing
	// (bi#57 red-check target): neutering the count lookup below must trip
	// S9 with "three requeue cycles holds for triage".
	// Red-check 2026-09-07 (bi#57): cycles forced to 0 -> S9 failed LOUD
	// with exactly
	//   "FAIL S9 three requeue cycles holds for triage {"refills":["q#01","q#02"],...}"
	// (the 3-cycle fixture refilled — churn invisible as a trend);
	// restored, green.
	for (const id of fresh) {
		const cycles = requeueCounts[id] ?? 0;
		if (cycles > maxRequeueCycles) skipWhy.set(id, `triage hold: ${cycles} requeue cycles (> ${maxRequeueCycles}) — operator triage before re-pack`);
	}
	for (const id of requeued) if (!skipWhy.has(id)) skipWhy.set(id, "red verdict this round (operator triage before re-pack)");
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
	// requeueCounts (hub#197): per-issue Open→Doing→Open cycle count — the
	// per-event requeue lines are loud, but only the per-id count makes the
	// churn visible as a trend (planRefill holds past the budget).
	return { budget, seated: [], done: [], requeued: [], requeueCounts: {}, burndown: [] };
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
	// hub#197: count the cycle per id — churn is loud per-event above and
	// now visible as a trend for planRefill's triage hold.
	const requeueCounts = { ...state.requeueCounts };
	for (const { id } of requeued) requeueCounts[id] = (requeueCounts[id] ?? 0) + 1;
	return {
		state: {
			...state,
			seated: state.seated.filter((id) => !members.includes(id)),
			requeued: [...state.requeued, ...requeued],
			requeueCounts,
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
//
// hub#197: the burndown gains a third leg `oracleGreen` (e2e_passing) —
// optional so oracle-less campaigns keep the byte-identical two-leg
// line. For ready/openRadius, DOWN is progress; for the oracle leg, UP
// is progress (burndownDecrements treats a strictly risen oracle leg as
// a decrement). burndownOracleDivergence flags loud when ready drains
// while the oracle never rises (micro-split gaming: re-splitting one
// issue into N trivial ones fakes a slope without moving the product);
// burndownPattern names the flat-then-cliff shape (integration deferred
// to the end).
export function sampleBurndown({ t, ready, openRadius, oracleGreen = null }) {
	const p = { t, ready, openRadius };
	if (oracleGreen != null) p.oracleGreen = oracleGreen;
	return p;
}

export function formatBurndown(points) {
	return points
		.map((p) => `burndown t=${p.t} ready=${p.ready} open_radius=${p.openRadius}${p.oracleGreen != null ? ` e2e_passing=${p.oracleGreen}` : ""}`)
		.join("\n");
}

export function burndownDecrements(points) {
	for (let i = 1; i < points.length; i++) {
		if (points[i].ready < points[i - 1].ready || points[i].openRadius < points[i - 1].openRadius) return true;
		// Oracle leg: progress is the oracle RISING, never the count falling.
		if (points[i].oracleGreen != null && points[i - 1].oracleGreen != null && points[i].oracleGreen > points[i - 1].oracleGreen) return true;
	}
	return false;
}

// hub#197 divergence flag: ready drained while the e2e_passing leg never
// rose — the burndown claims progress the oracle does not corroborate.
// Loud with both legs named; null when the oracle corroborates (or no
// oracle is carried — oracle-less campaigns stay silent here).
export function burndownOracleDivergence(points) {
	const leg = (points ?? []).filter((p) => p.oracleGreen != null);
	if (leg.length < 2 || points.length < 2) return null;
	const readyFrom = points[0].ready, readyTo = points[points.length - 1].ready;
	const oracleFrom = leg[0].oracleGreen, oracleTo = leg[leg.length - 1].oracleGreen;
	if (readyTo < readyFrom && oracleTo <= oracleFrom) {
		return `[bais] burndown divergence: ready drained ${readyFrom} -> ${readyTo} while e2e_passing never rose (${oracleFrom} -> ${oracleTo}) — micro-split gaming signal (hub#197)`;
	}
	return null;
}

// hub#197 named pattern: "flat-then-cliff" — ready flat across every
// sample but the last, then a drop of half or more in a single step
// (integration deferred to the end). "steady" when the legs move
// gradually, "flat" when nothing moves. Pure, deterministic.
export function burndownPattern(points) {
	if (!Array.isArray(points) || points.length < 2) return "flat";
	const first = points[0].ready, last = points[points.length - 1].ready;
	const flatUntilEnd = points.slice(0, -1).every((p) => p.ready === first);
	if (points.length >= 3 && flatUntilEnd && last <= first / 2 && last < first) {
		return "flat-then-cliff (integration deferred to the end)";
	}
	return burndownDecrements(points) ? "steady" : "flat";
}

export function toGoalStatus(points) {
	const last = points[points.length - 1] ?? { ready: 0, openRadius: 0 };
	const out = { ready: last.ready, open_radius: last.openRadius };
	if (last.oracleGreen != null) out.e2e_passing = last.oracleGreen;
	return out;
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

// --- oracle-continuity fold gate (hub#187, scripts lane) ---
//
// Done is a file edit; without this gate the campaign loop decrements the
// burndown on any PASS-verdict fold without re-running the oracle, so
// every outcome-fabrication move (vacuous Done, burndown micro-splits,
// prose red-checks) escaped. After every fold, the goal's deterministic
// e2e gates run through hub#213's gates-first machinery (runGoalGate —
// imported, never edited; the CLI prepends baml check/test and tiers
// T0/T1, see the wiring note in the file header). A fold that lands
// while the suite is red refuses the next refill LOUD naming the red
// case ids (planRefill's oracle guard) — UNLESS the folding issue names
// the red case in its body (acceptance bullets): then the fold IS the
// fix and the refill proceeds. Warn-first-then-fail (hub#158): the
// default "warn" phase prints the pinned warning without refusing; after
// the named milestone the refusal binds (CAMPAIGN_BUDGETS.oraclePhase).
//
// Offline: gates are plain-node deterministic commands (hub#184
// scaffolds), no model key. Live-surface cases (name live-* or
// live: true) follow the loud-skip precedent (bi/scripts/E2E.md:16-18):
// without a key they skip LOUD — a skipped case never reds the suite and
// never counts green.
//
// Load-bearing hunk (hub#187/bi#57 red-check target): the blocking-set
// derivation in oracleContinuity. Neutering `blocking` to [] must trip
// S7 with "red oracle refuses the refill naming red cases".
// Red-check 2026-09-07 (bi#57): blocking forced to [] -> S7 failed LOUD
// with the named primary
//   "FAIL S7 red oracle refuses the refill naming red cases ..."
// plus the two dependent S7 lines cascading (planRefill refusal,
// warn-first pin) — the fold passed despite the red scaffold, the exact
// outcome-fabrication this gate exists to catch; restored, green.

export const warnOracleRed = (red, bindsAfter = CAMPAIGN_BUDGETS.oracleBindsAfter) =>
	`[bais] oracle-continuity warn: fold landed while the e2e oracle is red (${red.join(", ")}) — refill proceeds this cycle; refusal binds after ${bindsAfter} (warn-first, hub#158)`;

export const refuseOracleRed = (red) =>
	`[bais] oracle-continuity: refill refused — fold landed while the e2e oracle is red (red cases: ${red.join(", ")}); fix the oracle, or land the fix by naming the red case in the folding issue's acceptance`;

export const warnLiveSkip = (name) =>
	`[bais] oracle-continuity skips live-surface case ${name}: no model key offline (loud-skip precedent, bi/scripts/E2E.md:16-18) — a skipped case never reds the suite and never counts green`;

// Split a gate list into offline-runnable gates plus loud live-surface
// skips. Pure; the caller prints the skip lines.
export function partitionOracleGates(gates, { liveKey = process.env.BI_E2E_LIVE_KEY ?? process.env.BAML_E2E_LIVE_KEY ?? "" } = {}) {
	const offline = [];
	const skips = [];
	for (const g of gates ?? []) {
		const name = String(g?.name ?? g?.argv?.join(" ") ?? "gate");
		if ((g?.live === true || name.startsWith("live-")) && liveKey === "") skips.push(warnLiveSkip(name));
		else offline.push(g);
	}
	return { gates: offline, skips };
}

// The campaign-side oracle check: run the goal's e2e gates (goalGates
// output, or any hub#213-shaped gate list) through runGoalGate and fold
// the result into a refill decision. Returns:
//   { ok, red, fixed, skips, refusal, warning, gate }
// ok=false + refusal set means planRefill must refuse loud; ok=false +
// warning set means warn-first (refill proceeds, warning printed).
export function oracleContinuity({
	gates = [],
	run = defaultGateRun,
	fingerprint = "fold",
	cache = null,
	retries = 0,
	issueBody = "",
	phase = CAMPAIGN_BUDGETS.oraclePhase,
} = {}) {
	const { gates: offline, skips } = partitionOracleGates(gates);
	if (offline.length === 0) return { ok: true, red: [], fixed: [], skips, refusal: null, warning: null, gate: null };
	const g = runGoalGate({ gates: offline, fingerprint, cache, run, retries });
	const red = g.results.filter((r) => r.status !== 0).map((r) => r.name);
	if (g.ok) return { ok: true, red: [], fixed: [], skips, refusal: null, warning: null, gate: g };
	// Fix exception: a red case named in the folding issue's body (its
	// acceptance bullets) is the fix landing — it never blocks the refill.
	const named = (caseId) => String(issueBody ?? "").includes(caseId);
	const fixed = red.filter(named);
	const blocking = red.filter((c) => !named(c));
	if (blocking.length === 0) return { ok: true, red, fixed, skips, refusal: null, warning: null, gate: g };
	if (phase === "warn") return { ok: false, red: blocking, fixed, skips, refusal: null, warning: warnOracleRed(blocking), gate: g };
	return { ok: false, red: blocking, fixed, skips, refusal: refuseOracleRed(blocking), warning: null, gate: g };
}

// --- fold-scope check (hub#192, scripts lane) ---
//
// Every spawn brief already says "change only these lines", but no gate
// compared a fold's diff paths to the issue's declared Files: set — so
// gold-plating and scope bleed were mechanically invisible. foldScope is
// a pure function over the diff text + the issue body (diffs are files,
// countable offline; no LLM in the gate):
//   - diff paths must be a SUBSET of the declared Files: footprint
//     (directory entries match by prefix); excess paths reject LOUD
//     naming each path (warn-first per CAMPAIGN_BUDGETS.foldScopePhase).
//   - undeclared footprint (no Files: line) keeps the hub#175 posture:
//     operator-confirm, never silently safe (pinned string below carries
//     the hub#175 parenthetical verbatim).
//   - per-fold diff-size budget (path-count + hunk-count caps echoing
//     COHORT.MAX_FILES): over-budget warns first, refuses after the
//     named milestone.
//
// WIRING — handoff-validate.mjs (outside this lane's footprint) should
// call foldScope with the handoff's diff body + the folding issue's body
// at fold time; campaign.mjs owns the pure derivation.
//
// Load-bearing hunk (hub#192/bi#57 red-check target): the subset
// comparison in foldScope. Neutering `excess` to [] must trip S8 with
// "out-of-scope fold rejected naming the path".
// Red-check 2026-09-07 (bi#57): excess forced to [] -> S8 failed LOUD
// with the named primary
//   "FAIL S8 out-of-scope fold rejected naming the path ..."
// plus two dependent S8 lines cascading (warn-first pin, sibling-prefix
// pin) — the gold-plating fold validated clean, the exact scope bleed
// this gate exists to catch; restored, green.

// Paths a unified diff touches: the b/ side of each `diff --git` header
// (renames count once, at their destination). Pure, offline.
export function diffPaths(diffText) {
	const paths = [];
	const re = /^diff --git a\/(\S+) b\/(\S+)\s*$/gm;
	let m;
	while ((m = re.exec(String(diffText ?? ""))) !== null) {
		if (!paths.includes(m[2])) paths.push(m[2]);
	}
	return paths;
}

// Hunk count of a unified diff (one per @@ header).
export function diffHunks(diffText) {
	return (String(diffText ?? "").match(/^@@ /gm) ?? []).length;
}

export const warnFoldScopeUnknown = (id) =>
	`[bais] fold scope unknown: ${id} declares no Files: footprint (no Files: — confirm scope with the operator before writing)`;

export const refuseFoldScope = (id, excess) =>
	`[bais] fold scope: fold for ${id} rejected — diff paths outside the declared Files: footprint: ${excess.join(", ")}`;

export const warnFoldScope = (id, excess, bindsAfter = CAMPAIGN_BUDGETS.foldScopeBindsAfter) =>
	`[bais] fold scope warn: fold for ${id} touches paths outside the declared Files: footprint (${excess.join(", ")}) — warns this cycle; refusal binds after ${bindsAfter} (warn-first, hub#158)`;

export const warnFoldBudget = (id, paths, hunks, maxPaths = CAMPAIGN_BUDGETS.foldMaxPaths, maxHunks = CAMPAIGN_BUDGETS.foldMaxHunks, bindsAfter = CAMPAIGN_BUDGETS.foldScopeBindsAfter) =>
	`[bais] fold budget warn: fold for ${id} is ${paths} paths/${hunks} hunks (cap ${maxPaths}/${maxHunks}) — warns this cycle; refusal binds after ${bindsAfter} (warn-first, hub#158)`;

export const refuseFoldBudget = (id, paths, hunks, maxPaths = CAMPAIGN_BUDGETS.foldMaxPaths, maxHunks = CAMPAIGN_BUDGETS.foldMaxHunks) =>
	`[bais] fold budget: fold for ${id} rejected — ${paths} paths/${hunks} hunks over the ${maxPaths}/${maxHunks} cap (split the fold; big-bang generation has no tripwire otherwise)`;

// A diff path is in-scope when it equals a declared Files: entry or sits
// under a declared directory entry (prefix match on the slash boundary —
// "src/foo.ts" never scopes in "src/foo.tss").
function inFootprint(path, declared) {
	return declared.some((d) => path === d || path.startsWith(d.endsWith("/") ? d : `${d}/`));
}

// Pure fold-scope verdict. Returns:
//   { ok, declared, paths, hunks, excess, overBudget, operatorConfirm, refusal, warning }
// operatorConfirm set means the hub#175 unknown-footprint posture:
// route to the operator, never silently safe.
export function foldScope({
	diff = "",
	issueBody = "",
	issueId = "(unknown issue)",
	phase = CAMPAIGN_BUDGETS.foldScopePhase,
	budgetPhase = CAMPAIGN_BUDGETS.foldBudgetPhase,
	maxPaths = CAMPAIGN_BUDGETS.foldMaxPaths,
	maxHunks = CAMPAIGN_BUDGETS.foldMaxHunks,
} = {}) {
	const { files, declared } = parseFiles(issueBody);
	if (!declared) {
		return { ok: false, declared, paths: [], hunks: 0, excess: [], overBudget: false, operatorConfirm: warnFoldScopeUnknown(issueId), refusal: null, warning: null };
	}
	const paths = diffPaths(diff);
	const hunks = diffHunks(diff);
	const excess = paths.filter((p) => !inFootprint(p, files));
	if (excess.length) {
		return phase === "warn"
			? { ok: false, declared, paths, hunks, excess, overBudget: false, operatorConfirm: null, refusal: null, warning: warnFoldScope(issueId, excess) }
			: { ok: false, declared, paths, hunks, excess, overBudget: false, operatorConfirm: null, refusal: refuseFoldScope(issueId, excess), warning: null };
	}
	const overBudget = paths.length > maxPaths || hunks > maxHunks;
	if (overBudget) {
		return budgetPhase === "warn"
			? { ok: false, declared, paths, hunks, excess, overBudget, operatorConfirm: null, refusal: null, warning: warnFoldBudget(issueId, paths.length, hunks, maxPaths, maxHunks) }
			: { ok: false, declared, paths, hunks, excess, overBudget, operatorConfirm: null, refusal: refuseFoldBudget(issueId, paths.length, hunks, maxPaths, maxHunks), warning: null };
	}
	return { ok: true, declared, paths, hunks, excess, overBudget, operatorConfirm: null, refusal: null, warning: null };
}

// --- empirical red-check at fold (hub#197, scripts lane) ---
//
// The reviewer checked red-check prose for string PRESENCE — attestation,
// not execution. verifyRedCheck closes that: the reviewer brief's named
// hunk is reverted and the suite re-run by a scripts-lane step (the host
// executes via the injected `execute` callback; this lane owns what
// counts as the right failure). A red-check whose observed output does
// not contain the expected failure is rejected (warn-first) naming the
// hunk and the observed-vs-expected output. Attestation-only red-checks
// (no expected failure recorded, or no executor wired) downgrade to
// warn, then fail after the named milestone.
//
// Load-bearing hunk (hub#197/bi#57 red-check target): the reproduction
// comparison below. Neutering it to always-true must trip S9 with
// "non-reproducing red-check rejected naming hunk + observed-vs-expected".
// Red-check 2026-09-07 (bi#57): comparison forced true -> S9 failed LOUD
// with the named primary
//   "FAIL S9 non-reproducing red-check rejected naming hunk + observed-vs-expected ..."
// plus the dependent warn-first S9 line cascading — a vacuous red-check
// passed, attestation counted as execution; restored, green.

export const warnRedCheckAttestation = (bindsAfter = CAMPAIGN_BUDGETS.redCheckBindsAfter) =>
	`[bais] red-check warn: attestation-only red-check (prose presence, no executed revert) — warns this cycle; refusal binds after ${bindsAfter} (warn-first, hub#158)`;

export const refuseRedCheckAttestation = () =>
	`[bais] red-check: fold rejected — attestation-only red-check; the named hunk must be reverted and the suite re-run (empirical, bi#57)`;

export const warnRedCheckNotReproduced = (hunk, expected, observed, bindsAfter = CAMPAIGN_BUDGETS.redCheckBindsAfter) =>
	`[bais] red-check warn: hunk ${hunk} did not reproduce the expected failure (expected: ${JSON.stringify(expected)}; observed: ${JSON.stringify(observed)}) — warns this cycle; refusal binds after ${bindsAfter} (warn-first, hub#158)`;

export const refuseRedCheckNotReproduced = (hunk, expected, observed) =>
	`[bais] red-check: fold rejected — hunk ${hunk} did not reproduce the expected failure (expected: ${JSON.stringify(expected)}; observed: ${JSON.stringify(observed)})`;

// Empirical red-check verdict. redcheck: { hunk, expected, ... } — the
// reviewer-brief record; execute: (redcheck) => observed output string
// after reverting the hunk and re-running the suite (host-owned, injected
// so the gate stays offline-deterministic). Returns:
//   { ok, attestationOnly, observed, refusal, warning }
export function verifyRedCheck({ redcheck = null, execute = null, phase = CAMPAIGN_BUDGETS.redCheckPhase } = {}) {
	const rc = redcheck ?? {};
	const hunk = String(rc.hunk ?? "").trim();
	const expected = String(rc.expected ?? "").trim();
	if (hunk === "" || expected === "" || typeof execute !== "function") {
		return phase === "warn"
			? { ok: true, attestationOnly: true, observed: "", refusal: null, warning: warnRedCheckAttestation() }
			: { ok: false, attestationOnly: true, observed: "", refusal: refuseRedCheckAttestation(), warning: null };
	}
	const observed = String(execute(rc) ?? "");
	if (observed.includes(expected)) return { ok: true, attestationOnly: false, observed, refusal: null, warning: null };
	return phase === "warn"
		? { ok: false, attestationOnly: false, observed, refusal: null, warning: warnRedCheckNotReproduced(hunk, expected, observed) }
		: { ok: false, attestationOnly: false, observed, refusal: refuseRedCheckNotReproduced(hunk, expected, observed), warning: null };
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
// S6 e2e progress — burndown reports e2e-cases-green alongside
//   issues-closed (hub#199).
// S7 oracle-continuity — a fold landing during a red e2e suite refuses
//   the refill naming red cases; fix exception, warn-first, green-path
//   unchanged, live-surface loud skip (hub#187).
// S8 fold-scope — diff paths ⊆ declared Files: footprint; undeclared
//   footprint operator-confirms (hub#175 string); over-budget warn-first
//   (hub#192).
// S9 measurement — burndown e2e_passing divergence leg, per-issue
//   requeue triage hold, empirical red-check at fold (hub#197).
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

// S7: oracle-continuity fold gate (hub#187) — a fold landing while the
// e2e oracle is red refuses the next refill naming the red case ids; the
// fix exception passes; warn-first prints the pinned string without
// refusing; green suite refills exactly as today; live-surface cases
// skip loud offline. Scaffolds are tmp-generated plain-node scripts
// (offline, no model key), run through hub#213's runGoalGate via
// goalGates — real processes, deterministic exit codes.
function scenarioOracleContinuity() {
	const e2eDir = mkdtempSync(join(tmpdir(), "campaign-e2e-"));
	writeFileSync(join(e2eDir, "green-case.mjs"), "process.exit(0);\n");
	writeFileSync(join(e2eDir, "red-case.mjs"), 'console.error("FAIL: red-case: scaffold-unimplemented");\nprocess.exit(1);\n');
	const goal = { sketch: { e2e: [{ case: "green-case" }, { case: "red-case" }] } };
	const gates = goalGates(goal, { e2eDir });
	check("S7 goalGates maps cases to deterministic argv",
		gates.length === 2 && gates[0].name === "green-case" && gates[1].argv[0] === "node", JSON.stringify(gates));

	const red = oracleContinuity({ gates, issueBody: "Acceptance:\n- unrelated fold work", phase: "fail" });
	check("S7 red oracle refuses the refill naming red cases",
		red.ok === false && red.refusal === refuseOracleRed(["red-case"]) && red.warning === null, JSON.stringify(red));
	const refused = planRefill({ seated: [], leased: [], fresh: ["t#01"], budget: 1, oracle: red });
	check("S7 planRefill refuses loud on red oracle (never swallowed quiet)",
		refused.refills.length === 0 && refused.refused === red.refusal, JSON.stringify(refused));

	const fix = oracleContinuity({ gates, issueBody: "Acceptance:\n- red-case goes green with this fold (it is the fix)", phase: "fail" });
	check("S7 fold whose issue names the red case passes (it is the fix)",
		fix.ok === true && fix.refusal === null && JSON.stringify(fix.fixed) === '["red-case"]', JSON.stringify(fix));

	const warn = oracleContinuity({ gates, issueBody: "", phase: "warn" });
	check("S7 warn-first cycle prints the pinned warning without refusing",
		warn.ok === false && warn.refusal === null && warn.warning === warnOracleRed(["red-case"]), JSON.stringify(warn));
	const proceeds = planRefill({ seated: [], leased: [], fresh: ["t#01"], budget: 1, oracle: warn });
	check("S7 warn-first refill proceeds exactly as today",
		JSON.stringify(proceeds.refills) === '["t#01"]' && proceeds.refused === null, JSON.stringify(proceeds));

	const greenOnly = oracleContinuity({ gates: goalGates({ sketch: { e2e: [{ case: "green-case" }] } }, { e2eDir }), phase: "fail" });
	check("S7 green suite keeps the happy path unchanged",
		greenOnly.ok === true && greenOnly.refusal === null && greenOnly.warning === null && greenOnly.red.length === 0, JSON.stringify(greenOnly));

	const live = oracleContinuity({ gates: [...goalGates({ sketch: { e2e: [{ case: "green-case" }] } }, { e2eDir }), { name: "live-smoke", live: true, argv: ["node", "-e", "process.exit(1)"] }], phase: "fail" });
	check("S7 live-surface case skips loud offline (never reds, never greens)",
		live.ok === true && live.skips.length === 1 && live.skips[0] === warnLiveSkip("live-smoke") && live.red.length === 0, JSON.stringify(live.skips));
	check("S7 live-skip string pins the loud-skip precedent",
		warnLiveSkip("live-smoke").includes("loud-skip precedent, bi/scripts/E2E.md:16-18"), warnLiveSkip("live-smoke"));
}

// S8: fold-scope check (hub#192) — diff paths must be a subset of the
// issue's declared Files: footprint; undeclared footprint routes to
// operator-confirm with the pinned hub#175 string; over-budget folds
// warn first and refuse after the named milestone. Pure functions over
// diff text + issue body; no LLM, offline.
function scenarioFoldScope() {
	const body = "Scope this fold.\nFiles: src/owned.ts\nFiles: src/dir/\nAcceptance:\n- owned work only";
	const inScope = foldScope({ diff: `${diffFor("src/owned.ts")}\n${diffFor("src/dir/inner.ts")}`, issueBody: body, issueId: "s#01", phase: "fail", budgetPhase: "fail" });
	check("S8 in-scope fold validates exactly as today",
		inScope.ok === true && inScope.refusal === null && inScope.warning === null, JSON.stringify(inScope));

	const outDiff = `${diffFor("src/owned.ts")}\n${diffFor("src/other.ts")}`;
	const rejected = foldScope({ diff: outDiff, issueBody: body, issueId: "s#01", phase: "fail" });
	check("S8 out-of-scope fold rejected naming the path",
		rejected.ok === false && rejected.refusal === refuseFoldScope("s#01", ["src/other.ts"]) && JSON.stringify(rejected.excess) === '["src/other.ts"]', JSON.stringify(rejected));
	const warned = foldScope({ diff: outDiff, issueBody: body, issueId: "s#01", phase: "warn" });
	check("S8 warn-first prints the pinned warning without refusing",
		warned.ok === false && warned.refusal === null && warned.warning === warnFoldScope("s#01", ["src/other.ts"]), JSON.stringify(warned));

	const unknown = foldScope({ diff: diffFor("src/owned.ts"), issueBody: "No footprint declared here.", issueId: "s#02", phase: "fail" });
	check("S8 undeclared footprint routes to operator-confirm (hub#175 posture, never silently safe)",
		unknown.ok === false && unknown.refusal === null && unknown.operatorConfirm === warnFoldScopeUnknown("s#02"), JSON.stringify(unknown));
	check("S8 unknown-footprint string carries the hub#175 parenthetical verbatim",
		warnFoldScopeUnknown("s#02").includes("(no Files: — confirm scope with the operator before writing)"), warnFoldScopeUnknown("s#02"));

	const bigDiff = ["a/1.ts", "a/2.ts", "a/3.ts", "a/4.ts", "a/5.ts", "a/6.ts"].map((p) => diffFor(`src/dir/${p}`)).join("\n");
	const bigBody = "Files: src/dir/\n";
	const bigWarn = foldScope({ diff: bigDiff, issueBody: bigBody, issueId: "s#03", phase: "fail", budgetPhase: "warn" });
	check("S8 over-budget fold warns in cycle one",
		bigWarn.ok === false && bigWarn.overBudget === true && bigWarn.refusal === null &&
			bigWarn.warning === warnFoldBudget("s#03", 6, 6), JSON.stringify(bigWarn));
	const bigFail = foldScope({ diff: bigDiff, issueBody: bigBody, issueId: "s#03", phase: "fail", budgetPhase: "fail" });
	check("S8 over-budget fold refuses after the named milestone",
		bigFail.ok === false && bigFail.refusal === refuseFoldBudget("s#03", 6, 6), JSON.stringify(bigFail));
	check("S8 budget values live in data (CAMPAIGN_BUDGETS), not literals",
		CAMPAIGN_BUDGETS.foldMaxPaths === 5 && CAMPAIGN_BUDGETS.foldMaxHunks === 12 && typeof CAMPAIGN_BUDGETS.requeueMaxCycles === "number", JSON.stringify(CAMPAIGN_BUDGETS));

	check("S8 diffPaths counts each touched path once (b/ side)",
		JSON.stringify(diffPaths(`${diffFor("x.ts")}\n${diffFor("x.ts")}\n${diffFor("y.ts")}`)) === '["x.ts","y.ts"]', "");
	check("S8 diffHunks counts @@ headers", diffHunks(`${diffFor("x.ts")}\n${diffFor("y.ts")}`) === 2, "");
	check("S8 declared file never scopes in a sibling prefix",
		foldScope({ diff: diffFor("src/owned.tss"), issueBody: body, issueId: "s#01", phase: "fail" }).excess.join() === "src/owned.tss", "");
}

// S9: campaign measurement (hub#197) — the burndown's e2e_passing leg
// flags divergence loud; per-issue requeue budget holds churn for
// triage; empirical red-check rejects non-reproducing hunks naming the
// hunk + observed-vs-expected. All deterministic and offline.
function scenarioMeasurement() {
	const diverging = [
		sampleBurndown({ t: "t0", ready: 4, openRadius: 6, oracleGreen: 1 }),
		sampleBurndown({ t: "t1", ready: 1, openRadius: 1, oracleGreen: 1 }),
	];
	const div = burndownOracleDivergence(diverging);
	check("S9 ready draining with a flat e2e_passing leg flags loud naming the divergence",
		div === "[bais] burndown divergence: ready drained 4 -> 1 while e2e_passing never rose (1 -> 1) — micro-split gaming signal (hub#197)", String(div));
	const corroborated = [
		sampleBurndown({ t: "t0", ready: 4, openRadius: 6, oracleGreen: 1 }),
		sampleBurndown({ t: "t1", ready: 1, openRadius: 1, oracleGreen: 3 }),
	];
	check("S9 oracle rising with the burndown is clean",
		burndownOracleDivergence(corroborated) === null && burndownDecrements(corroborated) === true, "");
	check("S9 oracle-less campaign stays silent on the divergence leg",
		burndownOracleDivergence([sampleBurndown({ t: "t0", ready: 4, openRadius: 6 }), sampleBurndown({ t: "t1", ready: 0, openRadius: 0 })]) === null, "");
	check("S9 burndown renders the e2e_passing leg only when carried",
		formatBurndown(diverging) === "burndown t=t0 ready=4 open_radius=6 e2e_passing=1\nburndown t=t1 ready=1 open_radius=1 e2e_passing=1", formatBurndown(diverging));
	check("S9 goal status projects the oracle leg",
		JSON.stringify(toGoalStatus(diverging)) === '{"ready":1,"open_radius":1,"e2e_passing":1}', JSON.stringify(toGoalStatus(diverging)));
	check("S9 flat-then-cliff burndown reads as the named pattern",
		burndownPattern([sampleBurndown({ t: "t0", ready: 4, openRadius: 6 }), sampleBurndown({ t: "t1", ready: 4, openRadius: 6 }), sampleBurndown({ t: "t2", ready: 1, openRadius: 1 })]) ===
			"flat-then-cliff (integration deferred to the end)", "");
	check("S9 steady burndown reads steady, unmoved reads flat",
		burndownPattern(corroborated) === "steady" && burndownPattern([sampleBurndown({ t: "t0", ready: 2, openRadius: 2 }), sampleBurndown({ t: "t1", ready: 2, openRadius: 2 })]) === "flat", "");

	// Requeue budget: applyVerdict counts each Open→Doing→Open cycle per
	// id; > 2 cycles holds the issue from refill with the triage-hold
	// reason (warnRefillSkip shape verbatim); <= 2 refills normally.
	let st = newCampaign(2);
	const failVerdict = (pack) => ({ pack, verdict: "FAIL", members: ["q#01"], failed: ["q#01"], reasons: ["item q#01 no diff under review"], releases: false });
	for (const round of ["r1", "r2", "r3"]) st = applyVerdict({ ...st, seated: ["q#01"] }, failVerdict(round)).state;
	check("S9 applyVerdict counts requeue cycles per id", st.requeueCounts["q#01"] === 3, JSON.stringify(st.requeueCounts));
	const heldOut = planRefill({ seated: [], leased: [], fresh: ["q#01", "q#02"], budget: 2, requeueCounts: st.requeueCounts });
	check("S9 three requeue cycles holds for triage",
		JSON.stringify(heldOut.refills) === '["q#02"]' &&
			heldOut.skips.some((l) => l === warnRefillSkip("q#01", "triage hold: 3 requeue cycles (> 2) — operator triage before re-pack")), JSON.stringify(heldOut));
	const twoCycles = planRefill({ seated: [], leased: [], fresh: ["q#01"], budget: 1, requeueCounts: { "q#01": 2 } });
	check("S9 two requeue cycles refills normally", JSON.stringify(twoCycles.refills) === '["q#01"]' && twoCycles.skips.length === 0, JSON.stringify(twoCycles));

	// Empirical red-check at fold: the named hunk is reverted and the
	// suite re-run by the injected executor (host executes; the gate owns
	// what counts as the right failure).
	const reproduces = verifyRedCheck({ redcheck: { hunk: "subset-check", expected: "FAIL scope" }, execute: () => "1 failure: FAIL scope out-of-scope fold validated", phase: "fail" });
	check("S9 reproducing red-check passes", reproduces.ok === true && reproduces.refusal === null, JSON.stringify(reproduces));
	const vacuous = verifyRedCheck({ redcheck: { hunk: "subset-check", expected: "FAIL scope" }, execute: () => "campaign: all green (62 pass)", phase: "fail" });
	check("S9 non-reproducing red-check rejected naming hunk + observed-vs-expected",
		vacuous.ok === false && vacuous.refusal === refuseRedCheckNotReproduced("subset-check", "FAIL scope", "campaign: all green (62 pass)"), JSON.stringify(vacuous));
	const vacuousWarn = verifyRedCheck({ redcheck: { hunk: "subset-check", expected: "FAIL scope" }, execute: () => "campaign: all green (62 pass)", phase: "warn" });
	check("S9 non-reproducing red-check warns first naming the same evidence",
		vacuousWarn.ok === false && vacuousWarn.refusal === null &&
			vacuousWarn.warning === warnRedCheckNotReproduced("subset-check", "FAIL scope", "campaign: all green (62 pass)"), JSON.stringify(vacuousWarn));
	const attestation = verifyRedCheck({ redcheck: { hunk: "subset-check", observed: "prose only" }, execute: () => "irrelevant", phase: "warn" });
	check("S9 attestation-only red-check downgrades to warn",
		attestation.ok === true && attestation.attestationOnly === true && attestation.warning === warnRedCheckAttestation(), JSON.stringify(attestation));
	const attestationFail = verifyRedCheck({ redcheck: { hunk: "subset-check", observed: "prose only" }, execute: () => "irrelevant", phase: "fail" });
	check("S9 attestation-only red-check fails after the milestone",
		attestationFail.ok === false && attestationFail.refusal === refuseRedCheckAttestation(), JSON.stringify(attestationFail));
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
	scenarioOracleContinuity();
	scenarioFoldScope();
	scenarioMeasurement();
	if (fail) {
		console.error(`${fail} failure(s), ${pass} pass`);
		process.exit(1);
	}
	console.log(`campaign: all green (${pass} pass)`);
}
