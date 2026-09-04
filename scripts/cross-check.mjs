// bais/scripts/cross-check.mjs — read-only store-vs-scan consistency check.
//
// BAML owns the rules; this script only compares. It answers list/ready/graph
// from the SQLite projection (store.db) and from a fresh directory scan, and
// fails LOUD: printed diffs show BOTH sides (store vs scan).
//
// Run (daily, from repo root): node bais/scripts/cross-check.mjs [issues-dir]
//   default issues-dir: bi/.bais/issues
// Read-only: never writes to the issues dir (or anywhere else). Exits non-zero
// on any divergence; store staleness (projection older than newest *.toml) is
// a warning only.

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { dbPathFor, hasStore, storeEdges, storeGraph, storeList, storeReady } from "../dist/src/store.js";
import { loadIssues, readyIssues } from "../dist/src/graph.js";

const issuesDir = resolve(process.argv[2] ?? "bi/.bais/issues");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const fmt = (xs) => (xs.length ? xs.join(", ") : "(none)");
const sorted = (xs) => [...new Set(xs)].sort();
const asSet = (xs) => new Set(xs);

// ---------------------------------------------------------------- G-strict (bi#60)
// Injected-violation proof for the strict-TOML unknown-key gate
// (bais/baml_src/ns_toml/toml.baml:399 `unknown top-level key`): a file that
// is graph-valid in every other respect plus one unknown key must be (a)
// caught by the strict gate and (b) missed by every pre-existing check.
// Observed 2026-09-04 (tmp fixture, in-process): scan failures name the
// file while the surviving graph stays clean — the graph layer cannot even
// see the violation, which is exactly the gap the gate closes.
{
	const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const gd = mkdtempSync(join(tmpdir(), "bais-gstrict-"));
	const gi = join(gd, ".bais", "issues");
	mkdirSync(gi, { recursive: true });
	writeFileSync(join(gi, "g#01.toml"), `id = "g#01"\ntitle = "good"\nstatus = "Open"\nkind = "Feat"\nbody = "x"\n`);
	// Graph-valid (resolvable Blocks edge, exact-case enums) + one unknown key.
	writeFileSync(join(gi, "bad.toml"),
		`id = "g#02"\ntitle = "sneaky"\nstatus = "Open"\nkind = "Feat"\nbody = "x"\nfrobnicate = "evil"\n\n[[edge]]\nfrom = "g#01"\nto = "g#02"\nkind = "Blocks"\n`);
	const got = await loadIssues(gi);
	// (a) the new gate catches it: the strict parser rejects the file.
	check(got.failures.length === 1 && got.failures[0].file === "bad.toml" && /unknown top-level key/.test(got.failures[0].error),
		`G-strict(a): strict gate rejects the unknown-key file (${got.failures.map((f) => f.file).join(",")})`);
	// (b) every pre-existing check misses it: the surviving graph is a clean
	// world — g#01 parses, nothing dangles (the bad edge died with the bad
	// file), nothing cycles, g#01 even reads ready. The graph layer reports
	// zero problems while the unknown-key violation slips past it entirely.
	const gSurvivorsReady = readyIssues(got.issues).map((f) => f.issue.id);
	check(got.issues.length === 1 && JSON.stringify(gSurvivorsReady) === '["g#01"]',
		`G-strict(b): pre-existing graph checks see a clean world (ready ${gSurvivorsReady.join(",")}, zero problems)`);
}

if (!existsSync(issuesDir)) {
	console.error(`FAIL: issues dir missing: ${issuesDir}`);
	process.exit(1);
}

