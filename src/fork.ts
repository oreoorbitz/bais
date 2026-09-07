// hub#157: subdir-hub shadow detection for `bais check`.
//
// The root .bais/ is the ecosystem hub with fallthrough resolution. A
// per-dir `bais init` would silently fork that directory off the hub
// (nearest-hub-wins), so `bais check` fails loud instead: any subdir .bais/
// under the checked hub without an explicit fork declaration is a fatal
// shadow; a declared fork passes quiet.
//
// Declaration format (chosen here, documented for operators): the subdir
// hub declares itself a fork in its own config file:
//
//   <sub>/.bais/config.toml:
//     fork = true
//     parent = "../.bais"   # optional pointer at the parent hub, informational
//
// `fork = true` (TOML boolean, case-insensitive key) is the load-bearing
// line — without it the subdir hub is undeclared. `parent` is documentation
// only and never affects the verdict.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface ShadowHub {
	// Subdir path relative to the checked cwd, e.g. "bagl".
	path: string;
	// Subdir hub path relative to the checked cwd, e.g. "bagl/.bais".
	hub: string;
	// True when <hub>/config.toml carries `fork = true`.
	declared: boolean;
	// Optional `parent = "..."` pointer from the subdir config (info only).
	parent: string | null;
}

// Subtrees that are never hub-shadow candidates: VCS, dependency,
// and build/projection output dirs, plus the root hub itself.
const SKIP = new Set([".git", "node_modules", "dist", "baml_sdk", ".baml", ".bais"]);

// hub#157 red-check target (bi#57): with the `fork = true` match below
// forced to false, the declared-fork fixture must go LOUD (proves the
// quiet pass comes from this line, not from the walker missing the dir).
export function readForkDeclaration(hubDir: string): { declared: boolean; parent: string | null } {
	let text: string;
	try {
		text = readFileSync(join(hubDir, "config.toml"), "utf8");
	} catch {
		return { declared: false, parent: null };
	}
	const declared = text.split("\n").some((l) => /^\s*fork\s*=\s*true\s*(#.*)?$/i.test(l));
	const pm = /^\s*parent\s*=\s*"([^"]*)"/im.exec(text);
	return { declared, parent: pm ? pm[1] : null };
}

// Outermost subdir hubs under cwd. A found hub (declared or not) is not
// descended into — its subtree is its own governance, and an undeclared
// shadow's children are reported via the outermost path only.
export function findShadowHubs(cwd: string): ShadowHub[] {
	const base = resolve(cwd);
	const out: ShadowHub[] = [];
	const walk = (dir: string): void => {
		let entries: { name: string; isDirectory(): boolean }[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (SKIP.has(e.name)) continue;
			const sub = join(dir, e.name);
			const hub = join(sub, ".bais");
			let isHub = false;
			try {
				isHub = statSync(hub).isDirectory();
			} catch {
				isHub = false;
			}
			if (isHub) {
				const { declared, parent } = readForkDeclaration(hub);
				out.push({
					path: relative(base, sub) || ".",
					hub: relative(base, hub) || ".bais",
					declared,
					parent,
				});
				continue;
			}
			walk(sub);
		}
	};
	walk(base);
	out.sort((a, b) => (a.hub < b.hub ? -1 : a.hub > b.hub ? 1 : 0));
	return out;
}

// Loud text line naming both paths with declare-or-remove guidance.
export function formatShadow(rootHub: string, s: ShadowHub): string {
	return `shadow\t${s.hub}\tshadows ${rootHub} (nearest-hub-wins forks ${s.path} off the hub) — declare the fork (fork = true in ${s.hub}/config.toml) or remove ${s.hub}`;
}
