// bais/scripts/oversight-join.mjs — bi#50: blocked-behind-stalled feed.
//
// `node bais/scripts/oversight-join.mjs [dir] [--json]` joins stalled holders
// to the chains parked behind them: "N issues parked behind stalled X,
// holder silent since ...". A blocker Doing for weeks with a silent holder is
// a different fact from a blocker Doing since yesterday.
//
// Split (BAML owns the predicate, host owns rendering):
//   - JOIN PREDICATE lives in baml_src/oversight_join.baml (pure over
//     projection rows + the stalled set: blocked-transitive closure over
//     Blocks edges crossed with stalled holders). This file MIRRORS it
//     (same BFS, same traversal gates) because the committed baml_sdk is a
//     0.17.0 artifact and new BAML functions cannot reach the SDK (see
//     src/graph.ts header) — the `baml test` cases there are the
//     specification of what the mirror below must do. Change one, change
//     the other.
//   - STALLED-NESS is never computed here: DEAD = check.staleClaims (cli.ts
//     leaseExpired: null/unparseable/<= now, bi#42). This script does its own
//     lease math nowhere, so the dead/live boundary cannot drift from `reap`.
//     A renewing (merely-slow) holder stays live, stays out of staleClaims,
//     and reports nothing — same shape, opposite verdict.
//   - PER-ISSUE REASONS reuse bi#48's why-not vocabulary: each parked row
//     carries its BlockedBy triple (blocker, blocker_status, exact edge),
//     where the blocker is the chain parent (the stalled-side edge on
//     fan-in), not an arbitrary unresolved edge.
//
// Two load-bearing decisions live here; everything else is owned:
//   1. ONLY claimed stalls join: a stale Doing WITH holder+lease. An
//      unclaimed Doing has no holder and no silent-since instant, so there is
//      nothing to join on — it stays in stalled.mjs's queue, never here.
//   2. ORDER = blocker id asc; parked rows are BFS root-outward (the BAML
//      order). Live holders are never named in any field of either output.
//
// `node bais/scripts/oversight-join.mjs --check` runs the acceptance fixture
// (tmp dirs, move-unblocked.mjs pattern — nothing committed, nothing
// written): stalled holder + 3-deep chain reports one entry naming all four;
// the same shape under a renewing holder reports nothing and never names the
// holder; an unclaimed blocker reports nothing. Fixture leases are far-past
// (2000-*) / far-future (2099-*), so the check is deterministic at any real
// now. Read-only: the target dir's bytes are snapshotted before/after.
//
// --json shape ({ chains: [...], count }) feeds review triage: each parked
// row carries id + title + its BlockedBy reason, so a reviewer can act
// without re-walking the graph.
//
// Red-check 2026-09-06 (bi#57): sourcing candidates from every Doing list
// row instead of check.staleClaims (deleting the dead-only filter) trips
// join.slow-empty + join.slow-json + join.slow-never-named — the live
// steady-1 leaks `stalled-behind j#01 steady-1 silent since 2099-...`
// (3 FAIL, 5 pass, exit 1); stalled + unclaimed arms stay green, proving the
// hunk is the liveness gate and nothing else. Restored → all 8 green. A join
// that cannot go red on a live leak would report renewing holders as
// stalled: camouflage, not coverage. Re-record on any hunk change.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

// check exits 1 on unrelated gate failures while still printing JSON to
// stdout — so parse stdout whatever the exit code. Fail-closed with a named
// reason when there is no JSON at all (bi#55: never silently empty).
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
		console.error(`oversight-join: no JSON from \`bais ${args.join(" ")}\` in ${dir} (not a bais project?)`);
		process.exit(1);
	}
};

// Mirror of BAML parked_behind (oversight_join.baml): forward-Blocks BFS from
// the stalled root (from = blocker, to = blocked). Traverse only through
// unresolved nodes — Done/Dropped intermediates resolve the block; missing
// ids stay conservative (unresolvable = blocking, same as is_blocked).
const parkedBehind = (blocker, issuesById, edges) => {
	const seen = [blocker];
	const frontier = [blocker];
	let cur;
	while ((cur = frontier.shift()) !== undefined) {
		for (const e of edges) {
			if (e.kind !== "Blocks" || e.from !== cur || seen.includes(e.to)) continue;
			const dep = issuesById.get(e.to);
			if (dep === undefined || (dep.status !== "Done" && dep.status !== "Dropped")) {
				seen.push(e.to);
				frontier.push(e.to);
			}
		}
	}
	return seen.filter((id) => id !== blocker);
};

