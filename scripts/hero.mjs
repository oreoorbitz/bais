// bais/scripts/hero.mjs — bi#135: hero selection + prompt packs (scripts lane).
//
// Hero = prompt pack (role, explore->dispatch->merge workflow, tool
// policy, style enforcement, stop conditions) selected from goal+style
// and injected into `bi run` on swarm-class requests. Builds on bi#61
// (playbook) and bi#128 (swarm injection) with a selection rule on top:
// one goal -> one hero; subagent briefs inherit hero constraints
// (taste/permission inheritance, kimi-style).
//
// Hero packs live in bi/heroes/*.toml (versioned, git-tracked — owned by
// the bi agent lane, unlike hub-local taste data in .bais/styles/).
// Goal shape: .bais/goal.toml + bais/spec/goal.md (top-level statement,
// style, hero fields). Style packs contribute their hero_prompt fragment
// (style enforcement); the hero governs workflow, the style governs taste.
//
// Selection rule (first hit wins — one goal -> exactly one hero):
//   1. goal.hero names a known hero (case-insensitive exact name) -> hero-field
//   2. goal.style matches a hero's styles list (exact) -> style-match
//   3. goal statement contains a hero keyword (case-insensitive, first
//      sorted hero wins) -> keyword-match
//   4. the pack with default = true -> default
//
// SRC-LANE WIRING (not this file — needs bi/src/cli.ts, outside this
// lane's footprint; follow the briefs.mjs precedent): in `bi run`, when
// isSwarmRequest(request) is true, call buildHeroPrompt() and prepend its
// text to the prompt context alongside the bi#61 playbook; when false,
// inject nothing (regular requests stay normal, bi#128 exit-reminder
// analog). In the dispatch --briefs path, append heroBriefSection(hero)
// per slot so briefs carry the hero's constraints. Until then:
//   node bais/scripts/hero.mjs --selftest
// against bais/scripts/fixtures/hero/.
//
// Reviewer verdicts (bi#59) are the replacement signal for bad heroes —
// noted as interface only, not implemented here: a future verdict feed
// maps hero name -> dispatch evidence; this lane defines no verdict
// logic and no hero packs change shape for it.
//
// Load-bearing hunk (bi#135/bi#57 red-check target): the style-match
// branch in selectHero. Reverting selectHero to skip it must trip the
// selftest with exactly:
//   "FAIL selftest: game+data-oriented selects the game hero"
// (verified 2026-09-06: branch removed -> that FAIL observed -> restored green).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
export const HEROES_DIR = join(ROOT, "bi", "heroes");
export const STYLES_DIR = join(ROOT, ".bais", "styles");

// Minimal TOML-subset readers (top-level scalar string, string list,
// bool, plus [hero] name/version/description — the subset the packs use;
// the BAML validator owns real parsing; this never validates).
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
const boolField = (text, name) => String(text).match(new RegExp(`^${name} *= *true`, "m")) !== null;

export function parseHeroToml(text) {
	return {
		name: strField(text, "name"),
		version: strField(text, "version"),
		description: strField(text, "description"),
		styles: listField(text, "styles"),
		keywords: listField(text, "keywords"),
		isDefault: boolField(text, "default"),
		role: strField(text, "role"),
		workflow: listField(text, "workflow"),
		tool_policy: listField(text, "tool_policy"),
		stop_conditions: listField(text, "stop_conditions"),
		brief_constraints: listField(text, "brief_constraints"),
	};
}

export function loadHeroes(dir = HEROES_DIR) {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".toml"))
		.sort()
		.map((f) => parseHeroToml(readFileSync(join(dir, f), "utf8")))
		.filter((h) => h.name !== "");
}

// Goal reader: top-level statement/style/hero (the real .bais/goal.toml
// shape — flat keys, not a [goal] table).
export function parseGoalToml(text) {
	return { statement: strField(text, "statement"), style: strField(text, "style"), hero: strField(text, "hero") };
}

