// bais/scripts/goal.mjs — bi#132: goal object + /goal interview/sketch/commit flow (scripts lane).
//
// Goals live per directory (.bais/goal.toml: statement, non_goals,
// done_criteria, style, hero) — one active campaign per directory, not one
// backlog ever. /goal <statement> runs the scoping interview against a
// visible completeness checklist; the LLM may not sketch until every box is
// filled or waived. Every question ends with a use-defaults escape, plus a
// max-rounds cap, so scoping cannot become an interrogation. /goal sketch
// dry-runs the graph proposal (nodes + edges + radii) for human edit;
// /goal commit writes files; /goal status tracks acceptance; /goal switch
// runs the restructure flow.
//
// SRC-LANE WIRING (not this file — needs bais/src/cli.ts, outside this
// lane's footprint; follow the briefs.mjs precedent): add a `goal`
// subcommand with `<start|sketch|commit|status|switch>`, per-directory
// `.bais/goal.toml` load/save via renderGoalToml/parseGoalToml, interview
// loop via nextQuestion/answer/waive/useDefaults, dry-run via sketch()
// printed for human edit, gated write via commit(..., { approved, write })
// where `approved` is an explicit human yes (never defaulted), and
// restructure via switchGoal(). Until then the operator runs:
//   node bais/scripts/goal.mjs --selftest
// against bais/scripts/fixtures/goal/.
//
// Load-bearing hunk (bi#132/bi#57 red-check target): the sketch guard.
// Reverting sketch() to skip the checklistComplete() refusal must trip the
// selftest with exactly:
//   "FAIL selftest: sketch refused while checklist open"
// (verified 2026-09-06: guard removed -> that FAIL observed -> restored green).
//
// hub#213 (hermes /goal mechanics): the interview checklist gains a tenth
// box, "contract" — the five-field completion contract (outcome,
// verification, constraints, boundaries, stop_when), shape-only validated
// per the validateGoal precedent and round-tripped through goal.toml — and
// the file gains a deterministic gate runner (runGoalGate): gates must exit
// 0 BEFORE any judge verdict, a git-fingerprint cache replays a recorded
// failure on unchanged workspace state without re-running, and bounded
// retries auto-pause with a named reason on exhaustion. See the hub#213
// sections below.
//
// hub#196 (sufficiency gate made a REAL branch): a stay-on-box reply — a
// bare "more"/"no"/"ask more", or a reply that is itself a question — never
// settles the box; it asks a follow-up on the SAME box and re-asks the
// settle prompt. Follow-ups cost per-box sub-rounds (MAX_BOX_FOLLOWUPS),
// never the global round budget, so a genuine loop on one box cannot starve
// the rest; sub-round exhaustion escapes via the reasoned-default path
// (hub#185 idiom: a defaulted waiver record naming the cap).
//
// hub#186 (skeleton-first ordering): sketch() always emits a `baseline`
// walking-skeleton node, chains done_criteria in build order (c1→c2→…→hero)
// instead of the flat star, and seats every criterion DependsOn baseline.
// foundationRank/compareFoundation are the pure derivation half; dispatch
// wiring (warn-first seating line + --json foundation flag) is dispatch.mjs
// consumer-side.
//
// hub#190 (weak-oracle defenses): every e2e exercise must decompose to
// {command, expect} (assert-true shapes fail loud at COMMIT time, not at
// consumption), every e2e case must cite ≥1 surface_spec facet (or the
// explicit "waiver" facet) with drifted citations reported naming the stale
// facet, generated scaffolds carry a red-check record header, and
// unreasoned surface_spec amendments flag loud in status() warns.
//
// hub#195 (goal-churn continuity): goals churn in long-horizon campaigns —
// "one overarching goal per project" stays true per campaign VERSION.
//   1. switchGoal returns the old campaign's surfaces for an explicit
//      keep/retire decision (applySurfaceDecisions), mirroring the retire
//      node list; undecided surfaces keep their cases but flagged.
//   2. commit() stamps every e2e scaffold with the campaign snapshot id
//      (goalSnapshotId, lifecycle.mjs) it was authored under; kept cases
//      rebind explicitly to the new snapshot id (rebindE2eSnapshot).
//   3. The re-interview's surface-spec box defaults to the archived
//      campaign's spec (fresh.prefill, consumed by defaultFor/useDefaults —
//      edit, don't rewrite). In-memory: the prefill rides the fresh goal
//      through `bais goal switch`'s immediate re-interview.
//   4. commit() records approved_sketch_hash + goal_snapshot in goal.toml;
//      drift flags loud in `bais check` (verifyApprovedSketch, the bi#136
//      "snapshot stale" precedent — never silently honored).
//
// Load-bearing hunk (hub#195/bi#57 red-check target): the approved-sketch
// hash write in commit() (goal.approved_sketch_hash = ... before the
// goal.toml render). Dropping it must trip the selftest below with exactly:
//   "FAIL selftest: commit records the approved-sketch hash in goal.toml"
// (verified 2026-09-08: assignment removed -> that FAIL observed first,
// with the tamper check cascading red behind it (goal.toml grandfathered
// without the recorded hash), exit 1 -> restored green).
// The mismatch refusal half lives in lifecycle.mjs verifyApprovedSketch
// (its red-check: "tampered sketch.toml is refused loud against the
// approved-sketch hash" — verified 2026-09-08: refusal neutered to
// always-ok -> that FAIL observed with the missing-sketch drift check
// behind it, exit 1; goal.mjs selftest's post-approval-edit check cascaded
// red -> restored green).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approvedSketchHash, goalSnapshotId, verifyApprovedSketch } from "./lifecycle.mjs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "goal");

export const CHECKLIST = ["users", "scale", "platform", "constraints", "style", "acceptance", "non-goals", "testing-surface", "surface-spec", "contract"];

// Max interview rounds: one per box plus slack, then the rest auto-default.
// Scoping stops being an interrogation even if the human never says "defaults".
export const MAX_ROUNDS = 11;

// Every interview question ends with this escape (asserted by the selftest).
export const DEFAULTS_ESCAPE = `Reply with a value, "waive" to skip this box, or "defaults" to fill every remaining box with defaults and move on.`;

// hub#165: explicit sufficiency gate asked every interview round — the exact
// question plus the stated incentive (more detail now = stronger generated
// e2e). Asked ahead of the defaults escape; the escape and the rounds cap
// are unchanged.
export const SUFFICIENCY_QUESTION = "Is that enough detail, or should I ask more questions?";
export const SUFFICIENCY_INCENTIVE = "More detail now = stronger generated e2e.";

// --- stay-on-box follow-ups (hub#196, scripts lane) ---
//
// hub#165's sufficiency gate was decorative: the CLI read ONE line per box
// and settled it, so an honest "no, ask more" BECAME the box value. This
// makes the gate a real branch, pure policy in goal.mjs (the hub#163
// single-source rule — cli.ts stays an argv router and needs no change:
// answer() simply leaves the box open and nextQuestion() re-asks the same
// box, so the existing one-line-per-box loop stays on the box naturally).
//
// A reply is STAY-ON-BOX when it is itself a question (ends "?") or a bare
// "more"/"no"/"ask more" form. stayOnBox() records a per-box sub-round and
// sets followupBox; nextQuestion() then asks the follow-up prompt for that
// box instead of advancing. Sub-rounds never touch goal.rounds — an
// extended loop on one box does not consume the rounds of later boxes.
// Exhaustion (past MAX_BOX_FOLLOWUPS) escapes via the reasoned-default
// path (hub#185 idiom): the box settles defaulted with a value naming the
// cap — for the loud boxes a waiver record, never a silent absence.
//
// Load-bearing hunk (hub#196/bi#57 red-check target): the stay-on-box
// branch in answer(). Removing it must trip the selftest below with
// exactly:
//   "FAIL selftest: stay-on-box reply never settles as the box value"
//   "FAIL selftest: stay-on-box reply asks a follow-up instead of settling"
// (verified 2026-09-07: branch removed -> both FAILs observed in that
// order ("more" settles verbatim on plain boxes; on testing-surface it
// throws with no follow-up ever asked), exit 1 -> restored green).
export const MAX_BOX_FOLLOWUPS = 3;

export function isStayOnBoxReply(value) {
	const t = String(value ?? "").trim().toLowerCase();
	if (t === "") return false;
	if (t.endsWith("?")) return true;
	return ["more", "no", "ask more", "more questions", "no, ask more", "not enough"].includes(t);
}

// The follow-up prompt re-asks the same box. The sufficiency gate +
// incentive + defaults escape render verbatim at the end, byte-identical
// to every settle prompt — the escape hatches stay one word at every point
// (the reasoned waiver is the backstop, not more questions).
export function followupQuestion(box) {
	return `Staying on ${box} — what additional detail should we capture before settling it? ${BOX_QUESTIONS[box]} ${SUFFICIENCY_QUESTION} ${SUFFICIENCY_INCENTIVE} ${DEFAULTS_ESCAPE}`;
}

// Record a stay-on-box sub-round. Within budget: mark the box as awaiting
// its follow-up answer and leave it open. Past budget: escape via the
// reasoned-default path (the rounds-cap idiom, hub#185) so a loop that
// never converges still cannot become an interrogation.
function stayOnBox(goal, box) {
	const n = (goal.followups?.[box] ?? 0) + 1;
	goal.followups[box] = n;
	if (n > MAX_BOX_FOLLOWUPS) {
		const capped = {
			"testing-surface": `waiver => stay-on-box follow-up cap reached (max ${MAX_BOX_FOLLOWUPS} follow-ups): no testing surface declared`,
			"surface-spec": `waiver => stay-on-box follow-up cap reached (max ${MAX_BOX_FOLLOWUPS} follow-ups): no surface declared, taste unexamined`,
			contract: `waiver => stay-on-box follow-up cap reached (max ${MAX_BOX_FOLLOWUPS} follow-ups): no completion contract declared`,
		};
		goal.boxes[box] = { status: "defaulted", value: capped[box] ?? DEFAULTS[box] };
		goal.followupBox = null;
		return goal;
	}
	goal.followupBox = box;
	return goal;
}

export const DEFAULTS = {
	users: "solo dev",
	scale: "single directory",
	platform: "local CLI",
	constraints: "offline-friendly",
	style: "plain",
	acceptance: "done criteria all checked",
	"non-goals": "none declared",
	// hub#185: the defaults escape is an explicit human act, so defaulting
	// the testing surface records a reasoned waiver (never a silent
	// absence) — the oracle-gap auto-issue in commit() quotes this reason.
	"testing-surface": "waiver => defaults escape: no testing surface declared",
	// hub#166: the defaults escape is an explicit human act, so defaulting
	// records a waiver (status defaulted, never an explicit waiver) — and
	// NEVER purity: a pure-no-io exemption is only ever established
	// explicitly via answerSurfaceSpec, never assumed.
	"surface-spec": "waiver => defaults escape: no surface declared, taste unexamined",
	// hub#213: same rule for the completion contract — defaulting records a
	// reasoned waiver, never a silent absence of the done-definition.
	contract: "waiver => defaults escape: no completion contract declared",
};

const BOX_QUESTIONS = {
	users: "Who is this goal for?",
	scale: "What scale must it handle?",
	platform: "What platform does it run on?",
	constraints: "What constraints bind it?",
	style: "What style should the work follow?",
	acceptance: "How will we know it is done?",
	"non-goals": "What is explicitly out of scope?",
	"testing-surface":
		"What does done LOOK like — which commands, views, or flows prove it, and how is each exercised? (one item per surface: <surface> => <how to exercise>, items separated by ';')",
	// hub#166: asked after testing-surface (CHECKLIST order) — what GOOD
	// looks like for the goal's interface surface. Settle only via
	// answerSurfaceSpec: spec items, an explicit taste-waiver with reason,
	// or an explicitly established pure-no-io exemption.
	"surface-spec":
		'What does GOOD look like — which existing spec, design, or artifacts define the interface surface (UI design, presentation form, parser token spec, API shape, machine-readable format)? (one item per facet: <facet> => <spec or design ref>, items separated by \';\'; "waiver => <reason>" records an explicit taste-waiver, "pure-no-io => <reason>" records a goal with truly no I/O)',
	// hub#213: the hermes completion contract — asked last (CHECKLIST order),
	// five fields, each "<field> => <text>". Settle only via answerContract:
	// all five fields, or an explicit waiver with reason.
	contract:
		'What is the completion contract — outcome => <what done delivers>; verification => <how done is proven>; constraints => <what binds the work>; boundaries => <what is out of scope>; stop_when => <when to stop>? (all five fields, items separated by \';\'; "waiver => <reason>" records an explicit contract-waiver)',
};

export function newGoal(statement) {
	const boxes = {};
	for (const box of CHECKLIST) boxes[box] = { status: "open", value: "" };
	// hub#196: followups = per-box stay-on-box sub-round counts; followupBox =
	// the box awaiting its follow-up answer (null when none). Both persist
	// through goal.toml so a saved/resumed interview keeps the loop state.
	return { statement: String(statement ?? ""), boxes, rounds: 0, followups: {}, followupBox: null, sketch: null, approved: false };
}

export function openBoxes(goal) {
	return CHECKLIST.filter((b) => goal.boxes[b].status === "open");
}

export function checklistComplete(goal) {
	return openBoxes(goal).length === 0;
}

// Next interview question, or null when the checklist is complete. Past the
// rounds cap the remaining boxes auto-default and a notice (also escape-
// terminated) is returned instead of a further question.
export function nextQuestion(goal) {
	if (checklistComplete(goal)) return null;
	if (goal.rounds >= MAX_ROUNDS) {
		// hub#185: the rounds cap records distinctly WHY the oracle is
		// absent — the capped value names the cap, never the plain default.
		const tsOpen = goal.boxes["testing-surface"] && goal.boxes["testing-surface"].status === "open";
		useDefaults(goal);
		if (tsOpen) {
			goal.boxes["testing-surface"] = {
				status: "defaulted",
				value: `waiver => rounds cap reached (max ${MAX_ROUNDS} rounds): no testing surface declared`,
			};
		}
		return `Rounds cap (${MAX_ROUNDS}) reached — remaining boxes filled with defaults. ${DEFAULTS_ESCAPE}`;
	}
	const box = openBoxes(goal)[0];
	// hub#196: a box awaiting its follow-up answer re-asks the follow-up
	// prompt instead of advancing — a per-box sub-round that never consumes
	// the global round budget of later boxes.
	if (goal.followupBox === box) return followupQuestion(box);
	goal.followupBox = null;
	goal.rounds++;
	return `${BOX_QUESTIONS[box]} ${SUFFICIENCY_QUESTION} ${SUFFICIENCY_INCENTIVE} ${DEFAULTS_ESCAPE}`;
}

export function answer(goal, box, value) {
	if (!(box in goal.boxes)) throw new Error(`unknown checklist box: ${box}`);
	// hub#196 (the red-check target — see the stay-on-box section header): a
	// stay-on-box reply never settles. It asks a follow-up on the same box;
	// the box stays open and the substance settles it later.
	if (goal.boxes[box].status === "open" && isStayOnBoxReply(value)) return stayOnBox(goal, box);
	// A substantive reply clears any pending follow-up before settling.
	if (goal.followupBox === box) goal.followupBox = null;
	// hub#166: every settle of the surface-spec box runs the loud
	// validation — a UI goal without a design fails here, not silently.
	if (box === "surface-spec") return answerSurfaceSpec(goal, value);
	// hub#185: the testing-surface box settles loud for the same reason —
	// a surface without an exercise half fails here, not silently.
	if (box === "testing-surface") return answerTestingSurface(goal, value);
	// hub#213: the contract box settles loud — a contract missing one of the
	// five fields fails here, not silently.
	if (box === "contract") return answerContract(goal, value);
	if (goal.boxes[box].status !== "open") throw new Error(`box already settled: ${box}`);
	goal.boxes[box] = { status: "filled", value: String(value ?? "") };
	return goal;
}

export function waive(goal, box) {
	if (!(box in goal.boxes)) throw new Error(`unknown checklist box: ${box}`);
	// hub#166: the surface-spec box cannot be bare-waived — a waiver without
	// a reason is exactly the silent taste-invention the box exists to stop.
	if (box === "surface-spec") {
		throw new Error(
			`surface-spec cannot be bare-waived: supply "<facet> => <spec>" via answerSurfaceSpec, an explicit taste-waiver "waiver => <reason>", or a pure exemption "pure-no-io => <reason>"`,
		);
	}
	// hub#185: the testing-surface box cannot be bare-waived either — a
	// skipped oracle without a reason is exactly the silent absence the
	// oracle-gap auto-issue exists to stop. Skipping stays one line via
	// "waiver => <reason>" (or "none-needed => <reason>" for a goal with
	// genuinely no observable surface); *silent* skipping dies here.
	if (box === "testing-surface") {
		throw new Error(
			`testing-surface cannot be bare-waived: supply "<surface> => <exercise>" via answer, an explicit waiver "waiver => <reason>", or "none-needed => <reason>" for a goal with genuinely no observable surface`,
		);
	}
	// hub#213: the contract box cannot be bare-waived either — a skipped
	// done-definition without a reason is exactly the silent gap the
	// five-field contract exists to stop. Skipping stays one line via
	// "waiver => <reason>"; *silent* skipping dies here.
	if (box === "contract") {
		throw new Error(
			`contract cannot be bare-waived: supply all five fields "<field> => <text>" via answerContract, or an explicit waiver "waiver => <reason>"`,
		);
	}
	if (goal.boxes[box].status !== "open") throw new Error(`box already settled: ${box}`);
	goal.boxes[box] = { status: "waived", value: "" };
	return goal;
}

// The box default: DEFAULTS, overridden by a switch prefill (hub#195 — the
// re-interview's surface-spec box defaults to the archived campaign's spec
// as the starting value; edit, don't rewrite).
export function defaultFor(goal, box) {
	const pre = goal?.prefill?.[box];
	return typeof pre === "string" && pre.trim() !== "" ? pre : DEFAULTS[box];
}

// The use-defaults escape: every still-open box takes its default.
export function useDefaults(goal) {
	for (const box of openBoxes(goal)) goal.boxes[box] = { status: "defaulted", value: defaultFor(goal, box) };
	return goal;
}

// Dry-run only: pure data, writes nothing. Refused while any box is open.
//
// hub#186 (skeleton-first ordering): the flat star (every criterion
// DependsOn hero) discarded the done_criteria array order — the natural
// build order — so equal blast-radius ties fell to lexical id and issue
// number silently became priority. The sketch now emits a `baseline`
// walking-skeleton node, chains the criteria in declared build order
// (c1→c2→…→hero, DependsOn), and seats every criterion DependsOn baseline
// (plus baseline→hero so the skeleton rolls up). Ordering as structure,
// not advice (Agentless fixed-phase pipelines, least-to-most decomposition
// — cited in the issue body).
//
// Load-bearing hunk (hub#186/bi#57 red-check target): the baseline node +
// chain. Reverting nodes/edges to the flat star must trip the selftest
// below with exactly:
//   "FAIL selftest: sketch emits the baseline walking-skeleton node"
// (verified 2026-09-07: flat star restored -> that FAIL observed first,
// with the chain-order and criterion-DependsOn-baseline checks red behind
// it, exit 1 -> restored green).
export const BASELINE_NODE_TITLE =
	"walking skeleton: minimal end-to-end path through every declared testing_surface item, proved by the e2e suite";

export function sketch(goal) {
	if (!checklistComplete(goal)) {
		return { ok: false, error: `sketch refused: checklist open (${openBoxes(goal).join(", ")})` };
	}
	const criteria = goalCriteria(goal);
	const nodes = [
		{ id: "hero", title: heroOf(goal) || goal.statement, radius: ["."] },
		{ id: "baseline", title: BASELINE_NODE_TITLE, radius: [] },
		...criteria.map((c, i) => ({ id: `c${i + 1}`, title: c.text, radius: [] })),
	];
	const edges = [
		{ from: "baseline", to: "hero", kind: "DependsOn" },
		// Build order as structure: c1→c2→…→hero (a zero/one-criterion goal
		// collapses to baseline→hero / c1→hero).
		...criteria.map((_, i) => ({ from: `c${i + 1}`, to: i + 1 < criteria.length ? `c${i + 2}` : "hero", kind: "DependsOn" })),
		// Every criterion is an enhancement layer on the walking skeleton.
		...criteria.map((_, i) => ({ from: `c${i + 1}`, to: "baseline", kind: "DependsOn" })),
	];
	// hub#166: the declared surface spec rides the sketch as oracle material —
	// BITS compares against the declared spec, not the model's imagination.
	// (The refusal above already covers the surface-spec box: sketch stays
	// refused while it is open.)
	// hub#184: e2e case ids are stable slugs derived from the surface text
	// (kebab-case, collision-suffixed) — reordering an interview answer
	// must not rename every case. The taken set is sketch-local so commit()
	// re-deriving the same slugs from the same e2e items agrees byte for
	// byte (commit() reuses the case ids as scaffold filenames).
	goal.sketch = {
		nodes,
		edges,
		e2e: e2eCasesOf(goal),
		oracle: goalSurfaceSpec(goal).map(surfaceSpecToBitsCase),
	};
	return { ok: true, proposal: goal.sketch };
}

