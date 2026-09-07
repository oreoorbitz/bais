// bais/scripts/roster.mjs — bi#147: named agent roster + assignment (scripts lane).
//
// Roster entries live as one file per agent in .bais/roster/:
//   [agent] name, model, specialty_tags (list), style (bi#134 pack name
//   under .bais/styles/), corpus (opaque BAGL corpus ref, resolved later),
//   description. The default generalist (default.toml, empty tags) never
//   wins a tag match; it is the LOUD fallback only.
//
// Standalone assignment for the goal hero (bi#135 runs in parallel — hero
// files are OUT of this lane, do not touch them):
//   match(component_tags, roster) -> { agent, reason, evidence }
// Tags are matched case-insensitively; score = overlap count; ties break
// by roster filename order (deterministic). Score 0 on every specialist
// falls back to the default agent LOUD: the reason names the component
// tags and states that nothing matched. evidence = { corpus } when the
// assigned agent binds a corpus, else null.
//
// Skill-library accumulation (domain-scoped, Hermes-style procedural
// memory): specialists file candidate skills freely in the candidate shape
// below; tag match is judged READ-side by the hero, not write-side by the
// specialist — misfiled-but-present beats correctly-judged-but-lost.
//   routeCandidate(candidate, roster) -> { library, reason }
// Best specialty overlap wins that specialist's library; no overlap (or
// orchestration-level tags like dispatch/coordination) escalates to the
// "coordinator" library. filed_in is reported, never trusted for routing.
// Libraries live at .bais/roster/libs/<library>/ (created on first route,
// not by this lane).
//
// Candidate-skill file shape:
//   [skill] id, title, tags (list), filed_in (library it landed in),
//   body (the procedural memory: what was learned, when it applies).
//
// SRC-LANE / HERO WIRING (not this file — needs bi hero work under
// bi#135, outside this lane's footprint): loadRoster() the roster dir,
// call match(component.tags, roster) per dispatched component, inject
// agent.style (resolve .bais/styles/<style>.toml hero_prompt) +
// evidence.corpus into the spawn brief; on read, call
// routeCandidate() per candidate skill and file/escalate accordingly.
// Until then the operator runs:
//   node bais/scripts/roster.mjs --selftest
// against bais/scripts/fixtures/roster/.
//
// Load-bearing hunk (bi#147/bi#57 red-check target): the LOUD fallback in
// match(). Reverting match() to always return the best specialist (even
// at score 0) must trip the selftest with exactly:
//   "FAIL selftest: unmapped specialty falls back to default LOUD"
// (verified 2026-09-06: fallback removed -> that FAIL observed -> restored green).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "roster");

// Minimal TOML readers (scalar string, string list — the subset the
// roster/candidate shapes use; the BAML validator owns real parsing).
const strField = (text, section, name) => {
	const sec = String(text).match(new RegExp(`^\\[${section}\\}[\\s\\S]*?(?=^\\[|$)`, "m"));
	const src = sec ? sec[0] : String(text);
	const m = src.match(new RegExp(`^${name} *= *"((?:[^"\\\\]|\\\\.)*)"`, "m"));
	return m ? JSON.parse(`"${m[1]}"`) : "";
};
const listField = (text, section, name) => {
	const sec = String(text).match(new RegExp(`^\\[${section}\\}[\\s\\S]*?(?=^\\[|$)`, "m"));
	const src = sec ? sec[0] : String(text);
	const m = src.match(new RegExp(`^${name} *= *\\[([\\s\\S]*?)\\]`, "m"));
	if (!m) return [];
	const out = [];
	const re = /"(?:[^"\\]|\\.)*"/g;
	let mm;
	while ((mm = re.exec(m[1])) !== null) out.push(JSON.parse(mm[0]));
	return out;
};
const norm = (tags) => (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase());

export function parseAgentToml(text, file = "<inline>") {
	return {
		file,
		name: strField(text, "agent", "name"),
		model: strField(text, "agent", "model"),
		specialty_tags: listField(text, "agent", "specialty_tags"),
		style: strField(text, "agent", "style"),
		corpus: strField(text, "agent", "corpus"),
		description: strField(text, "agent", "description"),
	};
}

// Load every *.toml in dir, sorted by filename for deterministic ties.
// Skips entries with no name (loud: caller decides; selftest asserts none).
export function loadRoster(dir) {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".toml"))
		.sort()
		.map((f) => parseAgentToml(readFileSync(join(dir, f), "utf8"), f));
}

// Score = case-insensitive tag overlap between the component and the
// agent's specialty tags. The default entry (empty tags) always scores 0.
export function scoreAgent(componentTags, agent) {
	const want = new Set(norm(componentTags));
	return norm(agent.specialty_tags).filter((t) => want.has(t)).length;
}

// Standalone assignment: best specialty overlap wins; nothing overlapping
// falls back to the default agent LOUD with a reason naming the tags.
// evidence attaches the winner's corpus binding (opaque string for now).
export function match(componentTags, roster) {
	const tags = norm(componentTags);
	const fallback = roster.find((a) => a.specialty_tags.length === 0) ?? roster[0];
	let best = null;
	let bestScore = 0;
	for (const agent of roster) {
		if (agent.specialty_tags.length === 0) continue; // default never competes
		const s = scoreAgent(tags, agent);
		if (s > bestScore) {
			best = agent;
			bestScore = s;
		}
	}
	if (best) {
		return {
			agent: best,
			reason: `${best.name} matches ${bestScore} component tag(s) [${tags.join(", ")}]; corpus evidence attached`,
			evidence: best.corpus ? { corpus: best.corpus } : null,
		};
	}
	return {
		agent: fallback,
		reason: `no roster entry matches component tags [${tags.join(", ")}]; falling back to default agent ${fallback.name} LOUD`,
		evidence: null,
	};
}