export function selectHero(goal, heroes) {
	const sorted = [...heroes].sort((a, b) => (a.name < b.name ? -1 : 1));
	const named = String(goal.hero ?? "").trim().toLowerCase();
	if (named !== "") {
		const hit = sorted.find((h) => h.name.toLowerCase() === named);
		if (hit) return { hero: hit, reason: "hero-field" };
	}
	const style = String(goal.style ?? "").trim();
	if (style !== "") {
		const hit = sorted.find((h) => h.styles.includes(style));
		if (hit) return { hero: hit, reason: "style-match" };
	}
	const statement = String(goal.statement ?? "").toLowerCase();
	if (statement !== "") {
		const hit = sorted.find((h) => h.keywords.some((k) => statement.includes(String(k).toLowerCase())));
		if (hit) return { hero: hit, reason: "keyword-match" };
	}
	const fallback = sorted.find((h) => h.isDefault) ?? sorted[0];
	return { hero: fallback, reason: "default" };
}

// Swarm-class request detection (bi#128: the agent's task is "start a
// batch"). Tight signal list — regular requests must stay normal.
export const SWARM_SIGNALS = ["start a batch", "dispatch", "swarm", "spawn", "fan-out", "fan out", "squad"];

export function isSwarmRequest(request) {
	const text = String(request ?? "").toLowerCase();
	return SWARM_SIGNALS.some((s) => text.includes(s));
}

// Style enforcement fragment: the goal style pack's hero_prompt, or ""
// when the style resolves to no pack (unknown styles never block).
export function styleHeroPrompt(style, stylesDir = STYLES_DIR) {
	try {
		const raw = readFileSync(join(stylesDir, `${style}.toml`), "utf8");
		return strField(raw, "hero_prompt");
	} catch {
		return "";
	}
}

export function renderHeroPrompt(hero, stylePrompt = "") {
	const L = [];
	L.push(`Hero: ${hero.name} — ${hero.role}`);
	L.push(`Workflow (explore->dispatch->merge):`);
	for (const w of hero.workflow) L.push(`- ${w}`);
	L.push(`Tool policy:`);
	for (const t of hero.tool_policy) L.push(`- ${t}`);
	if (stylePrompt) L.push(`Style enforcement: ${stylePrompt}`);
	L.push(`Stop conditions:`);
	for (const s of hero.stop_conditions) L.push(`- ${s}`);
	return L.join("\n");
}

// Injection entry point: swarm-class requests get the selected hero's
// prompt; regular requests get inject:false and empty text (asserted both
// ways by the selftest — injection absent on non-swarm requests).
export function buildHeroPrompt({ request, goal, heroesDir = HEROES_DIR, stylesDir = STYLES_DIR } = {}) {
	if (!isSwarmRequest(request)) return { inject: false, hero: null, text: "" };
	const heroes = loadHeroes(heroesDir);
	const { hero, reason } = selectHero(goal, heroes);
	return { inject: true, hero, reason, text: renderHeroPrompt(hero, styleHeroPrompt(goal.style, stylesDir)) };
}

// Subagent brief inheritance: appended per slot in the dispatch --briefs
// path (see SRC-LANE WIRING above) so briefs carry hero constraints.
export function heroBriefSection(hero) {
	const L = [];
	L.push(`Hero: ${hero.name} (inherited constraints — binding on this brief):`);
	for (const c of hero.brief_constraints) L.push(`- ${c}`);
	return L.join("\n");
}