// The sketch's e2e cases, derived without side effects (sketch() seeds
// goal.sketch with them; switchGoal re-derives them for uncommitted goals
// — hub#195). The taken set is derivation-local so slugs stay stable.
function e2eCasesOf(goal) {
	const taken = new Set();
	return goalSurface(goal).map((s) => surfaceToBitsCase(s, taken));
}

// --- foundation_rank derivation (hub#186, scripts lane) ---
//
// The pure derivation half of skeleton-first dispatch: 0 when the issue IS
// the baseline or a `precedes`-ancestor of it (transitive over edges
// {from, to, kind: "precedes"} — from precedes to), else 1. The transitive
// closure is plain BFS (the blast_radii precedent, main.baml). dispatch.mjs
// consumes compareFoundation as the PRIMARY sort key before blast radius
// (consumer-side wiring, warn-first: it prints FOUNDATION_SEATING_WARN for
// one release before the sort becomes binding).
//
// Load-bearing hunk (hub#186/bi#57 red-check target): the foundation sort
// key. Neutering compareFoundation to always return 0 must trip the
// selftest below with exactly:
//   "FAIL selftest: foundation sort seats the baseline before higher-blast enhancements"
// (verified 2026-09-07: comparator neutered to `return 0` -> the
// enhancement outranked the baseline on blast radius -> that FAIL
// observed, exit 1 -> restored green).
export function foundationRank(issueId, baselineId, edges) {
	if (issueId === baselineId) return 0;
	const adj = new Map();
	for (const e of edges ?? []) {
		if (String(e?.kind ?? "").toLowerCase() !== "precedes") continue;
		if (!adj.has(e.from)) adj.set(e.from, []);
		adj.get(e.from).push(e.to);
	}
	const seen = new Set([issueId]);
	const queue = [issueId];
	while (queue.length > 0) {
		const cur = queue.shift();
		if (cur === baselineId) return 0;
		for (const nxt of adj.get(cur) ?? []) {
			if (!seen.has(nxt)) {
				seen.add(nxt);
				queue.push(nxt);
			}
		}
	}
	return 1;
}

// Primary sort key comparator: foundation (rank 0) before enhancement
// (rank 1), 0 within a tier so the caller's next key (blast radius, then
// lexical id) decides. Pure.
export function compareFoundation(a, b, baselineId, edges) {
	return foundationRank(a, baselineId, edges) - foundationRank(b, baselineId, edges);
}

// The warn-first seating line, exact string pinned by the issue body.
// dispatch.mjs prints it when an enhancement seats before the baseline.
export const foundationSeatingWarn = (id, base) => `[bais] enhancement ${id} seated before baseline ${base} landed`;

// Gated write: without explicit human approval NOTHING is written — the
// write callback is never invoked. Needs a complete checklist and a sketch.
//
// hub#184: commit persists the whole sketch, not just goal.toml. write is
// a (relPath, content) callback owned by the CLI — goal.mjs owns the pure
// render (renderGoalToml precedent), the CLI owns the filesystem. Paths
// are .bais-relative ("goal.toml", "sketch.toml", "e2e/<slug>.mjs",
// "issues/goal#oracle-gap.toml"); wrote reports the ".bais/<rel>" form.
// hub#185: a commit with an empty e2e oracle auto-files the oracle-gap
// issue (quoted waiver reason) so the missing oracle lands in bais ready
// as work instead of a one-time warning.
export function commit(goal, { approved = false, write = null } = {}) {
	if (!approved) return { ok: false, wrote: [], error: "commit refused: no human approval" };
	if (!checklistComplete(goal)) {
		return { ok: false, wrote: [], error: `commit refused: checklist open (${openBoxes(goal).join(", ")})` };
	}
	if (!goal.sketch) return { ok: false, wrote: [], error: "commit refused: no sketch yet" };
	if (typeof write !== "function") return { ok: false, wrote: [], error: "commit refused: no writer" };
	const e2e = Array.isArray(goal.sketch.e2e) ? goal.sketch.e2e : [];
	// hub#190: mandatory fields fail loud at COMMIT time, never at
	// consumption. Every e2e exercise must decompose to {command, expect}
	// (an assert-true shape — no expected predicate — names the missing
	// expect), and every case must cite ≥1 oracle facet (or the explicit
	// "waiver" facet); a retired citation names the stale facet. Refusal
	// happens BEFORE any write.
	for (const c of e2e) {
		try {
			parseExercise(c.exercise);
		} catch (e) {
			return { ok: false, wrote: [], error: `commit refused: e2e case ${JSON.stringify(c.case)} fails exercise shape validation — ${String(e && e.message)}` };
		}
	}
	const badJoin = oracleFacetJoin(goal).find((j) => !j.ok);
	if (badJoin) return { ok: false, wrote: [], error: `commit refused: ${badJoin.reason}` };
	// hub#195: bind the committed goal.toml to the human-approved sketch.
	// The hash + campaign snapshot id derive from the exact sketch.toml
	// bytes being written, and are stamped into goal.toml (drift flags loud
	// in `bais check` — verifyApprovedSketch) and into every e2e scaffold
	// header (the campaign version the case was authored under). This
	// assignment is the hub#195 red-check hunk (see the file header).
	const sketchToml = renderSketchToml(goal.sketch);
	goal.approved_sketch_hash = approvedSketchHash(sketchToml);
	goal.goal_snapshot = goalSnapshotId(sketchToml);
	const files = [
		{ path: "goal.toml", content: renderGoalToml(goal) },
		{ path: "sketch.toml", content: sketchToml },
	];
	// Scaffold filenames reuse the e2e case ids verbatim — the anchor join
	// between sketch cases and scaffold files is exact, never positional.
	for (const c of e2e) {
		files.push({
			path: `e2e/${c.case}.mjs`,
			content: renderE2eScaffold({ surface: c.surface, exercise: c.exercise, snapshotId: goal.goal_snapshot }),
		});
	}
	if (e2e.length === 0) files.push({ path: "issues/goal#oracle-gap.toml", content: renderOracleGapIssue(goal) });
	for (const f of files) write(f.path, f.content);
	return { ok: true, wrote: files.map((f) => `.bais/${f.path}`), error: "" };
}

