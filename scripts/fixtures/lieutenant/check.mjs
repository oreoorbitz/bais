// bais/scripts/fixtures/lieutenant/check.mjs — goal-mode lieutenant
// protocol checker + fixture runner (bi#145).
//
// Enforces bais/spec/lieutenant.md over line-oriented event logs: a single
// lieutenant per directory, component plan agreed with the operator BEFORE
// any squad forms (plan-agreed gate), one squad per plan component,
// lieutenant-signed integration per component (no orphans), and a
// lieutenant-owned system test covering every component. Campaign-loop
// directives (bi#137 refill/burndown) are unknown records — the loop is a
// later issue, the lieutenant is the role.
//
// Usage (run from bais/):
//   node scripts/fixtures/lieutenant/check.mjs <file.events>  # exit 0 OK, 1 refused/incomplete
//   node scripts/fixtures/lieutenant/check.mjs --all          # all fixtures + checklist, exit 0 iff each behaves
// Pure ESM, zero dependencies: `node` only.
//
// Red-check (bi#57, recorded 2026-09-06 by lieut-145): deleted the
// plan-agreed refusal hunk (`if (!agreed) refuse(...)` in squad-formed),
// then ran --all over the untouched fixtures: squad-before-agreement
// proceeded past line 5 and the run went red with `expected REFUSED
// "before plan-agreed" @ line 5, got INCOMPLETE [plan never agreed]`
// (wrong reason — the gate was gone, only the end-state complaint
// remained); with the hunk restored all 4 fixtures + checklist return to
// their §4 outcomes. A gate that cannot go red on a pre-agreement squad
// is camouflage, not coverage.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const KV_RE = /^([A-Za-z0-9_-]+):\s?(.*)$/;

function parseArgs(argv) {
	const [a, b] = argv;
	if (a === undefined || a === "" || a === "--all") return { file: null, all: true };
	return { file: a, all: false, _extra: b };
}

/**
 * Check one event-log text. Pure: no fs, no clock.
 * @returns {{ verdict: "OK"|"REFUSED"|"INCOMPLETE", line: number|null, errors: string[] }}
 */
export function checkLieutenant(text) {
	const errors = [];
	let refused = null; // { line, message } — first structural violation wins
	const refuse = (line, message) => {
		if (!refused) refused = { line, message };
	};
	const rawLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();

	let dir = null;
	let lieutenant = null;
	let plan = null; // string[] | null
	let agreed = false;
	let sawTest = null; // { owner, covers, result, line }
	const squads = new Map(); // component -> { squad, line }
	const integrated = new Map(); // component -> line

	rawLines.forEach((line, idx) => {
		const n = idx + 1;
		const t = line.trim();
		if (t === "" || t.startsWith("#")) return;
		const m = KV_RE.exec(t);
		if (!m) {
			refuse(n, `malformed record ${JSON.stringify(t)} (expected "kind: rest")`);
			return;
		}
		const [, kind, rest] = m;
		const kv = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((p) => {
			const i = p.indexOf("=");
			return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)];
		}));
		switch (kind) {
			case "dir": {
				if (dir) refuse(n, "second dir record (one goal directory per log)");
				else if (!rest) refuse(n, "empty dir");
				else dir = rest;
				break;
			}
			case "lieutenant": {
				if (lieutenant) refuse(n, `second lieutenant claim ${JSON.stringify(rest)} (single lieutenant per directory)`);
				else if (!rest) refuse(n, "empty lieutenant");
				else lieutenant = rest;
				break;
			}
			case "plan-proposed": {
				if (!dir || !lieutenant) refuse(n, "plan-proposed before dir + lieutenant");
				else if (plan) refuse(n, "plan already proposed (one component plan per goal)");
				else {
					plan = rest.split(",").map((c) => c.trim()).filter(Boolean);
					if (!plan.length) {
						plan = null;
						refuse(n, "empty component list");
					}
				}
				break;
			}
			case "plan-agreed": {
				if (!plan) refuse(n, "plan-agreed with no proposed plan");
				else if (agreed) refuse(n, "plan already agreed");
				else if (kv(rest).by !== "operator") refuse(n, `plan-agreed requires by=operator, got ${JSON.stringify(rest)}`);
				else agreed = true;
				break;
			}
			case "squad-formed": {
				const first = rest.split(/\s+/)[0] ?? "";
				const { component } = kv(rest);
				if (!agreed) refuse(n, `squad formation before plan-agreed (squad ${JSON.stringify(first)})`);
				else if (!component) refuse(n, `squad-formed missing component= (${JSON.stringify(rest)})`);
				else if (!plan.includes(component)) refuse(n, `squad for unknown component ${JSON.stringify(component)} (not in agreed plan)`);
				else if (squads.has(component)) refuse(n, `second squad for component ${JSON.stringify(component)} (one squad per component)`);
				else squads.set(component, { squad: first, line: n });
				break;
			}
			case "depends": {
				const dm = /^(\S+) on (\S+)$/.exec(rest);
				if (!dm) refuse(n, `malformed depends (expected "depends: <comp> on <comp>")`);
				else if (!plan || !plan.includes(dm[1]) || !plan.includes(dm[2])) {
					refuse(n, `depends on unknown component (${JSON.stringify(rest)})`);
				}
				break;
			}
			case "integrated": {
				const first = rest.split(/\s+/)[0] ?? "";
				const { by, ref } = kv(rest);
				if (!squads.has(first)) refuse(n, `integration for component ${JSON.stringify(first)} with no squad`);
				else if (by !== lieutenant) refuse(n, `integration for ${JSON.stringify(first)} not signed by the lieutenant (by=${JSON.stringify(by)})`);
				else if (!ref) refuse(n, `integration for ${JSON.stringify(first)} missing ref= evidence`);
				else if (integrated.has(first)) refuse(n, `component ${JSON.stringify(first)} already integrated`);
				else integrated.set(first, n);
				break;
			}
			case "system-test": {
				if (sawTest) refuse(n, "second system-test record (one owned test per goal)");
				else {
					const { owner, covers, result } = kv(rest);
					sawTest = { owner, covers: (covers ?? "").split(",").map((c) => c.trim()).filter(Boolean), result, line: n };
				}
				break;
			}
			default:
				// bi#137 campaign-loop directives land here too: the loop is out of scope.
				refuse(n, `unknown record kind ${JSON.stringify(kind)} (no loop directives: bi#137 is out of scope)`);
		}
	});

	if (refused) return { verdict: "REFUSED", line: refused.line, errors: [`${refused.message}`] };
	if (!plan || !agreed) errors.push("plan never agreed");
	for (const c of plan ?? []) {
		if (!squads.has(c)) errors.push(`component ${JSON.stringify(c)} has no squad`);
		else if (!integrated.has(c)) errors.push(`component ${JSON.stringify(c)} never integrated (orphan output)`);
	}
	if (!sawTest) errors.push("no lieutenant-owned system test");
	else {
		if (sawTest.owner !== lieutenant) errors.push(`system test not owned by the lieutenant (owner=${JSON.stringify(sawTest.owner)})`);
		for (const c of plan ?? []) {
			if (!sawTest.covers.includes(c)) errors.push(`system test does not cover ${JSON.stringify(c)}`);
		}
		if (sawTest.result !== "pass") errors.push(`system test result is ${JSON.stringify(sawTest.result)} (expected "pass")`);
	}
	if (errors.length) return { verdict: "INCOMPLETE", line: null, errors };
	return { verdict: "OK", line: null, errors: [] };
}

