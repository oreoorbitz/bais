// bi#134 selftest — styles pack + per-node overrides (scripts lane).
//
// Run: node bais/scripts/fixtures/styles/selftest.mjs
// Acceptance it guards:
//   1. .bais/styles/ holds 4-6 versioned packs, each a named bundle of
//      constraints + defaults + anti-patterns + decomposition bias +
//      hero_prompt (the Style contract).
//   2. The SAME goal sketches DIFFERENT graphs under two styles
//      (data-oriented-game: few large systems; corporate-oop: many small
//      classes), each inside its pack's [min_nodes, max_nodes].
//   3. A per-issue `style:` override parses via readIssue and renders
//      into the spawn brief via renderBrief (hero governs workflow,
//      override governs taste).
//
// Load-bearing hunk (bi#134/bi#57 red-check target): the Style lines in
// renderBrief (bais/scripts/briefs.mjs). Reverting renderBrief to drop
// them must trip this selftest with exactly:
//   "FAIL selftest: override renders into the brief"
// (verified 2026-09-06: Style pushes removed -> that FAIL observed ->
// restored green).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderBrief, readIssue } from "../../briefs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, "..", "..", "..", "..", ".bais", "styles");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL selftest: ${msg}`);
	} else console.log(`ok selftest: ${msg}`);
};

// Minimal TOML readers (scalar string, string list, section table — the
// subset the packs use; the BAML validator owns real parsing).
const strField = (text, name) => {
	const m = String(text).match(new RegExp(`^${name} *= *"((?:[^"\\\\]|\\\\.)*)"`, "m"));
	return m ? JSON.parse(`"${m[1]}"`) : "";
};
const listField = (text, name) => {
	const m = String(text).match(new RegExp(`^${name} *= *\\[([\\s\\S]*?)\\]`, "m"));
	if (!m) return [];
	const out = [];
	const re = /"(?:[^"\\]|\\.)*"/g;
	let mm;
	while ((mm = re.exec(m[1])) !== null) out.push(JSON.parse(mm[0]));
	return out;
};
const intField = (text, name) => {
	const m = String(text).match(new RegExp(`^${name} *= *(\\d+)`, "m"));
	return m ? Number(m[1]) : NaN;
};

// 1. Pack directory: 4-6 versioned packs, full Style contract each.
const packs = readdirSync(STYLES).filter((f) => f.endsWith(".toml")).sort();
check(packs.length >= 4 && packs.length <= 6, `styles/ seeds 4-6 packs (found ${packs.length}: ${packs.join(", ")})`);
const byName = {};
for (const f of packs) {
	const text = readFileSync(join(STYLES, f), "utf8");
	const name = strField(text, "name");
	const version = strField(text, "version");
	check(name === f.replace(/\.toml$/, ""), `${f} name matches filename (${JSON.stringify(name)})`);
	check(/^\d+\.\d+\.\d+$/.test(version), `${name} versioned semver (${JSON.stringify(version)})`);
	check(listField(text, "constraints").length > 0, `${name} carries constraints`);
	check(listField(text, "defaults").length > 0, `${name} carries defaults`);
	check(listField(text, "anti_patterns").length > 0, `${name} carries anti-patterns`);
	check(strField(text, "bias").length > 0, `${name} carries decomposition bias`);
	check(strField(text, "hero_prompt").length > 0, `${name} carries hero_prompt`);
	const lo = intField(text, "min_nodes");
	const hi = intField(text, "max_nodes");
	check(Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi, `${name} node budget sane [${lo}, ${hi}]`);
	byName[name] = { lo, hi };
}
for (const need of ["data-oriented-game", "corporate-oop"]) {
	check(need in byName, `seed pack present: ${need}`);
}

// 2. Same goal, different graphs under two styles.
const goalText = readFileSync(join(HERE, "goal.toml"), "utf8");
const goalStmt = strField(goalText, "statement");
check(goalStmt.length > 0, "fixture goal carries a statement");
const game = JSON.parse(readFileSync(join(HERE, "sketch-data-oriented-game.json"), "utf8"));
const oop = JSON.parse(readFileSync(join(HERE, "sketch-corporate-oop.json"), "utf8"));
check(game.goal === goalStmt && oop.goal === goalStmt, "both sketches answer the SAME goal");
check(game.style === "data-oriented-game" && oop.style === "corporate-oop", "sketches name their styles");
const g = byName["data-oriented-game"];
const o = byName["corporate-oop"];
check(game.nodes.length >= g.lo && game.nodes.length <= g.hi, `game sketch inside pack budget (${game.nodes.length} in [${g.lo}, ${g.hi}])`);
check(oop.nodes.length >= o.lo && oop.nodes.length <= o.hi, `oop sketch inside pack budget (${oop.nodes.length} in [${o.lo}, ${o.hi}])`);
check(game.nodes.length < oop.nodes.length, `style constrains the sketch (${game.nodes.length} game nodes vs ${oop.nodes.length} oop nodes)`);
for (const [label, s] of [["game", game], ["oop", oop]]) {
	const ids = new Set(s.nodes.map((n) => n.id));
	check(s.nodes.every((n) => n.id && n.title), `${label} nodes carry id + title`);
	check(s.edges.every((e) => ids.has(e.from) && ids.has(e.to)), `${label} edges resolve to nodes`);
}

// 3. Per-node override: parses and renders into the brief.
const d = mkdtempSync(join(tmpdir(), "probe-styles-"));
mkdirSync(join(d, ".bais", "issues"), { recursive: true });
writeFileSync(join(d, ".bais", "config.toml"), 'project = "s"\n');
copyFileSync(join(HERE, "override-issue.toml"), join(d, ".bais", "issues", "s#01.toml"));
const issue = readIssue(d, "s#01");
check(issue.style === "corporate-oop", `override parses from issue style field (${JSON.stringify(issue.style)})`);
const brief = renderBrief({ slot: 0, ...issue, files: ["session.ts"], files_state: "declared", open_downstream: 0, dir: d });
check(brief.includes("Style override: corporate-oop") && brief.includes(".bais/styles/corporate-oop.toml"), "override renders into the brief");
check(brief.includes("hero governs workflow"), "brief names the hero/override split");
const plain = renderBrief({ slot: 0, id: "s#02", title: "plain work", body: 'Acceptance: done.', files: [], files_state: "unknown", dir: d });
check(plain.includes("inherits goal style (no per-node override"), "brief without override inherits goal style");

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("styles: all green");