// --- weak-oracle defenses (hub#190, scripts lane) ---
//
// Nothing stopped vacuous self-authored e2e: an assert-true case graded
// Pass, e2e cases cited no oracle facet, and the LLM could game ground
// truth by editing surface_spec to fit its output. Three defenses:
//
//   1. Determinism contract on exercise: parseExercise decomposes the
//      exercise half to {command, expect} plain data ("<command> =>
//      <expect>"), with an optional trailing facet citation
//      ("facets: a, b" — parenthesized or bare, at the end of the expect
//      half). Assert-true shapes (no expected predicate) throw loud — the
//      surface-spec settle-validation precedent — and commit() refuses
//      naming the case and the missing field (fail at commit time, never
//      at consumption). Readers (goalSurface, validateGoal) stay lenient
//      on legacy assert-true files; validateGoal warns (warn-first).
//   2. Mandatory oracle-facet join: oracleFacetJoin derives, per committed
//      e2e case, the cited surface_spec facets. A case citing nothing
//      fails with the named reason oracle_facet_absent; a citation naming
//      a facet no longer declared reports oracle_facet_drifted with the
//      stale facet named (the surviving/stale-receipts precedent). The
//      explicit "waiver" facet is always citable (a waived spec is data).
//   3. Spec-capture guard: status() compares the [goal] surface_spec list
//      against the interview-box-derived spec; divergence without a
//      reasoned amendment record (an appended { facet = "amendment",
//      spec = "<reason>" } item — the retire --reason idiom) flags loud in
//      warns. git hosts goal.toml, so unreasoned spec diffs are detectable.
//
// Load-bearing hunk (hub#190/bi#57 red-check target): the expect
// requirement in parseExercise. Removing it must trip the selftest below
// with exactly:
//   "FAIL selftest: assert-true exercise fails shape validation naming the missing expect"
// (verified 2026-09-07: the assert-true throw + empty-expect throw
// neutered (assert-true exercises validate as {command, expect:"pass"})
// -> that FAIL observed first, with the warn-first, empty-expect, and
// commit-refusal checks cascading red behind it, exit 1 -> restored
// green).
export function parseExercise(exercise) {
	const raw = String(exercise ?? "").trim();
	const need = `needs "<command> => <expect>" (optionally ending "facets: <facet>, ...") — an assert-true exercise grades vacuously`;
	if (raw === "") throw new Error(`invalid exercise: empty — ${need}`);
	const i = raw.indexOf("=>");
	if (i < 0) {
		throw new Error(`invalid exercise: assert-true shape, no expected predicate (got ${JSON.stringify(raw)}) — ${need}`);
	}
	const command = raw.slice(0, i).trim();
	let expect = raw.slice(i + 2).trim();
	if (!command) throw new Error(`invalid exercise: needs a command before "=>" (got ${JSON.stringify(raw)})`);
	if (!expect) {
		throw new Error(`invalid exercise: missing expected predicate after "=>" (got ${JSON.stringify(raw)}) — ${need}`);
	}
	let facets = [];
	const fm = expect.match(/\(?\s*facets:\s*([^()]+?)\s*\)?\s*$/);
	if (fm) {
		facets = fm[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
		expect = expect.slice(0, fm.index).trim().replace(/\(\s*$/, "").trim();
		if (!expect) {
			throw new Error(`invalid exercise: the facet citation consumed the whole expected predicate (got ${JSON.stringify(raw)}) — ${need}`);
		}
	}
	return { command, expect, facets };
}

// Per-case oracle-facet join: the LLM DECLARES (facet citations in the
// exercise), goal.mjs DERIVES/verifies (the bi#133 declare/derive split).
// Pure — the sketch e2e + the declared surface spec in, join rows out.
// Each row: { case, cited, drifted, ok, reason }.
export function oracleFacetJoin(goal) {
	const declared = new Set(goalSurfaceSpec(goal).map((s) => s.facet));
	const cases = Array.isArray(goal?.sketch?.e2e) ? goal.sketch.e2e : [];
	return cases.map((c) => {
		let cited = [];
		try {
			cited = parseExercise(c.exercise).facets;
		} catch {
			cited = [];
		}
		const drifted = cited.filter((f) => f !== "waiver" && !declared.has(f));
		if (cited.length === 0) {
			return {
				case: c.case,
				cited,
				drifted,
				ok: false,
				reason: `oracle_facet_absent: e2e case ${JSON.stringify(c.case)} cites no surface_spec facet — cite at least one declared facet (or the explicit "waiver" facet) via "facets: ..." in the exercise`,
			};
		}
		if (drifted.length > 0) {
			return {
				case: c.case,
				cited,
				drifted,
				ok: false,
				reason: `oracle_facet_drifted: e2e case ${JSON.stringify(c.case)} cites retired facet ${JSON.stringify(drifted[0])} (current facets: ${[...declared].join(", ") || "none"}) — re-cite a declared facet or amend surface_spec with a reasoned record`,
			};
		}
		return { case: c.case, cited, drifted, ok: true, reason: "" };
	});
}

// Acceptance tracking: done criteria checked off vs still open.
// hub#185: the oracle state rides along — an oracle-empty goal carries the
// oracle_absent warn (the cli.ts gate-warn precedent) so `bais goal status`
// says loud what the oracle-gap issue says durable.
export function status(goal) {
	const criteria = goalCriteria(goal);
	const done = criteria.filter((c) => c.done);
	const oracleEmpty = goalSurface(goal).length === 0;
	const warns = [];
	if (oracleEmpty) {
		warns.push(
			`oracle_absent: campaign has no e2e oracle — testing-surface waived (${testingSurfaceWaiverReason(goal) || "no reason recorded"})`,
		);
	}
	// hub#190 spec-capture guard: surface_spec is ground truth — the LLM
	// must not amend it to fit its output without a reasoned record. The
	// [goal] surface_spec list (file-level, what a hand/agent edit touches)
	// is compared against the interview-box-derived spec; divergence without
	// a reasoned amendment record ({ facet = "amendment", spec = "<reason>" }
	// appended — the retire --reason idiom) flags loud. A missing/empty
	// file-level list is grandfathered (pre-190 goals carry none).
	const parsedSpec = Array.isArray(goal._parsed?.surface_spec) ? goal._parsed.surface_spec : [];
	if (parsedSpec.length > 0) {
		const norm = (f) => (f === "pure" ? "pure-no-io" : String(f).toLowerCase());
		const amendments = parsedSpec.filter((s) => norm(s.facet) === "amendment");
		const fileSpec = parsedSpec
			.filter((s) => norm(s.facet) !== "amendment")
			.map((s) => [norm(s.facet), String(s.spec ?? "")]);
		const boxSpec = goalSurfaceSpec(goal).map((s) => [s.facet, s.spec]);
		if (JSON.stringify(fileSpec) !== JSON.stringify(boxSpec)) {
			const reasoned = amendments.length > 0 && amendments.every((a) => String(a.spec ?? "").trim() !== "");
			if (!reasoned) {
				warns.push(
					`surface_spec amended without a reasoned record — the declared spec is ground truth (hub#190); append { facet = "amendment", spec = "<reason>" } to surface_spec or revert the edit`,
				);
			}
		}
	}
	return {
		statement: goal.statement,
		checklist: Object.fromEntries(CHECKLIST.map((b) => [b, goal.boxes[b].status])),
		done: done.length,
		total: criteria.length,
		open: criteria.filter((c) => !c.done).map((c) => c.text),
		sketched: goal.sketch !== null,
		oracle: oracleEmpty ? "absent" : "present",
		warns,
	};
}

// Restructure flow: archive the old campaign, start a fresh interview for
// the new statement, list prior sketch nodes for the human to retire.
//
// hub#195 (goal-churn continuity): the switch no longer interviews from
// scratch.
//   - archived carries the old campaign's surface_spec text AND its
//     campaign snapshot id (goal.goal_snapshot persisted at commit,
//     re-derived from the sketch for uncommitted goals) — ground-truth
//     continuity across churn.
//   - fresh.prefill seeds the re-interview's surface-spec default with the
//     archived spec (edit, don't rewrite — defaultFor/useDefaults consume
//     it, so the defaults escape settles the archived spec, and the CLI
//     prints it as the surface-spec starting value).
//   - surfaces lists the old campaign's e2e cases for an explicit
//     keep/retire decision (applySurfaceDecisions), mirroring the retire
//     node list. Every row starts decision "undecided", flagged — undecided
//     surfaces keep their cases but flagged, never silently carried.
// A goal loaded from goal.toml carries no in-memory sketch; when the
// checklist is complete the sketch is re-derived (the commit verb's
// dry-run precedent) so the retire list and snapshot id stay populated.
// Mid-switch (checklist open) the derivation is skipped — surfaces still
// derive from the settled testing-surface box, and the fresh goal's own
// sketch-guard refusal stays intact (the hub#195 acceptance: gates degrade
// loud, not silent).
export function switchGoal(goal, newStatement) {
	const fresh = newGoal(newStatement);
	const archivedSpec = goalSurfaceSpec(goal)
		.map((s) => `${s.facet} => ${s.spec}`)
		.join("; ");
	if (archivedSpec !== "") fresh.prefill = { "surface-spec": archivedSpec };
	if (!goal.sketch && checklistComplete(goal)) sketch(goal);
	const snapshotId = goal.goal_snapshot || (goal.sketch ? goalSnapshotId(renderSketchToml(goal.sketch)) : "");
	const cases = Array.isArray(goal.sketch?.e2e) ? goal.sketch.e2e : e2eCasesOf(goal);
	return {
		archived: { statement: goal.statement, status: status(goal), surface_spec: archivedSpec, snapshot_id: snapshotId },
		fresh,
		retire: goal.sketch ? goal.sketch.nodes.map((n) => n.id) : [],
		surfaces: cases.map((c) => ({
			case: c.case,
			surface: c.surface,
			snapshot_id: snapshotId,
			decision: "undecided",
			flagged: true,
		})),
	};
}

// The keep/retire decision over a switch's surface list (hub#195).
// keep: surface texts or case ids to carry into the new campaign — kept
// cases rebind EXPLICITLY to the new snapshot id (from_snapshot records the
// origin). retire: { <surface|case>: <reason> } — retired cases stay flagged
// WITH the reason (the retire --reason idiom; a reasonless retire is not a
// decision). Everything else stays undecided + flagged. Pure.
export function applySurfaceDecisions(sw, { keep = [], retire = {} } = {}, newSnapshotId = "") {
	const keepSet = new Set(keep);
	const keep_surfaces = [];
	const retire_surfaces = [];
	const undecided = [];
	for (const s of sw?.surfaces ?? []) {
		const reason = retire[s.surface] ?? retire[s.case];
		if (keepSet.has(s.surface) || keepSet.has(s.case)) {
			keep_surfaces.push({ ...s, decision: "keep", flagged: false, from_snapshot: s.snapshot_id, snapshot_id: newSnapshotId });
		} else if (typeof reason === "string" && reason.trim() !== "") {
			retire_surfaces.push({ ...s, decision: "retire", flagged: true, reason });
		} else {
			undecided.push({ ...s, decision: "undecided", flagged: true });
		}
	}
	return { keep_surfaces, retire_surfaces, undecided };
}

// The explicit keep decision, physical form: rewrite an e2e case file's
// `// goal snapshot: <id>` header to the new campaign's snapshot id. A case
// without the header (pre-195 scaffold) gains it directly under the first
// line — binding a legacy case to the new campaign is also an explicit act.
export function rebindE2eSnapshot(text, newSnapshotId) {
	const line = `// goal snapshot: ${newSnapshotId}`;
	const src = String(text ?? "");
	if (GOAL_SNAPSHOT_LINE.test(src)) return src.replace(GOAL_SNAPSHOT_LINE, line);
	const lines = src.split("\n");
	lines.splice(1, 0, line);
	return lines.join("\n");
}
const GOAL_SNAPSHOT_LINE = /^\/\/ goal snapshot: .*$/m;

// --- surface keep/retire decisions applied to case files (hub#221) ---
//
// switchGoal lists the old campaign's surfaces undecided + flagged and
// applySurfaceDecisions decides them pure — but nothing applied a recorded
// decision to the case files on disk. `bais goal keep-surface` /
// `retire-surface` (cli.ts argv + filesystem only) close that gap through
// the three pure functions below (the hub#163 single-source rule):
//   - recordSurfaceDecision resolves a surface/case target against the
//     sketch e2e (or the re-derived cases for a loaded goal.toml — the
//     switchGoal precedent) and appends a {surface, case, decision, reason,
//     snapshot} record to goal.surface_decisions. A second decision for the
//     same surface refuses loud (bi#55 — never silently re-decided); a
//     retire without a reason refuses loud (the retire --reason idiom).
//   - keep applies physically as rebindE2eSnapshot (the case header moves to
//     the live campaign snapshot, so `bais check` stops flagging it).
//   - retire applies physically as a `// surface retired: <reason>` marker
//     under the case file's first line (comment-safe: the anchor header and
//     node execution are untouched); `bais check` suppresses the retired
//     surface's gap/stale/snapshot rows and prints a surface-retired line
//     instead — decided, never silently absent.
// The ledger renders as surface_decisions inline tables (only when non-empty
// — the hub#195 conditional-render precedent keeps pre-221 files
// byte-identical) and parses back in parseGoalToml.
//
// Load-bearing hunk (hub#221/bi#57 red-check target): the already-decided
// refusal in recordSurfaceDecision. Removing it must trip the selftest below
// with exactly:
//   "FAIL selftest: already-decided surface decision refuses loud naming the surface"
// (verified 2026-09-08: throw neutered to `if (false && prior)` -> that FAIL
// observed first, with the ledger-untouched check red behind it, exit 1 ->
// restored green).
export function surfaceDecisionsOf(goal) {
	return Array.isArray(goal?.surface_decisions) ? goal.surface_decisions : [];
}

// Pure reader for the scaffold headers renderE2eScaffold writes: line 1
// carries the surface (JSON string literal), plus the optional snapshot
// and anchor headers. Lets keep/retire-surface resolve targets against
// the case files on disk, not just the live goal's surfaces — after a
// switch the new campaign may not declare the old surfaces, but the
// files are still decidable. The CLI owns reading the files (hub#163);
// this owns the header shape.
export function parseE2eCaseHeader(text) {
	const src = String(text ?? "");
	let surface = "";
	const sm = src.match(/^\/\/ e2e scaffold for goal surface: ("(?:[^"\\]|\\.)*")/m);
	if (sm) {
		try {
			surface = JSON.parse(sm[1]);
		} catch {
			surface = "";
		}
	}
	const nm = src.match(/^\/\/ goal snapshot: (\S+)/m);
	const am = src.match(/^\/\/ goal anchor: ([0-9a-f]{64})/m);
	return { surface, snapshot: nm ? nm[1] : "", anchor: am ? am[1] : "" };
}

export function resolveSurfaceTarget(goal, target, { files = [] } = {}) {
	const t = String(target ?? "").trim();
	if (t === "") throw new Error("bais goal keep|retire-surface needs a <surface|case> target");
	const cases = Array.isArray(goal?.sketch?.e2e) ? goal.sketch.e2e : e2eCasesOf(goal);
	const hit = cases.find((c) => c.case === t || c.surface === t);
	if (hit) return { surface: hit.surface, case: hit.case };
	// After a switch the new campaign may not declare the old surfaces —
	// the case files on disk (surface header + filename stem) are still
	// decidable. files = [{ case, surface, snapshot }] gathered by the CLI.
	const disk = (Array.isArray(files) ? files : []).find((f) => f.case === t || f.surface === t);
	if (disk && disk.surface) return { surface: disk.surface, case: disk.case };
	throw new Error(
		`unknown surface ${JSON.stringify(t)} — no declared testing_surface item, e2e case, or case file matches (run \`bais goal switch\` to list decidable surfaces)`,
	);
}

export function recordSurfaceDecision(goal, { target, decision, reason = "", snapshot = "", files = [] } = {}) {
	if (decision !== "keep" && decision !== "retire") {
		throw new Error(`unknown surface decision ${JSON.stringify(decision)} — want "keep" or "retire"`);
	}
	const { surface, case: caseId } = resolveSurfaceTarget(goal, target, { files });
	const prior = surfaceDecisionsOf(goal).find((d) => d.surface === surface || d.case === caseId);
	if (prior) {
		throw new Error(
			`surface already decided: ${JSON.stringify(surface)} (${prior.decision}${prior.reason ? `: ${prior.reason}` : ""}) — re-decisions are never silent (bi#55)`,
		);
	}
	const r = String(reason ?? "").trim();
	if (decision === "retire" && r === "") {
		throw new Error(`retire-surface needs --reason <R> — retirements are never silent (got surface ${JSON.stringify(surface)})`);
	}
	const rec = { surface, case: caseId, decision, reason: decision === "retire" ? r : String(reason ?? ""), snapshot: String(snapshot ?? "") };
	goal.surface_decisions = [...surfaceDecisionsOf(goal), rec];
	return rec;
}

// Physical retire form: a comment marker under the first line. Idempotent —
// a present marker is replaced, never duplicated (the ledger still refuses
// double-decides; this only keeps hand-applied files clean).
export function markSurfaceRetired(text, reason) {
	const line = `// surface retired: ${String(reason ?? "").trim()}`;
	const src = String(text ?? "");
	if (/^\/\/ surface retired: .*$/m.test(src)) return src.replace(/^\/\/ surface retired: .*$/m, line);
	const lines = src.split("\n");
	lines.splice(1, 0, line);
	return lines.join("\n");
}

// --- goal.toml schema (see bais/spec/goal.md) ---
//
// [goal]
// statement = "..."
// style = "..."
// hero = "..."
// non_goals = ["...", ...]
// done_criteria = [{ text = "...", done = true|false }, ...]
// testing_surface = [{ surface = "...", exercise = "..." }, ...]
// surface_spec = [{ facet = "...", spec = "..." }, ...]
// contract = [{ field = "outcome|verification|constraints|boundaries|stop_when", text = "..." }, ...]
// goal_snapshot = "goal-snapshot-<sha256:12>" (hub#195 — committed campaigns only)
// approved_sketch_hash = "sha256:<hex>" (hub#195 — hash of the approved sketch.toml)
// surface_decisions = [{ surface = "...", case = "...", decision = "keep|retire", reason = "...", snapshot = "..." }, ...] (hub#221 — recorded keep/retire ledger, only when non-empty)
// [interview.<box>] status = "open|filled|waived|defaulted", value = "..."

export function heroOf(goal) {
	return goal.boxes.style.status === "open" ? "" : goal.boxes.style.value;
}

export function goalCriteria(goal) {
	const raw = goal.boxes.acceptance.status === "open" ? "" : goal.boxes.acceptance.value;
	if (!raw || raw === DEFAULTS.acceptance) return [];
	return raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map((text) => ({ text, done: false }));
}

const escStr = (s) => JSON.stringify(String(s ?? ""));
const escList = (arr) => `[${arr.map(escStr).join(", ")}]`;

export function renderGoalToml(goal) {
	const L = [];
	L.push("[goal]");
	L.push(`statement = ${escStr(goal.statement)}`);
	L.push(`style = ${escStr(goal.boxes.style.value)}`);
	L.push(`hero = ${escStr(heroOf(goal))}`);
	const nonGoals =
		goal.boxes["non-goals"].status === "open" || goal.boxes["non-goals"].value === DEFAULTS["non-goals"]
			? []
			: goal.boxes["non-goals"].value.split(";").map((s) => s.trim()).filter(Boolean);
	L.push(`non_goals = ${escList(nonGoals)}`);
	const crit = goalCriteria(goal).map((c) => `{ text = ${escStr(c.text)}, done = ${c.done} }`);
	L.push(`done_criteria = [${crit.join(", ")}]`);
	const surf = goalSurface(goal).map((s) => `{ surface = ${escStr(s.surface)}, exercise = ${escStr(s.exercise)} }`);
	L.push(`testing_surface = [${surf.join(", ")}]`);
	// hub#166: the surface spec persists as facet/spec inline tables (waiver
	// and pure-no-io records included — the exemption/waiver is data).
	const sspec = goalSurfaceSpec(goal).map((s) => `{ facet = ${escStr(s.facet)}, spec = ${escStr(s.spec)} }`);
	L.push(`surface_spec = [${sspec.join(", ")}]`);
	// hub#213: the completion contract persists as field/text inline tables
	// (waiver records render [] — a waived contract is data in the box value,
	// never a contract item, mirroring the testing_surface precedent).
	const contract = goalContract(goal).map((c) => `{ field = ${escStr(c.field)}, text = ${escStr(c.text)} }`);
	L.push(`contract = [${contract.join(", ")}]`);
	// hub#195: the approved-sketch binding (set by commit() — never rendered
	// for uncommitted/legacy goals, which keeps pre-195 files byte-identical).
	if (goal.goal_snapshot) L.push(`goal_snapshot = ${escStr(goal.goal_snapshot)}`);
	if (goal.approved_sketch_hash) L.push(`approved_sketch_hash = ${escStr(goal.approved_sketch_hash)}`);
	// hub#221: the recorded keep/retire ledger (only when non-empty — the
	// hub#195 conditional-render precedent keeps pre-221 files byte-identical).
	if (surfaceDecisionsOf(goal).length > 0) {
		const dec = surfaceDecisionsOf(goal).map(
			(d) =>
				`{ surface = ${escStr(d.surface)}, case = ${escStr(d.case)}, decision = ${escStr(d.decision)}, reason = ${escStr(d.reason)}, snapshot = ${escStr(d.snapshot)} }`,
		);
		L.push(`surface_decisions = [${dec.join(", ")}]`);
	}
	for (const box of CHECKLIST) {
		L.push(`[interview.${JSON.stringify(box)}]`);
		L.push(`status = ${escStr(goal.boxes[box].status)}`);
		L.push(`value = ${escStr(goal.boxes[box].value)}`);
		// hub#196: the stay-on-box loop state persists (sub-round counts +
		// the pending-follow-up flag) so save/resume keeps the loop. Zero
		// counts and no-pending render nothing — pre-196 files round-trip
		// byte-identical.
		const fu = goal.followups?.[box] ?? 0;
		if (fu > 0) L.push(`followups = ${fu}`);
		if (goal.followupBox === box) L.push(`followup_pending = true`);
	}
	return L.join("\n") + "\n";
}

// Minimal reader for goal.toml (scalar/list/table subset this file writes —
// the BAML validator owns real parsing; this never validates).
export function parseGoalToml(text) {
	const field = (name) => {
		const m = String(text).match(new RegExp(`^${name} *= *("(?:[^"\\\\]|\\\\.)*")`, "m"));
		return m ? JSON.parse(m[1]) : "";
	};
	const listField = (name) => {
		const m = String(text).match(new RegExp(`^${name} *= *\\[(.*)\\]`, "m"));
		if (!m) return [];
		const out = [];
		const re = /"(?:[^"\\]|\\.)*"/g;
		let mm;
		while ((mm = re.exec(m[1])) !== null) out.push(JSON.parse(mm[0]));
		return out;
	};
	const goal = newGoal(field("statement"));
	// hub#195: the approved-sketch binding (absent on pre-195 goal.toml files
	// — only assigned when present so legacy parses stay shape-identical).
	const snap195 = field("goal_snapshot");
	if (snap195) goal.goal_snapshot = snap195;
	const hash195 = field("approved_sketch_hash");
	if (hash195) goal.approved_sketch_hash = hash195;
	// hub#221: the keep/retire ledger (absent on pre-221 goal.toml files —
	// only assigned when present so legacy parses stay shape-identical).
	const dec221 = extractGoalList(text, "surface_decisions");
	if (dec221.found) goal.surface_decisions = dec221.items.map(parseSurfaceDecisionItem).filter((d) => d !== null);
	for (const box of CHECKLIST) {
		const sec = String(text).match(new RegExp(`^\\[interview\\.("?)${box.replace(/-/g, "\\-")}\\1\\]([^\\[]*)`, "m"));
		const status = sec && sec[2].match(/status *= *"(\w+)"/);
		const value = sec && sec[2].match(/value *= *("(?:[^"\\\\]|\\\\.)*")/);
		if (status && ["open", "filled", "waived", "defaulted"].includes(status[1])) {
			goal.boxes[box] = { status: status[1], value: value ? JSON.parse(value[1]) : "" };
		}
		// hub#196: restore the stay-on-box loop state. Missing lines are
		// grandfathered (pre-196 files carry none) as zero/no-pending.
		const fu = sec && sec[2].match(/followups *= *(\d+)/);
		if (fu) goal.followups[box] = Number(fu[1]);
		if (sec && /followup_pending *= *true/.test(sec[2])) goal.followupBox = box;
	}
	// hub#213: pre-contract goal.toml files carry no [interview.contract]
	// section. Missing is grandfathered (the validateGoal shape-only
	// precedent: pre-213 goals stay green) — the box settles as a defaulted
	// waiver record naming the grandfathering, never as a silent open box
	// (which would refuse sketch on every legacy goal) and never as a real
	// contract (goalContract yields [] for waiver records).
	if (!String(text).match(/^\[interview\.("?)contract\1\]/m)) {
		goal.boxes.contract = {
			status: "defaulted",
			value: "waiver => legacy goal.toml (pre-hub#213): no contract section recorded",
		};
	}
	goal._parsed = {
		style: field("style"),
		hero: field("hero"),
		non_goals: listField("non_goals"),
		testing_surface: extractGoalList(text, "testing_surface")
			.items.map(parseGoalSurfaceItem)
			.filter((c) => c !== null && !c.malformed),
		// hub#166: facet/spec inline tables (parseGoalSurfaceSpecItem is a
		// hoisted function declaration appended below).
		surface_spec: extractGoalList(text, "surface_spec")
			.items.map(parseGoalSurfaceSpecItem)
			.filter((c) => c !== null && !c.malformed),
		// hub#213: field/text inline tables (parseGoalContractItem is a
		// hoisted function declaration in the hub#213 section).
		contract: extractGoalList(text, "contract")
			.items.map(parseGoalContractItem)
			.filter((c) => c !== null && !c.malformed),
	};
	return goal;
}

// --- goal.toml validation gate (hub#158, scripts lane) ---
//
// Validates the goal.toml shapes this repo actually carries: the flat live
// shape (`.bais/goal.toml`: bare `statement`, `style`, `hero`, string-list
// `done_criteria`) AND the `[goal]` + `[interview.*]` shape renderGoalToml
// writes. Extraction is section-agnostic key matching (parse parity with
// parseGoalToml above, extended to multi-line arrays and inline-table
// criteria) — the BAML validator owns real TOML parsing; this owns the
// gate semantics.
//
// Required fields: statement, done_criteria, style, hero. Missing or empty
// fails loud naming the field. done_criteria must list at least one
// criterion and every criterion needs usable text (bare strings and
// `{ text = "...", done = bool }` inline tables both count).
//
// Reference checks (ground truth 2026-09-06): bi#134 landed, so
// `.bais/styles/` holds 6 packs (clean-concise, corporate-oop,
// data-oriented-game, htmx-minimal, nextjs-standard, vanilla-fast); bi#147
// is still Doing with no roster files on disk. Unknown style therefore
// warns (not fails) — forced anyway by the live root goal, whose
// `style = "data-oriented"` matches no pack. Unknown hero warns (not
// fails) until the bi#147 roster lands, at which point both warnings
// upgrade to failures. CLI wiring is out of scope (rides bi#132).
//
// Load-bearing hunk (hub#158/bi#57 red-check target): the missing
// done_criteria error. Commenting out that errors.push must trip the
// selftest below with exactly:
//   "FAIL selftest: missing done_criteria fails naming the field"
// (verified 2026-09-06: push removed -> that FAIL observed -> restored green).

import { readdirSync } from "node:fs";

// hub#165 extends the required set with testing_surface: required for new
// goals via the interview box (the sketch guard enforces it); file-level
// enforcement stays shape-only (missing/empty grandfathered — pre-surface
// goals, waived/defaulted boxes render []) until the hub#153 BITS e2e
// consumer lands, mirroring the style/hero warn-until-bi#147 precedent.
// hub#166 extends the required set with surface_spec: required for new goals
// via the interview box (the sketch guard enforces it); file-level
// enforcement stays shape-only (missing/empty grandfathered — pre-spec
// goals stay green) until the hub#153 BITS e2e consumer lands, mirroring
// the hub#165 testing_surface precedent.
// hub#213 extends the required set with contract: required for new goals via
// the interview box (the sketch guard enforces it); file-level enforcement
// stays shape-only (missing/empty grandfathered — pre-contract goals stay
// green, and parseGoalToml settles the box as a defaulted waiver record),
// mirroring the hub#165/hub#166 precedents.
export const GOAL_REQUIRED_FIELDS = ["statement", "done_criteria", "style", "hero", "testing_surface", "surface_spec", "contract"];

const HUB_ROOT = join(HERE, "..", "..");
const HUB_STYLES_DIR = join(HUB_ROOT, ".bais", "styles");
const HUB_GOAL_TOML = join(HUB_ROOT, ".bais", "goal.toml");

// Style pack names = .bais/styles/<pack>.toml stems (each file also carries
// [style] name, identical today; stems are the resolution key per bi#134).
export function listStylePacks(stylesDir) {
	try {
		return readdirSync(stylesDir)
			.filter((f) => f.endsWith(".toml"))
			.map((f) => f.slice(0, -".toml".length))
			.sort();
	} catch {
		return [];
	}
}

function extractGoalString(text, name) {
	const src = String(text ?? "");
	let m = src.match(new RegExp(`^${name} *= *"""([\\s\\S]*?)"""`, "m"));
	if (m) return { found: true, value: m[1] };
	m = src.match(new RegExp(`^${name} *= *("(?:[^"\\\\]|\\\\.)*")`, "m"));
	if (m) {
		try {
			return { found: true, value: JSON.parse(m[1]) };
		} catch {
			return { found: true, value: m[1].slice(1, -1) };
		}
	}
	return { found: false, value: "" };
}

function extractGoalList(text, name) {
	const src = String(text ?? "");
	const m = src.match(new RegExp(`^${name} *= *\\[([\\s\\S]*?)\\]`, "m"));
	if (!m) return { found: false, items: [] };
	return { found: true, items: splitGoalListItems(m[1]) };
}

// Split a TOML array body on top-level commas: brace-, bracket- and
// string-aware, `#` comments skipped outside strings. Non-greedy to the
// first `]` is enough for the shapes in play (inline-table criteria carry
// no bare brackets).
function splitGoalListItems(body) {
	const items = [];
	let depth = 0;
	let cur = "";
	let inStr = false;
	let esc = false;
	const lines = String(body).split("\n");
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inStr) {
				cur += ch;
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') {
				inStr = true;
				cur += ch;
				continue;
			}
			if (ch === "#") break;
			if (ch === "{" || ch === "[") depth++;
			if (ch === "}" || ch === "]") depth--;
			if (ch === "," && depth === 0) {
				items.push(cur);
				cur = "";
				continue;
			}
			cur += ch;
		}
		if (inStr) cur += "\n";
		else cur += " ";
	}
	if (cur.trim() !== "") items.push(cur);
	return items.map((s) => s.trim()).filter((s) => s !== "");
}

function parseGoalCriterion(item) {
	const t = String(item).trim();
	if (t === "") return null;
	if (t.startsWith("{")) {
		const tm = t.match(/text *= *("(?:[^"\\]|\\.)*")/);
		if (!tm) return { text: "", done: false, malformed: true };
		let text = "";
		try {
			text = JSON.parse(tm[1]);
		} catch {
			return { text: "", done: false, malformed: true };
		}
		const dm = t.match(/done *= *(true|false)/);
		return { text, done: dm ? dm[1] === "true" : false, malformed: false };
	}
	const sm = t.match(/^("(?:[^"\\]|\\.)*")$/);
	if (sm) {
		try {
			return { text: JSON.parse(sm[1]), done: false, malformed: false };
		} catch {
			return { text: "", done: false, malformed: true };
		}
	}
	return { text: "", done: false, malformed: true };
}

// Scripts-lane gate: { ok, errors, warns }. Errors fail loud naming the
// field; style/hero reference misses warn (never fail) until bi#147 lands.
export function validateGoal(text, { knownStyles = null, knownHeroes = null, stylesDir = HUB_STYLES_DIR } = {}) {
	const errors = [];
	const warns = [];
	const src = String(text ?? "");

	const statement = extractGoalString(src, "statement");
	if (!statement.found || statement.value.trim() === "") {
		errors.push(`invalid goal.toml: missing required field: "statement"`);
	}

	const criteria = extractGoalList(src, "done_criteria");
	if (!criteria.found) {
		errors.push(`invalid goal.toml: missing required field: "done_criteria"`);
	} else {
		const parsed = criteria.items.map(parseGoalCriterion).filter((c) => c !== null);
		if (parsed.length === 0) {
			errors.push(`invalid goal.toml: "done_criteria" must list at least one criterion`);
		}
		parsed.forEach((c, i) => {
			if (c.malformed || c.text.trim() === "") {
				errors.push(`invalid goal.toml: "done_criteria"[${i}] has no usable text`);
			}
		});
	}

	// testing_surface (hub#165): shape-only enforcement. Present items must
	// each carry a usable surface AND exercise (inline tables; bare strings
	// count as surface-only and fail naming the exercise half, like an
	// inline-table criterion without text). Missing/empty is grandfathered
	// (see GOAL_REQUIRED_FIELDS note) so pre-surface goals stay green.
	const surface = extractGoalList(src, "testing_surface");
	if (surface.found) {
		const parsed = surface.items.map(parseGoalSurfaceItem).filter((c) => c !== null);
		parsed.forEach((c, i) => {
			if (c.malformed || c.surface.trim() === "" || c.exercise.trim() === "") {
				errors.push(
					`invalid goal.toml: "testing_surface"[${i}] needs a usable surface and exercise (got ${JSON.stringify(surface.items[i])})`,
				);
			} else {
				// hub#190 (warn-first): an assert-true exercise (no expected
				// predicate) warns at file level for one release — commit()
				// already refuses it loud; legacy goals stay green here.
				try {
					parseExercise(c.exercise);
				} catch (e) {
					warns.push(
						`"testing_surface"[${i}] exercise is assert-true (no expected predicate) — hub#190 warn-first: \`bais goal commit\` refuses until it decomposes to "<command> => <expect>" (${String(e && e.message)})`,
					);
				}
			}
		});
	}

	// surface_spec (hub#166): shape-only enforcement, mirroring
	// testing_surface. Present items must each carry a usable facet AND
	// spec (inline tables; bare strings count as facet-only and fail naming
	// the field). Missing/empty is grandfathered (see GOAL_REQUIRED_FIELDS
	// note) so pre-spec goals stay green.
	const sspec = extractGoalList(src, "surface_spec");
	if (sspec.found) {
		const parsed = sspec.items.map(parseGoalSurfaceSpecItem).filter((c) => c !== null);
		parsed.forEach((c, i) => {
			if (c.malformed || c.facet.trim() === "" || c.spec.trim() === "") {
				errors.push(
					`invalid goal.toml: "surface_spec"[${i}] needs a usable facet and spec (got ${JSON.stringify(sspec.items[i])})`,
				);
			}
		});
	}

	// contract (hub#213): shape-only enforcement, mirroring
	// testing_surface/surface_spec. Present items must each carry a usable
	// field AND text; the field must be one of the five contract fields.
	// A non-empty contract must name ALL five fields exactly once — a
	// partial contract is exactly the gap the contract exists to close.
	// Missing/empty is grandfathered (see GOAL_REQUIRED_FIELDS note) so
	// pre-contract goals stay green.
	const contract213 = extractGoalList(src, "contract");
	if (contract213.found) {
		const parsed = contract213.items.map(parseGoalContractItem).filter((c) => c !== null);
		parsed.forEach((c, i) => {
			if (c.malformed || c.field.trim() === "" || c.text.trim() === "") {
				errors.push(
					`invalid goal.toml: "contract"[${i}] needs a usable field and text (got ${JSON.stringify(contract213.items[i])})`,
				);
			} else if (!CONTRACT_FIELDS.includes(c.field)) {
				errors.push(
					`invalid goal.toml: "contract"[${i}] has unknown field ${JSON.stringify(c.field)} (known: ${CONTRACT_FIELDS.join(", ")})`,
				);
			}
		});
		const usable = parsed.filter((c) => !c.malformed && c.field.trim() !== "" && CONTRACT_FIELDS.includes(c.field));
		if (usable.length > 0) {
			for (const f of CONTRACT_FIELDS) {
				if (!usable.some((c) => c.field === f)) {
					errors.push(`invalid goal.toml: "contract" is a five-field completion contract — missing "${f}"`);
				}
			}
			const seen = new Set();
			for (const c of usable) {
				if (seen.has(c.field)) {
					errors.push(`invalid goal.toml: "contract" duplicates field ${JSON.stringify(c.field)}`);
				}
				seen.add(c.field);
			}
		}
	}

	// surface_decisions (hub#221): shape-only enforcement, mirroring
	// testing_surface. Present items must each carry a usable surface and a
	// keep|retire decision; a retire should carry its reason (warn, not
	// fail — the reason lives loud in `bais goal` output either way).
	// Missing/empty is grandfathered (see GOAL_REQUIRED_FIELDS note) so
	// pre-221 goals stay green.
	const dec221 = extractGoalList(src, "surface_decisions");
	if (dec221.found && dec221.items.length > 0) {
		const parsed = dec221.items.map(parseSurfaceDecisionItem);
		const bad = dec221.items.filter((_, i) => parsed[i] === null);
		if (bad.length > 0) {
			errors.push(
				`invalid goal.toml: "surface_decisions" items need a usable surface and a keep|retire decision (got ${JSON.stringify(bad)})`,
			);
		}
		parsed.forEach((c, i) => {
			if (c !== null && c.decision === "retire" && c.reason.trim() === "") {
				warns.push(`"surface_decisions"[${i}] retires ${JSON.stringify(c.surface)} without a recorded reason — retirements are never silent`);
			}
		});
	}

	const style = extractGoalString(src, "style");
	if (!style.found || style.value.trim() === "") {
		errors.push(`invalid goal.toml: missing required field: "style"`);
	} else {
		const packs = Array.isArray(knownStyles) ? knownStyles : listStylePacks(stylesDir);
		if (!packs.includes(style.value)) {
			warns.push(
				packs.length === 0
					? `unknown style "${style.value}": no style packs resolvable at ${stylesDir} — warn-only until bi#134 lands`
					: `unknown style "${style.value}" (known packs: ${packs.join(", ")}) — warn-only until the roster/style fail-after lands (bi#147)`,
			);
		}
	}

	const hero = extractGoalString(src, "hero");
	if (!hero.found || hero.value.trim() === "") {
		errors.push(`invalid goal.toml: missing required field: "hero"`);
	} else {
		const roster = Array.isArray(knownHeroes) ? knownHeroes : [];
		if (!roster.includes(hero.value)) {
			warns.push(
				roster.length === 0
					? `unknown hero "${hero.value}": no agent roster resolvable — warn-only until bi#147 lands`
					: `unknown hero "${hero.value}" (known: ${roster.join(", ")}) — warn-only until bi#147 lands`,
			);
		}
	}

	return { ok: errors.length === 0, errors, warns };
}

