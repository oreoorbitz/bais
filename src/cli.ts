#!/usr/bin/env node
// bais — BAIS CLI (file-per-issue, git is the hosting). LLM's main path is --json.
//
// Reads prefer the SQLite projection (.bais/store.db, built by `bais ingest`
// from the TOML seed through the BAML reducer) and fall back to the readdir
// scan when no store exists. `check` validates the *issue files*; it is not
// `baml check`, which validates bais's own BAML source.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cyclicIds, danglingRefsIn, loadIssues, projectName, readyIssues } from "./graph.js";
import { hasStore, ingestIssues, storeCheck, storeEdges, storeGraph, storeList, storeReady } from "./store.js";
import { createHub } from "./hub.js";

const root = ".bais";
const issuesDir = join(root, "issues");

function help(): void {
	console.log(`bais — Basically A made-up Issue Standard

Usage:
  bais init
  bais ingest [--json]              # build .bais/store.db from issues/*.toml via the BAML reducer
  bais list [--json]
  bais ready [--json]               # carries as_of + completeness from the store
  bais check [--json]
  bais graph --from <id> [--json]   # recursive CTE from the store, BFS fallback
  bais hub [--port N]               # lease coordinator (Phase 3), serves until SIGINT

Not yet implemented:
  bais new "title" --kind bug [--area bridge/ffi] [--status open]
  bais move <id> <status>

One Issue = one file in .bais/issues/<id>.toml, git is the hosting.
`);
}

function ensureInit(): void {
	if (!existsSync(root)) {
		console.error("No .bais — run bais init");
		process.exit(1);
	}
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const asJson = argv.includes("--json");

if (cmd === "init") {
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(root, "config.toml"), 'project = "bais"\n');
	console.log("Initialized .bais");
	process.exit(0);
}

if (!cmd || argv.includes("--help") || argv.includes("-h")) {
	help();
	process.exit(cmd ? 0 : 1);
}

// Projection-first: every read below uses the store when present, so the
// recursive-CTE path and the scan path must agree (verified by replaying both
// in development). Dropping store.db always rebuilds from the TOML seed.
const useStore = hasStore(issuesDir);

if (cmd === "ingest") {
	ensureInit();
	const res = await ingestIssues(issuesDir);
	if (asJson) console.log(JSON.stringify({ store: ".bais/store.db", ...res }, null, 2));
	else console.log(`ingested ${res.events} events (${res.failures} unparseable) → .bais/store.db`);
	process.exit(0);
}

if (cmd === "list") {
	ensureInit();
	if (useStore) {
		const { tasks, as_of, completeness } = storeList(issuesDir);
		const edges = storeEdges(issuesDir);
		const issues = tasks.map((t) => ({
			issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
			edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
		}));
		if (asJson) {
			console.log(JSON.stringify({ issues, unparseable: [], as_of, completeness }, null, 2));
		} else {
			for (const f of issues) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}`);
		}
	} else {
		const { issues, failures } = await loadIssues(issuesDir);
		if (asJson) {
			console.log(JSON.stringify({ issues, unparseable: failures }, null, 2));
		} else {
			for (const f of issues) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}`);
			for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
			if (!issues.length && !failures.length) console.error("(no .bais/issues/*.toml — run bais init or add issues)");
		}
	}
	process.exit(0);
}

if (cmd === "ready") {
	ensureInit();
	if (useStore) {
		// The one agent-dispatch query, indexed — not a readdir scan.
		const { ready, as_of, completeness } = storeReady(issuesDir);
		const edges = storeEdges(issuesDir);
		const files = ready.map((t) => ({
			issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
			edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
		}));
		if (asJson) {
			console.log(JSON.stringify({ ready: files, unparseable: [], as_of, completeness }, null, 2));
		} else {
			for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}`);
			if (!files.length) console.log("(no ready issues)");
		}
	} else {
		const { issues, failures } = await loadIssues(issuesDir);
		const ready = readyIssues(issues);
		if (asJson) {
			console.log(JSON.stringify({ ready, unparseable: failures }, null, 2));
		} else {
			for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}`);
			if (!ready.length) console.log("(no ready issues)");
			// A file that failed to parse is absent from the graph, so both the
			// ready set and the edges that would have constrained it are short.
			if (failures.length) {
				console.error(`[bais] ${failures.length} unparseable file(s) excluded — \`bais check\` for details`);
			}
		}
	}
	process.exit(0);
}