// Mirror of BAML stalled_chains over check.staleClaims x list rows. Only
// claimed stalls join (holder + lease present); zero-parked roots yield no
// entry — the stall itself already lives in stale-claim.
const chainsIn = (dir) => {
	const chk = runJson(dir, ["check", "--json"]);
	const lst = runJson(dir, ["list", "--json"]);
	const rows = lst.issues ?? [];
	const issuesById = new Map(rows.map((r) => [r.issue.id, r.issue]));
	const edges = rows.flatMap((r) => r.edges ?? []);
	const chains = [];
	for (const s of chk.staleClaims ?? []) {
		if (s.holder == null || s.lease == null) continue;
		const parkedIds = parkedBehind(s.id, issuesById, edges);
		if (!parkedIds.length) continue;
		// Chain parent per parked id: the edge that discovered it (BFS
		// predecessor), so fan-in names the stalled-side edge.
		const parent = new Map();
		const seen = new Set([s.id]);
		const frontier = [s.id];
		let cur;
		while ((cur = frontier.shift()) !== undefined) {
			for (const e of edges) {
				if (e.kind !== "Blocks" || e.from !== cur || seen.has(e.to)) continue;
				const dep = issuesById.get(e.to);
				if (dep === undefined || (dep.status !== "Done" && dep.status !== "Dropped")) {
					seen.add(e.to);
					parent.set(e.to, e);
					frontier.push(e.to);
				}
			}
		}
		const parked = parkedIds.map((id) => {
			const p = parent.get(id);
			const blockerStatus = issuesById.get(p.from)?.status ?? "Missing";
			return {
				id,
				title: issuesById.get(id)?.title ?? "",
				blocker: p.from,
				blocker_status: blockerStatus,
				edge_from: p.from,
				edge_to: p.to,
				edge_kind: p.kind,
			};
		});
		chains.push({
			blocker: s.id,
			holder: s.holder,
			silent_since: s.lease,
			parked_count: parked.length,
			parked,
		});
	}
	chains.sort((a, b) => (a.blocker < b.blocker ? -1 : a.blocker > b.blocker ? 1 : 0));
	return { chains, unparseable: (lst.unparseable ?? []).length };
};

const fmtChain = (c) =>
	`stalled-behind\t${c.blocker}\t${c.holder} silent since ${c.silent_since}\tparked ${c.parked_count}: ${c.parked.map((p) => p.id).join(", ")}`;
const fmtParked = (p) =>
	`  parked\t${p.id}\t${p.title}\tblocked-by ${p.blocker} (${p.blocker_status}) [${p.edge_from} -> ${p.edge_to} ${p.edge_kind}]`;