// --- testing surface + sufficiency gate (hub#165, scripts lane) ---
//
// The goal interview captured intent but never observability: what does
// done LOOK like. The "testing-surface" checklist box closes that gap —
// observable surfaces (commands, views, flows) plus how each is exercised,
// one item per `<surface> => <how to exercise>`, items separated by `;`.
// Captured before sketch like every box (the sketch guard refuses while any
// box is open); the sketch proposal then carries `e2e` so the orchestrator
// can generate extensive e2e from the goal instead of inventing coverage.
//
// BITS case-shape note (hub#153): Case/Verdict land in bits/ with bits#01 —
// this side never defines them. surfaceToBitsCase emits the forward-
// compatible case half ({ case, surface, exercise }; direction: cases flow
// out of the goal, verdicts come back) for bits#01 to adopt.
//
// Load-bearing hunk (hub#165/bi#57 red-check target): the sketch e2e.
// Dropping `e2e` from the sketch proposal must trip the selftest below
// with exactly:
//   "FAIL selftest: sketch e2e covers every declared surface item"
// (verified 2026-09-06: e2e removed -> that FAIL observed -> restored green).

// Declared testing surface: well-formed `<surface> => <exercise>` items
// only. Open boxes, waiver/none-needed records (hub#185), the legacy
// "none declared" default, and malformed values yield [] — malformed items
// are dropped (the file gate and settle-time validation, not this, fail
// loud). Waiver records are data, never cases: a waived surface must not
// conjure an e2e case named "waiver".
export function goalSurface(goal) {
	const box = goal.boxes["testing-surface"];
	if (!box || box.status === "open") return [];
	const raw = String(box.value ?? "");
	if (!raw || raw === "none declared") return [];
	let items;
	try {
		items = parseTestingSurfaceValue(raw);
	} catch {
		return [];
	}
	return items
		.filter((it) => it.facet !== "waiver" && it.facet !== "none-needed")
		.map((it) => ({ surface: it.surface, exercise: it.exercise }));
}

// Forward-compatible BITS case half for one surface item (hub#153 notes the
// shape, bits#01 owns it — do not define Case/Verdict here).
// hub#184: the case id is the stable surface slug (not positional
// `surface-N`); taken is the sketch-local collision set, shared across the
// items of one sketch so commit() agrees with sketch() exactly.
export function surfaceToBitsCase(item, taken = new Set()) {
	const id = surfaceSlug(item.surface, taken);
	taken.add(id);
	return { case: id, surface: item.surface, exercise: item.exercise };
}

// --- testing-surface settle-time validation (hub#185, scripts lane) ---
//
// The oracle is optional in three silent ways (bare waive, the defaults
// escape, the rounds-cap auto-default) unless every path records a reason.
// Settling runs loud like answerSurfaceSpec: empty, malformed, and
// reasonless waiver/none-needed values throw naming testing-surface; the
// box stays open so sketch keeps refusing. Two reasoned skip forms:
//   "waiver => <reason>" — observable surface exists, owner accepts the gap;
//   "none-needed => <reason>" — the goal genuinely has no observable surface.
const TESTING_SURFACE_NEED =
	`supply "<surface> => <exercise>" items ("; "-separated), an explicit waiver "waiver => <reason>", or "none-needed => <reason>" for a goal with genuinely no observable surface`;

export function parseTestingSurfaceValue(value) {
	const raw = String(value ?? "");
	if (raw.trim() === "") {
		throw new Error(`invalid testing-surface: empty — ${TESTING_SURFACE_NEED}`);
	}
	const parts = raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (parts.length === 0) {
		throw new Error(`invalid testing-surface: empty — ${TESTING_SURFACE_NEED}`);
	}
	return parts.map((part) => {
		const i = part.indexOf("=>");
		if (i < 0) {
			throw new Error(
				`invalid testing-surface: every item needs "<surface> => <exercise>" (got ${JSON.stringify(part)}) — ${TESTING_SURFACE_NEED}`,
			);
		}
		const surface = part.slice(0, i).trim();
		const exercise = part.slice(i + 2).trim();
		const facet = surface.toLowerCase();
		if (!surface) {
			throw new Error(`invalid testing-surface: item needs a surface before "=>" (got ${JSON.stringify(part)})`);
		}
		if (!exercise) {
			if (facet === "waiver") {
				throw new Error(
					`invalid testing-surface: "waiver" needs a reason ("waiver => <reason>") — reasonless oracle-skips fail loud`,
				);
			}
			if (facet === "none-needed") {
				throw new Error(
					`invalid testing-surface: "none-needed" needs a reason ("none-needed => <reason>") — the claim of no observable surface is established explicitly, never assumed`,
				);
			}
			throw new Error(`invalid testing-surface: item needs an exercise after "=>" (got ${JSON.stringify(part)})`);
		}
		return { surface, exercise, facet };
	});
}

// Settle the testing-surface box (status filled) after loud validation.
export function answerTestingSurface(goal, value) {
	if (!("testing-surface" in goal.boxes)) throw new Error("unknown checklist box: testing-surface");
	if (goal.boxes["testing-surface"].status !== "open") throw new Error("box already settled: testing-surface");
	parseTestingSurfaceValue(value);
	goal.boxes["testing-surface"] = { status: "filled", value: String(value ?? "") };
	return goal;
}

// The recorded waiver reason ("" when real surfaces are declared or the
// box is still open). Legacy "none declared" values predate reasons.
// Quoted by the oracle-gap auto-issue and the oracle_absent status warn.
export function testingSurfaceWaiverReason(goal) {
	const box = goal.boxes["testing-surface"];
	if (!box || box.status === "open") return "";
	const raw = String(box.value ?? "");
	if (!raw) return "";
	if (raw === "none declared") return "legacy default: none declared";
	let items;
	try {
		items = parseTestingSurfaceValue(raw);
	} catch {
		return "";
	}
	const reasons = items
		.filter((it) => it.facet === "waiver" || it.facet === "none-needed")
		.map((it) => `${it.facet} => ${it.exercise}`);
	return reasons.join("; ");
}

// --- sketch persistence + e2e scaffolds (hub#184, scripts lane) ---
//
// commit() persists the approved sketch as .bais/sketch.toml (nodes +
// edges, plain TOML any reader parses) plus one failing-first scaffold
// per testing-surface item under .bais/e2e/. The scaffold runs with plain
// node (no BAML tooling), prints FAIL naming the surface, exits 1 — the
// scripts-lane drill idiom pushed into the hub. "E2e first" becomes the
// physical outcome of committing a goal, not prompt advice.
//
// Load-bearing hunk (hub#184/bi#57 red-check target): the e2e scaffold
// write in commit(). Dropping it must trip the selftest below with
// exactly:
//   "FAIL selftest: commit writes e2e scaffolds for every declared surface"
// (verify: remove the scaffold push -> that FAIL observed -> restore green).
//
// Load-bearing hunk (hub#184/bi#57 red-check target): the slug case ids.
// Reverting surfaceToBitsCase to positional `surface-N` must trip the
// selftest below with exactly:
//   "FAIL selftest: reordered surfaces keep stable case ids"
// (verify: restore positional ids -> that FAIL observed -> restore green).

// Stable case id from the surface text: kebab-case, collision-suffixed
// against taken. Pure — reordering answers never renames cases.
export function surfaceSlug(surface, taken = new Set()) {
	let slug = String(surface ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 48)
		.replace(/-+$/g, "");
	if (!slug) slug = "surface";
	let out = slug;
	let n = 2;
	while (taken.has(out)) out = `${slug}-${n++}`;
	return out;
}

// Goal anchor: sha256 of `surface + "=>" + exercise` (the eventId
// content-hash idiom, bais/scripts/fault-drills.mjs) — later drift joins
// match cases to surfaces deterministically. Pure; the selftest recomputes
// it independently and matches the scaffold header.
export function surfaceAnchor(surface, exercise) {
	return createHash("sha256").update(`${surface}=>${exercise}`, "utf8").digest("hex");
}

// Plain-TOML render of the approved nodes + edges (file-per-record can
// come later — one file is the minimal slice). Values escape via JSON
// string literals, valid TOML basic strings.
export function renderSketchToml(sketch) {
	const L = [];
	L.push("# .bais/sketch.toml — approved goal sketch (hub#184). Nodes + edges; e2e scaffolds live in .bais/e2e/.");
	for (const n of sketch.nodes ?? []) {
		L.push("[[node]]");
		L.push(`id = ${JSON.stringify(String(n.id ?? ""))}`);
		L.push(`title = ${JSON.stringify(String(n.title ?? ""))}`);
		L.push(`radius = [${(n.radius ?? []).map((r) => JSON.stringify(String(r))).join(", ")}]`);
		L.push("");
	}
	for (const e of sketch.edges ?? []) {
		L.push("[[edge]]");
		L.push(`from = ${JSON.stringify(String(e.from ?? ""))}`);
		L.push(`to = ${JSON.stringify(String(e.to ?? ""))}`);
		L.push(`kind = ${JSON.stringify(String(e.kind ?? ""))}`);
		L.push("");
	}
	return L.join("\n");
}

// Minimal reader for the shape renderSketchToml writes (the BAML validator
// owns real parsing; this never validates). Round-trip pinned by selftest.
export function parseSketchToml(text) {
	const nodes = [];
	const edges = [];
	const strField = (body, name) => {
		const m = body.match(new RegExp(`${name} *= *("(?:[^"\\\\]|\\\\.)*")`));
		if (!m) return "";
		try {
			return JSON.parse(m[1]);
		} catch {
			return "";
		}
	};
	for (const block of String(text ?? "").split(/\[\[(?:node|edge)\]\]/)) {
		const t = block.trim();
		if (t === "" || t.startsWith("#")) continue;
		if (/^id\s*=/m.test(t)) {
			const radius = [];
			const rm = t.match(/radius\s*=\s*\[([^\]]*)\]/);
			if (rm) {
				const re = /"(?:[^"\\]|\\.)*"/g;
				let mm;
				while ((mm = re.exec(rm[1])) !== null) {
					try {
						radius.push(JSON.parse(mm[0]));
					} catch {}
				}
			}
			nodes.push({ id: strField(t, "id"), title: strField(t, "title"), radius });
		} else if (/^from\s*=/m.test(t)) {
			edges.push({ from: strField(t, "from"), to: strField(t, "to"), kind: strField(t, "kind") });
		}
	}
	return { nodes, edges };
}

// One failing-first scaffold per testing-surface item: plain node stdlib,
// deterministic, offline. Prints `FAIL: <surface>: scaffold-unimplemented`
// on stderr, exits 1. The surface embeds as a JSON string literal so
// quotes/backticks in surface text cannot break the scaffold.
// hub#195: the header records the campaign snapshot id the case was
// authored under — cross-goal case reuse requires an explicit keep decision
// (rebindE2eSnapshot), never a silent carry-over.
export function renderE2eScaffold({ surface, exercise, snapshotId = "" }) {
	const anchor = surfaceAnchor(surface, exercise);
	const snapshotLine = snapshotId
		? `// goal snapshot: ${snapshotId} (campaign version this case was authored under — hub#195; cross-goal reuse needs an explicit keep decision)\n`
		: "";
	return `// e2e scaffold for goal surface: ${JSON.stringify(surface)}
${snapshotLine}// exercise: ${JSON.stringify(exercise)}
// goal anchor: ${anchor} (sha256 of surface + "=>" + exercise — hub#184)
// Generated by \`bais goal commit\` — failing-first scaffold: implement the
// exercise above; until then this file fails loud.
// red-check record (bi#57, hub#190 — required in every generated case file
// header, the bits-t2.mjs pattern):
//   hunk: the scaffold-unimplemented exit below (console.error + exit 1).
//   expected reason: "FAIL: <surface>: scaffold-unimplemented", exit 1.
//   observed: goal.mjs --selftest writes every generated scaffold to a
//     tmpdir, runs it under plain node, and asserts exactly that named
//     failure and exit code BEFORE any implementation lands — revert the
//     exit, the selftest fails naming this case, restore. A test that
//     cannot go red is camouflage, not coverage.
console.error("FAIL: " + ${JSON.stringify(surface)} + ": scaffold-unimplemented");
process.exit(1);
`;
}

// --- oracle-gap auto-issue (hub#185, scripts lane) ---
//
// commit() with an empty e2e oracle files this into .bais/issues/ so the
// missing oracle lands in `bais ready` as work for whatever model the
// human uses — a structural nudge, not a one-time warning. Minimal valid
// issue shape (id/title/status/kind/body); `bais check` on the hub stays
// green. The waiver reason rides the body (acceptance pins it).
//
// Load-bearing hunk (hub#185/bi#57 red-check target): the auto-file push
// in commit(). Dropping it must trip the selftest below with exactly:
//   "FAIL selftest: empty-oracle commit auto-files the oracle-gap issue"
// (verify: remove the push -> that FAIL observed -> restore green).
//
// Load-bearing hunk (hub#185/bi#57 red-check target): the loud settle.
// Removing the testing-surface bare-waive throw in waive() must trip the
// selftest below with exactly:
//   "FAIL selftest: bare waive of testing-surface fails loud"
// (verify: remove the throw -> bare waive settles silently -> that FAIL
// observed -> restore green).
export function renderOracleGapIssue(goal) {
	const reason = testingSurfaceWaiverReason(goal) || "no reason recorded";
	const L = [];
	L.push(`id = "goal#oracle-gap"`);
	L.push(`title = "Campaign has no e2e oracle — testing-surface waived"`);
	L.push(`status = "Open"`);
	// Kind Debt (the closed Kind enum allows Bug/Feat/Proposal/Debt/Flake/
	// Spike — a missing e2e oracle is test debt, not a feature).
	L.push(`kind = "Debt"`);
	L.push(`area = "bais/goal"`);
	L.push(`body = """`);
	L.push(`The committed goal declares no testing surface, so no e2e scaffolds were generated.`);
	L.push(`Testing-surface record: ${reason}`);
	L.push(`Close this by declaring surfaces (bais goal switch + answer testing-surface) or recording an explicit waiver reason here as Evidence.`);
	L.push(`"""`);
	return L.join("\n") + "\n";
}

// File-level surface item: inline tables need both halves; bare strings
// count as surface-only (no exercise half). Mirrors parseGoalCriterion.
function parseGoalSurfaceItem(item) {
	const t = String(item).trim();
	if (t === "") return null;
	if (t.startsWith("{")) {
		const sm = t.match(/surface *= *("(?:[^"\\]|\\.)*")/);
		const em = t.match(/exercise *= *("(?:[^"\\]|\\.)*")/);
		let surface = "";
		let exercise = "";
		try {
			surface = sm ? JSON.parse(sm[1]) : "";
		} catch {
			return { surface: "", exercise: "", malformed: true };
		}
		try {
			exercise = em ? JSON.parse(em[1]) : "";
		} catch {
			return { surface: "", exercise: "", malformed: true };
		}
		return { surface, exercise, malformed: false };
	}
	const sm = t.match(/^("(?:[^"\\]|\\.)*")$/);
	if (sm) {
		try {
			return { surface: JSON.parse(sm[1]), exercise: "", malformed: false };
		} catch {
			return { surface: "", exercise: "", malformed: true };
		}
	}
	return { surface: "", exercise: "", malformed: true };
}

// --- completion contract (hub#213, scripts lane) ---
//
// Hermes' persistent-goals loop defines done as a five-field completion
// contract: outcome (what done delivers), verification (how done is
// proven), constraints (what binds the work), boundaries (what is out of
// scope), stop_when (when to stop). It maps 1:1 onto BAIS acceptance
// bullets — the acceptance box captures the criteria, the contract box
// captures the completion definition a campaign's gates + judge evaluate
// against. Captured before sketch like every box (the sketch guard refuses
// while any box is open); settles loud via answerContract (answer()
// delegates for this box) as `;`-separated `<field> => <text>` items with
// all five fields present exactly once, or an explicit "waiver => <reason>"
// record. Legacy goal.toml files (no [interview.contract] section) are
// grandfathered by parseGoalToml as a defaulted waiver record, and the
// file-level gate (validateGoal) enforces shape-only: present items need a
// known field and usable text, a non-empty contract needs all five fields;
// missing/empty stays green.
//
// Load-bearing hunk (hub#213/bi#57 red-check target): the five-field
// completeness check in parseContractValue. Dropping the missing-field
// throw must trip the selftest below with exactly:
//   "FAIL selftest: partial contract settle fails loud naming the missing field"
// (verify: remove the missing-field throw -> that FAIL observed -> restore green).

export const CONTRACT_FIELDS = ["outcome", "verification", "constraints", "boundaries", "stop_when"];

const CONTRACT_NEED = `supply all five fields "<field> => <text>" ("; "-separated; fields: ${CONTRACT_FIELDS.join(", ")}), or an explicit waiver "waiver => <reason>"`;

// Loud settle-time validation for the contract box. Throws naming the box
// on every silent-gap path (empty, malformed, unknown or duplicate field,
// partial contract, reasonless waiver); the box stays open so sketch keeps
// refusing.
export function parseContractValue(value) {
	const raw = String(value ?? "");
	if (raw.trim() === "") {
		throw new Error(`invalid contract: empty — ${CONTRACT_NEED}`);
	}
	const parts = raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (parts.length === 0) {
		throw new Error(`invalid contract: empty — ${CONTRACT_NEED}`);
	}
	const items = parts.map((part) => {
		const i = part.indexOf("=>");
		if (i < 0) {
			throw new Error(`invalid contract: every item needs "<field> => <text>" (got ${JSON.stringify(part)}) — ${CONTRACT_NEED}`);
		}
		const field = part.slice(0, i).trim().toLowerCase();
		const text = part.slice(i + 2).trim();
		if (!field) {
			throw new Error(`invalid contract: item needs a field before "=>" (got ${JSON.stringify(part)})`);
		}
		if (!text) {
			if (field === "waiver") {
				throw new Error(`invalid contract: "waiver" needs a reason ("waiver => <reason>") — reasonless contract-skips fail loud`);
			}
			throw new Error(`invalid contract: field "${field}" needs text after "=>" (got ${JSON.stringify(part)})`);
		}
		if (field !== "waiver" && !CONTRACT_FIELDS.includes(field)) {
			throw new Error(`invalid contract: unknown field "${field}" (known: ${CONTRACT_FIELDS.join(", ")})`);
		}
		return { field, text };
	});
	const real = items.filter((it) => it.field !== "waiver");
	if (real.length > 0) {
		const missing = CONTRACT_FIELDS.filter((f) => !real.some((it) => it.field === f));
		if (missing.length > 0) {
			throw new Error(
				`invalid contract: five-field completion contract missing "${missing.join('", "')}" — a partial contract fails loud, ${CONTRACT_NEED}`,
			);
		}
		const seen = new Set();
		for (const it of real) {
			if (seen.has(it.field)) {
				throw new Error(`invalid contract: duplicate field "${it.field}" — each of the five fields appears exactly once`);
			}
			seen.add(it.field);
		}
	}
	return items;
}

