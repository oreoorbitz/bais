// bais/scripts/reviewer.mjs — bi#59: fresh-context reviewer role for load-bearing merges.
//
// The merger is blind to its own residue after a merge session, so every
// load-bearing merge gets a fresh-context reviewer: an agent with no stake
// in the implementation, dispatched from a clean worktree, told to
// red-check one named hunk empirically. Self-review is not review, and
// merger-review is barely review.
//
// This file is the role PROCEDURE (the WHO). The WHAT it drives is
// batch-receive review (pack-review.mjs — read-only consumption of the
// dispatch pack JSON shape, never code sharing beyond the import below).
// Its OUTPUTS feed two consumers:
//   - hero replacement (bi#135 applyVerdicts consumes
//     {hero:{decision,evidence}} — toVerdictFeed() emits exactly that
//     shape: decision "keep"|"replace" plus the evidence string; only
//     "replace" acts, "keep" passes through);
//   - audit input (bi#142 setTrail consumes [{requirement, evidence}] —
//     toAuditTrail() emits exactly that shape, one link per member plus
//     the suite plus the revert-hunk red-check).
//
// Grounding (ground-first skill: observation precedes inference):
// - Consumes dispatch packs read-only via pack-review.mjs reviewPack —
//   the live `dispatch --agents N --json` contract (observed 2026-09-06).
//   This file never writes to the issues dir and never imports
//   dispatch.mjs/briefs.mjs, hero.mjs (except the selftest's end-to-end
//   proof), roster.mjs, or bais/src.
// - Fresh context is procedural, not programmatic: renderReviewerBrief()
//   binds the dispatched agent to a clean worktree, names the
//   load-bearing questions, mandates the revert-hunk red-check per bi#57
//   and the /tmp-confirmed handoff per bi#56. The script enforces the
//   checkable part: an approval with no recorded red-check is not a
//   review, so it comes out "replace" naming exactly that gap.
//
// Review rules (deterministic, no LLM):
// - PASS pack + recorded revert-hunk red-check -> "keep", evidence names
//   every member, the suite, and the red-check observation.
// - Anything else -> "replace", evidence names the flaw (each red member
//   id + reason, or the missing red-check).
//
// Red-check 2026-09-06 (bi#57): with the keep/replace mapping neutered to
// always-"keep", the selftest went red FOR THE RIGHT REASON —
// `FAIL: reject pack replaces (keep)` plus `FAIL: verdict feeds hero
// replacement end to end (general -> general ...)` (the red pack was kept,
// so no hero was replaced); restored, green. Re-record on any hunk change.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPack as reviewBatch } from "./pack-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const REVIEWER_DECISIONS = ["keep", "replace"];

// Load-bearing hunk (bi#59/bi#57 red-check target): the keep/replace
// mapping. A green pack with a recorded red-check keeps; everything else
// replaces. Neutering this to always-"keep" must trip §2 with "reject
// names the flaw (r#12) with evidence".
export function decide(batchVerdict, redcheckOk) {
	return batchVerdict === "PASS" && redcheckOk ? "keep" : "replace";
}

export function redcheckOf(pack, redcheck = null) {
	const rc = redcheck ?? pack?.redcheck ?? null;
	const hunk = String(rc?.hunk ?? "").trim();
	const observed = String(rc?.observed ?? "").trim();
	return hunk !== "" && observed !== "" ? { hunk, observed } : null;
}

// Fresh-context review of one pack/handoff under one hero. Returns the
// review; toVerdictFeed()/toAuditTrail() project it onto consumers.
export function reviewPack(pack, { heroName = "", redcheck = null } = {}) {
	const hero = String(heroName || pack?.hero || "").trim() || "(missing hero)";
	const batch = reviewBatch(pack);
	const rc = redcheckOf(pack, redcheck);
	const findings = [...batch.reasons];
	if (!rc) findings.push("no revert-hunk red-check recorded (bi#57) — unverified green is camouflage, not coverage");
	const decision = decide(batch.verdict, rc !== null);
	const members = `[${batch.members.join(" ")}]`;
	const evidence =
		decision === "keep"
			? `reviewer bi#59: hero ${hero} pack ${batch.pack} green — ${batch.members.length} members ${members} each with diff under review, whole-pack suite pass; red-check reverted ${rc?.hunk} -> ${rc?.observed}`
			: `reviewer bi#59: hero ${hero} pack ${batch.pack} red — ${findings.join("; ")}; members ${members}`;
	return {
		ref: `review-${batch.pack}`,
		hero,
		pack: batch.pack,
		decision,
		evidence,
		findings,
		members: batch.members,
		failed: batch.failed,
		redcheck: rc,
		handoff: `/tmp/rev59-deliver/${batch.pack}.report.md`,
	};
}