export function parseCandidateToml(text, file = "<inline>") {
	const bodyM = String(text).match(/^body *= *"""([\s\S]*?)"""/m);
	return {
		file,
		id: strField(text, "skill", "id"),
		title: strField(text, "skill", "title"),
		tags: listField(text, "skill", "tags"),
		filed_in: strField(text, "skill", "filed_in"),
		body: bodyM ? bodyM[1] : strField(text, "skill", "body"),
	};
}

// Read-side routing (hero judges, specialist only files): best specialty
// overlap wins that specialist's library; a tie or zero overlap —
// including cross-domain and orchestration-level learnings — escalates to
// the coordinator library. filed_in is echoed in the reason, never used.
export function routeCandidate(candidate, roster) {
	const tags = norm(candidate.tags);
	let best = null;
	let bestScore = 0;
	for (const agent of roster) {
		if (agent.specialty_tags.length === 0) continue;
		const s = scoreAgent(tags, agent);
		if (s > bestScore) {
			best = agent;
			bestScore = s;
		}
	}
	if (best) {
		return {
			library: best.name.toLowerCase(),
			reason: `skill ${candidate.id} matches ${best.name} specialty (${bestScore} tag(s)); filed in ${candidate.filed_in || "unknown"}, routed to ${best.name.toLowerCase()} library on read`,
		};
	}
	return {
		library: "coordinator",
		reason: `skill ${candidate.id} matches no specialty [${tags.join(", ")}]; filed in ${candidate.filed_in || "unknown"}, escalated to coordinator library on read`,
	};
}

if (process.argv[2] === "--selftest") {
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) {
			failures++;
			console.error(`FAIL selftest: ${msg}`);
		} else console.log(`ok selftest: ${msg}`);
	};

	// Fixture roster: PhpJoe (php tags + php corpus) + default.
	const roster = loadRoster(join(FIXTURES, "roster"));
	check(roster.length === 2, `fixture roster holds 2 entries (got ${roster.length})`);
	const phpJoe = roster.find((a) => a.name === "PhpJoe");
	check(!!phpJoe && phpJoe.corpus === "bagl:corpora/php-v1", "PhpJoe binds the php corpus");
	check(phpJoe && phpJoe.style === "corporate-oop", "PhpJoe style names a .bais/styles pack");

	// Acceptance 1: PHP component -> PhpJoe with corpus evidence attached.
	const phpComponent = JSON.parse(readFileSync(join(FIXTURES, "component-php.json"), "utf8"));
	const assigned = match(phpComponent.tags, roster);
	check(assigned.agent.name === "PhpJoe", `PHP component assigns PhpJoe (got ${assigned.agent.name})`);
	check(!!assigned.evidence && assigned.evidence.corpus === "bagl:corpora/php-v1", "assignment carries corpus evidence");
	check(assigned.reason.includes("PhpJoe"), "assignment names its reason");

	// Acceptance 2: unmapped specialty falls back to default LOUD.
	const unknownComponent = JSON.parse(readFileSync(join(FIXTURES, "component-unknown.json"), "utf8"));
	const fellBack = match(unknownComponent.tags, roster);
	check(
		fellBack.agent.name === "default" && /loud/i.test(fellBack.reason),
		`unmapped specialty falls back to default LOUD (got ${fellBack.agent.name}: ${fellBack.reason})`,
	);

	// Acceptance 3 (domain-scoped accumulation, read-side routing):
	// a misfiled PHP-Hack bridge candidate routes to PhpJoe's library…
	const bridge = parseCandidateToml(readFileSync(join(FIXTURES, "candidate-php-bridge.toml"), "utf8"));
	const bridgeRoute = routeCandidate(bridge, roster);
	check(bridgeRoute.library === "phpjoe", `misfiled PHP skill routed to phpjoe library (got ${bridgeRoute.library})`);
	// …while an orchestration-level learning escalates to the coordinator.
	const dispatch = parseCandidateToml(readFileSync(join(FIXTURES, "candidate-dispatch-pattern.toml"), "utf8"));
	const dispatchRoute = routeCandidate(dispatch, roster);
	check(dispatchRoute.library === "coordinator", `dispatch learning escalated to coordinator (got ${dispatchRoute.library})`);

	process.exit(failures ? 1 : 0);
}

// --- hub#161 join addition (append-only): roster-side injection data ---
//
// resolveAgentStylePrompt() resolves the roster wiring spec's style half:
// agent.style names a bi#134 pack under .bais/styles/ and the pack's
// hero_prompt is the style fragment injected into the spawn brief
// alongside evidence.corpus. Unknown styles resolve to "" and never
// block assignment (hero.mjs styleHeroPrompt analog).
export const JOIN_STYLES_DIR = join(HERE, "..", "..", ".bais", "styles");

export function resolveAgentStylePrompt(style, stylesDir = JOIN_STYLES_DIR) {
	const name = String(style ?? "").trim();
	if (name === "") return "";
	try {
		const raw = readFileSync(join(stylesDir, `${name}.toml`), "utf8");
		return strField(raw, "style", "hero_prompt");
	} catch {
		return "";
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--selftest-join")) {
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) {
			failures++;
			console.error(`FAIL join selftest: ${msg}`);
		} else console.log(`ok join selftest: ${msg}`);
	};

	check(
		resolveAgentStylePrompt("corporate-oop").includes("Enforce corporate taste"),
		"corporate-oop style resolves its hero_prompt fragment",
	);
	check(resolveAgentStylePrompt("no-such-style") === "", "unknown style resolves empty (never blocks)");
	check(resolveAgentStylePrompt("") === "", "empty style resolves empty (never blocks)");

	if (failures > 0) process.exit(1);
	console.log("roster join selftest green");
}