// Staleness is a WARNING, not a failure: the projection may legitimately lag
// the directory. Compare store.db mtime against the newest *.toml mtime.
try {
	const dbPath = dbPathFor(issuesDir);
	if (!hasStore(issuesDir)) {
		console.error(`FAIL: no store at ${dbPath} — store answers unavailable (re-ingest; scan has no baseline to compare)`);
		process.exit(1);
	}
	const tomls = readdirSync(issuesDir).filter((f) => f.endsWith(".toml"));
	const newestToml = tomls.reduce((m, f) => Math.max(m, statSync(resolve(issuesDir, f)).mtimeMs), 0);
	const dbMtime = statSync(dbPath).mtimeMs;
	if (tomls.length && dbMtime < newestToml) {
		console.error(
			`WARN: store is stale: store.db mtime ${new Date(dbMtime).toISOString()} older than newest *.toml mtime ${new Date(newestToml).toISOString()} — divergences below may be lag, re-ingest to confirm`,
		);
	} else {
		console.log(`ok: store is fresh (store.db >= newest *.toml mtime)`);
	}
} catch (e) {
	console.error(`FAIL: staleness probe errored: ${e?.message ?? e}`);
	process.exit(1);
}

// Fresh scan answers (host graph mirrors — BAML owns the rules).
const { issues: files, failures: scanFailures } = await loadIssues(issuesDir);
if (scanFailures.length) {
	for (const f of scanFailures) console.error(`FAIL: scan could not parse ${f.file}: ${f.error.split("\n")[0]}`);
	failures += scanFailures.length;
}
const scanById = new Map(files.map((f) => [f.issue.id, f]));
const scanEdges = files.flatMap((f) => f.edges.map((e) => ({ ...e, declaredBy: f.issue.id })));
const scanReady = new Set(readyIssues(files).map((f) => f.issue.id));

// Store answers.
const storeed = storeList(issuesDir);
const storeReadyRes = storeReady(issuesDir);
const storeEdgeRows = storeEdges(issuesDir);
const storeById = new Map(storeed.tasks.map((t) => [t.entity, t]));

// 1. list: id sets.
{
	const scanIds = sorted([...scanById.keys()]);
	const storeIds = sorted([...storeById.keys()]);
	const sScan = asSet(scanIds);
	const sStore = asSet(storeIds);
	const missingInStore = scanIds.filter((id) => !sStore.has(id));
	const extraInStore = storeIds.filter((id) => !sScan.has(id));
	const same = missingInStore.length === 0 && extraInStore.length === 0;
	if (!same) {
		failures++;
		console.error(`FAIL: list id sets diverge`);
		console.error(`  scan-only  (missing in store): ${fmt(missingInStore)}`);
		console.error(`  store-only (missing in scan):  ${fmt(extraInStore)}`);
		console.error(`  scan ids:  ${fmt(scanIds)}`);
		console.error(`  store ids: ${fmt(storeIds)}`);
	} else console.log(`ok: list ids match (${scanIds.length} issues)`);
}

// 2. list: statuses for ids present on both sides.
{
	const div = [];
	for (const [id, f] of scanById) {
		const t = storeById.get(id);
		if (t && t.status !== f.issue.status) div.push({ id, scan: f.issue.status, store: t.status });
	}
	if (div.length) {
		failures++;
		console.error(`FAIL: ${div.length} status divergence(s)`);
		for (const d of div) console.error(`  ${d.id}: scan=${d.scan} store=${d.store}`);
	} else console.log(`ok: list statuses match`);
}

// 3. ready set.
{
	const scanR = sorted([...scanReady]);
	const storeR = sorted(storeReadyRes.ready.map((t) => t.entity));
	const sScan = asSet(scanR);
	const sStore = asSet(storeR);
	const missingInStore = scanR.filter((id) => !sStore.has(id));
	const extraInStore = storeR.filter((id) => !sScan.has(id));
	if (missingInStore.length || extraInStore.length) {
		failures++;
		console.error(`FAIL: ready sets diverge`);
		console.error(`  scan-only  (ready in scan, not store): ${fmt(missingInStore)}`);
		console.error(`  store-only (ready in store, not scan): ${fmt(extraInStore)}`);
		console.error(`  scan ready:  ${fmt(scanR)}`);
		console.error(`  store ready: ${fmt(storeR)}`);
	} else console.log(`ok: ready sets match (${scanR.length} ready)`);
}

