// bais/scripts/fixtures/check-stale/check.mjs — hub#178 fixture gate.
//
// Move-then-check-without-ingest must warn naming the stale store;
// a fresh ingest clears it. Tmp hubs only (mkdtemp); the live hub is
// never touched. Pure ESM: `node` + the built bais/dist/src/cli.js.
//
// Usage (run from bais/):
//   node scripts/fixtures/check-stale/check.mjs   # exit 0 iff all green
//
// Red-check (bi#57): neuter the store-path warn in src/cli.ts
// (`if (staleStore)` → `if (false)`) and rebuild — stale-text and
// stale-json go red with `expected stale-store line, got clean check`;
// restored, green.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "..", "dist", "src", "cli.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`ok: ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const run = (args, cwd) => {
	try {
		return { code: 0, out: execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", timeout: 120000 }) };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};

function mkHub() {
	const d = mkdtempSync(join(tmpdir(), "check-stale-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), `project = "stub"\n`);
	const issue = (id, status) =>
		`id = "${id}"\ntitle = "stub ${id}"\nstatus = "${status}"\nkind = "Feat"\nbody = "stub"\n`;
	writeFileSync(join(d, ".bais", "issues", "st#01.toml"), issue("st#01", "Open"));
	writeFileSync(join(d, ".bais", "issues", "st#02.toml"), issue("st#02", "Open"));
	return d;
}

const hub = mkHub();
let r = run(["ingest"], hub);
check("check-stale.ingest-ok", r.code === 0 && r.out.includes("ingested"), JSON.stringify(r.out).slice(0, 160));
r = run(["check"], hub);
check("check-stale.fresh-quiet",
	r.code === 0 && !r.out.includes("stale-store"),
	JSON.stringify(r.out).slice(0, 200));

// Out-of-band TOML edit (hand edit / git op / another worktree — the
// CLI's own move/renew re-ingest, so only out-of-band edits go stale),
// then check WITHOUT re-ingesting: the store path must warn loud but
// still exit 0 (advisory — ingest is the fix, same as stale-claim).
// utimes pins the mtime jump deterministically.
{
	const f = join(hub, ".bais", "issues", "st#02.toml");
	appendFileSync(f, "# touched out-of-band\n");
	const t = new Date(Date.now() + 120000);
	utimesSync(f, t, t);
}
r = run(["check"], hub);
check("check-stale.stale-text",
	r.code === 0 && r.out.includes("stale-store") && r.out.includes("store.db") && r.out.includes("bais ingest"),
	`code=${r.code} out=${JSON.stringify(r.out).slice(0, 200)}`);
r = run(["check", "--json"], hub);
let stale = null;
try {
	stale = JSON.parse(r.out).staleStore;
} catch (e) {
	stale = `unparseable: ${e.message}`;
}
check("check-stale.stale-json",
	stale !== null && typeof stale === "object" && (stale.behindMs ?? -1) > 0,
	JSON.stringify(stale).slice(0, 160));

// Fresh ingest clears it: no stale line, staleStore null.
r = run(["ingest"], hub);
check("check-stale.reingest-ok", r.code === 0, JSON.stringify(r.out).slice(0, 120));
r = run(["check"], hub);
check("check-stale.fresh-clears",
	r.code === 0 && !r.out.includes("stale-store"),
	JSON.stringify(r.out).slice(0, 200));

console.log(`check-stale fixtures: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