// Settle the contract box (status filled) after loud validation.
export function answerContract(goal, value) {
	if (!("contract" in goal.boxes)) throw new Error("unknown checklist box: contract");
	if (goal.boxes.contract.status !== "open") throw new Error("box already settled: contract");
	parseContractValue(value);
	goal.boxes.contract = { status: "filled", value: String(value ?? "") };
	return goal;
}

// Declared contract: well-formed `<field> => <text>` items only. Open boxes,
// waiver records (defaults escape, rounds cap, legacy grandfathering), and
// malformed values yield [] — waivers are data, never contract items
// (the goalSurface precedent).
export function goalContract(goal) {
	const box = goal.boxes.contract;
	if (!box || box.status === "open") return [];
	const raw = String(box.value ?? "");
	if (raw.trim() === "") return [];
	let items;
	try {
		items = parseContractValue(raw);
	} catch {
		return [];
	}
	return items.filter((it) => it.field !== "waiver").map((it) => ({ field: it.field, text: it.text }));
}

// Which path the box took: open | contract | waiver.
export function contractKind(goal) {
	const box = goal.boxes.contract;
	if (!box || box.status === "open") return "open";
	const raw = String(box.value ?? "");
	if (raw.trim() === "") return "open";
	return goalContract(goal).length > 0 ? "contract" : "waiver";
}

// File-level contract item: inline tables need both halves; bare strings
// count as field-only (no text half). Mirrors parseGoalSurfaceSpecItem.
function parseGoalContractItem(item) {
	const t = String(item).trim();
	if (t === "") return null;
	if (t.startsWith("{")) {
		const fm = t.match(/field *= *("(?:[^"\\]|\\.)*")/);
		const tm = t.match(/text *= *("(?:[^"\\]|\\.)*")/);
		let field = "";
		let text = "";
		try {
			field = fm ? JSON.parse(fm[1]) : "";
		} catch {
			return { field: "", text: "", malformed: true };
		}
		try {
			text = tm ? JSON.parse(tm[1]) : "";
		} catch {
			return { field: "", text: "", malformed: true };
		}
		return { field, text, malformed: false };
	}
	const sm = t.match(/^("(?:[^"\\]|\\.)*")$/);
	if (sm) {
		try {
			return { field: JSON.parse(sm[1]), text: "", malformed: false };
		} catch {
			return { field: "", text: "", malformed: true };
		}
	}
	return { field: "", text: "", malformed: true };
}

// --- deterministic gate runner + fingerprint cache + bounded retries (hub#213) ---
//
// Hermes' second mechanic: quality gates — DETERMINISTIC commands (baml
// check/test, the committed .bais/e2e scaffolds per hub#184) that must exit
// 0 BEFORE any LLM judge verdict runs. Three rules:
//
//   1. Gates first, judge second. The judge callback is invoked only when
//      every gate is green; a red gate means no judge call, ever. The judge
//      is fail-open (a throwing judge yields a warn, never a crash) with a
//      hard turn budget passed through as the real backstop.
//   2. Git-fingerprint cache. Gate results are cached keyed to a workspace
//      fingerprint (git HEAD + status/diff content hash). Re-evaluating an
//      unchanged fingerprint replays the recorded result — a recorded
//      FAILURE included — without re-running the suite, so a stuck agent
//      cannot burn wall-clock re-running an identical red suite.
//   3. Bounded retries + auto-pause. The suite is attempted at most
//      retries+1 times; each attempt re-evaluates the fingerprint (a retry
//      on changed state re-runs, a retry on unchanged state replays).
//      Exhaustion auto-pauses with a named reason
//      ("gate_red_retries_exhausted: ...") instead of looping forever.
//
// The runner is pure-ish: fingerprint, run, cache, and judge are injected,
// so the selftest is offline-deterministic. The CLI owns real processes
// (defaultGateRun) and persistence (newFileGateCache); goalGates maps a
// committed goal's e2e cases to gate argv (deterministic commands per
// hub#184).
//
// Load-bearing hunk (hub#213/bi#57 red-check target): the gate-first guard.
// Invoking the judge when a gate is red (e.g. moving the judge call out of
// the `green` branch) must trip the selftest below with exactly:
//   "FAIL selftest: judge never invoked while a gate is red"
// (verified 2026-09-07: guard neutered -> that FAIL observed -> restored green).

// Bounded retries per gate evaluation: retries+1 attempts total, then the
// campaign auto-pauses instead of burning wall-clock.
export const GATE_RETRY_DEFAULT = 2;

const GATE_CACHE_MAX = 32;

// Git fingerprint of the workspace state the gates ran against: HEAD plus
// the status/diff content, hashed. Untracked files join by name (porcelain)
// — the CLI wiring note in the hub#213 issue covers content-hashing them.
export function workspaceFingerprint(cwd, { spawn = spawnSync } = {}) {
	const run = (args) => {
		const r = spawn("git", args, { cwd, encoding: "utf8", timeout: 30000 });
		return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
	};
	const h = createHash("sha256");
	h.update(run(["rev-parse", "HEAD"]), "utf8");
	h.update("", "utf8");
	h.update(run(["status", "--porcelain"]), "utf8");
	h.update("", "utf8");
	h.update(run(["diff", "HEAD"]), "utf8");
	return h.digest("hex");
}

// Real process gate run: spawnSync the argv, report exit status + output
// tail. A spawn error (missing binary, timeout) is a red gate, never a
// throw — gates fail loud as results, not exceptions.
export function defaultGateRun(gate) {
	const r = spawnSync(gate.argv[0], gate.argv.slice(1), {
		cwd: gate.cwd,
		encoding: "utf8",
		timeout: gate.timeout ?? 120000,
	});
	const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
	return { status: typeof r.status === "number" ? r.status : 1, output };
}

// The committed goal's deterministic gates: one per e2e scaffold (hub#184),
// run under plain node. Pure — the CLI prepends baml check/test gates.
export function goalGates(goal, { e2eDir = ".bais/e2e", node = "node" } = {}) {
	const cases = Array.isArray(goal?.sketch?.e2e) ? goal.sketch.e2e : [];
	return cases.map((c) => ({ name: c.case, argv: [node, join(e2eDir, `${c.case}.mjs`)] }));
}

// File-backed JSON gate-result cache keyed by fingerprint (the CLI owns the
// path; .bais/gate-cache.json per the wiring spec). Bounded: oldest entries
// drop past GATE_CACHE_MAX so campaigns cannot grow it without limit.
export function newFileGateCache(path) {
	let records = {};
	try {
		records = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		records = {};
	}
	return {
		get: (fp) => records[fp] ?? null,
		set: (fp, record) => {
			records[fp] = record;
			const keys = Object.keys(records);
			while (keys.length > GATE_CACHE_MAX) delete records[keys.shift()];
			writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
		},
	};
}

const tail = (s, n = 400) => {
	const t = String(s ?? "");
	return t.length <= n ? t : t.slice(t.length - n);
};

// Evaluate the deterministic gates with fingerprint caching and bounded
// retries; only when every gate is green may the judge run. Returns:
//   { ok, results, attempts, executed, replayed, paused, pause_reason, judge }
// results: [{ name, status, output_tail, replayed }] — first red gate stops
// the suite (fail-fast: later gates never run on a red attempt).
export function runGoalGate({
	gates,
	fingerprint,
	cache = null,
	run = defaultGateRun,
	retries = GATE_RETRY_DEFAULT,
	judge = null,
	turnBudget = 0,
} = {}) {
	const suite = Array.isArray(gates) ? gates : [];
	const fp = typeof fingerprint === "function" ? fingerprint : () => String(fingerprint ?? "");
	const maxAttempts = Math.max(1, (retries | 0) + 1);
	let results = [];
	let attempts = 0;
	let executed = 0;
	let replayed = false;
	let green = false;
	for (attempts = 1; attempts <= maxAttempts; attempts++) {
		const print = fp();
		const hit = cache && typeof cache.get === "function" ? cache.get(print) : null;
		if (hit && Array.isArray(hit.results)) {
			replayed = true;
			results = hit.results.map((r) => ({ ...r, replayed: true }));
		} else {
			replayed = false;
			results = [];
			for (const g of suite) {
				const r = run(g);
				executed++;
				results.push({ name: String(g.name ?? g.argv?.join(" ") ?? "gate"), status: r.status, output_tail: tail(r.output), replayed: false });
				if (r.status !== 0) break;
			}
			if (cache && typeof cache.set === "function") {
				cache.set(print, { fingerprint: print, ok: results.every((r) => r.status === 0), results });
			}
		}
		green = suite.length > 0 && results.length === suite.length && results.every((r) => r.status === 0);
		if (suite.length === 0) green = false;
		if (green) break;
	}
	if (!green) {
		attempts = Math.min(attempts, maxAttempts);
		const red = results.find((r) => r.status !== 0);
		const reason =
			suite.length === 0
				? "gate_empty: no deterministic gates declared — the judge never runs without a green gate suite"
				: `gate_red_retries_exhausted: gate ${JSON.stringify(red?.name ?? "unknown")} exit ${red?.status ?? "?"} after ${attempts}/${maxAttempts} attempts${replayed ? " (unchanged fingerprint — replayed, not re-run)" : ""}`;
		// Gate-first guard (the hub#213 red-check target): the return below
		// happens BEFORE the judge block — a red suite can never reach it.
		return { ok: false, results, attempts, executed, replayed, paused: true, pause_reason: reason, judge: { invoked: false, verdict: null } };
	}
	const out = { ok: true, results, attempts, executed, replayed, paused: false, pause_reason: "", judge: { invoked: false, verdict: null } };
	if (typeof judge === "function") {
		// Fail-open judge with the hard turn budget as backstop: a throwing
		// or verdict-less judge warns and never blocks the green gates.
		try {
			const verdict = judge({ results, turnBudget });
			out.judge = { invoked: true, verdict: verdict ?? null };
			if (verdict == null) out.judge.warn = "judge returned no verdict (fail-open)";
		} catch (e) {
			out.judge = { invoked: true, verdict: null, warn: `judge threw (fail-open): ${String(e && e.message)}` };
		}
	}
	return out;
}

