#!/usr/bin/env node
// bais — BAIS CLI (file-per-issue, git is the hosting). LLM's main path is --json.
//
// Reads prefer the SQLite projection (.bais/store.db, built by `bais ingest`
// from the TOML seed through the BAML reducer) and fall back to the readdir
// scan when no store exists. `check` validates the *issue files*; it is not
// `baml check`, which validates bais's own BAML source.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cyclicIds, danglingRefsIn, loadIssues, projectName, readyIssues, whyNotIn } from "./graph.js";
import { parseBaisFile } from "./toml.js";
import type { WhyNot } from "./graph.js";
import { hasStore, ingestIssues, storeCaps, storeCheck, storeEdges, storeGraph, storeList, storeOversight, storeReady, storeSample, storeWhyNot } from "./store.js";
import { createHub } from "./hub.js";
import { loadPeerKey, appendForeignEvents, publishCheckpoint, verifyCheckpointRoot } from "./hub.js";
import { exportSnapshot, importSnapshot, markBootstrapComplete, recordImportedAnchor } from "./store.js";
import { event, mcp_tools } from "../baml_sdk/index.js";

const root = ".bais";
const issuesDir = join(root, "issues");

function help(): void {
	console.log(`bais — Basically A made-up Issue Standard

Usage:
  bais init
  bais ingest [--json]              # build .bais/store.db from issues/*.toml via the BAML reducer
  bais list [--json]
  bais ready [--json] [--why-not] [--wait [--timeout N]]
                                # carries as_of + completeness from the store
  bais move <id> <status> [--json]  # prints newly-unblocked set
  bais check [--json]
  bais graph --from <id> [--json]   # recursive CTE from the store, BFS fallback
  bais hub [--port N]               # lease coordinator (Phase 3), serves until SIGINT
  bais keygen [--force]             # peer ed25519 identity (.bais/key.json)
  bais checkpoint                   # publish a signed state snapshot
  bais snapshot [--out <file>]      # export fast-bootstrap snapshot JSON
  bais sync --from <url>            # snapshot import + backfill-verify + delta
  bais oversight [--json]           # exception feeds (conflicts, overruns, unverified, stalled, caps)
  bais sample <n> [--seed s]        # deterministic sample of Done work for review
  bais caps [--audience did]        # live capability view
  bais grant <aud> --can a,b --scope S --expiry-lc N --hub URL
  bais revoke <grant-id> --revoker did --hub URL   # the kill switch

Not yet implemented:
  bais new "title" --kind bug [--area bridge/ffi] [--status open]

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

// One omission, one tab-separated line. Kinds mirror BAML WhyNotKind; each
// line names the exact edge/lease/cycle behind the omission.
function printWhyNot(reasons: WhyNot[]): void {
	for (const r of reasons) {
		if (r.kind === "BlockedBy") {
			console.log(`why-not\t${r.id}\tblocked-by ${r.blocker} (${r.blocker_status}) [${r.edge_from} -> ${r.edge_to} ${r.edge_kind}]`);
		} else if (r.kind === "DanglingRef") {
			console.log(`why-not\t${r.id}\tdangling-ref ${r.ref_side}=${r.ref_id} (${r.ref_status}) [${r.edge_from} -> ${r.edge_to} ${r.edge_kind}]`);
		} else if (r.kind === "InCycle") {
			console.log(`why-not\t${r.id}\tin-cycle [${(r.cycle ?? []).join(", ")}]`);
		} else {
			console.log(`why-not\t${r.id}\tleased-to ${r.holder} (expires_lc ${r.expires_lc ?? "null"})`);
		}
	}
}

// bi#45: blocking `ready --wait [--timeout N]`. The waiter sleeps until an
// admitted event touches the store, then re-evaluates readiness exactly once
// (fall-through to the normal render below). Wake primitive: stat-only watch
// of store.db (store path) plus the issues directory listing + per-file
// mtime/size (scan path, and the store-appears flip). The sleep loop performs
// ZERO readiness evaluations — no storeReady/loadIssues calls, only
// statSync/readdirSync — so a waiter with no matching work never spin-polls.
// No hub change was needed: every admission path (hub writes,
// appendForeignEvents, ingest) rewrites store.db, so its mtime+size is the
// store-touch signal all writers share. The live-push path (SSE) stays in
// bi's subscriber (bi#44); this is the offline/poll-confirm counterpart.
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function storeTouchSig(): string {
	const parts: string[] = [];
	try {
		const st = statSync(join(root, "store.db"));
		parts.push(`db:${st.mtimeMs}:${st.size}`);
	} catch {
		parts.push("db:absent");
	}
	let names: string[] = [];
	try {
		names = readdirSync(issuesDir).filter((f) => f.endsWith(".toml")).sort();
	} catch {
		names = [];
	}
	for (const n of names) {
		try {
			const s = statSync(join(issuesDir, n));
			parts.push(`${n}@${s.mtimeMs}:${s.size}`);
		} catch {
			parts.push(`${n}@?`);
		}
	}
	return parts.join(",");
}

function optValue(name: string): string | undefined {
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	const pref = argv.find((a) => a.startsWith(`${name}=`));
	return pref ? pref.slice(name.length + 1) : undefined;
}

if (cmd === "ready") {
	ensureInit();
	// --why-not is a pure addition: without it every line below is exactly the
	// old output. With it, each Open-but-unready issue carries its reason.
	const whyNot = argv.includes("--why-not");
	const wait = argv.includes("--wait");
	if (wait) {
		// Timeout is seconds; expiry prints the (empty) result with exit 0.
		const rawTimeout = optValue("--timeout");
		let timeoutMs = Infinity;
		if (rawTimeout !== undefined) {
			const secs = Number(rawTimeout);
			if (!Number.isFinite(secs) || secs < 0) {
				console.error("bais ready --wait needs --timeout <non-negative seconds>");
				process.exit(1);
			}
			timeoutMs = secs * 1000;
		}
		// One predicate eval up front to decide whether waiting is needed;
		// a non-empty set prints immediately with no sleep at all.
		let isEmpty: boolean;
		if (useStore) isEmpty = storeReady(issuesDir).ready.length === 0;
		else isEmpty = readyIssues((await loadIssues(issuesDir)).issues).length === 0;
		if (isEmpty) {
			const before = storeTouchSig();
			const t0 = Date.now();
			let delay = 25;
			let lastSig = before;
			let stable = 0;
			for (;;) {
				const elapsed = Date.now() - t0;
				if (elapsed >= timeoutMs) break;
				await sleepMs(Math.min(delay, timeoutMs - elapsed));
				delay = Math.min(delay * 1.5, 250);
				const sig = storeTouchSig();
				if (sig === before) continue;
				// Touched — but the writer (ingest/hub/sync) may still hold
				// the SQLite lock mid-rebuild. Settle: require the signature
				// stable across 3 consecutive polls, then one grace beat so
				// the writer can exit and release the lock before the single
				// fresh evaluation below. Timeout still bounds the whole wait.
				if (sig === lastSig) {
					stable += 1;
					if (stable >= 3) {
						await sleepMs(Math.min(150, Math.max(0, timeoutMs - (Date.now() - t0))));
						break;
					}
				} else {
					stable = 0;
					lastSig = sig;
					delay = 25;
				}
			}
		}
		// Fall through: the normal render below re-evaluates exactly once
		// over the fresh store (or the unchanged one on timeout expiry).
	}
	if (useStore) {
		// The one agent-dispatch query, indexed — not a readdir scan.
		const { ready, as_of, completeness } = storeReady(issuesDir);
		const edges = storeEdges(issuesDir);
		const files = ready.map((t) => ({
			issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
			edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
		}));
		const reasons = whyNot ? storeWhyNot(issuesDir).reasons : [];
		if (asJson) {
			console.log(
				JSON.stringify(
					whyNot
						? { ready: files, why_not: reasons, unparseable: [], as_of, completeness }
						: { ready: files, unparseable: [], as_of, completeness },
					null,
					2,
				),
			);
		} else {
			for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}`);
			if (!files.length) console.log("(no ready issues)");
			printWhyNot(reasons);
		}
	} else {
		const { issues, failures } = await loadIssues(issuesDir);
		const ready = readyIssues(issues);
		// No store means no leases table, so the scan path reasons over the
		// graph alone (leases only exist once a store is ingested).
		const reasons = whyNot ? whyNotIn(issues, projectName(issuesDir)) : [];
		if (asJson) {
			console.log(
				JSON.stringify(
					whyNot ? { ready, why_not: reasons, unparseable: failures } : { ready, unparseable: failures },
					null,
					2,
				),
			);
		} else {
			for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}`);
			if (!ready.length) console.log("(no ready issues)");
			printWhyNot(reasons);
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

// bi#49: `bais move <id> <status>` prints what the transition unblocked.
// Read-only derivation, no new policy: the readiness predicate is BAML-owned
// (mirrored by readyIssues/storeReady, reused unchanged), evaluated before
// and after the edit; the newly-unblocked set is after-minus-before by id.
// The move itself is a surgical `status = "..."` line edit (comments and
// formatting elsewhere in the file are preserved), validated by re-parsing
// through the BAML parser with restore-on-failure. When a store exists it is
// rebuilt via ingest so the projection never goes stale behind the files
// (same documented v1 limit as any ingest: hub/sync-appended events are
// dropped by a seed rebuild — back up store.db on a live hub first).
// Output follows the tab-separated conventions (`list`, `ready --why-not`):
// `moved\t<id>\t<old>\t<new>` plus one `unblocked\t<id>\t<title>` line
// per freed issue (sorted by id; nothing extra when the set is empty), and
// --json carries the unblocked ids for scripting.
if (cmd === "move") {
	ensureInit();
	const id = argv[1];
	const to = argv[2];
	const valid = ["Open", "Doing", "Blocked", "Done", "Dropped"];
	if (!id || !to || !valid.includes(to)) {
		console.error(`bais move <id> <status> — status one of ${valid.join("|")}`);
		process.exit(1);
	}
	const readyIds = async (): Promise<Set<string>> => {
		if (useStore) return new Set(storeReady(issuesDir).ready.map((t) => t.entity));
		const { issues } = await loadIssues(issuesDir);
		return new Set(readyIssues(issues).map((f) => f.issue.id));
	};
	const readyList = async (): Promise<{ id: string; title: string }[]> => {
		if (useStore) return storeReady(issuesDir).ready.map((t) => ({ id: t.entity, title: t.title }));
		const { issues } = await loadIssues(issuesDir);
		return readyIssues(issues).map((f) => ({ id: f.issue.id, title: f.issue.title }));
	};
	const before = await readyIds();
	const file = join(issuesDir, `${id}.toml`);
	if (!existsSync(file)) {
		console.error(`bais move: unknown issue ${id}`);
		process.exit(1);
	}
	const orig = readFileSync(file, "utf8");
	const statusMatch = /^\s*status\s*=\s*"[^"]*"/m.exec(orig);
	if (!statusMatch) {
		console.error(`bais move: ${id}.toml has no status line`);
		process.exit(1);
	}
	const from = /"([^"]*)"/.exec(statusMatch[0])?.[1] ?? "";
	const next = orig.replace(statusMatch[0], `status = "${to}"`);
	writeFileSync(file, next);
	try {
		await parseBaisFile(next);
	} catch (e: any) {
		writeFileSync(file, orig);
		console.error(`bais move: edited ${id}.toml rejected (${String(e?.message ?? e).split("\n")[0]}) — restored`);
		process.exit(1);
	}
	if (useStore) await ingestIssues(issuesDir);
	const unblocked = (await readyList())
		.filter((r) => !before.has(r.id))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (asJson) {
		console.log(JSON.stringify({ moved: { id, from, to }, unblocked }, null, 2));
	} else {
		console.log(`moved\t${id}\t${from}\t${to}`);
		for (const u of unblocked) console.log(`unblocked\t${u.id}\t${u.title}`);
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

if (cmd === "oversight") {
	// Exception feeds, queryable not scrollable (Phase 5, step 16).
	// Local-first: reads the projection, no hub needed.
	ensureInit();
	if (!useStore) {
		console.error("oversight needs .bais/store.db — run bais ingest");
		process.exit(1);
	}
	const o = storeOversight(issuesDir);
	if (asJson) {
		console.log(JSON.stringify(o, null, 2));
	} else {
		console.log(`conflicts\t${o.conflicts.length}`);
		for (const c of o.conflicts) console.log(`  ${c.entity}\t${c.field}\t${c.options.join("|")}\t@lc${c.at_lc}`);
		console.log(`budget_overruns\t${o.budget_overruns.length}`);
		for (const b of o.budget_overruns) console.log(`  ${b.principal}\t${b.incurred} > ${b.cap}`);
		console.log(`unverified_submits\t${o.unverified_submits.length}`);
		for (const s of o.unverified_submits) console.log(`  ${s.submit_id}\t${s.task}\tby ${s.producer}`);
		console.log(`stalled_leases\t${o.stalled_leases.length}`);
		for (const l of o.stalled_leases) console.log(`  ${l.id}\t${l.task}\tholder ${l.holder}`);
		console.log(`caps_over_budget\t${o.caps_over_budget.length}`);
		for (const c of o.caps_over_budget) console.log(`  ${c.grant_id}\t${c.audience}\tspent ${c.incurred} > cap ${c.budget_cap_usd}`);
	}
	process.exit(0);
}

if (cmd === "sample") {
	// Deterministic sample of completed (Done) work for human review.
	ensureInit();
	if (!useStore) {
		console.error("sample needs .bais/store.db — run bais ingest");
		process.exit(1);
	}
	const n = Number(argv[1] ?? "5");
	const seedIdx = argv.indexOf("--seed");
	const seed = seedIdx !== -1 ? Number(argv[seedIdx + 1] ?? "0") : 0;
	if (!Number.isInteger(n) || n < 0) {
		console.error("sample needs <n> (non-negative integer)");
		process.exit(1);
	}
	const { sample, total } = storeSample(issuesDir, n, Number.isInteger(seed) ? seed : 0);
	if (asJson) console.log(JSON.stringify({ sample, total, n, seed }, null, 2));
	else for (const t of sample) console.log(`${t.entity}\t${t.title}`);
	process.exit(0);
}

if (cmd === "caps") {
	// Live capability view from the projection.
	ensureInit();
	if (!useStore) {
		console.error("caps needs .bais/store.db — run bais ingest");
		process.exit(1);
	}
	const audIdx = argv.indexOf("--audience");
	const aud = audIdx !== -1 ? argv[audIdx + 1] : undefined;
	let caps = storeCaps(issuesDir);
	if (aud) caps = caps.filter((c) => c.audience === aud);
	if (asJson) console.log(JSON.stringify({ caps }, null, 2));
	else for (const c of caps) console.log(`${c.revoked ? "revoked" : "live"}\t${c.grant_id}\t${c.audience}\t${c.can.join(",")}\t${c.scope}`);
	process.exit(0);
}

if (cmd === "grant" || cmd === "revoke") {
	// Issuance goes through the live hub (single writer, correct chains).
	// The kill switch is `bais revoke` — revocation is fail-open by design.
	ensureInit();
	const hubIdx = argv.indexOf("--hub");
	const hub = hubIdx !== -1 ? argv[hubIdx + 1] : undefined;
	if (!hub) {
		console.error(`bais ${cmd} requires --hub <url> (issuance is a hub write)`);
		process.exit(1);
	}
	const post = async (path: string, body: unknown): Promise<any> => {
		const r = await fetch(`${hub}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const j = (await r.json()) as any;
		if (!r.ok) throw new Error(j.error ?? j.reason ?? r.status);
		return j;
	};
	const opt = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i !== -1 ? argv[i + 1] : undefined;
	};
	try {
		if (cmd === "grant") {
			const audience = argv[1];
			const can = (opt("--can") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			const scope = opt("--scope") ?? "*";
			const expiry = Number(opt("--expiry-lc") ?? "");
			if (!audience || !can.length || !Number.isInteger(expiry)) {
				console.error("bais grant <audience> --can a,b --scope S --expiry-lc N [--budget-usd X --budget-tokens Y --issuer DID --hub URL]");
				process.exit(1);
			}
			const body: Record<string, unknown> = { audience, can, scope, expiry_lc: expiry };
			const bu = opt("--budget-usd");
			const bt = opt("--budget-tokens");
			if (bu !== undefined) body.budget_cap_usd = Number(bu);
			if (bt !== undefined) body.budget_cap_tokens = Number(bt);
			const issuer = opt("--issuer");
			if (issuer) body.issuer = issuer;
			const j = await post("/grant", body);
			console.log(`granted\t${j.grant_id}\t${audience}\t${scope}`);
		} else {
			const ref = argv[1];
			const revoker = opt("--revoker");
			if (!ref || !revoker) {
				console.error("bais revoke <grant-id> --revoker DID --hub URL");
				process.exit(1);
			}
			const j = await post("/revoke", { grant_ref: ref, revoker });
			console.log(`revoked\t${j.revoked}\tby ${j.by}`);
		}
	} catch (e: any) {
		console.error(`${cmd}: ${String(e?.message ?? e).split("\n")[0]}`);
		process.exit(1);
	}
	process.exit(0);
}

