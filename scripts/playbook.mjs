// bais/scripts/playbook.mjs — bi#61: playbook context-block assembler (scripts lane).
//
// Extracts the canonical context block from bais/spec/playbook.md (§2,
// between the PLAYBOOK-BLOCK markers) verbatim and enforces the token
// budget: over-budget blocks are refused loud, never silently injected.
// `check-version` asserts the playbook's version against a hub's
// capabilities (interop_version in .bais/config.toml, absent means 1),
// warning loud on mismatch in the interop.md §2 style. Pure ESM, zero
// dependencies: `node` only. NEVER imports baml_sdk — the playbook must
// serve outside agents (hub#154 interop surface) with no BAML tooling.
//
// Usage (run from bais/):
//   node scripts/playbook.mjs assemble [--budget N] [--file <md>] [--mode standard|swarm]
//     → block bytes on stdout, exit 0; over budget →
//     `PLAYBOOK BUDGET REFUSED <file> (<chars> chars > budget <N>)`, exit 1.
//   --mode swarm appends the §2S swarm block (bi#128 dispatch-class
//   injection); default standard emits §2 alone, byte-identical to
//   before. Unknown --mode is REFUSED, exit 2. Budget counts total bytes.
//   node scripts/playbook.mjs check-version --hub <root>
//     → `PLAYBOOK VERSION OK <root> (playbook 1, hub interop <H>)`, exit 0;
//     newer hub → `PLAYBOOK VERSION MISMATCH <root> (playbook 1 supports
//     interop <= 1, hub declares <H>)`, exit 1.
// Missing --file/--hub, missing file, or missing block markers is
// `PLAYBOOK REFUSED ...`, exit 2 (a typo'd path must never read as clean).
//
// SRC-LANE WIRING (not this file — needs bi/src/cli.ts, owned by
// bi#135/bi#128): `bi run` prints assemble's stdout ahead of the ready
// list; a future served endpoint over the hub#154 interop surface returns
// these same bytes. Until then the operator runs the node line directly.
//
// Red-check (bi#57, recorded 2026-09-06 by play-61): neutered the
// budget-refusal hunk below (`if (chars > budget)` → `if (false)`), then
// ran the fixture gate over untouched fixtures: `budget-red` went red
// with `expected PLAYBOOK BUDGET REFUSED, got ASSEMBLED` (wrong outcome —
// the silent-bloat path the gate exists to prevent); with the hunk
// restored all 5 checks return to their spec §4 outcomes. A gate that
// cannot go red on an over-budget block is camouflage, not coverage.
// Red-check (bi#57, recorded 2026-09-06 by b4merge for bi#128):
// neutered the swarm mode gate (`if (mode === "swarm")` → `if (true)`)
// so standard mode leaks the swarm block: `swarm-absent` went red
// (`standard block carries swarm text`) plus `outside-reader` collateral
// (`steps=15 pointed=10` — the 5 swarm steps leak into the standard
// shape the reader pins); restored, 8/8 green.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC = join(HERE, "..", "spec", "playbook.md");

export const PLAYBOOK_VERSION = 1;
export const SUPPORTED_INTEROP_MAX = 1;
export const DEFAULT_BUDGET = 4000;
export const BEGIN = "<!-- PLAYBOOK-BLOCK-BEGIN -->";
export const END = "<!-- PLAYBOOK-BLOCK-END -->";
export const SWARM_BEGIN = "<!-- SWARM-BLOCK-BEGIN -->";
export const SWARM_END = "<!-- SWARM-BLOCK-END -->";

export function extractBlock(md) {
	const bi = md.indexOf(BEGIN);
	const ei = md.indexOf(END);
	if (bi === -1 || ei === -1 || ei <= bi) {
		throw new Error("block markers missing or out of order");
	}
	return md.slice(bi + BEGIN.length, ei).replace(/^\n/, "").replace(/\s+$/, "");
}

