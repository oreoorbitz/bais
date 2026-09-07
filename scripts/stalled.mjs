// bais/scripts/stalled.mjs — bi#127: resume-or-reap triage, ordered by radius.
//
// `node bais/scripts/stalled.mjs [dir] [--json]` lists Doing issues whose
// claim is dead (expired / missing / unparseable-instant lease) ordered by
// open blast radius, descending (ties: id ascending). Read-only like
// dispatch: it only runs `bais check --json` (dead set) and `bais list
// --json` (titles + radii) against dir (default: cwd) and never
// moves/renews/reaps. Reclaim the top with `renew`, release with `reap`.
//
// Two load-bearing decisions live here; everything else is owned:
//   1. DEAD = check.staleClaims (cli.ts leaseExpired: null/unparseable/<=
//      now). This script does its own lease math nowhere, so the dead/live
//      boundary cannot drift from `reap`. Live claims are never named:
//      neither text nor --json output contains a live id in any field.
//   2. ORDER = open_downstream desc, id asc — the same comparator
//      `ready --order blast-radius` uses (cli.ts), so the queue agrees
//      with the dispatcher about what "load-bearing" means.
//
// `node bais/scripts/stalled.mjs --check` runs the acceptance fixture
// (fixtures/stalled/): live-claimed + dead-claimed + unclaimed Doing —
// only dead listed, radius order, live never named, fixture bytes
// unchanged. Fixture leases are far-past (2000-*) / far-future (2099), so
// the check is deterministic at any real now. The "unparseable" arm uses a
// shape-valid but impossible instant (2000-99-99T99:99:99Z): it passes the
// BAML 20-char shape gate and fails Date.parse, which is exactly the
// "unparseable instant reads as expired" path. Truly malformed leases
// ("soon") are whole-file parse failures (toml.baml `bad lease`), excluded
// from every surface including reap — no fixture arm for those.
//
// NOTE (bi#127): shipped standalone. `dispatch --stalled` wiring in
// scripts/dispatch.mjs was left out on purpose — dispatch.mjs is owned by
// a parallel agent; folding this in is a one-branch follow-up.
//
// Red-check 2026-09-06 (bi#57): sourcing candidates from `list` Doing rows
// instead of `check` staleClaims (deleting the dead-only filter) trips
// stalled.rows + stalled.json-order + stalled.live-never-named — the live
// s#03 leaks into the queue (3 FAIL, 3 pass, exit 1). Restored → 6 green.
// A queue that cannot go red on a live leak is camouflage, not coverage.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const FIXDIR = join(HERE, "fixtures", "stalled");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// check exits 1 on unrelated gate failures (dangling/cycles/evidence) while
// still printing JSON to stdout — so parse stdout whatever the exit code.
// Fail-closed with a named reason when there is no JSON at all (bi#55:
// never silently empty).
const runCli = (dir, args) => {
	try {
		return execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
	} catch (e) {
		return (e.stdout ?? "").toString();
	}
};
const runJson = (dir, args) => {
	const out = runCli(dir, args);
	try {
		return JSON.parse(out);
	} catch {
		console.error(`stalled: no JSON from \`bais ${args.join(" ")}\` in ${dir} (not a bais project?)`);
		process.exit(1);
	}
};

const stalledIn = (dir) => {
	const chk = runJson(dir, ["check", "--json"]);
	const lst = runJson(dir, ["list", "--json"]);
	const byId = new Map((lst.issues ?? []).map((r) => [r.issue.id, r]));
	const rows = (chk.staleClaims ?? []).map((s) => {
		const f = byId.get(s.id);
		return {
			id: s.id,
			holder: s.holder ?? null,
			lease: s.lease ?? null,
			title: f?.issue.title ?? "",
			open_downstream: f?.blast_radius?.open_downstream ?? 0,
		};
	});
	rows.sort((a, b) => b.open_downstream - a.open_downstream || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { rows, unparseable: (lst.unparseable ?? []).length };
};

const fmtRow = (r) => `stalled\t${r.id}\tbr=${r.open_downstream}\t${r.holder ?? "unknown"}\t${r.lease ?? "no-lease"}\t${r.title}`;

const snapshot = (dir) => {
	const is = join(dir, ".bais", "issues");
	return readdirSync(is).sort().map((f) => `${f}\n${readFileSync(join(is, f), "utf8")}`).join("\n");
};

function selfCheck() {
	const before = snapshot(FIXDIR);
	const runSelf = (args) => {
		try {
			return { code: 0, out: execFileSync("node", [process.argv[1], ...args], { encoding: "utf8", timeout: 60000 }) };
		} catch (e) {
			return { code: e.status ?? -1, out: ((e.stdout ?? "") + (e.stderr ?? "")).toString() };
		}
	};
	const t = runSelf([FIXDIR]);
	const want = [
		"stalled\ts#01\tbr=2\tghost-1\t2000-01-01T00:00:00Z\tdead hub",
		"stalled\ts#04\tbr=1\tunknown\tno-lease\tunclaimed",
		"stalled\ts#02\tbr=0\tghost-2\t2000-06-01T00:00:00Z\tdead leaf",
		"stalled\ts#05\tbr=0\tghost-3\t2000-99-99T99:99:99Z\tgarbled lease",
	];
	check("stalled.rows", t.code === 0 && t.out.trim() === want.join("\n"), JSON.stringify(t));
	const j = runSelf([FIXDIR, "--json"]);
	let ids = null;
	try { ids = JSON.parse(j.out).stalled.map((r) => r.id); } catch { /* handled below */ }
	check("stalled.json-order", j.code === 0 && JSON.stringify(ids) === JSON.stringify(["s#01", "s#04", "s#02", "s#05"]), j.out);
	const both = t.out + j.out;
	check("stalled.live-never-named", !both.includes("s#03"), both);
	check("stalled.non-doing-excluded", !both.includes("s#06") && !both.includes("s#10") && !both.includes("s#11") && !both.includes("s#12"), both);
	check("stalled.readonly", snapshot(FIXDIR) === before, "fixture bytes changed");
	check("stalled.clean-exit", t.code === 0 && j.code === 0, `${t.code}/${j.code}`);
	if (fail) { console.log(`stalled: ${fail} FAIL, ${pass} pass`); process.exit(1); }
	console.log(`stalled: all ${pass} green`);
}

const args = process.argv.slice(2);
if (args.includes("--check")) selfCheck();
else {
	const json = args.includes("--json");
	const dir = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
	const { rows, unparseable } = stalledIn(dir);
	if (json) console.log(JSON.stringify({ stalled: rows, count: rows.length }, null, 2));
	else if (!rows.length) console.log("(no stalled claims)");
	else for (const r of rows) console.log(fmtRow(r));
	// Counts only: live ids are never named, unparseable files have no
	// claims to name (whole-file parse failures, same as dispatch).
	if (unparseable) console.error(`[bais] ${unparseable} unparseable file(s) excluded — \`bais check\` for details`);
}