if (cmd === "graph") {
	ensureInit();
	const fromIdx = argv.indexOf("--from");
	const from = fromIdx !== -1 ? argv[fromIdx + 1] : undefined;
	if (!from) {
		console.error("bais graph requires --from <id>");
		process.exit(1);
	}
	if (useStore) {
		const { nodes, as_of, completeness } = storeGraph(issuesDir, from);
		const edges = storeEdges(issuesDir);
		const files = nodes.map((t) => ({
			issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
			edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
		}));
		if (asJson) console.log(JSON.stringify({ from, nodes: files, as_of, completeness }, null, 2));
		else for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}`);
	} else {
		// No store: BFS over the scan (same traversal bi's graphBaisIssues does).
		const { issues } = await loadIssues(issuesDir);
		const edges = issues.flatMap((f) => f.edges);
		const seen = new Set<string>([from]);
		const queue = [from];
		while (queue.length) {
			const cur = queue.shift()!;
			for (const e of edges) {
				for (const nxt of [e.from, e.to]) {
					if ((e.from === cur || e.to === cur) && !seen.has(nxt)) {
						seen.add(nxt);
						queue.push(nxt);
					}
				}
			}
		}
		const files = [...seen].flatMap((id) => issues.filter((f) => f.issue.id === id));
		if (asJson) console.log(JSON.stringify({ from, nodes: files }, null, 2));
		else for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}`);
	}
	process.exit(0);
}

if (cmd === "check") {
	ensureInit();
	if (useStore) {
		const { ok, bad, dangling, cycles } = storeCheck(issuesDir);
		const missing = dangling.filter((d) => d.status === "Missing");
		const external = dangling.filter((d) => d.status === "External");
		if (asJson) {
			console.log(JSON.stringify({ ok, bad, dangling, cycles }, null, 2));
		} else {
			for (const d of missing) console.log(`dangling\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
			for (const d of external) console.log(`external\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
			if (cycles.length) console.log(`cycle\t${cycles.join(", ")}`);
			console.log(`ok\t${ok} issues, ${bad.length} bad`);
		}
		if (bad.length || missing.length || cycles.length) process.exit(1);
	} else {
		const { issues, failures } = await loadIssues(issuesDir);
		const dangling = danglingRefsIn(issues, projectName(issuesDir));
		const missing = dangling.filter((d) => d.status === "Missing");
		const external = dangling.filter((d) => d.status === "External");
		const cycles = cyclicIds(issues);

		if (asJson) {
			console.log(JSON.stringify({ ok: issues.length, bad: failures, dangling, cycles }, null, 2));
		} else {
			for (const f of issues) console.log(`ok\t${f.issue.id}`);
			for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
			// A Blocks edge naming an id that does not exist parks its target
			// indefinitely — is_blocked treats an unresolvable blocker as blocking.
			for (const d of missing) console.log(`dangling\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
			// Another project's id is not resolvable from here. Reported so a typo'd
			// prefix stays visible, but not a failure.
			for (const d of external) console.log(`external\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
			// Nothing in a dependency cycle can ever become ready.
			if (cycles.length) console.log(`cycle\t${cycles.join(", ")}`);
		}

		// External is reported, never fatal — a cross-project edge is legitimate and
		// unresolvable from one directory. Applies to --json too: the old check
		// exited 0 in JSON mode, which made it useless as a CI gate.
		if (failures.length || missing.length || cycles.length) process.exit(1);
	}
	process.exit(0);
}

if (cmd === "hub") {
	// Linearizable lease coordinator (Phase 3). Optional local process:
	// `bais hub [--port N]` serves until SIGINT. Requires an ingested
	// store; refuses hub-only boot (see hub.ts header for v1 limits).
	ensureInit();
	let port = 0;
	const pi = argv.indexOf("--port");
	if (pi !== -1 && pi + 1 < argv.length) port = Number(argv[pi + 1]) || 0;
	try {
		const { hub } = await createHub(issuesDir, { port });
		console.error(`bais hub listening on :${hub.port} (store: ${join(root, "store.db")})`);
		await new Promise<void>((resolve) => {
			const stop = () => {
				hub.close().then(() => resolve(), () => resolve());
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
		});
	} catch (e: any) {
		console.error(`hub: ${String(e?.message ?? e).split("\n")[0]}`);
		process.exit(1);
	}
	process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
help();
process.exit(1);