if (cmd === "mcp") {
	// MCP server over stdio (Phase 5, step 17): Content-Length framed
	// JSON-RPC 2.0. Tool specs come from BAML (names/descriptions/schemas);
	// execution is local projection reads. Logs go to stderr — stdout is
	// protocol bytes only.
	ensureInit();
	const specs = (await (mcp_tools as any)()) as { name: string; description: string; input_schema: unknown }[];
	const text = (v: unknown): { content: { type: string; text: string }[] } => ({
		content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
	});
	const callTool = (name: string, args: any): unknown => {
		switch (name) {
			case "bais_list":
				return text(storeList(issuesDir));
			case "bais_ready": {
				const { ready, as_of, completeness } = storeReady(issuesDir);
				const edges = storeEdges(issuesDir);
				return text({
					ready: ready.map((t) => ({
						issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
						edges: edges.filter((e) => e.declaredBy === t.entity),
					})),
					as_of,
					completeness,
				});
			}
			case "bais_graph": {
				if (!args || typeof args.from !== "string") throw Object.assign(new Error("graph needs {from}"), { code: -32602 });
				const { nodes, as_of, completeness } = storeGraph(issuesDir, args.from);
				return text({ from: args.from, nodes, as_of, completeness });
			}
			case "bais_check":
				return text(storeCheck(issuesDir));
			case "bais_oversight":
				return text(storeOversight(issuesDir));
			case "bais_sample": {
				const n = Number(args?.n ?? 5);
				const seed = Number(args?.seed ?? 0);
				if (!Number.isInteger(n) || n < 0 || !Number.isInteger(seed)) {
					throw Object.assign(new Error("sample needs {n} and optional {seed}"), { code: -32602 });
				}
				return text({ ...storeSample(issuesDir, n, seed), n, seed });
			}
			default:
				throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
		}
	};
	const sendMsg = (obj: unknown): void => {
		const b = Buffer.from(JSON.stringify(obj), "utf8");
		process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`);
		process.stdout.write(b);
	};
	const route = async (method: string, params: any): Promise<unknown> => {
		if (method === "initialize") {
			return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bais", version: "0.0.0" } };
		}
		if (method === "ping") return {};
		if (method === "tools/list") {
			return { tools: specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.input_schema })) };
		}
		if (method === "tools/call") {
			return callTool(params?.name, params?.arguments ?? {});
		}
		throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
	};
	let buf = Buffer.alloc(0);
	const pump = (): void => {
		for (;;) {
			const hi = buf.indexOf("\r\n\r\n");
			if (hi === -1) return;
			const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, hi).toString("utf8"));
			if (!m) {
				buf = buf.subarray(hi + 4);
				continue;
			}
			const len = Number(m[1]);
			if (buf.length < hi + 4 + len) return;
			const body = buf.subarray(hi + 4, hi + 4 + len).toString("utf8");
			buf = buf.subarray(hi + 4 + len);
			void (async () => {
				let msg: any;
				try {
					msg = JSON.parse(body);
				} catch {
					sendMsg({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
					return;
				}
				if (msg.id === undefined) return; // notification — no response
				try {
					sendMsg({ jsonrpc: "2.0", id: msg.id, result: await route(msg.method, msg.params ?? {}) });
				} catch (e: any) {
					sendMsg({ jsonrpc: "2.0", id: msg.id, error: { code: typeof e?.code === "number" ? e.code : -32603, message: String(e?.message ?? e).split("\n")[0] } });
				}
			})();
		}
	};
	process.stdin.on("data", (c: Buffer) => {
		buf = Buffer.concat([buf, c]);
		pump();
	});
	process.stdin.on("end", () => process.exit(0));
	process.stdin.resume();
	// Stay alive serving; the process ends on stdin end.
	await new Promise(() => {});
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
		let trust: "recomputed" | "signature" = "recomputed";
		// An anchored peer's backfill can never reproduce the tables (the
		// covered log is gone), so anchor first: refreshes merge instead of
		// rebuilding, in BOTH trust paths below. Peers predating
		// anchor-state snapshots cannot source anchored bootstraps —
		// upgrade the peer, not the trust.
		if (snapshot.anchor) {
			if (!snapshot.anchor_state || !Array.isArray(snapshot.cursors)) {
				throw new Error("pruned peer predates anchor-state snapshots — upgrade the peer hub first");
			}
			recordImportedAnchor(issuesDir, snapshot.anchor, snapshot.anchor_state, snapshot.cursors);
		}
		// Backfill FIRST: delta chains only link onto a complete local log.
		const full = (await get("/sync")) as any;
		const covered = (full.events ?? []).filter((e: any) => e.lc <= cp.lc);
		const missing = cp.heads.filter((h: string) => !covered.some((e: any) => e.id === h));
		if (missing.length && !snapshot.anchor) throw new Error(`backfill incomplete: missing covered heads ${missing.join(",")}`);
		if (missing.length && snapshot.anchor) {
			// Truncated peer (POST /prune): the covered log is gone by
			// operator action, so recompute-verify is impossible. Fall back
			// to signature trust — the surviving CheckpointPublish event is
			// still signature-checked on ingest, and accepting it means the
			// publisher attests these tables. Recorded as trust: signature.
			// (Anchor recorded above; the delta layers onto it.)
			console.error(`peer pruned below ${cp.id} — backfill unavailable, establishing signature trust`);
			const tdelta = (await get(`/sync?since_lc=${cp.lc}`)) as any;
			const t = await appendForeignEvents(issuesDir, tdelta.events ?? [], { mode: "delta", anchorHeads: cp.heads });
			if (!t.accepted.includes(cp.id)) {
				throw new Error("anchor checkpoint event not replicated — cannot establish signature trust");
			}
			console.error(`anchor ${cp.id} accepted (publisher signature valid)`);
			trust = "signature";
		} else {
			const b = await appendForeignEvents(issuesDir, covered, { mode: "backfill" });
			if (b.rejected.length) throw new Error(`backfill rejected: ${b.rejected.map((r) => `${r.id}=${r.reason}`).join(",")}`);
			console.error(`backfill: ${b.accepted.length} events replayed`);
		}
		if (trust === "recomputed") {
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
		}
		// Signature-trust branch already ingested the delta above; the
		// anchor event's acceptance is the trust decision (no recompute —
		// the covered log is gone by operator action, recorded in meta).
		markBootstrapComplete(issuesDir, trust);
		// Final unlock verdict goes to stdout (machine-readable result —
		// sync-test.mjs asserts on it); progress stays on stderr.
		console.log(
			trust === "recomputed"
				? `verified root ${cp.state_root.slice(0, 12)}… — writes unlocked`
				: `signature trust on ${cp.id} — writes unlocked (trust: signature)`,
		);
		if (asJson) console.log(JSON.stringify({ checkpoint: cp.id, verified: true, trust }, null, 2));
	} catch (e: any) {
		console.error(`sync: ${String(e?.message ?? e).split("\n")[0]}`);
		process.exit(1);
	}
	process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
help();
process.exit(1);