// --- selftest (acceptance fixtures) ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) {
			failures++;
			console.error(`FAIL selftest: ${msg}`);
		} else console.log(`ok selftest: ${msg}`);
	};

	// Fixture 1 (bi#132a): sketch refused while the checklist is open.
	const open = parseGoalToml(readFileSync(join(FIXTURES, "open-goal.toml"), "utf8"));
	const refused = sketch(open);
	check(
		refused.ok === false && refused.error.startsWith("sketch refused: checklist open"),
		`sketch refused while checklist open (got ${JSON.stringify(refused.error)})`,
	);
	check(open.sketch === null, "refused sketch leaves no sketch behind");

	// Every question ends with the use-defaults escape.
	const q = nextQuestion(open);
	check(typeof q === "string" && q.endsWith(DEFAULTS_ESCAPE), "interview question ends with defaults escape");

	// Fixture 2 (bi#132b): the defaults escape fills the rest.
	useDefaults(open);
	check(checklistComplete(open), "defaults escape fills every remaining box");
	const ready = sketch(open);
	check(ready.ok === true && ready.proposal.nodes.length >= 1, "sketch proceeds once the checklist is complete");
	check(
		ready.proposal.nodes.every((n) => "id" in n && "title" in n && Array.isArray(n.radius)) &&
			ready.proposal.edges.every((e) => "from" in e && "to" in e),
		"sketch proposal carries nodes + edges + radii",
	);

	// Fixture 3 (bi#132c): commit writes nothing before human approval.
	// (hub#185: the ready fixture + defaults escape leaves testing-surface
	// waiver-defaulted, so the approved commit below also carries the
	// sketch.toml + oracle-gap pair — the empty-oracle shape.)
	const committed = parseGoalToml(readFileSync(join(FIXTURES, "ready-goal.toml"), "utf8"));
	useDefaults(committed);
	sketch(committed);
	const writes = new Map();
	const dry = commit(committed, {
		approved: false,
		write: (p, c) => writes.set(p, c),
	});
	check(dry.ok === false && dry.wrote.length === 0 && writes.size === 0, "commit writes nothing before approval");
	const wet = commit(committed, {
		approved: true,
		write: (rel, content) => {
			writes.set(rel, content);
			if (rel === "goal.toml") {
				const back = parseGoalToml(content);
				check(back.statement === committed.statement, "committed goal.toml round-trips the statement");
			}
		},
	});
	check(
		wet.ok === true &&
			wet.wrote.includes(".bais/goal.toml") &&
			wet.wrote.includes(".bais/sketch.toml") &&
			wet.wrote.includes(".bais/issues/goal#oracle-gap.toml") &&
			writes.size === wet.wrote.length,
		`empty-oracle commit writes goal.toml + sketch.toml + oracle-gap issue (got ${JSON.stringify(wet.wrote)})`,
	);
	check(
		![...writes.keys()].some((p) => p.startsWith("e2e/")),
		"empty-oracle commit writes no e2e scaffolds",
	);

	// Rounds cap: an interrogation that never ends auto-defaults instead.
	const slow = newGoal("never-ending scoping");
	let last = "";
	for (let i = 0; i <= MAX_ROUNDS; i++) last = nextQuestion(slow);
	check(checklistComplete(slow) && last.endsWith(DEFAULTS_ESCAPE), "rounds cap auto-defaults the rest");

	// Round-trip: the ready fixture parses to a complete checklist.
	const readyParsed = parseGoalToml(readFileSync(join(FIXTURES, "ready-goal.toml"), "utf8"));
	useDefaults(readyParsed);
	check(checklistComplete(readyParsed), "ready fixture parses to a completable checklist");

	// hub#158: goal.toml validation gate (styles pack landed per bi#134 —
	// 6 packs; roster still pending per bi#147, so hero always warns).
	const packs158 = listStylePacks(HUB_STYLES_DIR);
	check(
		packs158.length >= 4 && packs158.includes("data-oriented-game"),
		`style packs resolvable from .bais/styles (got ${packs158.length}: ${packs158.join(", ")})`,
	);

	// Live root goal is the real-world fixture: read-only, at most
	// style/hero warns, zero errors.
	const live158 = validateGoal(readFileSync(HUB_GOAL_TOML, "utf8"), { knownStyles: packs158 });
	check(
		live158.ok === true && live158.errors.length === 0,
		`live .bais/goal.toml validates (errors: ${JSON.stringify(live158.errors)})`,
	);
	check(
		live158.warns.every((w) => /style|hero|roster/i.test(w)),
		`live goal warns are style/hero-only (warns: ${JSON.stringify(live158.warns)})`,
	);

	// Acceptance 1: missing done_criteria fails loud naming the field.
	const missing158 = validateGoal(readFileSync(join(FIXTURES, "missing-criteria-goal.toml"), "utf8"), {
		knownStyles: packs158,
		knownHeroes: ["plain"],
	});
	check(
		missing158.ok === false && missing158.errors.some((e) => e.includes("done_criteria")),
		`missing done_criteria fails naming the field (errors: ${JSON.stringify(missing158.errors)})`,
	);

	// Acceptance 2: unknown style warns (not fails).
	const unknownStyle158 = validateGoal(readFileSync(join(FIXTURES, "unknown-style-goal.toml"), "utf8"), {
		knownStyles: packs158,
		knownHeroes: ["plain"],
	});
	check(unknownStyle158.ok === true, "unknown style still validates ok (warn-only)");
	check(
		unknownStyle158.warns.some((w) => w.includes("style") && w.includes("no-such-style")),
		`unknown style warns naming it (warns: ${JSON.stringify(unknownStyle158.warns)})`,
	);

	// Empty criteria list fails naming done_criteria; inline-table criteria
	// (the renderGoalToml shape) validate alongside bare strings.
	const empty158 = validateGoal(`statement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = []\n`, {
		knownStyles: ["plain"],
		knownHeroes: ["plain"],
	});
	check(
		empty158.ok === false && empty158.errors.some((e) => e.includes("done_criteria")),
		"empty done_criteria fails naming the field",
	);
	const inline158 = validateGoal(
		`[goal]\nstatement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = [{ text = "a", done = true }, { text = "b", done = false }]\n`,
		{ knownStyles: ["plain"], knownHeroes: ["plain"] },
	);
	check(
		inline158.ok === true && inline158.errors.length === 0 && inline158.warns.length === 0,
		"inline-table criteria + known style/hero validate clean",
	);

	// hub#165: the sufficiency gate appears verbatim with the incentive, and
	// the waive/defaults escape is still intact at the end.
	const suf165 = newGoal("sufficiency wording");
	const sufQ165 = nextQuestion(suf165);
	check(typeof sufQ165 === "string" && sufQ165.includes(SUFFICIENCY_QUESTION), "interview question carries the sufficiency gate verbatim");
	check(sufQ165.includes(SUFFICIENCY_INCENTIVE), "sufficiency gate states the e2e incentive");
	check(sufQ165.endsWith(DEFAULTS_ESCAPE), "sufficiency question keeps the defaults escape intact");

	// hub#165: a goal with a declared surface sketches e2e covering every
	// surface item, each in BITS case shape (case/surface/exercise).
	const surf165 = parseGoalToml(readFileSync(join(FIXTURES, "surface-goal.toml"), "utf8"));
	check(checklistComplete(surf165), "surface fixture parses to a complete checklist");
	const surfSketch165 = sketch(surf165);
	const items165 = goalSurface(surf165);
	const e2e165 = surfSketch165.ok === true && Array.isArray(surfSketch165.proposal.e2e) ? surfSketch165.proposal.e2e : null;
	check(e2e165 !== null, "sketch emits an e2e proposal alongside nodes + edges");
	check(
		e2e165 !== null && e2e165.length === items165.length && items165.length === 2,
		`sketch e2e covers every declared surface item (got ${JSON.stringify(e2e165)})`,
	);
	check(
		e2e165 !== null &&
			e2e165.every(
				(c, i) => typeof c.case === "string" && c.surface === items165[i].surface && c.exercise === items165[i].exercise,
			),
		"surface items flow into BITS case shape (case/surface/exercise)",
	);

	// hub#165: declared surface validates clean; an item without an exercise
	// half fails loud naming testing_surface.
	const surfValid165 = validateGoal(readFileSync(join(FIXTURES, "surface-goal.toml"), "utf8"), {
		knownStyles: ["plain"],
		knownHeroes: ["plain"],
	});
	check(
		surfValid165.ok === true && surfValid165.errors.length === 0,
		`declared testing_surface validates clean (errors: ${JSON.stringify(surfValid165.errors)})`,
	);
	const surfBad165 = validateGoal(readFileSync(join(FIXTURES, "surface-bad-goal.toml"), "utf8"), {
		knownStyles: ["plain"],
		knownHeroes: ["plain"],
	});
	check(
		surfBad165.ok === false && surfBad165.errors.some((e) => e.includes("testing_surface")),
		`surface item without exercise fails naming the field (errors: ${JSON.stringify(surfBad165.errors)})`,
	);

	// hub#165: the testing-surface box and [goal] testing_surface survive a
	// render/parse round-trip.
	const surfBack165 = parseGoalToml(renderGoalToml(surf165));
	check(
		surfBack165.boxes["testing-surface"].value === surf165.boxes["testing-surface"].value,
		"testing-surface box round-trips through goal.toml",
	);
	check(
		surfBack165._parsed.testing_surface.length === items165.length,
		"[goal] testing_surface round-trips every declared item",
	);

	// hub#166: the surface-spec (taste) box — what GOOD looks like. Three
	// paths: spec provided (flows into sketch oracle), explicit
	// taste-waiver with reason (recorded, sketch proceeds), pure-no-IO
	// exemption established explicitly (never assumed).
	const gap166 = parseGoalToml(readFileSync(join(FIXTURES, "taste-gap-goal.toml"), "utf8"));
	check(!checklistComplete(gap166), "taste-gap fixture leaves the surface-spec box open");
	const gapSketch166 = sketch(gap166);
	check(
		gapSketch166.ok === false && gapSketch166.error.includes("surface-spec"),
		`sketch refused while the surface-spec box is open (got ${JSON.stringify(gapSketch166.error)})`,
	);
	// Acceptance 1: UI goal without a design fails the box loud — empty and
	// malformed settles throw naming surface-spec, and a bare waive throws
	// directing to the explicit paths.
	let loud166 = "";
	try {
		answer(gap166, "surface-spec", "");
	} catch (e) {
		loud166 = String(e && e.message);
	}
	check(
		loud166.includes("surface-spec"),
		`empty surface-spec settle fails loud naming the box (got ${JSON.stringify(loud166)})`,
	);
	let bare166 = "";
	try {
		waive(gap166, "surface-spec");
	} catch (e) {
		bare166 = String(e && e.message);
	}
	check(
		bare166.includes("surface-spec") && bare166.includes("waiver =>"),
		`bare waive of surface-spec fails loud with the explicit paths (got ${JSON.stringify(bare166)})`,
	);
	check(gap166.boxes["surface-spec"].status === "open", "failed settles leave the surface-spec box open");
	// The gap fixture is grandfathered at file level (no surface_spec key).
	const gapValid166 = validateGoal(readFileSync(join(FIXTURES, "taste-gap-goal.toml"), "utf8"), {
		knownStyles: ["plain"],
		knownHeroes: ["plain"],
	});
	check(
		gapValid166.ok === true && gapValid166.errors.length === 0,
		`taste-gap fixture validates clean without surface_spec (errors: ${JSON.stringify(gapValid166.errors)})`,
	);

	// Acceptance 2: parser goal with a token spec — the spec flows into the
	// sketch oracle in BITS case shape (case/facet/spec), verbatim.
	const parser166 = parseGoalToml(readFileSync(join(FIXTURES, "parser-spec-goal.toml"), "utf8"));
	check(checklistComplete(parser166), "parser fixture parses to a complete checklist");
	check(surfaceSpecKind(parser166) === "spec", "parser fixture surface kind is spec");
	const parserSketch166 = sketch(parser166);
	const oracle166 =
		parserSketch166.ok === true && Array.isArray(parserSketch166.proposal.oracle) ? parserSketch166.proposal.oracle : null;
	const specItems166 = goalSurfaceSpec(parser166);
	check(
		oracle166 !== null && oracle166.length === specItems166.length && specItems166.length === 2,
		`sketch oracle covers every declared surface-spec item (got ${JSON.stringify(oracle166)})`,
	);
	check(
		oracle166 !== null &&
			oracle166.every(
				(c, i) => typeof c.case === "string" && c.facet === specItems166[i].facet && c.spec === specItems166[i].spec,
			),
		"token spec flows into BITS case shape (case/facet/spec)",
	);
	check(
		oracle166 !== null &&
			oracle166.some((c) => c.facet === "parser tokens" && c.spec.includes("toml.abnf")),
		"token spec text rides the oracle verbatim",
	);
	const parserValid166 = validateGoal(readFileSync(join(FIXTURES, "parser-spec-goal.toml"), "utf8"), {
		knownStyles: ["plain"],
		knownHeroes: ["plain"],
	});
	check(
		parserValid166.ok === true && parserValid166.errors.length === 0,
		`declared surface_spec validates clean (errors: ${JSON.stringify(parserValid166.errors)})`,
	);
	// A facet-only item fails loud naming surface_spec.
	const specBad166 = validateGoal(
		`[goal]\nstatement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = ["a"]\nsurface_spec = ["parser tokens"]\n`,
		{ knownStyles: ["plain"], knownHeroes: ["plain"] },
	);
	check(
		specBad166.ok === false && specBad166.errors.some((e) => e.includes("surface_spec")),
		`facet-only surface_spec item fails naming the field (errors: ${JSON.stringify(specBad166.errors)})`,
	);
	// The parser surface_spec survives a render/parse round-trip.
	const parserBack166 = parseGoalToml(renderGoalToml(parser166));
	check(
		parserBack166.boxes["surface-spec"].value === parser166.boxes["surface-spec"].value,
		"surface-spec box round-trips through goal.toml",
	);
	check(
		parserBack166._parsed.surface_spec.length === specItems166.length,
		"[goal] surface_spec round-trips every declared item",
	);

	// Acceptance 3a: explicit taste-waiver with reason — recorded, sketch
	// proceeds, oracle carries the waiver record.
	const waiver166 = parseGoalToml(readFileSync(join(FIXTURES, "taste-waiver-goal.toml"), "utf8"));
	check(checklistComplete(waiver166), "waiver fixture parses to a complete checklist");
	check(surfaceSpecKind(waiver166) === "waiver", "waiver fixture surface kind is waiver");
	const waiverSketch166 = sketch(waiver166);
	check(waiverSketch166.ok === true, "sketch proceeds once the waiver is recorded");
	check(
		waiverSketch166.ok === true &&
			waiverSketch166.proposal.oracle.some((c) => c.facet === "waiver" && c.spec.includes("taste risk")),
		"oracle records the taste-waiver with its reason",
	);
	// A waiver without a reason fails loud — reasonless taste-skips are the
	// failure mode.
	let reasonless166 = "";
	try {
		answer(newGoal("x"), "surface-spec", "waiver => ");
	} catch (e) {
		reasonless166 = String(e && e.message);
	}
	check(
		reasonless166.includes("surface-spec") && reasonless166.includes("waiver"),
		`reasonless waiver fails loud (got ${JSON.stringify(reasonless166)})`,
	);

	// Acceptance 3b: pure-no-IO exemption — established explicitly in the
	// box value, sketch proceeds, oracle records it.
	const pure166 = parseGoalToml(readFileSync(join(FIXTURES, "pure-goal.toml"), "utf8"));
	check(checklistComplete(pure166), "pure fixture parses to a complete checklist");
	check(surfaceSpecKind(pure166) === "pure", "pure fixture surface kind is pure");
	const pureSketch166 = sketch(pure166);
	check(pureSketch166.ok === true, "sketch proceeds once the exemption is recorded");
	check(
		pureSketch166.ok === true &&
			pureSketch166.proposal.oracle.some((c) => c.facet === "pure-no-io" && c.spec.length > 0),
		"oracle records the pure-no-io exemption with its reason",
	);
	// Purity is never assumed: the defaults escape records a waiver, never
	// a pure exemption.
	const defaulted166 = newGoal("defaults never assume purity");
	useDefaults(defaulted166);
	check(surfaceSpecKind(defaulted166) === "waiver", "defaulted surface-spec is a waiver record, never pure");
	check(sketch(defaulted166).ok === true, "sketch proceeds after the defaults escape");

	// hub#184: commit persists the sketch — sketch.toml + one failing-first
	// scaffold per declared surface on the 2-surface fixture.
	const commit184 = parseGoalToml(readFileSync(join(FIXTURES, "surface-goal.toml"), "utf8"));
	check(checklistComplete(commit184), "commit fixture parses to a complete checklist");
	// hub#190: commit() now refuses assert-true exercises and citationless
	// cases loud — the commit fixture settles the well-formed {command,
	// expect} + facet-citation form in-memory (fixture FILES untouched; the
	// legacy form stays covered by the reader/warn-first checks below and
	// by the hub#190 refusal fixtures). Slugs derive from surface text, so
	// case ids are unchanged.
	commit184.boxes["testing-surface"].value =
		"bais list shows open issues => run: bais list --json => exit 0 and the output lists open issue ids (facets: cli output shape); bais ready orders by severity => run: bais ready => exit 0 and the highest-severity ready issue leads (facets: cli output shape)";
	const sk184 = sketch(commit184);
	check(sk184.ok === true, "commit fixture sketches clean");
	const files184 = new Map();
	const res184 = commit(commit184, { approved: true, write: (p, c) => files184.set(p, c) });
	const e2e184 = sk184.proposal.e2e;
	check(
		res184.ok === true &&
			res184.wrote.includes(".bais/goal.toml") &&
			res184.wrote.includes(".bais/sketch.toml") &&
			e2e184.every((c) => res184.wrote.includes(`.bais/e2e/${c.case}.mjs`)) &&
			res184.wrote.length === 2 + e2e184.length,
		`commit writes e2e scaffolds for every declared surface (got ${JSON.stringify(res184.wrote)})`,
	);
	check(
		![...files184.keys()].some((p) => p.startsWith("issues/")),
		"surfaced commit files no oracle-gap issue",
	);
	// sketch.toml round-trips nodes + edges through any TOML reader shape.
	const back184 = parseSketchToml(files184.get("sketch.toml"));
	check(
		JSON.stringify(back184.nodes) === JSON.stringify(sk184.proposal.nodes) &&
			JSON.stringify(back184.edges) === JSON.stringify(sk184.proposal.edges),
		"sketch.toml round-trips the approved nodes + edges",
	);
	// Slugs derive from surface text (kebab-case): same surfaces in a
	// different order yield the same case ids.
	const ids184 = e2e184.map((c) => c.case).sort();
	check(
		JSON.stringify(ids184) ===
			JSON.stringify(["bais-list-shows-open-issues", "bais-ready-orders-by-severity"]),
		`case ids are kebab slugs of the surface text (got ${JSON.stringify(ids184)})`,
	);
	const flipped184 = parseGoalToml(readFileSync(join(FIXTURES, "surface-goal.toml"), "utf8"));
	flipped184.boxes["testing-surface"].value =
		"bais ready orders by severity => run: bais ready; bais list shows open issues => run: bais list --json";
	// Surface→id mapping (not the id set): positional ids would rename
	// every case on reorder, slugs keep each surface's id. Compared
	// key-sorted — object insertion order follows answer order, which is
	// exactly what reordering changes.
	const canon184 = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
	const map184 = Object.fromEntries(sk184.proposal.e2e.map((c) => [c.surface, c.case]));
	const mapFlip184 = Object.fromEntries(sketch(flipped184).proposal.e2e.map((c) => [c.surface, c.case]));
	check(
		canon184(mapFlip184) === canon184(map184),
		`reordered surfaces keep stable case ids (got ${JSON.stringify(mapFlip184)})`,
	);
	// Collision suffixing: identical surfaces share a stem, never a file.
	check(
		surfaceSlug("bais list", new Set(["bais-list"])) === "bais-list-2",
		"colliding surfaces suffix (-2)",
	);
	// Every scaffold header carries the surface anchor; an independent
	// sha256 recompute matches it. Scaffolds run under plain node: exit 1
	// with FAIL naming the surface (tmpdir — never the live tree).
	const e2eDir184 = join(realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "bi-goal184-"))), "e2e");
	mkdirSync(e2eDir184, { recursive: true });
	for (const c of e2e184) {
		const src = files184.get(`e2e/${c.case}.mjs`);
		const m = src.match(/^\/\/ goal anchor: ([0-9a-f]{64}) /m);
		const expected = createHash("sha256").update(`${c.surface}=>${c.exercise}`, "utf8").digest("hex");
		check(m !== null && m[1] === expected, `scaffold ${c.case} header carries the recomputed surface anchor`);
		const fp = join(e2eDir184, `${c.case}.mjs`);
		writeFileSync(fp, src);
		const run = spawnSync("node", [fp], { encoding: "utf8", timeout: 30000 });
		const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		check(
			run.status === 1 && out.includes(`FAIL: ${c.surface}: scaffold-unimplemented`),
			`scaffold ${c.case} fails first under plain node (exit ${run.status}, out ${JSON.stringify(out.slice(0, 120))})`,
		);
	}

	// hub#185: the oracle's absence is loud, reasoned, and durable.
	// Bare waive refuses naming the reasoned-waiver forms; the box stays open.
	let bare185 = "";
	try {
		waive(newGoal("x"), "testing-surface");
	} catch (e) {
		bare185 = String(e && e.message);
	}
	check(
		bare185.includes("testing-surface") && bare185.includes("waiver =>") && bare185.includes("none-needed =>"),
		`bare waive of testing-surface fails loud (got ${JSON.stringify(bare185)})`,
	);
	const stillOpen185 = newGoal("box stays open");
	try {
		waive(stillOpen185, "testing-surface");
	} catch {}
	check(stillOpen185.boxes["testing-surface"].status === "open", "failed waive leaves the testing-surface box open");
	// Reasoned settles: waiver and none-needed both fill; empty, malformed,
	// and reasonless values throw naming the box.
	const waiver185 = newGoal("waived oracle");
	answer(waiver185, "testing-surface", "waiver => owner accepts the gap, review-gated");
	check(waiver185.boxes["testing-surface"].status === "filled", "waiver => reason settles the testing-surface box");
	check(goalSurface(waiver185).length === 0, "a waived surface yields no e2e cases (waivers are data, never cases)");
	check(
		testingSurfaceWaiverReason(waiver185).includes("owner accepts the gap"),
		"the waiver reason is recorded as data",
	);
	const none185 = newGoal("no observable surface");
	answer(none185, "testing-surface", "none-needed => pure argv filter, nothing observable to exercise");
	check(goalSurface(none185).length === 0, "none-needed yields no e2e cases");
	for (const [label, val] of [
		["empty", ""],
		["malformed", "just a surface with no exercise half"],
		["reasonless waiver", "waiver => "],
		["reasonless none-needed", "none-needed => "],
	]) {
		let msg = "";
		try {
			answer(newGoal("x"), "testing-surface", val);
		} catch (e) {
			msg = String(e && e.message);
		}
		check(msg.includes("testing-surface"), `${label} testing-surface settle fails loud naming the box (got ${JSON.stringify(msg)})`);
	}
	// A defaults-only goal commits and the oracle-gap issue carries the
	// waiver reason; the rounds cap records distinctly.
	const defaults185 = newGoal("defaults-only campaign");
	useDefaults(defaults185);
	check(
		defaults185.boxes["testing-surface"].value.includes("waiver =>"),
		"the defaults escape records a reasoned testing-surface waiver",
	);
	check(checklistComplete(defaults185) && sketch(defaults185).ok === true, "defaults-only goal sketches");
	const files185 = new Map();
	const res185 = commit(defaults185, { approved: true, write: (p, c) => files185.set(p, c) });
	const gap185 = files185.get("issues/goal#oracle-gap.toml");
	check(
		res185.ok === true && typeof gap185 === "string" && gap185.includes("defaults escape"),
		`empty-oracle commit auto-files the oracle-gap issue (got ${JSON.stringify(res185.wrote)})`,
	);
	check(
		String(gap185 ?? "").includes("waiver => defaults escape: no testing surface declared"),
		"the oracle-gap issue body quotes the waiver reason",
	);
	const capped185 = newGoal("capped campaign");
	for (let i = 0; i <= MAX_ROUNDS; i++) nextQuestion(capped185);
	check(
		capped185.boxes["testing-surface"].value.includes("rounds cap reached"),
		`rounds-cap exhaustion records the distinct capped value (got ${JSON.stringify(capped185.boxes["testing-surface"].value)})`,
	);
	check(
		capped185.boxes["testing-surface"].value !== "none declared",
		"the capped value is not the plain default string",
	);
	// Status renders oracle_absent on the warn channel for oracle-empty
	// goals, and none for goals with declared surfaces.
	const stEmpty185 = status(defaults185);
	check(
		stEmpty185.oracle === "absent" && stEmpty185.warns.some((w) => w.includes("oracle_absent")),
		`oracle-empty status warns oracle_absent (got ${JSON.stringify(stEmpty185.warns)})`,
	);
	const stFull185 = status(commit184);
	check(
		stFull185.oracle === "present" && stFull185.warns.length === 0,
		`surfaced status carries no oracle warn (got ${JSON.stringify(stFull185.warns)})`,
	);
	// End-to-end on a fixture hub (tmpdir — never live issues): the
	// committed files land, `bais check` stays green, and the oracle-gap
	// issue appears in `bais ready`.
	const hub185 = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "bi-goal185-")));
	mkdirSync(join(hub185, ".bais", "issues"), { recursive: true });
	mkdirSync(join(hub185, ".bais", "e2e"), { recursive: true });
	writeFileSync(join(hub185, ".bais", "config.toml"), 'project = "goal-e2e"\n');
	for (const [rel, content] of files185) writeFileSync(join(hub185, ".bais", rel), content);
	const CLI185 = join(HERE, "..", "dist", "src", "cli.js");
	const check185 = spawnSync("node", [CLI185, "check"], { cwd: hub185, encoding: "utf8", timeout: 60000 });
	check(
		check185.status === 0,
		`bais check stays green on the oracle-gap fixture hub (exit ${check185.status}, out ${JSON.stringify(`${check185.stdout ?? ""}${check185.stderr ?? ""}`.slice(0, 200))})`,
	);
	const ready185 = spawnSync("node", [CLI185, "ready"], { cwd: hub185, encoding: "utf8", timeout: 60000 });
	const readyOut185 = `${ready185.stdout ?? ""}${ready185.stderr ?? ""}`;
	check(
		readyOut185.includes("goal#oracle-gap"),
		`the oracle-gap issue appears in bais ready (out ${JSON.stringify(readyOut185.slice(0, 200))})`,
	);

	// hub#199: goal progress consumes verdicts — the committed e2e cases
	// join against graded verdicts (both the BAML {case_id, outcome} and
	// the bits-t2 ledger {id, outcome} shapes); unrun cases are pending,
	// never silently green.
	const prog199 = e2eVerdictProgress(commit184, [
		{ case_id: "bais-list-shows-open-issues", outcome: "Pass" },
		{ id: "bais-ready-orders-by-severity", outcome: "fail" },
	]);
	check(
		prog199.total === 2 &&
			prog199.green === 1 &&
			JSON.stringify(prog199.red) === '["bais-ready-orders-by-severity"]' &&
			prog199.pending.length === 0,
		`verdict progress joins committed e2e cases (got ${JSON.stringify(prog199)})`,
	);
	const pend199 = e2eVerdictProgress(commit184, []);
	check(
		pend199.total === 2 && pend199.green === 0 && pend199.pending.length === 2,
		`unrun e2e cases are pending, never silently green (got ${JSON.stringify(pend199)})`,
	);

	// hub#213: the five-field completion contract (hermes /goal mechanics).
	// Settle path: all five fields fill the box; goalContract reads them
	// back in order; contractKind reports "contract".
	const ctr213 = newGoal("contracted campaign");
	answer(
		ctr213,
		"contract",
		"outcome => bais goal gate ships; verification => baml test + gate selftest exit 0; constraints => offline, no new deps; boundaries => no cli.ts edits; stop_when => gate green on two consecutive fingerprints",
	);
	check(ctr213.boxes.contract.status === "filled", "five-field contract settles the contract box");
	check(
		JSON.stringify(goalContract(ctr213).map((c) => c.field)) === JSON.stringify(CONTRACT_FIELDS),
		`goalContract reads all five fields in order (got ${JSON.stringify(goalContract(ctr213))})`,
	);
	check(contractKind(ctr213) === "contract", "settled contract kind is contract");
	check(
		goalContract(ctr213).find((c) => c.field === "stop_when").text.includes("two consecutive"),
		"stop_when text survives verbatim",
	);
	// Loud settles: partial, unknown-field, duplicate, empty, and reasonless
	// values throw naming the box; the box stays open so sketch refuses.
	let partial213 = "";
	try {
		answer(newGoal("x"), "contract", "outcome => a; verification => b; constraints => c; boundaries => d");
	} catch (e) {
		partial213 = String(e && e.message);
	}
	check(
		partial213.includes("contract") && partial213.includes("stop_when"),
		`partial contract settle fails loud naming the missing field (got ${JSON.stringify(partial213)})`,
	);
	let unknown213 = "";
	try {
		answer(newGoal("x"), "contract", "outcome => a; verification => b; constraints => c; boundaries => d; stop_when => e; vibes => f");
	} catch (e) {
		unknown213 = String(e && e.message);
	}
	check(
		unknown213.includes("contract") && unknown213.includes("vibes"),
		`unknown contract field fails loud naming it (got ${JSON.stringify(unknown213)})`,
	);
	let dup213 = "";
	try {
		answer(newGoal("x"), "contract", "outcome => a; outcome => b; verification => c; constraints => d; boundaries => e; stop_when => f");
	} catch (e) {
		dup213 = String(e && e.message);
	}
	check(dup213.includes("duplicate"), `duplicate contract field fails loud (got ${JSON.stringify(dup213)})`);
	let bareCtr213 = "";
	try {
		waive(newGoal("x"), "contract");
	} catch (e) {
		bareCtr213 = String(e && e.message);
	}
	check(
		bareCtr213.includes("contract") && bareCtr213.includes("waiver =>"),
		`bare waive of contract fails loud with the explicit path (got ${JSON.stringify(bareCtr213)})`,
	);
	// Reasoned waiver settles but yields no contract items (waivers are
	// data, never a contract); the defaults escape records a waiver, never
	// a silent absence.
	const cwaiv213 = newGoal("waived contract");
	answer(cwaiv213, "contract", "waiver => spike goal, done defined by review");
	check(
		contractKind(cwaiv213) === "waiver" && goalContract(cwaiv213).length === 0,
		"reasoned contract waiver settles as data, never as contract items",
	);
	const cdef213 = newGoal("defaults contract");
	useDefaults(cdef213);
	check(
		cdef213.boxes.contract.value.includes("waiver =>") && checklistComplete(cdef213) && sketch(cdef213).ok === true,
		"the defaults escape records a reasoned contract waiver and sketch proceeds",
	);
	// Legacy grandfathering: pre-hub#213 fixtures carry no contract section —
	// the box settles as a defaulted waiver naming the grandfathering, the
	// checklist stays complete, and goalContract yields [].
	check(
		surf165.boxes.contract.status === "defaulted" && surf165.boxes.contract.value.includes("legacy goal.toml"),
		`legacy fixture without a contract section is grandfathered (got ${JSON.stringify(surf165.boxes.contract)})`,
	);
	check(contractKind(surf165) === "waiver" && goalContract(surf165).length === 0, "grandfathered contract yields no items");
	// Round-trip: the contract box value and the [goal] contract inline
	// tables survive render/parse byte-for-byte. Real acceptance criteria
	// keep the rendered done_criteria non-empty for validateGoal below.
	answer(ctr213, "acceptance", "gate selftest exits 0; baml test green");
	useDefaults(ctr213);
	const ctrBack213 = parseGoalToml(renderGoalToml(ctr213));
	check(
		ctrBack213.boxes.contract.value === ctr213.boxes.contract.value,
		"contract box round-trips through goal.toml",
	);
	check(
		JSON.stringify(ctrBack213._parsed.contract.map((c) => [c.field, c.text])) ===
			JSON.stringify(goalContract(ctr213).map((c) => [c.field, c.text])),
		"[goal] contract round-trips every declared field",
	);
	check(contractKind(ctrBack213) === "contract", "round-tripped contract kind is contract");
	// Shape-only validation: the rendered contract validates clean; a
	// partial contract fails naming the missing field; an unknown field
	// fails naming it; missing/empty is grandfathered.
	const ctrValid213 = validateGoal(renderGoalToml(ctr213), { knownStyles: ["plain"], knownHeroes: ["plain"] });
	check(
		ctrValid213.ok === true && ctrValid213.errors.length === 0,
		`declared contract validates clean (errors: ${JSON.stringify(ctrValid213.errors)})`,
	);
	const ctrPartialValid213 = validateGoal(
		`[goal]\nstatement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = ["a"]\ncontract = [{ field = "outcome", text = "a" }]\n`,
		{ knownStyles: ["plain"], knownHeroes: ["plain"] },
	);
	check(
		ctrPartialValid213.ok === false && ctrPartialValid213.errors.some((e) => e.includes("contract") && e.includes("verification")),
		`partial contract fails validation naming the missing field (errors: ${JSON.stringify(ctrPartialValid213.errors)})`,
	);
	const ctrUnknownValid213 = validateGoal(
		`[goal]\nstatement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = ["a"]\ncontract = [{ field = "vibes", text = "a" }]\n`,
		{ knownStyles: ["plain"], knownHeroes: ["plain"] },
	);
	check(
		ctrUnknownValid213.ok === false && ctrUnknownValid213.errors.some((e) => e.includes("contract") && e.includes("vibes")),
		`unknown contract field fails validation naming it (errors: ${JSON.stringify(ctrUnknownValid213.errors)})`,
	);
	const ctrEmptyValid213 = validateGoal(
		`[goal]\nstatement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = ["a"]\ncontract = []\n`,
		{ knownStyles: ["plain"], knownHeroes: ["plain"] },
	);
	check(ctrEmptyValid213.ok === true, "empty contract is grandfathered (missing/empty stays green)");

	// hub#213: the deterministic gate runner. Fixture goal = the committed
	// surface goal — its e2e scaffolds (already written to a tmpdir above,
	// failing-first per hub#184) are the deterministic gates.
	const gates213 = goalGates(commit184, { e2eDir: e2eDir184 });
	check(gates213.length === 2 && gates213.every((g) => Array.isArray(g.argv)), "goalGates maps committed e2e cases to gate argv");
	// (a) Deterministic gate run + auto-pause: the red scaffold suite runs,
	// fails fast on the first red gate, and exhausts bounded retries into an
	// auto-pause with a named reason. Injected run counts executions.
	let runs213 = 0;
	const cacheA213 = new Map();
	const redRun213 = runGoalGate({
		gates: gates213,
		fingerprint: "fp-fixture-red",
		cache: { get: (k) => cacheA213.get(k) ?? null, set: (k, v) => cacheA213.set(k, v) },
		run: (g) => {
			runs213++;
			const r = defaultGateRun(g);
			return r;
		},
		retries: GATE_RETRY_DEFAULT,
	});
	check(
		redRun213.ok === false && redRun213.paused === true && redRun213.pause_reason.includes("gate_red_retries_exhausted"),
		`red gate suite auto-pauses with a named reason (got ${JSON.stringify(redRun213.pause_reason)})`,
	);
	check(
		redRun213.judge.invoked === false,
		"red gate suite leaves the judge uninvoked",
	);
	check(
		redRun213.results.length === 1 && redRun213.results[0].status === 1,
		`gate suite fails fast on the first red gate (got ${JSON.stringify(redRun213.results.map((r) => [r.name, r.status]))})`,
	);
	// (b) Fingerprint skip: retries 2 and 3 hit the unchanged fingerprint and
	// REPLAY the recorded failure instead of re-running — exactly one gate
	// execution across three attempts.
	check(
		redRun213.attempts === GATE_RETRY_DEFAULT + 1 && runs213 === 1,
		`unchanged fingerprint replays the recorded failure without re-running (attempts ${redRun213.attempts}, executions ${runs213})`,
	);
	check(redRun213.replayed === true && redRun213.results[0].replayed === true, "the replayed result is marked as a replay");
	// (c) Retries re-run on changed state: a fresh fingerprint per attempt
	// re-runs the gate each attempt, then still auto-pauses.
	let runsB213 = 0;
	let fpN213 = 0;
	const redRunB213 = runGoalGate({
		gates: gates213,
		fingerprint: () => `fp-changing-${fpN213++}`,
		cache: newFileGateCache(join(e2eDir184, "gate-cache-test.json")),
		run: (g) => {
			runsB213++;
			return defaultGateRun(g);
		},
		retries: 2,
	});
	check(
		redRunB213.paused === true && runsB213 === 3 && redRunB213.replayed === false,
		`changed fingerprint re-runs the gate each attempt before auto-pause (executions ${runsB213})`,
	);
	// (d) Green gates: the judge runs exactly once with the turn budget, and
	// a judge throwing fails open (warn, never a crash). A cached green
	// replay still permits the judge — gates-first, judge-second.
	const greenGates213 = [{ name: "always-green", argv: ["node", "-e", "process.exit(0)"] }];
	let judgeCalls213 = 0;
	const greenRun213 = runGoalGate({
		gates: greenGates213,
		fingerprint: "fp-fixture-green",
		run: defaultGateRun,
		judge: ({ turnBudget: tb }) => {
			judgeCalls213++;
			return tb === 5 ? "accept" : "wrong-budget";
		},
		turnBudget: 5,
	});
	check(
		greenRun213.ok === true && greenRun213.paused === false && judgeCalls213 === 1 && greenRun213.judge.verdict === "accept",
		`green gates run the judge once with the turn budget (got ${JSON.stringify(greenRun213.judge)})`,
	);
	const failOpen213 = runGoalGate({
		gates: greenGates213,
		fingerprint: "fp-fixture-green-2",
		run: defaultGateRun,
		judge: () => {
			throw new Error("model exploded");
		},
	});
	check(
		failOpen213.ok === true && failOpen213.judge.invoked === true && /fail-open/.test(failOpen213.judge.warn ?? ""),
		`throwing judge fails open with a warn (got ${JSON.stringify(failOpen213.judge)})`,
	);
	// (e) The hub#213 red-check anchor (bi#57): the judge is NEVER invoked
	// while a gate is red. The judge callback records every call; the guard
	// in runGoalGate returns before the judge block on a red suite.
	let judgeRed213 = 0;
	const neverJudge213 = runGoalGate({
		gates: gates213,
		fingerprint: "fp-fixture-never-judge",
		run: defaultGateRun,
		retries: 0,
		judge: () => {
			judgeRed213++;
			return "accept";
		},
	});
	check(
		neverJudge213.ok === false && neverJudge213.judge.invoked === false && judgeRed213 === 0,
		"judge never invoked while a gate is red",
	);
	// Real fingerprint helper: deterministic on a fixed git state, and a
	// hex digest (shape-only — the content is the repo's business).
	const fpLive213 = workspaceFingerprint(HUB_ROOT);
	check(/^[0-9a-f]{64}$/.test(fpLive213), "workspaceFingerprint yields a sha256 hex digest");

	// hub#196: the sufficiency gate is a REAL branch — a stay-on-box reply
	// asks a follow-up on the same box and never settles as the box value.
	const stay196 = newGoal("stay-on-box campaign");
	nextQuestion(stay196); // users first-ask (rounds = 1)
	answer(stay196, "users", "more");
	check(
		stay196.boxes.users.status === "open" && stay196.boxes.users.value === "" && stay196.followupBox === "users",
		"stay-on-box reply never settles as the box value",
	);
	const fq196 = nextQuestion(stay196);
	check(
		typeof fq196 === "string" && fq196.startsWith("Staying on users") && !fq196.startsWith(BOX_QUESTIONS.users),
		"stay-on-box reply asks a follow-up instead of settling",
	);
	check(
		fq196.includes(SUFFICIENCY_QUESTION) && fq196.includes(SUFFICIENCY_INCENTIVE) && fq196.endsWith(DEFAULTS_ESCAPE),
		"follow-up prompt keeps the sufficiency gate + escapes verbatim",
	);
	// The testing-surface fixture from the acceptance bullet: "more" asks a
	// follow-up; the box settles only on the substantive answer, and the
	// final value is the substance, never the word "more".
	const tsStay196 = newGoal("surface stay-on-box");
	for (const b of ["users", "scale", "platform", "constraints", "style", "acceptance", "non-goals"]) {
		tsStay196.boxes[b] = { status: "filled", value: "x" };
	}
	answer(tsStay196, "testing-surface", "more");
	check(
		tsStay196.boxes["testing-surface"].status === "open" && tsStay196.followupBox === "testing-surface",
		"stay-on-box 'more' on testing-surface leaves the box open awaiting the follow-up",
	);
	check(
		nextQuestion(tsStay196).startsWith("Staying on testing-surface"),
		"stay-on-box reply asks a follow-up instead of settling",
	);
	answer(tsStay196, "testing-surface", "bais list shows open issues => run: bais list --json => exit 0 (facets: waiver)");
	check(
		tsStay196.boxes["testing-surface"].status === "filled" &&
			tsStay196.boxes["testing-surface"].value.includes("bais list shows open issues") &&
			tsStay196.boxes["testing-surface"].value !== "more",
		"settled box value is the substance, never the stay-on-box word",
	);
	// Per-box sub-rounds: follow-ups never consume the global round budget
	// of later boxes.
	const rounds196 = newGoal("sub-round isolation");
	nextQuestion(rounds196); // users first-ask, rounds = 1
	answer(rounds196, "users", "more");
	nextQuestion(rounds196); // follow-up — no round consumed
	answer(rounds196, "users", "what about scale?");
	nextQuestion(rounds196); // follow-up — no round consumed
	check(rounds196.rounds === 1, `per-box sub-rounds do not consume later boxes' rounds (rounds ${rounds196.rounds})`);
	answer(rounds196, "users", "solo dev, detail settled");
	nextQuestion(rounds196); // scale first-ask
	check(
		rounds196.rounds === 2 && openBoxes(rounds196)[0] === "scale",
		"later boxes still get their first-ask after a follow-up loop",
	);
	// Question-shaped replies stay on the box too; a bare "no" stays.
	const q196 = newGoal("question reply");
	answer(q196, "users", "does scale include the sibling repos?");
	check(q196.followupBox === "users" && q196.boxes.users.status === "open", "a question reply stays on the box");
	// Exhaustion: past MAX_BOX_FOLLOWUPS the box escapes via the
	// reasoned-default path naming the cap (hub#185 idiom).
	const exhaust196 = newGoal("follow-up exhaustion");
	for (let i = 0; i <= MAX_BOX_FOLLOWUPS; i++) answer(exhaust196, "testing-surface", "more");
	check(
		exhaust196.boxes["testing-surface"].status === "defaulted" &&
			exhaust196.boxes["testing-surface"].value.includes("stay-on-box follow-up cap reached") &&
			exhaust196.boxes["testing-surface"].value.startsWith("waiver =>"),
		`follow-up exhaustion escapes via the reasoned-default path (got ${JSON.stringify(exhaust196.boxes["testing-surface"])})`,
	);
	check(exhaust196.followupBox === null, "exhaustion clears the pending follow-up");
	// The loop state persists through goal.toml (save/resume keeps it).
	const persist196 = newGoal("persisted follow-up");
	answer(persist196, "users", "more");
	const persistBack196 = parseGoalToml(renderGoalToml(persist196));
	check(
		persistBack196.followupBox === "users" && persistBack196.followups.users === 1,
		`stay-on-box loop state round-trips through goal.toml (got followupBox ${JSON.stringify(persistBack196.followupBox)}, followups ${JSON.stringify(persistBack196.followups)})`,
	);
	check(
		nextQuestion(persistBack196).startsWith("Staying on users"),
		"resumed interview re-asks the follow-up on the same box",
	);

	// hub#186: skeleton-first ordering — baseline node + build-order chain.
	const skOrder186 = newGoal("ordered campaign");
	answer(skOrder186, "acceptance", "alpha; beta; gamma");
	useDefaults(skOrder186);
	const sk186 = sketch(skOrder186);
	const nodes186 = sk186.ok === true ? sk186.proposal.nodes : [];
	const edges186 = sk186.ok === true ? sk186.proposal.edges : [];
	const baseline186 = nodes186.find((n) => n.id === "baseline");
	check(
		baseline186 !== undefined && baseline186.title === BASELINE_NODE_TITLE,
		"sketch emits the baseline walking-skeleton node",
	);
	const has186 = (from, to) => edges186.some((e) => e.from === from && e.to === to && e.kind === "DependsOn");
	check(
		has186("c1", "c2") && has186("c2", "c3") && has186("c3", "hero") && !has186("c1", "hero"),
		`criteria chain in declared build order c1→c2→c3→hero (got ${JSON.stringify(edges186)})`,
	);
	check(
		has186("c1", "baseline") && has186("c2", "baseline") && has186("c3", "baseline") && has186("baseline", "hero"),
		"every criterion DependsOn baseline, baseline DependsOn hero",
	);
	// foundation_rank: 0 for the baseline and its precedes-ancestors
	// (transitive), 1 for everything else.
	const pre186 = [
		{ from: "tooling", to: "core", kind: "precedes" },
		{ from: "core", to: "baseline", kind: "precedes" },
		{ from: "unrelated", to: "core", kind: "DependsOn" },
	];
	check(
		foundationRank("baseline", "baseline", pre186) === 0 &&
			foundationRank("core", "baseline", pre186) === 0 &&
			foundationRank("tooling", "baseline", pre186) === 0 &&
			foundationRank("unrelated", "baseline", pre186) === 1 &&
			foundationRank("enhancement", "baseline", pre186) === 1,
		"foundation_rank: 0 for baseline and precedes-ancestors, 1 otherwise",
	);
	// The foundation sort seats the baseline before an enhancement with
	// higher blast radius (dispatch's primary key; blast radius second).
	const pack186 = [
		{ id: "enhancement", blast: 99 },
		{ id: "baseline", blast: 1 },
	];
	pack186.sort((a, b) => compareFoundation(a.id, b.id, "baseline", []) || b.blast - a.blast);
	check(
		pack186[0].id === "baseline",
		"foundation sort seats the baseline before higher-blast enhancements",
	);
	check(
		foundationSeatingWarn("goal#x", "baseline") === "[bais] enhancement goal#x seated before baseline baseline landed",
		"warn-first seating line matches the pinned string",
	);

	// hub#190: weak-oracle defenses.
	// (1) Exercise shape: assert-true fails loud naming the missing expect;
	// a well-formed {command, expect} passes with facets extracted.
	let assertTrue190 = "";
	try {
		parseExercise("run: bais list --json");
	} catch (e) {
		assertTrue190 = String(e && e.message);
	}
	check(
		assertTrue190.includes("assert-true") && assertTrue190.includes("expect"),
		`assert-true exercise fails shape validation naming the missing expect (got ${JSON.stringify(assertTrue190)})`,
	);
	const wellFormed190 = parseExercise("run: bais list --json => exit 0, lists open ids (facets: cli output shape)");
	check(
		wellFormed190.command === "run: bais list --json" &&
			wellFormed190.expect === "exit 0, lists open ids" &&
			JSON.stringify(wellFormed190.facets) === '["cli output shape"]',
		`well-formed {command, expect} passes shape validation (got ${JSON.stringify(wellFormed190)})`,
	);
	let emptyExpect190 = "";
	try {
		parseExercise("run: bais list => ");
	} catch (e) {
		emptyExpect190 = String(e && e.message);
	}
	check(emptyExpect190.includes("expect"), `empty expect half fails loud (got ${JSON.stringify(emptyExpect190)})`);
	// File level is warn-first: the legacy assert-true fixture validates ok
	// but warns naming the advisory (errors stay zero).
	const warnFirst190 = validateGoal(readFileSync(join(FIXTURES, "surface-goal.toml"), "utf8"), {
		knownStyles: ["plain"],
		knownHeroes: ["plain"],
	});
	check(
		warnFirst190.ok === true && warnFirst190.errors.length === 0 && warnFirst190.warns.some((w) => w.includes("assert-true")),
		`legacy assert-true exercises warn at file level, never fail (warns: ${JSON.stringify(warnFirst190.warns)})`,
	);
	// Commit refuses an assert-true exercise loud, naming the case + expect.
	const badCommit190 = parseGoalToml(readFileSync(join(FIXTURES, "surface-goal.toml"), "utf8"));
	sketch(badCommit190);
	const badRes190 = commit(badCommit190, { approved: true, write: () => {} });
	check(
		badRes190.ok === false && badRes190.wrote.length === 0 && badRes190.error.includes("expect") && badRes190.error.includes("bais-list-shows-open-issues"),
		`commit refuses an assert-true exercise naming the missing expect (got ${JSON.stringify(badRes190.error)})`,
	);
	// (2) Mandatory oracle-facet join: no citation fails with a named
	// reason; a retired citation reports drifted naming the stale facet.
	const noCite190 = newGoal("no citation");
	answer(noCite190, "testing-surface", "flow x => run: x => exit 0");
	answer(noCite190, "surface-spec", "real facet => the spec text");
	useDefaults(noCite190);
	sketch(noCite190);
	const joinAbsent190 = oracleFacetJoin(noCite190);
	check(
		joinAbsent190.length === 1 && joinAbsent190[0].ok === false && joinAbsent190[0].reason.includes("oracle_facet_absent"),
		`case with no oracle-facet citation fails the derivation with a named reason (got ${JSON.stringify(joinAbsent190)})`,
	);
	const noCiteRes190 = commit(noCite190, { approved: true, write: () => {} });
	check(
		noCiteRes190.ok === false && noCiteRes190.error.includes("oracle_facet_absent"),
		`commit refuses a case with no oracle-facet citation (got ${JSON.stringify(noCiteRes190.error)})`,
	);
	const drift190 = newGoal("drifted citation");
	answer(drift190, "testing-surface", "flow x => run: x => exit 0 (facets: ghost facet)");
	answer(drift190, "surface-spec", "real facet => the spec text");
	useDefaults(drift190);
	sketch(drift190);
	const joinDrift190 = oracleFacetJoin(drift190);
	check(
		joinDrift190.length === 1 && joinDrift190[0].ok === false && joinDrift190[0].reason.includes("oracle_facet_drifted") && joinDrift190[0].reason.includes("ghost facet"),
		`case citing a retired facet reports drifted with the stale facet named (got ${JSON.stringify(joinDrift190)})`,
	);
	// The committed fixture's cases cite a declared facet — the join is ok.
	const joinOk190 = oracleFacetJoin(commit184);
	check(
		joinOk190.length === 2 && joinOk190.every((j) => j.ok && j.cited.includes("cli output shape")),
		`well-cited cases pass the oracle-facet join (got ${JSON.stringify(joinOk190)})`,
	);
	// The explicit "waiver" facet is always citable (a waived spec is data).
	const waiverCite190 = newGoal("waiver citation");
	answer(waiverCite190, "testing-surface", "flow x => run: x => exit 0 (facets: waiver)");
	useDefaults(waiverCite190); // surface-spec defaults to a waiver record
	sketch(waiverCite190);
	check(
		oracleFacetJoin(waiverCite190).every((j) => j.ok),
		"a case citing the explicit waiver facet passes the join",
	);
	// (3) Spec-capture guard: an unreasoned surface_spec edit flags loud in
	// goal status; a reasoned amendment record is clean.
	const amend190 = parseGoalToml(readFileSync(join(FIXTURES, "parser-spec-goal.toml"), "utf8"));
	check(
		status(amend190).warns.every((w) => !w.includes("surface_spec amended")),
		"unamended parser fixture status carries no spec-capture warn",
	);
	amend190._parsed.surface_spec = [{ facet: "parser tokens", spec: "whatever the model felt like emitting" }];
	check(
		status(amend190).warns.some((w) => w.includes("surface_spec amended without a reasoned record")),
		"unreasoned surface_spec edit flags loud in goal status",
	);
	amend190._parsed.surface_spec.push({ facet: "amendment", spec: "adopted toml.abnf v1.1 token split, human-reviewed" });
	check(
		status(amend190).warns.every((w) => !w.includes("surface_spec amended")),
		"reasoned surface_spec amendment is clean",
	);
	// (4) Every generated scaffold header carries the red-check record.
	for (const c of e2e184) {
		const src190 = files184.get(`e2e/${c.case}.mjs`);
		check(
			typeof src190 === "string" && src190.includes("// red-check record (bi#57") && src190.includes("hunk:") && src190.includes("expected reason:") && src190.includes("observed:"),
			`scaffold ${c.case} header carries the red-check record (hunk + expected reason + observed)`,
		);
	}

	// hub#195: goal-churn continuity. The committed campaign (commit184
	// above) is the old goal; a switch carries its surfaces + spec forward
	// deliberately, and goal.toml is bound to the approved sketch by hash.
	//
	// (4) Approved-sketch hash: commit() records it in goal.toml; the
	// scaffold headers record the campaign snapshot id; the committed pair
	// verifies and a tampered sketch.toml flags loud.
	const goalToml195 = files184.get("goal.toml");
	check(
		/approved_sketch_hash = "sha256:[0-9a-f]{64}"/.test(goalToml195),
		"commit records the approved-sketch hash in goal.toml",
	);
	check(
		goalToml195.includes(`goal_snapshot = "${commit184.goal_snapshot}"`),
		`goal.toml carries the campaign snapshot id (got ${commit184.goal_snapshot})`,
	);
	for (const c of e2e184) {
		check(
			files184.get(`e2e/${c.case}.mjs`).includes(`// goal snapshot: ${commit184.goal_snapshot}`),
			`scaffold ${c.case} records the goal snapshot id it was authored under`,
		);
	}
	const sketchToml195 = files184.get("sketch.toml");
	check(
		verifyApprovedSketch({ goalTomlText: goalToml195, sketchTomlText: sketchToml195 }).ok,
		"committed goal.toml + sketch.toml verify against the approved-sketch hash",
	);
	const tampered195 = `${sketchToml195}\n[[node]]\nid = "sneaky"\ntitle = "post-approval edit"\nradius = []\n`;
	const tamVer195 = verifyApprovedSketch({ goalTomlText: goalToml195, sketchTomlText: tampered195 });
	check(
		!tamVer195.ok && tamVer195.drift && /sketch stale/.test(tamVer195.error),
		`post-approval sketch edit flags loud against the approved-sketch hash (got ${JSON.stringify(tamVer195)})`,
	);
	// The parsed-back goal.toml restores the binding fields.
	const reparsed195 = parseGoalToml(goalToml195);
	check(
		reparsed195.goal_snapshot === commit184.goal_snapshot && reparsed195.approved_sketch_hash === commit184.approved_sketch_hash,
		"parseGoalToml restores goal_snapshot + approved_sketch_hash",
	);

	// (1) The switch lists the old surfaces for keep/retire decision.
	const sw195 = switchGoal(commit184, "Ship per-directory goal tracking v2");
	check(
		JSON.stringify(sw195.retire) === JSON.stringify(sk184.proposal.nodes.map((n) => n.id)),
		"switch keeps the retire node list",
	);
	check(
		sw195.surfaces.length === 2 && sw195.surfaces.every((s) => s.decision === "undecided" && s.flagged),
		`switch lists the old surfaces undecided + flagged for keep/retire decision (got ${JSON.stringify(sw195.surfaces)})`,
	);
	check(
		sw195.surfaces.every((s) => s.snapshot_id === commit184.goal_snapshot),
		"listed surfaces carry the snapshot id they were authored under",
	);
	// Kept cases rebind explicitly to the new snapshot id; retired surfaces'
	// cases are flagged with the reason; undecided keep cases but flagged.
	const newSnap195 = "goal-snapshot-0000000000aa";
	const dec195 = applySurfaceDecisions(
		sw195,
		{ keep: ["bais list shows open issues"], retire: { "bais ready orders by severity": "goal moved off the ready view" } },
		newSnap195,
	);
	check(
		dec195.keep_surfaces.length === 1 &&
			dec195.keep_surfaces[0].snapshot_id === newSnap195 &&
			dec195.keep_surfaces[0].from_snapshot === commit184.goal_snapshot &&
			!dec195.keep_surfaces[0].flagged,
		`kept cases rebind explicitly to the new snapshot id (got ${JSON.stringify(dec195.keep_surfaces)})`,
	);
	check(
		dec195.retire_surfaces.length === 1 &&
			dec195.retire_surfaces[0].flagged &&
			dec195.retire_surfaces[0].reason === "goal moved off the ready view",
		`retired surfaces' cases are flagged with the reason (got ${JSON.stringify(dec195.retire_surfaces)})`,
	);
	const decNone195 = applySurfaceDecisions(sw195, {}, newSnap195);
	check(
		decNone195.undecided.length === 2 && decNone195.undecided.every((s) => s.flagged),
		"undecided surfaces keep their cases but flagged",
	);
	// The rebind rewrites the case file to the new snapshot id (the explicit
	// keep decision, physical form).
	const rebound195 = rebindE2eSnapshot(files184.get(`e2e/${dec195.keep_surfaces[0].case}.mjs`), newSnap195);
	check(
		rebound195.includes(`// goal snapshot: ${newSnap195}`) && !rebound195.includes(commit184.goal_snapshot),
		"rebindE2eSnapshot rewrites the case file to the new snapshot id",
	);
	const legacyRebind195 = rebindE2eSnapshot("// e2e scaffold for goal surface: \"x\"\nconsole.error(\"x\");\n", newSnap195);
	check(
		legacyRebind195.split("\n")[1] === `// goal snapshot: ${newSnap195}`,
		"rebind binds a headerless legacy case under the first line",
	);

	// (3) The re-interview pre-fills surface_spec from the archived campaign.
	check(
		sw195.archived.surface_spec.includes("cli output shape"),
		`the archived campaign's surface_spec rides the switch result (got ${JSON.stringify(sw195.archived.surface_spec)})`,
	);
	check(
		defaultFor(sw195.fresh, "surface-spec").includes("cli output shape"),
		"the re-interview pre-fills surface_spec from the archive as the default",
	);
	useDefaults(sw195.fresh);
	check(
		sw195.fresh.boxes["surface-spec"].status === "defaulted" && sw195.fresh.boxes["surface-spec"].value.includes("cli output shape"),
		"the defaults escape settles surface-spec with the archived spec (edit, don't rewrite)",
	);
	check(
		goalSurfaceSpec(sw195.fresh).some((s) => s.facet === "cli output shape"),
		"the prefilled spec parses back into declared facets",
	);

	// (2)+(4) Mid-switch (incomplete interview): the fresh goal's gates
	// degrade loud, not silent — the sketch-guard refusal path stays intact.
	const midSw195 = switchGoal(parseGoalToml(readFileSync(join(FIXTURES, "open-goal.toml"), "utf8")), "mid-switch target");
	const midSketch195 = sketch(midSw195.fresh);
	check(
		midSketch195.ok === false && /sketch refused: checklist open/.test(midSketch195.error),
		`mid-switch incomplete interview: sketch-guard refusal stays loud (got ${JSON.stringify(midSketch195)})`,
	);
	const midCommit195 = commit(midSw195.fresh, { approved: true, write: () => {} });
	check(
		midCommit195.ok === false && /checklist open/.test(midCommit195.error),
		`mid-switch commit refuses loud on the open checklist (got ${JSON.stringify(midCommit195)})`,
	);
	// A loaded (unsketched) complete goal still switches with populated
	// surfaces + snapshot id — the sketch is re-derived for the archive.
	const loadedSwitch195 = switchGoal(reparsed195, "v3 from a loaded goal.toml");
	check(
		loadedSwitch195.surfaces.length === 2 && loadedSwitch195.archived.snapshot_id === commit184.goal_snapshot,
		"switch on a goal loaded from goal.toml re-derives surfaces + snapshot id",
	);

	// hub#221: keep/retire-surface decisions applied to case files. The
	// committed campaign (commit184) carries two sketched surfaces; decisions
	// resolve by surface text or case id, record into the ledger, and apply
	// physically (keep = rebind to the live snapshot, retire = marker line).
	const keep221 = recordSurfaceDecision(commit184, {
		target: "bais list shows open issues",
		decision: "keep",
		snapshot: "goal-snapshot-0000000000aa",
	});
	check(
		keep221.case === "bais-list-shows-open-issues" && keep221.decision === "keep" && keep221.snapshot === "goal-snapshot-0000000000aa",
		`keep records the resolved case + live snapshot (got ${JSON.stringify(keep221)})`,
	);
	const keepByCase221 = resolveSurfaceTarget(commit184, "bais-ready-orders-by-severity");
	check(
		keepByCase221.surface === "bais ready orders by severity",
		`targets resolve by case id as well as surface text (got ${JSON.stringify(keepByCase221)})`,
	);
	// After a switch the new campaign may not declare the old surfaces —
	// the case files on disk stay decidable via their headers.
	const switched221 = switchGoal(commit184, "v2 without the old surfaces");
	useDefaults(switched221.fresh);
	const diskFiles221 = [...files184.keys()]
		.filter((p) => p.startsWith("e2e/"))
		.map((p) => ({ case: p.slice(4, -4), ...parseE2eCaseHeader(files184.get(p)) }));
	const oldViaDisk221 = resolveSurfaceTarget(switched221.fresh, "bais-list-shows-open-issues", { files: diskFiles221 });
	check(
		oldViaDisk221.surface === "bais list shows open issues",
		`switched-away surface resolves via the case file on disk (got ${JSON.stringify(oldViaDisk221)})`,
	);
	const rebound221 = rebindE2eSnapshot(files184.get("e2e/bais-list-shows-open-issues.mjs"), "goal-snapshot-0000000000aa");
	check(
		rebound221.includes("// goal snapshot: goal-snapshot-0000000000aa") && !rebound221.includes(commit184.goal_snapshot),
		"recorded keep applies to the case file via rebind to the live snapshot",
	);
	// A second decision for the same surface refuses loud naming it (bi#55).
	let redecided221 = "";
	try {
		recordSurfaceDecision(commit184, { target: "bais-list-shows-open-issues", decision: "retire", reason: "changed mind" });
	} catch (e) {
		redecided221 = String(e && e.message);
	}
	check(
		redecided221.includes("already decided") && redecided221.includes("bais list shows open issues"),
		`already-decided surface decision refuses loud naming the surface (got ${JSON.stringify(redecided221)})`,
	);
	// Unknown targets and reasonless retires refuse loud; the ledger is
	// untouched by refused decisions.
	let unknown221 = "";
	try {
		recordSurfaceDecision(commit184, { target: "no such surface", decision: "keep" });
	} catch (e) {
		unknown221 = String(e && e.message);
	}
	check(unknown221.includes("unknown surface"), `unknown surface target refuses loud (got ${JSON.stringify(unknown221)})`);
	let reasonless221 = "";
	try {
		recordSurfaceDecision(commit184, { target: "bais ready orders by severity", decision: "retire" });
	} catch (e) {
		reasonless221 = String(e && e.message);
	}
	check(reasonless221.includes("--reason"), `reasonless retire refuses loud (got ${JSON.stringify(reasonless221)})`);
	check(surfaceDecisionsOf(commit184).length === 1, "refused decisions leave the ledger untouched");
	// The retire records with its reason and marks the case file; the anchor
	// header survives so the coverage join still resolves the case.
	const retire221 = recordSurfaceDecision(commit184, {
		target: "bais-ready-orders-by-severity",
		decision: "retire",
		reason: "goal moved off the ready view",
	});
	check(
		retire221.decision === "retire" && retire221.reason === "goal moved off the ready view",
		`retire records with its reason (got ${JSON.stringify(retire221)})`,
	);
	const marked221 = markSurfaceRetired(files184.get("e2e/bais-ready-orders-by-severity.mjs"), retire221.reason);
	check(
		marked221.includes("// surface retired: goal moved off the ready view") && marked221.includes("// goal anchor:"),
		"retire marks the case file without touching the anchor header",
	);
	check(
		markSurfaceRetired(marked221, "other reason").split("\n").filter((l) => l.startsWith("// surface retired:")).length === 1,
		"retire marker application is idempotent (replace, never duplicate)",
	);
	// The ledger round-trips through goal.toml; a hand-corrupted ledger
	// fails the file gate naming surface_decisions.
	const back221 = parseGoalToml(renderGoalToml(commit184));
	check(
		JSON.stringify(back221.surface_decisions) === JSON.stringify(surfaceDecisionsOf(commit184)),
		"surface_decisions round-trip through goal.toml",
	);
	const badLedger221 = validateGoal(
		`[goal]\nstatement = "x"\nstyle = "plain"\nhero = "plain"\ndone_criteria = ["a"]\nsurface_decisions = [{ surface = "s", case = "c", decision = "maybe", reason = "", snapshot = "" }]\n`,
		{ knownStyles: ["plain"], knownHeroes: ["plain"] },
	);
	check(
		badLedger221.ok === false && badLedger221.errors.some((e) => e.includes("surface_decisions")),
		`corrupt surface_decisions ledger fails naming the field (errors: ${JSON.stringify(badLedger221.errors)})`,
	);

	process.exit(failures ? 1 : 0);
}

