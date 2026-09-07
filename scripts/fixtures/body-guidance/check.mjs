// bais/scripts/fixtures/body-guidance/check.mjs — P-B-V body reviewer
// checklist (bi#146), runnable edition of bais/spec/body-guidance.md §3.
//
// Scores one body file per run against the five one-pass boxes:
// [problem] [behavior] [nongoals] [verification] [no-works-correctly].
// Reviewer aid, NOT a gate — bi#146 is guidance-first, so --all expects
// the before-fixtures to FAIL (naming boxes) and the afters to pass.
//
// Usage (run from bais/):
//   node scripts/fixtures/body-guidance/check.mjs <file.md>  # exit 0 OK, 1 FAIL
//   node scripts/fixtures/body-guidance/check.mjs --all      # fixtures, exit 0 iff each behaves
// Pure ESM, zero dependencies: `node` only.
//
// Red-check (bi#57 adapted, recorded 2026-09-06 by pbv-146):
// bi12-before.md is the standing failure demonstrator — verbatim live
// bi#12 body, no `##` sections, must FAIL naming [problem] [behavior]
// [nongoals] [verification]. If a checker edit ever turns it green
// without touching the fixture, the checker regressed: restore before
// landing. A checklist that cannot fail is camouflage, not coverage.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const BOXES = ["problem", "behavior", "nongoals", "verification", "no-works-correctly"];
const BANNED = [/works correctly/i, /works as expected/i, /behaves properly/i, /functions correctly/i];
const PROBE = /`[^`]*\b(baml|node|bi|bais|rg|npm)\b[^`]*`|probe/i;

function section(text, name) {
	const m = new RegExp(`^##\\s+${name}\\s*$`, "im").exec(text);
	if (!m) return "";
	const rest = text.slice(m.index + m[0].length);
	const next = /^##\s+\S/m.exec(rest);
	return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * Score one body text. Pure: no fs, no clock.
 * @returns {{ verdict: "OK"|"FAIL", failed: string[], notes: string[] }}
 */
export function checkBody(text) {
	const failed = [];
	const notes = [];
	const problem = section(text, "Problem");
	const behavior = section(text, "Behavior");
	const verification = section(text, "Verification");
	if (!problem) { failed.push("problem"); notes.push("[problem] no non-empty ## Problem section"); }
	if (!behavior) { failed.push("behavior"); notes.push("[behavior] no non-empty ## Behavior section"); }
	const nongoals = section(text, "Non-goals");
	const inlineNongoal = /do not pin|out of scope|not in scope/i.test(text);
	if (!nongoals && !inlineNongoal) {
		failed.push("nongoals");
		notes.push("[nongoals] no ## Non-goals section and no 'do not pin' / 'out of scope' line");
	} else if (/^none\s*\.?\s*$/i.test(nongoals)) {
		// A bare "None" with no reason fails; "None adjacent — <why>" passes.
		failed.push("nongoals");
		notes.push("[nongoals] bare 'none' without a reason");
	}
	if (!verification) {
		failed.push("verification");
		notes.push("[verification] no non-empty ## Verification section");
	} else if (!PROBE.test(verification)) {
		failed.push("verification");
		notes.push("[verification] names no command or probe (backticked baml|node|bi|bais|rg|npm command, or 'probe')");
	}
	const banned = BANNED.find((re) => re.test(text));
	if (banned) {
		failed.push("no-works-correctly");
		notes.push(`[no-works-correctly] banned phrase ${banned} — name the command or probe instead`);
	}
	return { verdict: failed.length ? "FAIL" : "OK", failed, notes };
}

function checkFile(path) {
	return checkBody(readFileSync(path, "utf8"));
}

const EXPECT = [
	{ file: "bi10-before.md", verdict: "FAIL", boxes: ["problem", "behavior", "nongoals", "verification"] },
	{ file: "bi10-after.md", verdict: "OK" },
	{ file: "bi11-before.md", verdict: "FAIL", boxes: ["problem", "behavior", "nongoals", "verification"] },
	{ file: "bi11-after.md", verdict: "OK" },
	{ file: "bi12-before.md", verdict: "FAIL", boxes: ["problem", "behavior", "nongoals", "verification"] },
	{ file: "bi12-after.md", verdict: "OK" },
];

function runAll() {
	let pass = 0;
	for (const e of EXPECT) {
		const r = checkFile(join(HERE, e.file));
		const okVerdict = r.verdict === e.verdict;
		const okBoxes = e.boxes === undefined || e.boxes.every((b) => r.failed.includes(b));
		if (okVerdict && okBoxes) {
			console.log(`PASS\t${e.file}\t${r.verdict}${r.failed.length ? ` [${r.failed.join(" ")}]` : ""}`);
			pass++;
		} else {
			console.log(`FAIL\t${e.file}\texpected ${e.verdict}${e.boxes ? ` [${e.boxes.join(" ")}]` : ""}, got ${r.verdict} [${r.failed.join(" ")}] (${r.notes.join("; ")})`);
		}
	}
	console.log(`${pass}/${EXPECT.length} body-guidance fixtures behave as specified`);
	return pass === EXPECT.length ? 0 : 1;
}

const arg = process.argv[2];
if (arg === undefined || arg === "" || arg === "--all") {
	process.exit(runAll());
} else {
	const r = checkFile(join(HERE, arg));
	if (r.verdict === "OK") console.log(`BODY OK\t${arg}`);
	else {
		console.log(`BODY FAIL\t${arg}\t[${r.failed.join(" ")}]`);
		for (const n of r.notes) console.log(`note\t${n}`);
	}
	process.exit(r.verdict === "OK" ? 0 : 1);
}