function checkFile(path) {
	return checkLieutenant(readFileSync(path, "utf8"));
}

/** Validate the filled ownership checklist against the OK fixture's plan. */
function checkChecklist(okPlan, okLieutenant) {
	const p = join(HERE, "system-test-checklist.md");
	const text = readFileSync(p, "utf8");
	const errs = [];
	if (/^-\s\[\s\]/m.test(text)) errs.push("unchecked box");
	const owner = /^owner:\s*(\S+)/m.exec(text)?.[1];
	const covers = /^covers:\s*(.+)$/m.exec(text)?.[1]?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
	if (owner !== okLieutenant) errs.push(`owner ${JSON.stringify(owner)} != lieutenant ${JSON.stringify(okLieutenant)}`);
	for (const c of okPlan) {
		if (!covers.includes(c)) errs.push(`covers missing ${JSON.stringify(c)}`);
	}
	return { file: "system-test-checklist.md", errs };
}

function planOfOkFixture() {
	const text = readFileSync(join(HERE, "plan-agreed-ok.events"), "utf8");
	const plan = /^plan-proposed:\s*(.+)$/m.exec(text)?.[1]?.split(",").map((c) => c.trim()) ?? [];
	const lieut = /^lieutenant:\s*(\S+)/m.exec(text)?.[1];
	return { plan, lieut };
}

const EXPECT = [
	{ file: "plan-agreed-ok.events", verdict: "OK" },
	{ file: "squad-before-agreement.events", verdict: "REFUSED", line: 5, match: "before plan-agreed" },
	{ file: "orphan-output.events", verdict: "INCOMPLETE", match: "orphan" },
	{ file: "unowned-system-test.events", verdict: "INCOMPLETE", match: "not owned" },
];

function runAll() {
	let pass = 0;
	for (const e of EXPECT) {
		const r = checkFile(join(HERE, e.file));
		const okVerdict = r.verdict === e.verdict;
		const okLine = e.line === undefined || r.line === e.line;
		const okMatch = e.match === undefined || r.errors.some((x) => x.includes(e.match));
		if (okVerdict && okLine && okMatch) {
			console.log(`PASS\t${e.file}\t${r.verdict}`);
			pass++;
		} else {
			console.log(`FAIL\t${e.file}\texpected ${e.verdict}${e.line ? ` @ line ${e.line}` : ""} ${e.match ? JSON.stringify(e.match) : ""}, got ${r.verdict}${r.line ? ` @ line ${r.line}` : ""} [${r.errors.join("; ")}]`);
		}
	}
	const { plan, lieut } = planOfOkFixture();
	const cl = checkChecklist(plan, lieut);
	if (!cl.errs.length) {
		console.log(`PASS\t${cl.file}\towner + covers match, all boxes ticked`);
		pass++;
	} else {
		console.log(`FAIL\t${cl.file}\t[${cl.errs.join("; ")}]`);
	}
	const total = EXPECT.length + 1;
	console.log(`${pass}/${total} lieutenant fixtures behave as specified`);
	return pass === total ? 0 : 1;
}

const { file, all } = parseArgs(process.argv.slice(2));
if (all) {
	process.exit(runAll());
} else {
	const r = checkFile(file);
	if (r.verdict === "OK") console.log(`LIEUTENANT OK\t${file}`);
	else {
		console.log(`LIEUTENANT ${r.verdict}\t${file}`);
		for (const e of r.errors) console.log(`error\t${r.line ?? "-"}\t${e}`);
	}
	process.exit(r.verdict === "OK" ? 0 : 1);
}