// --- surface spec / taste box (hub#166, scripts lane, append-only) ---
//
// hub#165 captures the testing surface (what to observe). The complement:
// what GOOD looks like. Taste doesn't survive stochastic generation, so
// when a goal has an interface surface — UI design, presentation form,
// parser token spec, API shape, machine-readable format — the interview
// asks the human for the existing spec/design/artifacts instead of letting
// the orchestrator invent taste. The spec constrains generation
// (heroes/styles compose within it) and becomes e2e oracle material (BITS
// compares against the declared spec, not the model's imagination).
//
// Three settle paths, all through answerSurfaceSpec (answer() delegates for
// this box), each `;`-separated `<facet> => <detail>` items:
//   spec provided — e.g. "parser tokens => KEY, STRING per toml.abnf";
//     flows into the sketch oracle via surfaceSpecToBitsCase.
//   explicit taste-waiver — "waiver => <reason>" (reason required, fails
//     loud without one); recorded in the box value, sketch proceeds.
//   pure-no-IO exemption — "pure-no-io => <reason>" ("pure" accepted as an
//     alias, normalized); established explicitly, never assumed — the
//     defaults escape records a waiver, and bare waive() throws loud.
// Sketch stays refused while the box is open via the existing
// checklistComplete() guard (no special case needed).
//
// Load-bearing hunk (hub#166/bi#57 red-check target): the sketch oracle.
// Dropping `oracle` from the sketch proposal must trip the selftest above
// with exactly:
//   "FAIL selftest: sketch oracle covers every declared surface-spec item"
// (verify: remove the oracle line -> that FAIL observed -> restore green).

