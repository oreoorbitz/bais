// bais/scripts/selfmod-audit.mjs — trace-provenance-law audit conformance
// (hub#218). A Done self-modification-class close (Files: footprint on
// baml_src/*.baml, skill, prompt, memory, tool, src/cli.*) must cite
// executable eval evidence (Evidence: drill()/e2e()); verdict-only
// closes satisfy close-evidence (bi#83) but not this audit. Warn by
// default (advisory, exit untouched), fatal under --selfmod-strict.
//
// Fixture hub lives in /tmp: the audit needs no git siblings (unlike
// the hash-vs-evidence drill). The drill stem resolves fixture-locally
// (<hub>/scripts/*.mjs is the hub's own drill namespace); the e2e stem
// resolves via <hub>/.bais/e2e/. The Doing selfmod issue pins the
// Done-only rule (a proposal is not a close).
//
// Red-check (bi#57) 2026-09-11: SELFMOD_CLASS_RE blinded to /(?!)/
// (matches nothing) → 3 FAIL (verdict-only close goes silent in warn
// text, strict stays green, JSON problems empty); restored
// cmp-identical → all green.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "bais", "dist", "src", "cli.js");
const ENV = { ...process.env, BAML_PROFILE: "0" };

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`ok: ${name}`); }
	else { fail++; console.log(`FAIL: ${name} ${extra}`); }
};
const run = (dir, args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000, env: ENV });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const issue = (id, status, files, evidence, extra = "") => `id = "${id}"\ntitle = "t"\nstatus = "${status}"\nkind = "Feat"\n${extra}body = """\nb\nFiles: ${files}\n${evidence}\n"""\n`;

const d = mkdtempSync(join("/tmp", "selfmod-audit-"));
try {
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	mkdirSync(join(d, ".bais", "e2e"), { recursive: true });
	mkdirSync(join(d, "scripts"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	writeFileSync(join(d, "scripts", "selfmod-drill.mjs"), "// fixture drill stem: existence is resolvability\n");
	writeFileSync(join(d, ".bais", "e2e", "selfmod-recall.mjs"), "// fixture e2e stem\n");
	// t#01: BAML-source close, verdict-only → the audit's target row.
	writeFileSync(join(d, ".bais", "issues", "t#01.toml"), issue("t#01", "Done", "bais/baml_src/main.baml", "Evidence: verdict(t#03)"));
	// t#02: BAML-source close, drill cite → silent.
	writeFileSync(join(d, ".bais", "issues", "t#02.toml"), issue("t#02", "Done", "bais/baml_src/main.baml", "Evidence: drill(selfmod-drill)"));
	// t#03: non-selfmod close, verdict-only → silent (class gate, not evidence gate).
	writeFileSync(join(d, ".bais", "issues", "t#03.toml"), issue("t#03", "Done", "bais/src/graph.ts", "Evidence: verdict(t#02)"));
	// t#04: skill-class close, e2e cite → silent (e2e is executable evidence).
	writeFileSync(join(d, ".bais", "issues", "t#04.toml"), issue("t#04", "Done", "bi/baml_src/ns_skills/foo/SKILL.md", "Evidence: e2e(selfmod-recall)"));
	// t#05: selfmod Doing, no evidence → silent (Done-only rule).
	writeFileSync(
		join(d, ".bais", "issues", "t#05.toml"),
		issue("t#05", "Doing", "bais/baml_src/main.baml", "", 'holder = "t"\nlease = "2027-01-01T00:00:00Z"\n'),
	);

	const r = run(d, ["check"]);
	const selfmodRows = r.out.split("\n").filter((l) => l.startsWith("selfmod\t"));
	check("warn phase stays green", r.code === 0, `code=${r.code}`);
	check("verdict-only selfmod close is loud", selfmodRows.some((l) => l.includes("t#01") && l.includes("selfmod-no-eval-evidence")), JSON.stringify(selfmodRows));
	check("drill-cited close stays silent", !selfmodRows.some((l) => l.includes("t#02")), JSON.stringify(selfmodRows));
	check("non-selfmod verdict-only close stays silent", !selfmodRows.some((l) => l.includes("t#03")), JSON.stringify(selfmodRows));
	check("e2e-cited skill close stays silent", !selfmodRows.some((l) => l.includes("t#04")), JSON.stringify(selfmodRows));
	check("Doing selfmod carries no requirement", !selfmodRows.some((l) => l.includes("t#05")), JSON.stringify(selfmodRows));
	check("warn phase line names rollout state", r.out.includes("selfmod-phase\twarn"), JSON.stringify(r.out.split("\n").filter((l) => l.startsWith("selfmod-phase"))));

	const strict = run(d, ["check", "--selfmod-strict"]);
	check("strict exits 1 on unevidenced selfmod close", strict.code === 1 && strict.out.includes("selfmod\tt#01\tselfmod-no-eval-evidence"), `code=${strict.code}`);
	check("strict stays silent for evidenced closes", !strict.out.split("\n").filter((l) => l.startsWith("selfmod\t")).some((l) => l.includes("t#02") || l.includes("t#03") || l.includes("t#04")), "strict rows");

	const j = run(d, ["check", "--json"]);
	const payload = JSON.parse(j.out);
	check("json carries selfmod phase+problems", j.code === 0 && payload.selfmod?.phase === "warn" && payload.selfmod?.problems?.length === 1 && payload.selfmod.problems[0].id === "t#01", `code=${j.code}`);
} finally {
	rmSync(d, { recursive: true, force: true });
}

if (fail) { console.log(`selfmod-audit: ${fail} FAIL, ${pass} pass`); process.exit(1); }
console.log("selfmod-audit: all green");