// 4. graph: global edge sets (source|type|target triples — what traversal acts on).
// bi#58: the ?? arms are not membership-where-equality-belongs — scan edges
// carry from/to/kind while store rows carry source/type/target (documented
// wire-shape bridge); both arms feed the same exact-triple comparison below.
const triple = (e) => `${e.from ?? e.source}|${e.kind ?? e.type}|${e.to ?? e.target}`;
{
	const scanT = sorted(scanEdges.map(triple));
	const storeT = sorted(storeEdgeRows.map((r) => `${r.source}|${r.type}|${r.target}`));
	const sScan = asSet(scanT);
	const sStore = asSet(storeT);
	const missingInStore = scanT.filter((t) => !sStore.has(t));
	const extraInStore = storeT.filter((t) => !sScan.has(t));
	if (missingInStore.length || extraInStore.length) {
		failures++;
		console.error(`FAIL: edge sets diverge`);
		for (const t of missingInStore) {
			const e = scanEdges.find((x) => triple(x) === t);
			console.error(`  scan-only edge:  ${t} (declaredBy=${e?.declaredBy})`);
		}
		for (const t of extraInStore) {
			const r = storeEdgeRows.find((x) => `${x.source}|${x.type}|${x.target}` === t);
			console.error(`  store-only edge: ${t} (id=${r?.id} declaredBy=${r?.declaredBy})`);
		}
		console.error(`  scan edges:  ${scanT.length} total: ${fmt(scanT)}`);
		console.error(`  store edges: ${storeT.length} total: ${fmt(storeT)}`);
	} else console.log(`ok: edge sets match (${scanT.length} edges)`);
}

// 5. graph: per-node reachability — storeGraph(from) vs BFS both directions
// over the scan edges (mirrors the recursive CTE, both directions).
{
	const adj = new Map();
	const link = (a, b) => {
		if (!adj.has(a)) adj.set(a, new Set());
		adj.get(a).add(b);
	};
	for (const e of scanEdges) {
		link(e.from, e.to);
		link(e.to, e.from);
	}
	const bfs = (from) => {
		const seen = new Set([from]);
		const q = [from];
		while (q.length) {
			for (const n of adj.get(q.pop()) ?? []) {
				if (!seen.has(n)) {
					seen.add(n);
					q.push(n);
				}
			}
		}
		// The store CTE can reach dangling ids but the task join drops them:
		// only known ids are comparable.
		return sorted([...seen].filter((id) => scanById.has(id)));
	};
	const div = [];
	for (const id of scanById.keys()) {
		const storeNodes = sorted(storeGraph(issuesDir, id).nodes.map((t) => t.entity));
		const scanNodes = bfs(id);
		if (storeNodes.join("\0") !== scanNodes.join("\0")) div.push({ id, scanNodes, storeNodes });
	}
	// Nodes the store knows but the scan does not (id-set divergence already
	// reported above, but their graph answers would throw the BFS off).
	for (const id of storeById.keys()) {
		if (!scanById.has(id)) {
			const storeNodes = sorted(storeGraph(issuesDir, id).nodes.map((t) => t.entity));
			div.push({ id, scanNodes: [], storeNodes });
		}
	}
	if (div.length) {
		failures++;
		console.error(`FAIL: ${div.length} graph reachability divergence(s)`);
		for (const d of div.slice(0, 20)) {
			console.error(`  from ${d.id}:`);
			console.error(`    scan:  ${fmt(d.scanNodes)}`);
			console.error(`    store: ${fmt(d.storeNodes)}`);
		}
		if (div.length > 20) console.error(`  ... and ${div.length - 20} more`);
	} else console.log(`ok: graph reachability matches for all ${scanById.size} nodes`);
}

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("cross-check: all green");
