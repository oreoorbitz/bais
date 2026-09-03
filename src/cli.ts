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
import { loadPeerKey, appendForeignEvents, publishCheckpoint, verifyCheckpointRoot } from "./hub.js";
import { exportSnapshot, importSnapshot, markBootstrapComplete } from "./store.js";
import { event } from "../baml_sdk/index.js";

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
  bais keygen [--force]             # peer ed25519 identity (.bais/key.json)
  bais checkpoint                   # publish a signed state snapshot
  bais snapshot [--out <file>]      # export fast-bootstrap snapshot JSON
  bais sync --from <url>            # snapshot import + backfill-verify + delta

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
	process.on("unhandledRejection", (e) => console.error(`hub: unhandled rejection: ${String((e as any)?.message ?? e).split("\n")[0]}`));
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

if (cmd === "keygen") {
	ensureInit();
	const { existsSync: ex, unlinkSync } = await import("node:fs");
	const kp = join(root, "key.json");
	if (ex(kp) && !argv.includes("--force")) {
		const cur = loadPeerKey(root);
		console.log(`keeping ${kp} (${cur.did}) — pass --force to rotate`);
		process.exit(0);
	}
	if (ex(kp)) unlinkSync(kp);
	const key = loadPeerKey(root);
	console.log(`${kp}\n${key.did}`);
	process.exit(0);
}

if (cmd === "checkpoint") {
	ensureInit();
	try {
		const cp = await publishCheckpoint(issuesDir);
		console.log(asJson ? JSON.stringify({ checkpoint: cp }, null, 2) : `checkpoint ${cp.id} lc=${cp.lc} root=${cp.state_root.slice(0, 12)}…`);
	} catch (e: any) {
		console.error(`checkpoint: ${String(e?.message ?? e).split("\n")[0]}`);
		process.exit(1);
	}
	process.exit(0);
}

if (cmd === "snapshot") {
	ensureInit();
	const snap = exportSnapshot(issuesDir);
	if (!snap.checkpoint) {
		console.error("snapshot: no checkpoint published — run `bais checkpoint` first");
		process.exit(1);
	}
	const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
	const text = JSON.stringify({ snapshot: snap }, null, 2);
	if (out) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(out, text);
		console.error(`snapshot ${snap.checkpoint.id} → ${out}`);
	} else {
		console.log(text);
	}
	process.exit(0);
}

if (cmd === "sync") {
	// Fast bootstrap + verified replication (Phase 4 step 12/13):
	// snapshot import (instant TOFU reads) → delta pull → backfill the
	// covered log → recompute state_root → writes unlock only on match.
	// A root mismatch keeps tables readable but writes blocked (restart
	// the hub after resolving — divergence alarm, report failure mode #2).
	ensureInit();
	const fi = argv.indexOf("--from");
	const peer = fi !== -1 ? argv[fi + 1] : null;
	if (!peer) {
		console.error("sync needs --from <hub url>");
		process.exit(1);
	}
	const get = async (path: string): Promise<any> => {
		const r = await fetch(`${peer}${path}`);
		if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
		return r.json();
	};
	try {
		const { snapshot } = (await get("/snapshot")) as any;
		if (!snapshot?.checkpoint) throw new Error("peer has no checkpoint — cannot anchor bootstrap");
		importSnapshot(issuesDir, snapshot, peer);
		console.error(`imported snapshot ${snapshot.checkpoint.id} (lc=${snapshot.checkpoint.lc})`);
		const cp = snapshot.checkpoint;
		// Backfill FIRST: delta chains only link onto a complete local log.
		const full = (await get("/sync")) as any;
		const covered = (full.events ?? []).filter((e: any) => e.lc <= cp.lc);
		const missing = cp.heads.filter((h: string) => !covered.some((e: any) => e.id === h));
		if (missing.length) throw new Error(`backfill incomplete: missing covered heads ${missing.join(",")}`);
		const b = await appendForeignEvents(issuesDir, covered, { mode: "backfill" });
		if (b.rejected.length) throw new Error(`backfill rejected: ${b.rejected.map((r) => `${r.id}=${r.reason}`).join(",")}`);
		console.error(`backfill: ${b.accepted.length} events replayed`);
		// Cryptographic trust establishment: re-derive the root locally.
		const { DatabaseSync } = await import("node:sqlite");
		const { resolve } = await import("node:path");
		const db = new DatabaseSync(resolve(issuesDir, "..", "store.db"));
		const rows = db.prepare("SELECT * FROM events ORDER BY lc, id").all() as any[];
		db.close();
		const reduction = await (event as any).reduce(
			rows.map((r) => ({
				...r,
				refs: JSON.parse(r.refs),
				body: JSON.parse(r.body),
				sig: r.sig ?? null,
				admitted: r.admitted === 1,
				drop_reason: r.drop_reason,
			})),
		);
		if (!verifyCheckpointRoot(reduction, cp.state_root)) throw new Error("state_root mismatch — divergence alarm, writes stay blocked");
		// Root matches: pull the post-checkpoint delta, then unlock writes.
		const delta = (await get(`/sync?since_lc=${cp.lc}`)) as any;
		const d = await appendForeignEvents(issuesDir, delta.events ?? [], { mode: "delta" });
		console.error(`delta: ${d.accepted.length} accepted, ${d.rejected.length} rejected`);
		markBootstrapComplete(issuesDir);
		console.error(`verified root ${cp.state_root.slice(0, 12)}… — writes unlocked`);
		if (asJson) console.log(JSON.stringify({ checkpoint: cp.id, verified: true }, null, 2));
	} catch (e: any) {
		console.error(`sync: ${String(e?.message ?? e).split("\n")[0]}`);
		process.exit(1);
	}
	process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
help();
process.exit(1);