// Hero-consumable verdict feed (bi#135 applyVerdicts shape verbatim):
// hero name -> { decision, evidence }. "replace" re-selects with evidence
// in heroReason; "keep" passes through untouched.
export function toVerdictFeed(review) {
	return { [review.hero]: { decision: review.decision, evidence: review.evidence } };
}

// Audit input (bi#142 setTrail shape verbatim): one
// requirement-to-evidence link per member, plus the suite, plus the
// revert-hunk red-check — the trail the audit gate walks.
export function toAuditTrail(review) {
	const links = review.members.map((id) => {
		const red = review.failed.includes(id);
		const reason = review.findings.find((f) => f.includes(id)) ?? (red ? "red (see findings)" : "");
		return {
			requirement: `pack ${review.pack} member ${id} carries a diff under review and passes its item check`,
			evidence: red ? `RED — ${reason}` : `ok — diff present, item pass`,
		};
	});
	links.push({
		requirement: `pack ${review.pack} whole-pack suite passes`,
		evidence: review.findings.some((f) => f.includes("suite")) ? "RED — suite red" : "ok — suite pass",
	});
	links.push({
		requirement: `pack ${review.pack} revert-hunk red-check recorded (bi#57)`,
		evidence: review.redcheck ? `reverted ${review.redcheck.hunk} -> ${review.redcheck.observed}` : "RED — no red-check recorded",
	});
	return links.map(({ requirement, evidence }) => ({ requirement, evidence }));
}

// Report format (bi#56: the report lands at the /tmp-confirmed handoff
// path before the verdict counts).
export function formatReport(review) {
	const L = [];
	L.push(`reviewer report ${review.ref}: ${review.decision.toUpperCase()} hero ${review.hero} pack ${review.pack}`);
	L.push(`members: [${review.members.join(" ")}]${review.failed.length ? ` red: ${review.failed.join(", ")}` : ""}`);
	for (const f of review.findings) L.push(`  finding: ${f}`);
	L.push(
		review.redcheck
			? `  red-check: reverted ${review.redcheck.hunk} -> ${review.redcheck.observed}`
			: `  red-check: MISSING (bi#57)`,
	);
	L.push(`evidence: ${review.evidence}`);
	L.push(`handoff: ${review.handoff}`);
	return L.join("\n");
}

// Reviewer brief template: binds the dispatched agent to fresh context —
// clean worktree, named load-bearing questions, the revert-hunk red-check,
// this report format, and the /tmp-confirmed handoff.
export function renderReviewerBrief({ pack = "", heroName = "", questions = [], handoffDir = "/tmp/rev59-deliver" } = {}) {
	const L = [];
	L.push(`reviewer brief (bi#59 fresh-context reviewer — you have no stake in this implementation):`);
	L.push(`- worktree: dispatch from a CLEAN worktree; never reuse the merger's checkout (its residue is what you are hunting).`);
	L.push(`- target: review pack ${pack || "<pack>"} under hero ${heroName || "<hero>"} as ONE unit (whole-pack diff + whole-pack suite).`);
	L.push(`- load-bearing questions (answer EACH with file:line evidence):`);
	for (const q of questions.length ? questions : ["<one named hunk per load-bearing claim>"]) L.push(`  - ${q}`);
	L.push(`- red-check (bi#57, mandatory): revert ONE load-bearing hunk, observe the suite fail FOR THE RIGHT REASON, restore, re-run green; record hunk + expected reason + observed output.`);
	L.push(`- report format: ref, hero, decision (keep|replace), evidence, per-member findings, red-check note, handoff path (see formatReport).`);
	L.push(`- handoff (bi#56, mandatory): copy the report to ${handoffDir}/ BEFORE finishing; cmp-confirm; quote the path. No handoff, no verdict.`);
	return L.join("\n");
}

export function reviewFile(path, opts = {}) {
	const raw = readFileSync(resolve(path), "utf8");
	return reviewPack(JSON.parse(raw), opts);
}