// --- --check: acceptance fixtures in tmp dirs (nothing committed) ---
const issueToml = (id, title, status, holder, lease, edges = []) => {
	const claim = holder == null ? "" : `holder = "${holder}"\nlease = "${lease}"\n`;
	const es = edges.map((e) => `[[edge]]\nfrom = "${e[0]}"\nto = "${e[1]}"\nkind = "${e[2]}"\n`).join("\n");
	return `id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "Feat"\n${claim}body = "b"\n\n${es}`;
};
const mkfix = () => {
	const d = mkdtempSync(join(tmpdir(), "join50-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "j"\n');
	return d;
};
const chainShape = (dir, lease, holder) => {
	const is = join(dir, ".bais", "issues");
	writeFileSync(join(is, "j#01.toml"), issueToml("j#01", "stalled root", "Doing", holder, lease));
	writeFileSync(join(is, "j#02.toml"), issueToml("j#02", "parked one", "Open", null, null, [["j#01", "j#02", "Blocks"]]));
	writeFileSync(join(is, "j#03.toml"), issueToml("j#03", "parked two", "Open", null, null, [["j#02", "j#03", "Blocks"]]));
	writeFileSync(join(is, "j#04.toml"), issueToml("j#04", "parked three", "Open", null, null, [["j#03", "j#04", "Blocks"]]));
};
const snapshot = (dir) => {
	const is = join(dir, ".bais", "issues");
	return readdirSync(is).sort().map((f) => `${f}\n${readFileSync(join(is, f), "utf8")}`).join("\n");
};

function selfCheck() {
	const runSelf = (args, dir) => {
		try {
			return { code: 0, out: execFileSync("node", [process.argv[1], ...args], { cwd: dir, encoding: "utf8", timeout: 60000 }) };
		} catch (e) {
			return { code: e.status ?? -1, out: ((e.stdout ?? "") + (e.stderr ?? "")).toString() };
		}
	};
	// Arm 1: stalled holder + 3-deep parked chain — one entry naming all four.
	{
		const d = mkfix();
		chainShape(d, "2000-01-01T00:00:00Z", "ghost-1");
		const before = snapshot(d);
		const t = runSelf([d], d);
		const want = [
			"stalled-behind\tj#01\tghost-1 silent since 2000-01-01T00:00:00Z\tparked 3: j#02, j#03, j#04",
			"  parked\tj#02\tparked one\tblocked-by j#01 (Doing) [j#01 -> j#02 Blocks]",
			"  parked\tj#03\tparked two\tblocked-by j#02 (Open) [j#02 -> j#03 Blocks]",
			"  parked\tj#04\tparked three\tblocked-by j#03 (Open) [j#03 -> j#04 Blocks]",
		].join("\n");
		check("join.stalled-rows", t.code === 0 && t.out.trim() === want, JSON.stringify(t));
		const j = runSelf([d, "--json"], d);
		let chains = null;
		try { chains = JSON.parse(j.out).chains; } catch { /* handled below */ }
		check("join.stalled-json", j.code === 0 && chains !== null
			&& chains.length === 1 && chains[0].blocker === "j#01" && chains[0].holder === "ghost-1"
			&& chains[0].silent_since === "2000-01-01T00:00:00Z" && chains[0].parked_count === 3
			&& JSON.stringify(chains[0].parked.map((p) => p.id)) === '["j#02","j#03","j#04"]'
			&& chains[0].parked.every((p) => p.title && p.blocker && p.blocker_status && p.edge_from && p.edge_to && p.edge_kind === "Blocks"), j.out);
		check("join.stalled-readonly", snapshot(d) === before, "target bytes changed");
	}
	// Arm 2: renewing (merely-slow) holder, same shape — nothing, never named.
	{
		const d = mkfix();
		chainShape(d, "2099-01-01T00:00:00Z", "steady-1");
		const before = snapshot(d);
		const t = runSelf([d], d);
		check("join.slow-empty", t.code === 0 && t.out.trim() === "(no stalled chains)", JSON.stringify(t));
		const j = runSelf([d, "--json"], d);
		let count = null;
		try { count = JSON.parse(j.out).count; } catch { /* handled below */ }
		check("join.slow-json", j.code === 0 && count === 0, j.out);
		check("join.slow-never-named", !t.out.includes("steady-1") && !j.out.includes("steady-1"), t.out + j.out);
		check("join.slow-readonly", snapshot(d) === before, "target bytes changed");
	}
	// Arm 3: unclaimed Doing blocker — no holder/silent-since, nothing joins.
	{
		const d = mkfix();
		chainShape(d, null, null);
		const t = runSelf([d], d);
		const j = runSelf([d, "--json"], d);
		let count = null;
		try { count = JSON.parse(j.out).count; } catch { /* handled below */ }
		check("join.unclaimed-empty", t.code === 0 && t.out.trim() === "(no stalled chains)" && count === 0, t.out + j.out);
	}
	if (fail) { console.log(`oversight-join: ${fail} FAIL, ${pass} pass`); process.exit(1); }
	console.log(`oversight-join: all ${pass} green`);
}

const args = process.argv.slice(2);
if (args.includes("--check")) selfCheck();
else {
	const json = args.includes("--json");
	const dir = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
	const { chains, unparseable } = chainsIn(dir);
	if (json) console.log(JSON.stringify({ chains, count: chains.length }, null, 2));
	else if (!chains.length) console.log("(no stalled chains)");
	else for (const c of chains) {
		console.log(fmtChain(c));
		for (const p of c.parked) console.log(fmtParked(p));
	}
	if (unparseable) console.error(`[bais] ${unparseable} unparseable file(s) excluded — \`bais check\` for details`);
}