// --- selftest (acceptance fixtures) ---
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--selftest")) {
	const { renderBrief } = await import("./briefs.mjs");
	const FIX = join(HERE, "fixtures", "hero");
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) {
			failures++;
			console.error(`FAIL selftest: ${msg}`);
		} else console.log(`ok selftest: ${msg}`);
	};

	const heroes = loadHeroes();
	check(heroes.length >= 2 && heroes.some((h) => h.isDefault), "hero packs load with exactly one default");

	const gameGoal = parseGoalToml(readFileSync(join(FIX, "game-goal.toml"), "utf8"));
	const sel = selectHero(gameGoal, heroes);
	check(sel.hero.name === "game" && sel.reason === "style-match", "game+data-oriented selects the game hero");
	check(selectHero(gameGoal, heroes).hero.name === "game", "one goal -> one hero (deterministic)");

	const plainGoal = parseGoalToml(readFileSync(join(FIX, "plain-goal.toml"), "utf8"));
	check(selectHero(plainGoal, heroes).hero.name === "general", "unknown style falls back to the default hero");

	const keywordGoal = parseGoalToml(readFileSync(join(FIX, "game-plain-goal.toml"), "utf8"));
	const ksel = selectHero(keywordGoal, heroes);
	check(ksel.hero.name === "game" && ksel.reason === "keyword-match", "game statement without game style selects the game hero");

	const gameHero = heroes.find((h) => h.name === "game");
	const section = heroBriefSection(gameHero);
	check(gameHero.brief_constraints.length > 0 && gameHero.brief_constraints.every((c) => section.includes(c)), "brief section carries every game-hero constraint");
	const brief = renderBrief({ slot: 1, id: "bi#135", title: "probe", body: "", files: [], files_state: "unknown", dir: "bi" });
	check(gameHero.brief_constraints.every((c) => `${brief}\n${section}`.includes(c)), "composed brief carries hero constraints");

	const requests = JSON.parse(readFileSync(join(FIX, "requests.json"), "utf8"));
	const swarm = buildHeroPrompt({ request: requests.swarm, goal: gameGoal });
	check(swarm.inject === true && swarm.hero.name === "game", "swarm request injects the game hero (flag true)");
	check(swarm.text.includes("game") && swarm.text.includes("Stop conditions:"), "injected text carries role, workflow, and stop conditions");
	check(swarm.text.includes("SoA layouts"), "injected text appends the style pack hero_prompt");
	const regular = buildHeroPrompt({ request: requests.regular, goal: gameGoal });
	check(regular.inject === false && regular.hero === null && regular.text === "", "regular request injects nothing (flag false, text empty)");

	if (failures > 0) process.exit(1);
	console.log("hero selftest green");
}

// --- hub#161 join: hero-to-roster assignment (append-only addition) ---
//
// goal -> hero (selectHero) -> roster entry (roster match()) per
// component, with corpus evidence attached; LOUD fallback preserved end
// to end (the fallback reason propagates into the injection text
// verbatim); reviewer verdicts (bi#59) replace a rejected hero with
// evidence; injection carries hero constraints + roster style.
//
// Verdict feed shape (the interface hero.mjs left open): a plain map of
// hero name -> { decision: "replace", evidence: "<why>" }. A rejected
// selected hero is re-selected from the remaining packs (default first)
// and the replacement + evidence are recorded in heroReason, so the
// spawn brief shows why the hero changed. Dynamic import keeps this
// addition append-only (no header import — roster.mjs never imports
// this file, so there is no cycle).
//
// Load-bearing hunk (hub#161/bi#57 red-check target): the applyVerdicts
// call inside assignGoalComponents. Reverting assignGoalComponents to
// keep the first-selected hero (skipping applyVerdicts) must trip the
// join selftest with exactly:
//   "FAIL join selftest: reviewer verdict replaces the rejected hero with evidence"
// (verified 2026-09-06: verdict call skipped -> that FAIL observed -> restored green).

export function applyVerdicts(selected, heroes, verdicts = {}) {
	const feed = verdicts ?? {};
	const mark = feed[selected?.name] ?? null;
	const decision = String(mark?.decision ?? mark?.verdict ?? "").toLowerCase();
	if (decision !== "replace") return { hero: selected, replaced: null };
	const evidence = String(mark?.evidence ?? "").trim();
	const rest = [...heroes]
		.filter((h) => h.name !== selected.name)
		.sort((a, b) => (a.name < b.name ? -1 : 1));
	const next = rest.find((h) => h.isDefault) ?? rest[0] ?? selected;
	return { hero: next, replaced: { from: selected.name, to: next.name, evidence } };
}

