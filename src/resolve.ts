// bais/src/resolve.ts — hub#160: nearest-hub resolution for the raw bais CLI.
//
// The raw CLI used to read `./.bais` relative to the cwd only, so `bais` run
// from bi/ or bais/ (no local .bais) died with `No .bais — run bais init`
// even though the ecosystem root hub sits one level up. This mirrors the
// nearest-hub core of bi/src/bais.ts resolveIssuesDir: the cwd hub wins when
// present, otherwise fall through to the closest ancestor hub (the root hub
// from bi/ or bais/). A nested hub (bagl/.bais) still wins from inside bagl/ —
// nearest-hub-wins, the same rule hub#157's shadow scan (fork.ts) assumes.
//
// Deliberately upward-only: unlike bi's host (which also probes ./bi/.bais,
// ./bais/.bais and ../bais/.bais for its own layout reasons), the raw CLI
// never guesses a hub in a subdirectory or sibling — the cwd hub or the
// closest ancestor hub wins. (Outermost-wins would be one line — keep walking
// instead of returning — but it would fork bagl/ off its own hub.)

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Closest directory at or above `from` containing a `.bais/` hub, or null.
// The hub marker is the `.bais` directory itself (what `bais init` creates
// and what ensureInit used to check); init always creates issues/ alongside.
export function resolveHubDir(from: string = process.cwd()): string | null {
	let dir = resolve(from);
	for (;;) {
		if (existsSync(join(dir, ".bais"))) return join(dir, ".bais");
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