export function extractSwarm(md) {
	const bi = md.indexOf(SWARM_BEGIN);
	const ei = md.indexOf(SWARM_END);
	if (bi === -1 || ei === -1 || ei <= bi) {
		throw new Error("swarm block markers missing or out of order");
	}
	return md.slice(bi + SWARM_BEGIN.length, ei).replace(/^\n/, "").replace(/\s+$/, "");
}

export function assembleFile(path, budget = DEFAULT_BUDGET, mode = "standard") {
	if (mode !== "standard" && mode !== "swarm") {
		return { ok: false, code: 2, line: `PLAYBOOK REFUSED ${path} (unknown --mode ${mode})` };
	}
	if (!existsSync(path)) {
		return { ok: false, code: 2, line: `PLAYBOOK REFUSED ${path} (no such file)` };
	}
	let md;
	try {
		md = readFileSync(path, "utf8");
	} catch (e) {
		return { ok: false, code: 2, line: `PLAYBOOK REFUSED ${path} (${e.message})` };
	}
	let block;
	try {
		block = extractBlock(md);
		if (mode === "swarm") block = block + "\n" + extractSwarm(md);
	} catch (e) {
		return { ok: false, code: 2, line: `PLAYBOOK REFUSED ${path} (${e.message})` };
	}
	const chars = [...block].length;
	// Load-bearing hunk (bi#57 red-check target): the budget refusal.
	// Neutering this to always-assemble must trip fixtures/playbook/check.mjs
	// `budget-red` with `expected PLAYBOOK BUDGET REFUSED, got ASSEMBLED`.
	if (chars > budget) {
		return { ok: false, code: 1, line: `PLAYBOOK BUDGET REFUSED ${path} (${chars} chars > budget ${budget})` };
	}
	return { ok: true, code: 0, block, chars };
}

export function readHubInterop(hub) {
	const cfg = join(hub, ".bais", "config.toml");
	if (!existsSync(cfg)) {
		return { ok: false, code: 2, line: `PLAYBOOK REFUSED ${hub} (no .bais/config.toml)` };
	}
	const text = readFileSync(cfg, "utf8");
	const m = text.match(/^\s*interop_version\s*=\s*(\d+)\s*$/m);
	return { ok: true, version: m ? parseInt(m[1], 10) : 1 };
}

export function checkVersion(hub) {
	const r = readHubInterop(hub);
	if (!r.ok) return r;
	if (r.version > SUPPORTED_INTEROP_MAX) {
		return { ok: false, code: 1, line: `PLAYBOOK VERSION MISMATCH ${hub} (playbook ${PLAYBOOK_VERSION} supports interop <= ${SUPPORTED_INTEROP_MAX}, hub declares ${r.version})` };
	}
	return { ok: true, code: 0, line: `PLAYBOOK VERSION OK ${hub} (playbook ${PLAYBOOK_VERSION}, hub interop ${r.version})` };
}

function usage() {
	console.log("PLAYBOOK REFUSED (usage: playbook.mjs assemble [--budget N] [--file <md>] [--mode standard|swarm] | check-version --hub <root>)");
	process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === "assemble") {
	let budget = DEFAULT_BUDGET;
	let file = DEFAULT_SPEC;
	let mode = "standard";
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--budget") budget = parseInt(args[++i], 10);
		else if (args[i] === "--file") file = resolve(args[++i]);
		else if (args[i] === "--mode") mode = args[++i];
		else usage();
	}
	if (!Number.isFinite(budget) || budget <= 0) {
		console.log(`PLAYBOOK REFUSED (bad --budget ${args[args.indexOf("--budget") + 1]})`);
		process.exit(2);
	}
	const r = assembleFile(file, budget, mode);
	if (!r.ok) {
		console.log(r.line);
		process.exit(r.code);
	}
	process.stdout.write(r.block + "\n");
} else if (cmd === "check-version") {
	const hi = args.indexOf("--hub");
	if (hi === -1 || !args[hi + 1]) usage();
	const r = checkVersion(resolve(args[hi + 1]));
	console.log(r.line);
	process.exit(r.code);
} else {
	usage();
}