const optValue = (argv, name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest") || argv.length === 0) {
		const { applyVerdicts, loadHeroes } = await import("./hero.mjs");
		let failures = 0;
		const check = (cond, msg) => {
			if (!cond) {
				failures++;
				console.error(`FAIL: ${msg}`);
			} else console.log(`ok: ${msg}`);
		};
		const fix = (n) => join(HERE, "fixtures", "reviewer", n);
		const heroes = loadHeroes();
		const general = heroes.find((h) => h.name === "general");
		// 1. Approve: green pack + recorded red-check keeps, with evidence.
		const keep = reviewFile(fix("approve-pack.json"));
		check(keep.decision === "keep", `approve pack keeps (${keep.decision})`);
		check(keep.evidence.includes("r#01") && keep.evidence.includes("r#02"), `approval evidence names every member`);
		check(keep.evidence.includes("suite pass") && !!keep.redcheck, `approval evidence carries suite + red-check`);
		check(keep.handoff === "/tmp/rev59-deliver/r-approve.report.md", `report carries the /tmp-confirmed handoff path (${keep.handoff})`);
		// 2. Reject: red pack replaces, evidence names the flaw — and the
		// verdict feeds hero replacement end to end (general -> game).
		const rep = reviewFile(fix("reject-pack.json"));
		check(rep.decision === "replace", `reject pack replaces (${rep.decision})`);
		check(rep.evidence.includes("r#12"), `reject names the flaw (r#12) with evidence`);
		check(JSON.stringify(rep.failed) === '["r#12"]', `failed names the red member (${JSON.stringify(rep.failed)})`);
		const kept = applyVerdicts(general, heroes, toVerdictFeed(keep));
		check(kept.hero.name === "general" && kept.replaced === null, `keep verdict leaves the hero in place`);
		const moved = applyVerdicts(general, heroes, toVerdictFeed(rep));
		check(
			moved.hero.name === "game" && moved.replaced.from === "general" && moved.replaced.evidence.includes("r#12"),
			`verdict feeds hero replacement end to end (general -> ${moved.hero.name} with r#12 evidence)`,
		);
		// 3. Audit input: trail names each requirement-to-evidence link.
		const trail = toAuditTrail(rep);
		check(
			trail.length === rep.members.length + 2 && trail.every((l) => l.requirement && l.evidence),
			`audit trail links every member + suite + red-check (${trail.length} links)`,
		);
		check(trail.some((l) => l.evidence.includes("r#12")), `audit trail carries the flaw evidence`);
		// 4. Brief template binds fresh context: clean worktree, named
		// questions, red-check, report format, /tmp handoff.
		const brief = renderReviewerBrief({ pack: "r-approve", heroName: "general", questions: ["does the diff touch only owned files?"] });
		for (const s of ["CLEAN worktree", "does the diff touch only owned files?", "red-check (bi#57", "report format", "handoff (bi#56"]) {
			check(brief.includes(s), `brief binds fresh context (${s})`);
		}
		// 5. Refusals: malformed/empty packs never come out keep.
		let refused = 0;
		try {
			reviewFile(fix("no-such-pack.json"));
		} catch {
			refused++;
		}
		const bare = reviewPack({ pack: "r-bare", suite: "pass", hero: "general", slots: [] });
		const nocheck = reviewPack({ pack: "r-nocheck", suite: "pass", hero: "general", slots: [{ id: "r#21", item: "pass", diff: "diff --git ok" }] });
		check(refused === 1, `missing pack file refused`);
		check(bare.decision === "replace", `memberless pack replaces, never silent-keep`);
		check(nocheck.decision === "replace" && nocheck.evidence.includes("no revert-hunk red-check"), `approval without red-check replaces naming the gap`);
		if (failures) {
			console.error(`${failures} failure(s)`);
			process.exit(1);
		}
		console.log("reviewer: all green");
	} else {
		const file = optValue(argv, "--pack");
		const heroName = optValue(argv, "--hero") ?? "";
		if (!file) {
			console.error("reviewer needs --pack <pack.json> [--hero <name>] [--json]");
			process.exit(2);
		}
		let r;
		try {
			r = reviewFile(file, { heroName });
		} catch (e) {
			console.error(`reviewer refused: ${e.message}`);
			process.exit(2);
		}
		if (argv.includes("--json")) console.log(JSON.stringify({ ...r, feed: toVerdictFeed(r), trail: toAuditTrail(r) }, null, 2));
		else console.log(formatReport(r));
		process.exit(r.decision === "keep" ? 0 : 1);
	}
}