export async function assignGoalComponents(
	{ goal, components = [], heroesDir = HEROES_DIR, rosterDir = join(ROOT, ".bais", "roster"), stylesDir = STYLES_DIR, verdicts = {} } = {},
) {
	const heroes = loadHeroes(heroesDir);
	const { hero: first, reason: firstReason } = selectHero(goal, heroes);
	const { hero, replaced } = applyVerdicts(first, heroes, verdicts);
	const heroReason = replaced
		? `${firstReason}; replaced ${replaced.from} -> ${replaced.to} per reviewer verdict${replaced.evidence ? `: ${replaced.evidence}` : ""}`
		: firstReason;
	const { loadRoster, match: matchRoster, resolveAgentStylePrompt } = await import("./roster.mjs");
	const roster = loadRoster(rosterDir);
	const assignments = (Array.isArray(components) ? components : []).map((component) => {
		const hit = matchRoster(component.tags ?? [], roster);
		return {
			component,
			agent: hit.agent,
			reason: hit.reason,
			evidence: hit.evidence,
			stylePrompt: resolveAgentStylePrompt(hit.agent.style, stylesDir),
		};
	});
	return { hero, heroReason, replaced, assignments, text: renderAssignmentInjection({ hero, assignments }) };
}

export function renderAssignmentInjection({ hero, assignments = [] } = {}) {
	const L = [];
	L.push(heroBriefSection(hero));
	for (const a of assignments) {
		const label = a.component?.id ?? a.component?.title ?? "<?>";
		L.push(`Component ${label} -> agent ${a.agent.name} (${a.agent.model}): ${a.reason}`);
		if (a.stylePrompt) L.push(`Roster style (${a.agent.style}): ${a.stylePrompt}`);
		L.push(
			a.evidence?.corpus
				? `Corpus evidence: ${a.evidence.corpus}`
				: "Corpus evidence: none (LOUD fallback carries the reason above)",
		);
	}
	return L.join("\n");
}

// --- join selftest (hub#161 acceptance fixtures) ---
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--selftest-join")) {
	const JOIN_FIX = join(HERE, "fixtures", "join");
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) {
			failures++;
			console.error(`FAIL join selftest: ${msg}`);
		} else console.log(`ok join selftest: ${msg}`);
	};

	const goal = parseGoalToml(readFileSync(join(JOIN_FIX, "goal.toml"), "utf8"));
	const components = JSON.parse(readFileSync(join(JOIN_FIX, "components.json"), "utf8"));
	const verdicts = JSON.parse(readFileSync(join(JOIN_FIX, "verdicts.json"), "utf8"));
	const out = await assignGoalComponents({ goal, components, rosterDir: join(JOIN_FIX, "roster") });

	check(out.hero.name === "general" && out.heroReason === "default", "goal selects the general hero by default");
	check(out.assignments.length === 2, "every goal component gets exactly one roster entry");

	const php = out.assignments.find((a) => a.component.id === "join-component-php");
	check(!!php && php.agent.name === "PhpJoe", `PHP component assigns PhpJoe (got ${php?.agent.name})`);
	check(!!php?.evidence && php.evidence.corpus === "bagl:corpora/php-v1", "PHP assignment carries corpus evidence");

	const orch = out.assignments.find((a) => a.component.id === "join-component-orchestration");
	check(!!orch && orch.agent.name === "default" && /loud/i.test(orch?.reason ?? ""), `orchestration falls back to default LOUD (got ${orch?.agent.name})`);
	check(!!orch && orch.reason.includes("dispatch"), "fallback reason names the component tags");

	check(
		out.hero.brief_constraints.length > 0 && out.hero.brief_constraints.every((c) => out.text.includes(c)),
		"injection carries every hero constraint",
	);
	check(out.text.includes("Enforce corporate taste"), "injection carries the roster style fragment");
	check(/loud/i.test(out.text), "fallback LOUD is preserved end to end in the injection");

	const rep = await assignGoalComponents({ goal, components, rosterDir: join(JOIN_FIX, "roster"), verdicts });
	check(
		rep.hero.name === "game" && rep.heroReason.includes("replaced general -> game") && rep.heroReason.includes("reviewer pilot bi#59"),
		"reviewer verdict replaces the rejected hero with evidence",
	);

	if (failures > 0) process.exit(1);
	console.log("hero-roster join selftest green");
}
