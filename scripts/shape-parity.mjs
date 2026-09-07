// bais/scripts/shape-parity.mjs — hub#199: goal <-> BITS case-shape parity contract.
//
// hub#184's empirical lesson: the goal sketch's "forward-compatible"
// {case, surface, exercise} drifted from the landed BITS Case
// {id, title, tier, token_cap, timeout_ms} BEFORE the first consumer ran —
// unpersisted, unverified shapes rot. This script is the contract that
// makes the next drift fail at authorship, not at consumption. Three
// sides, pinned against each other (mirror-parity.mjs precedent: named
// FAILs, offline, read-only):
//
//   G  goal emitter — bais/scripts/goal.mjs surfaceToBitsCase /
//      surfaceSpecToBitsCase (imported, executed on literals).
//   B  BAML shapes — bits/baml_src/main.baml Case + Oracle class field
//      lists (parsed from source; BAML owns the shapes, `baml test`
//      proves them, no SDK needed for a field-list read).
//   F  fixtures — bits/test-backlog/e2e-cases/*.case.json / *.oracle.json
//      (the single source of truth the T2 arms wrap).
//
// Pinned mappings (growth lands here in the same commit as the shape
// change — an exact-set FAIL is the authorship tripwire, not a bug):
//   goal e2e   {case, surface, exercise} -> Case  {id, surface, exercise}
//   goal oracle {case, facet, spec}      -> Oracle {case_id, facet, spec}
// Runner-extension fixture fields (NOT in Case, justified):
//   scaffold — repo-relative path to the plain-node .bais/e2e/ scaffold
//   expect   — "pass" | "fail:<reason>" the T2 arm asserts (grading pin)
//
// Red-check record (bi#57), observed live 2026-09-07:
//   $ cp bits/test-backlog/e2e-cases/red-scaffold-grades-fail.case.json /tmp/shape199-backup.json
//   $ rename the fixture field `surface` -> `surfce` (sed hand-edit)
//   $ node bais/scripts/shape-parity.mjs
//     => FAIL: fixture red-scaffold-grades-fail.case.json: all fields
//        known (Case fields + runner extensions) — unknown: "surfce"
//     => shape-parity: 1 failure(s) — drift fails loud here, not at consumption
//     => exit 1
//   $ cp /tmp/shape199-backup.json back (cmp-identical), probe green
//     (19 checks, exit 0). A passing contract that cannot go red is
//     camouflage, not coverage.
//
// Run: node bais/scripts/shape-parity.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { surfaceToBitsCase, surfaceSpecToBitsCase } from "./goal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const BITS_MAIN = join(REPO, "bits", "baml_src", "main.baml");
const CASES_DIR = join(REPO, "bits", "test-backlog", "e2e-cases");

const CASE_BASE = ["id", "title", "tier", "token_cap", "timeout_ms"];
const CASE_GOAL = ["surface", "exercise"]; // hub#199 additions to Case
const CASE_FIELDS = [...CASE_BASE, ...CASE_GOAL];
const RUNNER_FIELDS = ["scaffold", "expect"]; // fixture-only, justified above
const ORACLE_FIELDS = ["case_id", "facet", "spec"];

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (arr) => [...arr].sort();

// BAML side: field list of `class <name> { ... }` parsed from source.
// Returns null when the class is gone entirely (its own named FAIL).
function classFields(src, name) {
	const m = new RegExp(`class ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src);
	if (!m) return null;
	return [...m[1].matchAll(/^\s+([a-z_]+):/gm)].map((x) => x[1]);
}

// ---- §B BAML shapes (bits/baml_src/main.baml) ----
const src = readFileSync(BITS_MAIN, "utf8");
const caseFields = classFields(src, "Case");
const oracleFields = classFields(src, "Oracle");
check(caseFields !== null, "BAML Case class present in bits/baml_src/main.baml");
check(oracleFields !== null, "BAML Oracle class present in bits/baml_src/main.baml");
if (caseFields !== null) {
	check(
		eq(sorted(caseFields), sorted(CASE_FIELDS)),
		`Case field set is exactly the pinned contract (got [${caseFields.join(", ")}] — a change lands here in the same commit)`,
	);
}
if (oracleFields !== null) {
	check(
		eq(sorted(oracleFields), sorted(ORACLE_FIELDS)),
		`Oracle field set is exactly {case_id, facet, spec} (got [${(oracleFields ?? []).join(", ")}])`,
	);
}

// ---- §G goal emitter (bais/scripts/goal.mjs) ----
const goalCase = surfaceToBitsCase({ surface: "probe surface", exercise: "probe exercise" }, new Set());
check(
	eq(sorted(Object.keys(goalCase)), ["case", "exercise", "surface"]),
	`goal e2e case emits exactly {case, surface, exercise} (got [${Object.keys(goalCase).join(", ")}])`,
);
for (const [goalKey, caseField] of [["case", "id"], ["surface", "surface"], ["exercise", "exercise"]]) {
	check(
		caseFields !== null && caseFields.includes(caseField),
		`goal e2e key "${goalKey}" has a typed home: Case.${caseField}`,
	);
}
const goalOracle = surfaceSpecToBitsCase({ facet: "probe facet", spec: "probe spec" }, 0);
check(
	eq(sorted(Object.keys(goalOracle)), ["case", "facet", "spec"]),
	`goal oracle emits exactly {case, facet, spec} (got [${Object.keys(goalOracle).join(", ")}])`,
);
for (const [goalKey, oracleField] of [["case", "case_id"], ["facet", "facet"], ["spec", "spec"]]) {
	check(
		oracleFields !== null && oracleFields.includes(oracleField),
		`goal oracle key "${goalKey}" has a typed home: Oracle.${oracleField}`,
	);
}

// ---- §F fixtures (bits/test-backlog/e2e-cases/) ----
check(existsSync(CASES_DIR), `e2e case fixture dir present at ${CASES_DIR}`);
if (existsSync(CASES_DIR)) {
	const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
	check(files.some((f) => f.endsWith(".case.json")), "at least one *.case.json fixture present");
	for (const f of files) {
		let data;
		try {
			data = JSON.parse(readFileSync(join(CASES_DIR, f), "utf8"));
		} catch (e) {
			check(false, `fixture ${f}: unparseable JSON (${e.message})`);
			continue;
		}
		const keys = Object.keys(data);
		if (f.endsWith(".case.json")) {
			const unknown = keys.filter((k) => !CASE_FIELDS.includes(k) && !RUNNER_FIELDS.includes(k));
			check(
				unknown.length === 0,
				`fixture ${f}: all fields known (Case fields + runner extensions)${unknown.length ? ` — unknown: ${unknown.map((k) => `"${k}"`).join(", ")}` : ""}`,
			);
			const missing = CASE_BASE.filter((k) => !keys.includes(k));
			check(
				missing.length === 0,
				`fixture ${f}: required Case fields present${missing.length ? ` — missing: ${missing.map((k) => `"${k}"`).join(", ")}` : ""}`,
			);
		} else if (f.endsWith(".oracle.json")) {
			check(
				eq(sorted(keys), sorted(ORACLE_FIELDS)),
				`fixture ${f}: oracle keys are exactly {case_id, facet, spec} (got [${keys.join(", ")}])`,
			);
		}
	}
}

if (failures) {
	console.error(`shape-parity: ${failures} failure(s) — drift fails loud here, not at consumption`);
	process.exit(1);
}
console.log("shape-parity: all green (goal emitter, BAML Case/Oracle, and fixtures agree)");