// Loud settle-time validation for the surface-spec box. Throws naming the
// box on every silent-taste path (empty, malformed, reasonless waiver or
// exemption); the box stays open so sketch keeps refusing.
export function parseSurfaceSpecValue(value) {
	const need = `supply "<facet> => <spec>", an explicit taste-waiver "waiver => <reason>", or a pure exemption "pure-no-io => <reason>"`;
	const raw = String(value ?? "");
	if (raw.trim() === "") {
		throw new Error(`invalid surface-spec: UI goal without a design fails loud — ${need}`);
	}
	const parts = raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (parts.length === 0) {
		throw new Error(`invalid surface-spec: UI goal without a design fails loud — ${need}`);
	}
	return parts.map((part) => {
		const i = part.indexOf("=>");
		if (i < 0) {
			throw new Error(`invalid surface-spec: every item needs "<facet> => <spec>" (got ${JSON.stringify(part)}) — ${need}`);
		}
		const facetRaw = part.slice(0, i).trim().toLowerCase();
		const spec = part.slice(i + 2).trim();
		const facet = facetRaw === "pure" ? "pure-no-io" : facetRaw;
		if (!facet) {
			throw new Error(`invalid surface-spec: item needs a facet before "=>" (got ${JSON.stringify(part)})`);
		}
		if (!spec) {
			if (facet === "waiver") {
				throw new Error(`invalid surface-spec: "waiver" needs a reason ("waiver => <reason>") — reasonless taste-skips fail loud`);
			}
			if (facet === "pure-no-io") {
				throw new Error(
					`invalid surface-spec: "pure-no-io" needs a reason ("pure-no-io => <reason>") — purity is established explicitly, never assumed`,
				);
			}
			throw new Error(`invalid surface-spec: item needs a spec after "=>" (got ${JSON.stringify(part)})`);
		}
		return { facet, spec };
	});
}

// Settle the surface-spec box (status filled) after loud validation.
export function answerSurfaceSpec(goal, value) {
	if (!("surface-spec" in goal.boxes)) throw new Error("unknown checklist box: surface-spec");
	if (goal.boxes["surface-spec"].status !== "open") throw new Error("box already settled: surface-spec");
	parseSurfaceSpecValue(value);
	goal.boxes["surface-spec"] = { status: "filled", value: String(value ?? "") };
	return goal;
}

// Declared surface spec: well-formed `<facet> => <spec>` items only.
// Open/waived boxes and empty values yield [] — malformed items are dropped
// (settle-time validation and the file gate, not this, fail loud).
export function goalSurfaceSpec(goal) {
	const box = goal.boxes["surface-spec"];
	if (!box || box.status === "open" || box.status === "waived") return [];
	const raw = String(box.value ?? "");
	if (raw.trim() === "") return [];
	try {
		return parseSurfaceSpecValue(raw);
	} catch {
		return [];
	}
}

// Which of the three paths the box took: open | spec | waiver | pure.
// Precedence is pure > waiver > spec so a mixed record surfaces the
// strongest exemption claim; the defaults escape always reads waiver.
export function surfaceSpecKind(goal) {
	const box = goal.boxes["surface-spec"];
	if (!box || box.status === "open") return "open";
	const items = goalSurfaceSpec(goal);
	if (items.some((it) => it.facet === "pure-no-io")) return "pure";
	if (items.some((it) => it.facet === "waiver")) return "waiver";
	if (items.length > 0) return "spec";
	return "open";
}

// Forward-compatible BITS oracle half for one surface-spec item (hub#153
// notes the shape, bits#01 owns it — do not define Case/Verdict here).
export function surfaceSpecToBitsCase(item, i) {
	return { case: `spec-${i + 1}`, facet: item.facet, spec: item.spec };
}

// --- verdict-consuming goal progress (hub#199, scripts lane) ---
//
// hub#153 opened the loop (a BAIS issue cites a BITS arm as close
// evidence); this closes it: goal progress joins the committed e2e cases
// (sketch e2e case ids) against graded BITS verdicts and reports
// e2e-cases-green. Verdicts are BITS-graded records ({case_id, outcome}
// — bits/baml_src/main.baml Verdict/GradedCase); the bits-t2 ledger's
// {id, outcome} lowercase shape reads the same. campaign.mjs
// e2eProgress/formatGoalProgress owns the burndown line; this owns the
// goal-side join. Pure — verdicts flow in, never fetched here. An unrun
// case is pending, never silently green. The emitted case shape itself
// ({case, surface, exercise} -> Case.id/surface/exercise, {case, facet,
// spec} -> Oracle.case_id/facet/spec) is pinned by
// bais/scripts/shape-parity.mjs.
export function e2eVerdictProgress(goal, verdicts) {
	const cases = Array.isArray(goal?.sketch?.e2e) ? goal.sketch.e2e : [];
	const byId = new Map();
	for (const v of verdicts ?? []) byId.set(v.case_id ?? v.id, String(v.outcome ?? "").toLowerCase());
	const green = [];
	const red = [];
	const pending = [];
	for (const c of cases) {
		const o = byId.get(c.case);
		if (o === "pass") green.push(c.case);
		else if (o === "fail") red.push(c.case);
		else pending.push(c.case);
	}
	return { total: cases.length, green: green.length, red, pending };
}

// File-level surface-spec item: inline tables need both halves; bare
// strings count as facet-only (no spec half). Mirrors
// parseGoalSurfaceItem.
function parseGoalSurfaceSpecItem(item) {
	const t = String(item).trim();
	if (t === "") return null;
	if (t.startsWith("{")) {
		const fm = t.match(/facet *= *("(?:[^"\\]|\\.)*")/);
		const sm = t.match(/spec *= *("(?:[^"\\]|\\.)*")/);
		let facet = "";
		let spec = "";
		try {
			facet = fm ? JSON.parse(fm[1]) : "";
		} catch {
			return { facet: "", spec: "", malformed: true };
		}
		try {
			spec = sm ? JSON.parse(sm[1]) : "";
		} catch {
			return { facet: "", spec: "", malformed: true };
		}
		return { facet, spec, malformed: false };
	}
	const sm = t.match(/^("(?:[^"\\]|\\.)*")$/);
	if (sm) {
		try {
			return { facet: JSON.parse(sm[1]), spec: "", malformed: false };
		} catch {
			return { facet: "", spec: "", malformed: true };
		}
	}
	return { facet: "", spec: "", malformed: true };
}

// File-level surface-decision item (hub#221): inline tables need a surface
// and a keep|retire decision; anything else is not a decision. Mirrors
// parseGoalSurfaceSpecItem.
function parseSurfaceDecisionItem(item) {
	const t = String(item).trim();
	if (t === "") return null;
	if (!t.startsWith("{")) return null;
	const str = (name) => {
		const m = t.match(new RegExp(`${name} *= *("(?:[^"\\\\]|\\\\.)*")`));
		if (!m) return "";
		try {
			return JSON.parse(m[1]);
		} catch {
			return "";
		}
	};
	const decision = str("decision");
	if (decision !== "keep" && decision !== "retire") return null;
	const surface = str("surface");
	if (surface.trim() === "") return null;
	return { surface, case: str("case"), decision, reason: str("reason"), snapshot: str("snapshot") };
}
