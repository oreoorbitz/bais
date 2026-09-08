#!/usr/bin/env node
// bais — BAIS CLI (file-per-issue, git is the hosting). LLM's main path is --json.
//
// Reads prefer the SQLite projection (.bais/store.db, built by `bais ingest`
// from the TOML seed through the BAML reducer) and fall back to the readdir
// scan when no store exists. `check` validates the *issue files*; it is not
// `baml check`, which validates bais's own BAML source.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveHubDir } from "./resolve.js";

// Machine-consumed JSON MUST go through printJson, never console.log:
// console.log to a pipe is async, and the process.exit(0) at the end of
// every command truncates payloads past the 64KB pipe buffer (`ready --json`
// on bi/.bais is ~74KB and used to end mid-string). writeSync drains before
// exit. New --json emits: use this.
function printJson(obj: unknown): void {
	writeSync(1, JSON.stringify(obj, null, 2) + "\n");
}
import { baselineIssueFromSketch, blastRadii, closeEvidenceIn, creationDaysFromMtimes, cyclicIds, danglingRefsIn, declarationDistributionIn, dispatchPack, e2eCaseAnchorsIn, e2eDirFor, e2eDriftJoin, groupSwarmClaims, knownDrillNames, knownE2eStems, layerDriftIn, loadIssues, nowDays, parseFileClaims, parseGoalTestingSurface, parseSwarmVerdicts, projectName, radiusVsEvidenceIn, readyIssues, scriptsDirFor, swarmVerdictProblemsIn, urgencyFor, warnUnknownShared, warnUnknownWithheld, whyNotIn } from "./graph.js";
import { findShadowHubs, formatShadow } from "./fork.js";
import type { BlastRadius, Urgency } from "./graph.js";
import { parseBaisFile } from "./toml.js";
import type { WhyNot } from "./graph.js";
import { loadPromptRecords, promptsDirFor, registryVerdict, renderProblemLine } from "./prompt_registry.js";
import type { RegistryPhase } from "./prompt_registry.js";
import { dismissSuggestion, loadSuggestions, MAX_PENDING, pendingSuggestions, promoteDerivation, writePromotedIssue, writeSuggestion } from "./suggestion.js";
import { dbPathFor, hasStore, ingestIssues, storeCaps, storeCheck, storeEdges, storeFreshness, storeGraph, storeList, storeOversight, storeReady, storeSample, storeWhyNot, verifyStore, deepVerify } from "./store.js";
import { createHub } from "./hub.js";
import { loadPeerKey, appendForeignEvents, publishCheckpoint, verifyCheckpointRoot } from "./hub.js";
import { exportSnapshot, importSnapshot, markBootstrapComplete, recordImportedAnchor } from "./store.js";
import { event, mcp_tools } from "../baml_sdk/index.js";

// hub#160: nearest-hub fallthrough. The closest .bais at or above the cwd
// wins; when that is the cwd hub the paths stay relative (root-cwd behavior
// byte-for-byte unchanged, including the hub#157 check-path labels), and an
// ancestor hub resolves absolute. No hub anywhere keeps the old relative
// paths so ensureInit/init behave exactly as before. `init` below stays
// cwd-local on purpose: it creates hubs (and forks), never claims one.
const resolvedHub = resolveHubDir(process.cwd());
const root = resolvedHub !== null && resolvedHub !== join(resolve(process.cwd()), ".bais") ? resolvedHub : ".bais";
const issuesDir = join(root, "issues");

function help(): void {
	console.log(`bais — Basically A made-up Issue Standard

Usage:
  bais init
  bais ingest [--json]              # build .bais/store.db from issues/*.toml via the BAML reducer
  bais list [--json]                       # trailing br=N col = open blast radius (bi#122)
  bais ready [--json] [--why-not] [--wait [--timeout N]] [--order blast-radius|urgency]
  bais dispatch --agents N [--json] [--briefs]  # dry-run swarm pack: load-bearing first (bi#123), never mutates
                                # carries as_of + completeness from the store
  bais goal <start|sketch|commit|status|switch> [--approve]  # per-directory campaign interview (bi#132)
  bais goal e2e [--json]                  # surface/case coverage join: ok/missing/stale rows (hub#191);
                                # exits 1 when any surface lacks a case or any case is stale
  bais goal gate [--json]                 # deterministic gates first (baml check/test + e2e scaffolds),
                                # fingerprint-cached, auto-pauses on red — judge never wired (hub#213)
  bais goal snapshot --out <file>            # snapshot the campaign (recoverable-clear precondition, bi#136)
  bais goal clear --snapshot <file> --confirm  # snapshot-first + explicit confirm (refused otherwise)
  bais goal retire <id> --reason <R> [--archive]  # Dropped with reason (or archived), never silent delete
  bais stale [--days N] [--json]  # deterministic prune candidates with reasons, never auto-closes (bi#80)
  bais curator [--dry-run|--apply] [--now <RFC3339>] [--actor <name>] [--json]
                                # lifecycle sweep: dry-run (default) reports only, writes nothing;
                                # --apply snapshots first, then ledger + state via curator.mjs (hub#212)
  bais suggestions list [--all] [--json]    # consent-first suggestion lane (hub#211)
  bais suggestions dismiss <sug-id>         # latch the dedup_key forever
  bais suggestions promote <sug-id> <new-issue-id> --yes
                                # without --yes: derivation preview, writes nothing; with --yes:
                                # issue write first, Promoted latch only after it succeeds
  bais archive --size [--cap N] [--json]  # archive budget: exact bytes, loud warn over cap (bi#136)
  bais archive <id> [--reason R]          # move an issue to .bais/archive/
  bais delete <id> [--json]               # fully remove an issue file + projection rebuild
  bais move <id> <status> [--json] [--as <owner> --for 4h]
                                # Doing without --as is an anonymous
                                # claim: allowed, instantly stale
  bais renew <id> --as <owner> [--for 4h]  # extend a live claim (heartbeat)
  bais reap [--now <instant>] [--json]     # expired Doing -> Open
  bais list [--json] [--claims]            # --claims appends holder/lease cols + swarm groups (bi#130)
  bais check [--json] [--registry-strict] [--e2e-strict] [--audit-strict]
                                # --registry-strict: prompt-registry problems + parse failures become
                                # fatal (hub#210); default phase is warn (advisory, exit untouched)
                                # --e2e-strict: unresolvable-e2e evidence + e2e-gap/e2e-stale drift
                                # joins become fatal (hub#188/hub#191); default warn
                                # --audit-strict: layer-drift / radius-vs-evidence /
                                # declaration-distribution audits become fatal (hub#193); default warn
  bais verify [--deep] [--json]  # content fingerprint (deep: full BAML re-reduce + id sweep)
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
	// hub#160: always cwd-local (see resolution above) — init creates a hub
	// here, even when an ancestor hub exists (that is how forks are born).
	mkdirSync(join(".bais", "issues"), { recursive: true });
	writeFileSync(join(".bais", "config.toml"), 'project = "bais"\n');
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
	// Claims are file-envelope: the store projection predates them, so
	// --claims merges the scan truth over either read path.
	const withClaims = argv.includes("--claims");
	const claimById = new Map<string, { holder: string | null; lease: string | null }>();
	if (withClaims) {
		for (const f of (await loadIssues(issuesDir)).issues) claimById.set(f.issue.id, { holder: f.holder, lease: f.lease });
	}
	const claimCols = (id: string): string => {
		if (!withClaims) return "";
		const c = claimById.get(id);
		return `\t${c?.holder ?? ""}\t${c?.lease ?? ""}`;
	};
	// bi#130: swarm membership groups (holder form swarm-id/agent-id).
	// Only present when swarm-form holders exist, so plain-only hubs
	// print exactly the old shape (claim.list-claims pins it).
	const swarmGroups = withClaims
		? groupSwarmClaims([...claimById.entries()].map(([id, c]) => ({ id, holder: c.holder })))
		: [];
	const printSwarms = (): void => {
		for (const g of swarmGroups) {
			const noun = g.members.length === 1 ? "member" : "members";
			console.log(`swarm\t${g.swarm}\t${g.members.length} ${noun}: ${g.members.map((m) => `${m.id}(${m.agent})`).join(", ")}`);
		}
	};
	if (optValue("--order") !== undefined) {
		console.error("bais list: --order is only supported by `bais ready`");
		process.exit(1);
	}
	// bi#122 load-bearing marker: trailing br=N column (open blast radius)
	// on text rows, blast_radius object on --json rows. Uniform (even when 0)
	// so the column shape stays greppable.
	const brCol = (radii: Map<string, BlastRadius>, id: string): string => `\tbr=${radii.get(id)?.open_downstream ?? 0}`;
	const withBr = (rows: { issue: { id: string } }[], radii: BlastRadius[]) => {
		const byId = new Map(radii.map((r) => [r.id, r]));
		return rows.map((f) => ({ ...f, blast_radius: byId.get(f.issue.id) ?? { id: f.issue.id, open_downstream: 0, total_downstream: 0 } }));
	};
	if (useStore) {
		const { tasks, as_of, completeness } = storeList(issuesDir);
		const edges = storeEdges(issuesDir);
		const issues = tasks.map((t) => ({
			issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
			edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
		}));
		const radii = new Map(blastRadii(issues as any).map((r) => [r.id, r]));
		if (asJson) {
			printJson({ issues: withBr(issues, [...radii.values()]), unparseable: [], as_of, completeness, ...(withClaims ? { swarms: swarmGroups } : {}) });
		} else {
			for (const f of issues) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}${claimCols(f.issue.id)}${brCol(radii, f.issue.id)}`);
			printSwarms();
		}
	} else {
		// bi#55: name the storeless fallback; stdout/exit untouched.
		warnScanFallback();
		const { issues, failures } = await loadIssues(issuesDir);
		const radii = new Map(blastRadii(issues).map((r) => [r.id, r]));
		if (asJson) {
			printJson({ issues: withBr(issues, [...radii.values()]), unparseable: failures, ...(withClaims ? { swarms: swarmGroups } : {}) });
		} else {
			for (const f of issues) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}${claimCols(f.issue.id)}${brCol(radii, f.issue.id)}`);
			printSwarms();
			for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
			if (!issues.length && !failures.length) console.error("(no .bais/issues/*.toml — run bais init or add issues)");
		}
	}
	process.exit(0);
}

// bi#55: the hasStore fallback is a fail-closed path like any other — it
// gets a named reason on the diagnostic channel. stdout and exit codes are
// untouched (machine consumers parse stdout; diagnostics ride stderr).
function warnScanFallback(): void {
	console.error("[bais] no store.db — directory scan (run `bais ingest` for indexed reads)");
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
	const order = optValue("--order");
	if (order !== undefined && order !== "blast-radius" && order !== "urgency") {
		console.error(`bais ready: --order ${JSON.stringify(order)} needs blast-radius|urgency`);
		process.exit(1);
	}
	// bi#51: --order urgency sorts ready by the computed urgency score,
	// descending (ties break on id, so the order is deterministic). Every row
	// carries its receipt — the score WITH named components, never a bare
	// number — in text (`u=N sev=S blocks=B stalled=P/Dd`) and as the full
	// urgency object on --json rows. Costs come from file mtimes (whole days;
	// the host clock in the bi#42 split), `now` is the wall-clock day.
	const urgCol = (u: Urgency | undefined): string =>
		`\tu=${u?.score ?? 0} sev=${u?.severity_part ?? 0} blocks=${u?.blocks_part ?? 0} stalled=${u?.stalled_part ?? 0}/${u?.stalled_days ?? 0}d`;
	const withUrg = <T extends { issue: { id: string } }>(rows: T[], urg: Map<string, Urgency>): (T & { urgency: Urgency })[] =>
		rows.map((f) => ({
			...f,
			urgency: urg.get(f.issue.id) ?? {
				issue_id: f.issue.id,
				score: 0,
				severity_part: 0,
				fan_out: 0,
				sole_unblocks: 0,
				blocks_part: 0,
				stalled_days: 0,
				stalled_part: 0,
				incurred_tokens: 0,
				cost_part: 0,
			},
		}));
	const orderByUrg = <T extends { issue: { id: string } }>(rows: T[], urg: Map<string, Urgency>): T[] => {
		if (order !== "urgency") return rows;
		return [...rows].sort(
			(a, b) => (urg.get(b.issue.id)?.score ?? 0) - (urg.get(a.issue.id)?.score ?? 0) || (a.issue.id < b.issue.id ? -1 : a.issue.id > b.issue.id ? 1 : 0),
		);
	};
	// bi#122: --order blast-radius sorts ready by open blast radius, descending
	// (ties break on id, so the order is deterministic). The br=N marker rides
	// on text rows either way; --json rows carry the full blast_radius object.
	const brCol = (radii: Map<string, BlastRadius>, id: string): string => `\tbr=${radii.get(id)?.open_downstream ?? 0}`;
	const withBr = (rows: { issue: { id: string } }[], radii: BlastRadius[]) => {
		const byId = new Map(radii.map((r) => [r.id, r]));
		return rows.map((f) => ({ ...f, blast_radius: byId.get(f.issue.id) ?? { id: f.issue.id, open_downstream: 0, total_downstream: 0 } }));
	};
	const orderByBr = <T extends { issue: { id: string } }>(rows: T[], radii: Map<string, BlastRadius>): T[] => {
		if (order !== "blast-radius") return rows;
		return [...rows].sort(
			(a, b) => (radii.get(b.issue.id)?.open_downstream ?? 0) - (radii.get(a.issue.id)?.open_downstream ?? 0) || (a.issue.id < b.issue.id ? -1 : a.issue.id > b.issue.id ? 1 : 0),
		);
	};
	if (useStore) {
		// The one agent-dispatch query, indexed — not a readdir scan.
		const { ready, as_of, completeness } = storeReady(issuesDir);
		const edges = storeEdges(issuesDir);
		// Blast radius needs the whole graph (dependents are usually unready),
		// so join the full task projection, not just the ready rows.
		const { tasks } = storeList(issuesDir);
		const all = tasks.map((t) => ({
			issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
			edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
		}));
		const radii = new Map(blastRadii(all as any).map((r) => [r.id, r]));
		// bi#51: urgency over the WHOLE graph (dependents are usually
		// unready) with mtime-stamped creation days; the ready rows below
		// are the only ones served.
		const allEdges = all.flatMap((a) => a.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })));
		const now = nowDays();
		const costs = creationDaysFromMtimes(
			issuesDir,
			all.map((a) => a.issue.id),
		);
		const urg = new Map(all.map((a) => [a.issue.id, urgencyFor(a.issue, allEdges, costs, now)]));
		const files = orderByUrg(
			orderByBr(
				ready.map((t) => ({
					issue: { id: t.entity, title: t.title, status: t.status, kind: t.kind, area: t.area, severity: t.severity, source: t.source, body: t.body },
					edges: edges.filter((e) => e.declaredBy === t.entity).map((e) => ({ from: e.source, to: e.target, kind: e.type })),
				})),
				radii,
			),
			urg,
		);
		const reasons = whyNot ? storeWhyNot(issuesDir).reasons : [];
		// Pure addition: without --order urgency every line above and below
		// is exactly the old output (no urgency key on rows).
		const outRows = order === "urgency" ? withUrg(withBr(files, [...radii.values()]), urg) : withBr(files, [...radii.values()]);
		if (asJson) {
			printJson(
				whyNot
					? { ready: outRows, why_not: reasons, unparseable: [], as_of, completeness }
					: { ready: outRows, unparseable: [], as_of, completeness },
			);
		} else {
			for (const f of files)
				console.log(
					`${f.issue.id}\t${f.issue.title}${brCol(radii, f.issue.id)}${order === "urgency" ? urgCol(urg.get(f.issue.id)) : ""}`,
				);
			if (!files.length) console.log("(no ready issues)");
			printWhyNot(reasons);
		}
	} else {
		// bi#55: name the storeless fallback; stdout/exit untouched.
		warnScanFallback();
		const { issues, failures } = await loadIssues(issuesDir);
		const radii = new Map(blastRadii(issues).map((r) => [r.id, r]));
		// bi#51 scan path: same urgency inputs as the store path (whole-graph
		// edges, mtime creation days, wall-clock now).
		const scanEdges = issues.flatMap((f) => f.edges);
		const scanNow = nowDays();
		const scanCosts = creationDaysFromMtimes(
			issuesDir,
			issues.map((f) => f.issue.id),
		);
		const scanUrg = new Map(issues.map((f) => [f.issue.id, urgencyFor(f.issue, scanEdges, scanCosts, scanNow)]));
		const ready = orderByUrg(orderByBr(readyIssues(issues), radii), scanUrg);
		// No store means no leases table, so the scan path reasons over the
		// graph alone (leases only exist once a store is ingested).
		const reasons = whyNot ? whyNotIn(issues, projectName(issuesDir)) : [];
		const scanBase = withBr(ready, [...radii.values()]);
		const scanRows = order === "urgency" ? withUrg(scanBase, scanUrg) : scanBase;
		if (asJson) {
			printJson(
				whyNot ? { ready: scanRows, why_not: reasons, unparseable: failures } : { ready: scanRows, unparseable: failures },
			);
		} else {
			for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}${brCol(radii, f.issue.id)}${order === "urgency" ? urgCol(scanUrg.get(f.issue.id)) : ""}`);
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

// hub#163: single-source briefs. renderBrief/warnPartial live ONLY in
// bais/scripts/briefs.mjs (canonical — owns the bi#134 style lines too);
// this CLI imports them instead of mirroring them (the bi#144 hand-sync
// proved mirrors drift). Candidates cover the compiled layout (dist/src ->
// pkg/scripts) and the dev layout (src -> pkg/scripts); a missing renderer
// fails loud below, never silent-drifted.
async function loadBriefsRenderer(): Promise<{ renderBrief: (o: any) => string; warnPartial: (b: number, p: number) => string | null }> {
	const { dirname } = await import("node:path");
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "..", "..", "scripts", "briefs.mjs"),
		join(here, "..", "scripts", "briefs.mjs"),
	];
	const found = candidates.find((c) => existsSync(c));
	if (!found) {
		console.error(`bais dispatch: brief renderer not found (tried ${candidates.join(", ")})`);
		process.exit(1);
	}
	return (await import(pathToFileURL(found).href)) as any;
}
// hub#163: renderBrief + warnPartial deleted — imported from
// bais/scripts/briefs.mjs via loadBriefsRenderer() above. The bi#126
// red-check (forced-null warnPartial fails the --briefs verify LOUD)
// now lives in bais/scripts/brief-parity.mjs.
// bi#123: workload-aware swarm pack as a dry-run. Loads the scan (never the
// store): dispatch needs live file-envelope claims and fresh bodies, and the
// store projection predates both. Prints slot -> issue rows; the operator
// spawns agents from the printout and each agent claims for itself — dispatch
// never mutates, so proxy claims cannot break the lease model.
if (cmd === "dispatch") {
	ensureInit();
	const rawAgents = optValue("--agents");
	const budget = rawAgents === undefined ? NaN : Number(rawAgents);
	if (!Number.isInteger(budget) || budget <= 0) {
		console.error("bais dispatch needs --agents <positive integer>");
		process.exit(1);
	}
	const { issues, failures } = await loadIssues(issuesDir);
	const now = Date.now();
	const leased = issues
		.filter((f) => f.holder != null && f.lease != null && Number.isFinite(Date.parse(f.lease as string)) && Date.parse(f.lease as string) > now)
		.map((f) => f.issue.id);
	// bi#130: swarm occupancy — live claims grouped by swarm prefix, so
	// the operator sees which swarm holds what before spawning into the
	// pack. Plain holders contribute no group; slot rows are untouched.
	const swarmGroups = groupSwarmClaims(issues.filter((f) => leased.includes(f.issue.id)).map((f) => ({ id: f.issue.id, holder: f.holder })));
	const swarmOccupancy = swarmGroups.map(
		(g) => `[bais] swarm ${g.swarm}: ${g.members.length} live claim(s): ${g.members.map((m) => `${m.id}(${m.agent})`).join(", ")}`,
	);
	const footprints = new Map(issues.map((f) => [f.issue.id, parseFileClaims(f.issue.body)]));
	// A `Files:` prefix means declared — even `Files:` empty (touches no files
	// is a real claim). No prefix means unknown: packs freely, flagged.
	const declared = new Set(
		issues.filter((f) => (f.issue.body ?? "").split("\n").some((l) => l.trim().startsWith("Files:"))).map((f) => f.issue.id),
	);
	const radii = new Map(blastRadii(issues).map((r) => [r.id, r]));
	const byId = new Map(issues.map((f) => [f.issue.id, f]));
	const slots = dispatchPack(issues, leased, footprints, budget).map((s) => {
		const f = byId.get(s.issue_id);
		return {
			slot: s.slot,
			issue: { id: s.issue_id, title: f?.issue.title ?? "" },
			open_downstream: radii.get(s.issue_id)?.open_downstream ?? 0,
			files: footprints.get(s.issue_id) ?? [],
			files_state: declared.has(s.issue_id) ? "declared" : "unknown",
		};
	});
	// hub#175 warning path: dispatchPack withholds 2nd+ unknowns (at most
	// one unknown per pack) — name what the exclusion cost. withheld =
	// unpacked ready+unleased unknowns capped by unfilled, in greedy order
	// (over-budget unknowns stay unnamed, same as the scripts post-filter
	// over the budget-limited greedy); a kept unknown alongside declared
	// partners warns naming the unknown. --json carries both fields.
	const unfilled = budget - slots.length;
	const packedIds = new Set(slots.map((s) => s.issue.id));
	const readyIds = new Set(readyIssues(issues).map((f) => f.issue.id));
	const keptUnknown = slots.find((s) => s.files_state !== "declared");
	const unpackedUnknowns = issues
		.filter((f) => !declared.has(f.issue.id) && !packedIds.has(f.issue.id) && !leased.includes(f.issue.id) && readyIds.has(f.issue.id))
		.map((f) => f.issue.id)
		.sort((a, b) => (radii.get(b)?.open_downstream ?? 0) - (radii.get(a)?.open_downstream ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
	const withheld = keptUnknown !== undefined ? unpackedUnknowns.slice(0, Math.max(0, unfilled)) : [];
	const unknownWarnings: string[] = [];
	if (withheld.length) unknownWarnings.push(warnUnknownWithheld(withheld));
	if (keptUnknown !== undefined) {
		const partners = slots.filter((s) => s.files_state === "declared").map((s) => s.issue.id);
		if (partners.length) unknownWarnings.push(warnUnknownShared(keptUnknown.issue.id, partners));
	}
	// bi#125/bi#126: --briefs renders spawn briefs instead of slot rows;
	// every mode carries unfilled + the loud partial-pack stderr line.
	// hub#163: renderer is single-sourced (briefs.mjs) — no local mirror.
	const { renderBrief, warnPartial } = await loadBriefsRenderer();
	const wantBriefs = argv.includes("--briefs");
	const partial = warnPartial(budget, slots.length);
	const briefFor = (s: (typeof slots)[number]): string => {
		const f = byId.get(s.issue.id);
		// No `style` passed: the strict parser (ns_toml) rejects top-level
		// `style` keys, so no loadable issue carries one (probed 2026-09-06:
		// styled file → "unknown top-level key style"); the .mjs default
		// (inherits line) applies until the parser allowlists the field.
		return renderBrief({ slot: s.slot, id: s.issue.id, title: s.issue.title, status: f?.issue.status, body: f?.issue.body, files: s.files, files_state: s.files_state, open_downstream: s.open_downstream, dir: process.cwd() });
	};
	if (asJson) {
		// --json stays stderr-quiet (the machine field is unfilled);
		// briefs.mjs shells here inheriting stderr and warns itself, so a
		// loud line here would double §8's pinned single line.
		printJson({ slots: wantBriefs ? slots.map((s) => ({ ...s, brief: briefFor(s) })) : slots, leased, budget, unfilled, warnings: unknownWarnings, withheld, unparseable: failures, swarms: swarmGroups });
	} else if (wantBriefs) {
		if (partial) console.error(partial);
		for (const w of unknownWarnings) console.error(w);
		for (const o of swarmOccupancy) console.error(o);
		if (!slots.length) console.log("(no packable issues for this budget)");
		slots.forEach((s, i) => console.log((i === 0 ? "" : "\n") + briefFor(s)));
	} else {
		if (partial) console.error(partial);
		for (const w of unknownWarnings) console.error(w);
		for (const s of slots) {
			const files = s.files_state === "declared" ? s.files.join(",") : "unknown";
			console.log(`slot${s.slot}\t${s.issue.id}\tbr=${s.open_downstream}\tfiles: ${files}\t${s.issue.title}`);
		}
		if (!slots.length) console.log("(no packable issues for this budget)");
		if (leased.length) console.error(`[bais] skipped live-claimed: ${leased.join(", ")}`);
		for (const o of swarmOccupancy) console.error(o);
		if (failures.length) {
			console.error(`[bais] ${failures.length} unparseable file(s) excluded — \`bais check\` for details`);
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
		if (asJson) printJson({ from, nodes: files, as_of, completeness });
		else for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}`);
	} else {
		// No store: BFS over the scan (same traversal bi's graphBaisIssues does).
		// bi#55: name the storeless fallback; stdout/exit untouched.
		warnScanFallback();
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
		if (asJson) printJson({ from, nodes: files });
		else for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}`);
	}
	process.exit(0);
}

if (cmd === "verify") {
	ensureInit();
	if (!existsSync(join(root, "store.db"))) {
		console.error("verify needs .bais/store.db — run bais ingest");
		process.exit(1);
	}
	let fp: { ok: boolean; detail: string };
	try {
		fp = verifyStore(issuesDir);
	} catch (e) {
		// Structurally unreadable (not just content-flipped): name it.
		fp = { ok: false, detail: `unreadable: ${e instanceof Error ? e.message : e}` };
	}
	if (!fp.ok && fp.detail.startsWith("unsealed-legacy")) {
		// Legacy stores predate fingerprints — that is a state, not a failure.
		if (!asJson) console.log(`verify\tok\t${fp.detail}`);
		else console.log(JSON.stringify({ ok: true, fingerprint: fp.detail, problems: [] }, null, 2));
		process.exit(0);
	}
	let problems: string[] = [];
	if (!fp.ok) problems.push(`fingerprint: ${fp.detail}`);
	if (argv.includes("--deep")) {
		const deep = await deepVerify(issuesDir);
		problems.push(...deep.problems);
	}
	if (asJson) {
		console.log(JSON.stringify({ ok: problems.length === 0, fingerprint: fp.detail, problems }, null, 2));
	} else if (problems.length === 0) {
		console.log(`verify\tok\tfingerprint ${fp.detail}`);
	} else {
		for (const p of problems) console.log(`verify\tFAIL\t${p}`);
	}
	process.exit(problems.length === 0 ? 0 : 1);
}

// hub#178: human behind-duration for the stale-store warning.
function formatBehind(ms: number): string {
	const m = Math.floor(ms / 60000);
	if (m < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`;
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

if (cmd === "check") {
	ensureInit();
	// hub#157: subdir-hub shadow scan. The cwd .bais/ is the hub; any
	// subdir .bais/ without `fork = true` in its config is an undeclared
	// shadow (nearest-hub-wins would silently fork it off the hub).
	// Undeclared shadows are fatal in every branch below; declared forks
	// pass quiet. Text mode prints one loud `shadow` line per offender
	// naming both paths; --json carries the full `shadows` array.
	const shadows = findShadowHubs(process.cwd());
	const undeclared = shadows.filter((s) => !s.declared);
	const printShadows = (): void => {
		for (const s of undeclared) console.log(formatShadow(root, s));
	};
	// hub#188/hub#191 rollout phase (warn-first-then-fail, the hub#210
	// prompt-registry precedent): warn is advisory — it never touches the
	// exit code; --e2e-strict flips unresolvable-e2e evidence and the
	// e2e-gap/e2e-stale drift joins to fatal (CI-pinnable).
	const e2ePhase: "warn" | "fail" = argv.includes("--e2e-strict") ? "fail" : "warn";
	// hub#193: same rollout for the layer-drift / radius-vs-evidence /
	// declaration-distribution audit family (--audit-strict flips).
	const auditPhase: "warn" | "fail" = argv.includes("--audit-strict") ? "fail" : "warn";
	// The scan is the shared truth for body-envelope facts (the stale-claim
	// precedent): one load feeds swarm shaping, e2e evidence resolution,
	// the drift joins, and the hub#193 audits on BOTH paths below.
	const checkLoad = await loadIssues(issuesDir);
	const checkFiles = checkLoad.issues;
	// bi#83: close-evidence render, shared by both paths. A Done issue with
	// no Evidence: refs, or refs that do not resolve, is LOUD: one
	// `evidence` line per problem. Missing (same-project unresolvable) is
	// fatal; External (cross-project verdict ref) is advisory, never fatal —
	// the same split dangling refs use. hub#188: unresolvable-e2e is
	// warn-first — advisory while e2ePhase is warn, fatal under
	// --e2e-strict (the rollout state prints on the e2e-phase line below).
	const printEvidence = (evidence: { id: string; reason: string; ref: string | null; kind: string | null; status: string }[]): number => {
		let fatal = 0;
		for (const p of evidence) {
			if (p.reason === "missing-close-evidence") {
				console.log(`evidence\t${p.id}\tmissing-close-evidence\tDone with no Evidence: refs (add Evidence: drill(<name>), verdict(<id>), and/or e2e(<stem>) to the body)`);
			} else {
				console.log(`evidence\t${p.id}\t${p.reason}\t${p.ref} does not resolve`);
			}
			if (p.status === "Missing" && !(e2ePhase === "warn" && p.reason === "unresolvable-e2e")) fatal += 1;
		}
		return fatal;
	};
	// bi#131: swarm-verdict render, shared by both paths. A `Swarm:` line
	// that does not parse is LOUD: one `swarm` line per malformed line,
	// always fatal (a shape violation, never an external ref). Well-formed
	// verdicts are silent in text; --json carries them as `swarmVerdicts`
	// (the slot→pack join key for oversight/reviewer verdicts, bi#59).
	const printSwarm = (problems: { id: string; reason: string; ref: string | null }[]): number => {
		for (const p of problems) console.log(`swarm\t${p.id}\t${p.reason}\t${p.ref ?? ""}`);
		return problems.length;
	};
	// Swarm shaping reads bodies, which live on the scan (the projection
	// predates them, same as claims) — both paths share these entries.
	const swarmEntries = checkFiles.map((f) => ({ id: f.issue.id, status: f.issue.status, body: f.issue.body }));
	const swarm = swarmVerdictProblemsIn(swarmEntries);
	// hub#210: prompt-registry rollout (warn-first-then-fail, the style/hero
	// hub#158 precedent). Records live in the sibling prompts lane
	// (promptsDirFor); the eval-edge join runs over the same loaded-issue
	// list check already builds (swarmEntries carries id+status). Warn phase
	// is advisory — it never touches the exit code; --registry-strict flips
	// to fail, adding registry problems + parse failures to every exit-1
	// condition below (store/scan, text/--json alike).
	const registryPhase: RegistryPhase = argv.includes("--registry-strict") ? "fail" : "warn";
	const registryLoad = loadPromptRecords(promptsDirFor(issuesDir));
	const registry = registryVerdict(
		registryLoad.records.map((r) => r.record),
		swarmEntries,
		registryPhase,
	);
	const registryFatal = registryPhase === "fail" ? registry.problems.length + registryLoad.failures.length : 0;
	const registryJson = (): unknown => ({
		phase: registry.phase,
		passed: registry.passed,
		problems: registry.problems,
		failures: registryLoad.failures,
	});
	const printRegistry = (): void => {
		for (const f of registryLoad.failures) console.log(`prompt-registry\t${f.file}\tparse-failure\t${f.error}`);
		for (const p of registry.problems) console.log(renderProblemLine(p));
		console.log(
			`prompt-registry-phase\t${registry.phase}\t${registry.phase === "warn" ? "advisory — --registry-strict flips to fail (hub#210)" : "strict — registry problems and parse failures are fatal (hub#210)"}`,
		);
	};
	// hub#188: e2e close-evidence stems resolve against .bais/e2e/ exactly
	// like drill stems resolve against the hub's drill namespace.
	const e2eDir = e2eDirFor(issuesDir);
	const e2eStems = knownE2eStems(e2eDir);
	const checkDrills = knownDrillNames(scriptsDirFor(issuesDir));
	// Scan-truth close evidence: the store predicate predates the e2e ref
	// kind, so e2e-kind problems always come from this computation (the
	// store path merges them over its own drill/verdict rows below).
	const scanEvidence = closeEvidenceIn(swarmEntries, projectName(issuesDir), checkDrills, e2eStems);
	// hub#191: drift joins over goal.toml text + the .bais/e2e/ listing.
	// Warn-first, named reason per row, never auto-mutating (bi#55). A
	// goal.toml with no declared testing_surface is grandfathered
	// (declared=false — both joins vacuous), so pre-surface hubs stay
	// silent; the phase line always names the rollout state.
	const goalText = existsSync(join(root, "goal.toml")) ? readFileSync(join(root, "goal.toml"), "utf8") : "";
	const e2eDrift = e2eDriftJoin(parseGoalTestingSurface(goalText), e2eCaseAnchorsIn(e2eDir));
	const e2eDriftFatal = e2ePhase === "fail" ? e2eDrift.gaps.length + e2eDrift.stale.length : 0;
	const printE2eDrift = (): void => {
		for (const g of e2eDrift.gaps) {
			console.log(`e2e-gap\t${g.surface}\tdeclared testing_surface item has no .bais/e2e case (anchor ${g.anchor}) — add the case or retire the surface, never silently (hub#191)`);
		}
		for (const s of e2eDrift.stale) {
			console.log(`e2e-stale\t${s.file}\tgoal anchor ${s.anchor ?? "(none embedded)"} matches no declared testing_surface item — the surface was edited or renamed without touching the case (hub#191)`);
		}
		console.log(
			`e2e-phase\t${e2ePhase}\t${e2ePhase === "warn" ? "advisory — --e2e-strict flips to fail (hub#188/hub#191)" : "strict — unresolvable-e2e, e2e-gap and e2e-stale are fatal (hub#188/hub#191)"}`,
		);
	};
	// hub#193: progressive-enhancement audits, warn-first. The layer-drift
	// baseline is the hub#186 declared baseline (.bais/sketch.toml
	// [[node]] id = "baseline" with an explicit issue = "<id>" key);
	// undeclared is a named state on the phase line, never an invented
	// baseline. Deterministic rows, named reasons, no auto-mutation.
	const sketchText = existsSync(join(root, "sketch.toml")) ? readFileSync(join(root, "sketch.toml"), "utf8") : "";
	const auditBaseline = baselineIssueFromSketch(sketchText);
	const layerDrift = auditBaseline !== null ? layerDriftIn(checkFiles, auditBaseline) : [];
	const radiusAudit = radiusVsEvidenceIn(checkFiles);
	const declarationAudit = declarationDistributionIn(checkFiles);
	// hub#195: the committed goal.toml is bound to the human-approved sketch
	// by approved_sketch_hash; drift (post-approval nodes/edges edits) flags
	// loud and fatal — the bi#136 "snapshot stale" precedent, never silently
	// honored. A goal.toml without the hash is grandfathered (pre-195
	// campaigns carry none), so legacy hubs stay green. Case-file snapshot
	// drift (a case still bound to a retired campaign version — cross-goal
	// reuse without an explicit keep decision) rides the e2e rollout phase
	// like the hub#191 joins: advisory in warn, fatal under --e2e-strict.
	const lm195 = await loadScriptModule("lifecycle.mjs");
	const sketchStale = lm195.verifyApprovedSketch({ goalTomlText: goalText, sketchTomlText: sketchText });
	const sketchStaleFatal = sketchStale.ok ? 0 : 1;
	const goalSnapshot195 = ((): string => {
		const m = goalText.match(/^goal_snapshot *= *("(?:[^"\\]|\\.)*")/m);
		if (!m) return "";
		try {
			return JSON.parse(m[1]);
		} catch {
			return "";
		}
	})();
	const e2eCaseFiles195 = ((): { file: string; text: string }[] => {
		try {
			return readdirSync(e2eDir)
				.filter((f) => f.endsWith(".mjs"))
				.sort()
				.map((f) => ({ file: f, text: readFileSync(join(e2eDir, f), "utf8") }));
		} catch {
			return [];
		}
	})();
	const snapshotDrift195 = lm195.e2eSnapshotDrift({ goalSnapshot: goalSnapshot195, cases: e2eCaseFiles195 });
	const snapshotDriftFatal = e2ePhase === "fail" ? snapshotDrift195.length : 0;
	const printSketchStale = (): void => {
		if (!sketchStale.ok) console.log(`goal-sketch-stale\t${sketchStale.error}`);
		for (const r of snapshotDrift195) {
			console.log(`e2e-snapshot-stale\t${r.file}\t${r.reason}`);
		}
	};
	const sketchStaleJson = (): unknown => ({
		ok: sketchStale.ok,
		drift: sketchStale.drift,
		grandfathered: sketchStale.grandfathered,
		error: sketchStale.error,
		case_snapshot_drift: snapshotDrift195,
	});
	const auditFatal = auditPhase === "fail" ? layerDrift.length + radiusAudit.length + (declarationAudit !== null ? 1 : 0) : 0;
	const printAudits = (): void => {
		for (const r of layerDrift) {
			console.log(`audit\t${r.id}\tlayer-drift\tDoing/Done with Open baseline ancestor ${r.ancestor} (baseline ${r.baseline}) — land the foundation before the enhancement (hub#193)`);
		}
		for (const r of radiusAudit) {
			console.log(`audit\t${r.id}\tradius-vs-evidence\topen_downstream=${r.open_downstream} (>= 3) folded with no Evidence: e2e(<stem>) cite — surface-observable change unproven (hub#193)`);
		}
		if (declarationAudit !== null) {
			console.log(`audit\t-\tdeclaration-distribution\t${declarationAudit.severity5}/${declarationAudit.open} Open issues (${declarationAudit.pct}%) at severity 5 — above K=${declarationAudit.k}% (hub#193)`);
		}
		console.log(
			`audit-phase\t${auditPhase}\t${auditPhase === "warn" ? "advisory — --audit-strict flips to fail (hub#193)" : "strict — layer-drift, radius-vs-evidence and declaration-distribution are fatal (hub#193)"}; layer-drift baseline: ${auditBaseline ?? "undeclared (no .bais/sketch.toml baseline node with an issue= key — hub#186)"}`,
		);
	};
	const e2eJson = (): unknown => ({ phase: e2ePhase, drift: e2eDrift });
	const auditsJson = (): unknown => ({
		phase: auditPhase,
		baseline: auditBaseline,
		layer_drift: layerDrift,
		radius_vs_evidence: radiusAudit,
		declaration_distribution: declarationAudit,
	});
	if (useStore) {
		const store = storeCheck(issuesDir);
		const { ok, bad, dangling, cycles } = store;
		// hub#188: drill/verdict evidence rows come from the store; e2e-kind
		// rows come from the scan truth (the store predicate predates the
		// e2e ref kind — the stale-claim file-envelope precedent).
		const evidence = [...store.evidence.filter((p) => p.kind !== "e2e"), ...scanEvidence.filter((p) => p.kind === "e2e")];
		const missing = dangling.filter((d) => d.status === "Missing");
		const external = dangling.filter((d) => d.status === "External");
		// hub#178: a store older than the newest issue file serves a stale
		// projection while looking clean. Advisory only, never fatal —
		// `bais ingest` is the fix (same posture as stale-claim).
		const fresh = storeFreshness(issuesDir);
		const staleStore = fresh.state === "stale"
			? { db: dbPathFor(issuesDir), behindMs: fresh.behindMs, warn: `store ${formatBehind(fresh.behindMs)} behind newest issue mtime — run \`bais ingest\`` }
			: fresh.state === "legacy-unknown"
				? { db: dbPathFor(issuesDir), behindMs: null, warn: `store age unknown (${fresh.detail})` }
				: null;
		const swarmVerdicts = swarmEntries.flatMap((e) => parseSwarmVerdicts(e.body).map((v) => ({ id: e.id, ...v })));
		if (asJson) {
			const staleClaims = checkFiles
				.filter((f) => f.issue.status === "Doing" && leaseExpired(f.lease, Date.now()))
				.map((f) => ({ id: f.issue.id, holder: f.holder, lease: f.lease }));
			console.log(JSON.stringify({ ok, bad, dangling, cycles, evidence, staleClaims, staleStore, shadows, swarm, swarmVerdicts, promptRegistry: registryJson(), e2e: e2eJson(), audits: auditsJson(), goalSketch: sketchStaleJson() }, null, 2));
		} else {
			for (const d of missing) console.log(`dangling\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
			for (const d of external) console.log(`external\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
			if (cycles.length) console.log(`cycle\t${cycles.join(", ")}`);
			// Claims are file-envelope (the projection predates them):
			// stale-claim always reads the scan truth. Advisory only.
			for (const f of checkFiles) {
				if (f.issue.status !== "Doing" || !leaseExpired(f.lease, Date.now())) continue;
				console.log(`stale-claim\t${f.issue.id}\t${f.holder ?? "unknown"}\t${f.lease ?? "no-lease"}`);
			}
			if (staleStore) console.log(`stale-store\t${staleStore.db}\t${staleStore.warn}`);
			const fatalEvidence = printEvidence(evidence);
			const fatalSwarm = printSwarm(swarm);
			printShadows();
			printRegistry();
			printE2eDrift();
			printAudits();
			printSketchStale();
			console.log(`ok\t${ok} issues, ${bad.length} bad`);
			if (bad.length || missing.length || cycles.length || fatalEvidence || fatalSwarm || undeclared.length || registryFatal || e2eDriftFatal || auditFatal || sketchStaleFatal || snapshotDriftFatal) process.exit(1);
			process.exit(0);
		}
		// hub#188/hub#191/hub#193: in the warn phases unresolvable-e2e and
		// every drift/audit row are advisory — e2eDriftFatal/auditFatal are
		// zero and unresolvable-e2e is excluded from the fatal count.
		const fatalEvidence = evidence.filter((p) => p.status === "Missing" && !(e2ePhase === "warn" && p.reason === "unresolvable-e2e")).length;
		if (bad.length || missing.length || cycles.length || fatalEvidence || swarm.length || undeclared.length || registryFatal || e2eDriftFatal || auditFatal || sketchStaleFatal || snapshotDriftFatal) process.exit(1);
	} else {
		const issues = checkFiles;
		const failures = checkLoad.failures;
		const dangling = danglingRefsIn(issues, projectName(issuesDir));
		const missing = dangling.filter((d) => d.status === "Missing");
		const external = dangling.filter((d) => d.status === "External");
		const cycles = cyclicIds(issues);
		// hub#188: scan truth, e2e stems resolved against .bais/e2e/.
		const evidence = scanEvidence;

		const swarmVerdicts = swarmEntries.flatMap((e) => parseSwarmVerdicts(e.body).map((v) => ({ id: e.id, ...v })));
		if (asJson) {
			const staleClaims = issues
				.filter((f) => f.issue.status === "Doing" && leaseExpired(f.lease, Date.now()))
				.map((f) => ({ id: f.issue.id, holder: f.holder, lease: f.lease }));
			console.log(JSON.stringify({ ok: issues.length, bad: failures, dangling, cycles, evidence, staleClaims, shadows, swarm, swarmVerdicts, promptRegistry: registryJson(), e2e: e2eJson(), audits: auditsJson(), goalSketch: sketchStaleJson() }, null, 2));
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
			// Dead-agent claims: Doing with an expired (or missing)
			// lease is loud here and reaped by `bais reap`. Advisory,
			// never fatal — reap is the fix, not this gate.
			for (const f of issues) {
				if (f.issue.status !== "Doing" || !leaseExpired(f.lease, Date.now())) continue;
				console.log(`stale-claim\t${f.issue.id}\t${f.holder ?? "unknown"}\t${f.lease ?? "no-lease"}`);
			}
			// bi#83: prose-only closes refuse loudly — Done with no (or
			// unresolvable) Evidence: refs names the missing evidence here.
			const fatalEvidence = printEvidence(evidence);
			// bi#131: malformed Swarm: verdict lines refuse loudly here.
			const fatalSwarm = printSwarm(swarm);
			printShadows();
			printRegistry();
			printE2eDrift();
			printAudits();
			printSketchStale();
			if (failures.length || missing.length || cycles.length || fatalEvidence || fatalSwarm || undeclared.length || registryFatal || e2eDriftFatal || auditFatal || sketchStaleFatal || snapshotDriftFatal) process.exit(1);
			process.exit(0);
		}

		// External is reported, never fatal — a cross-project edge is legitimate and
		// unresolvable from one directory. Applies to --json too: the old check
		// exited 0 in JSON mode, which made it useless as a CI gate. Same for
		// External verdict refs (bi#83): reported, never fatal. hub#188: in the
		// warn phase unresolvable-e2e is advisory too (e2eDriftFatal/auditFatal
		// stay zero until --e2e-strict/--audit-strict).
		const fatalEvidence = evidence.filter((p) => p.status === "Missing" && !(e2ePhase === "warn" && p.reason === "unresolvable-e2e")).length;
		if (failures.length || missing.length || cycles.length || fatalEvidence || swarm.length || undeclared.length || registryFatal || e2eDriftFatal || auditFatal || sketchStaleFatal || snapshotDriftFatal) process.exit(1);
	}
	process.exit(0);
}

// Lease-bound Doing (dead-agent reclamation): a Doing without a live
// claim is stale. Claims live on the file envelope (holder + RFC3339
// UTC lease), set by `move <id> Doing --as <owner> [--for 4h]` and
// cleared on any move out of Doing. `renew` extends (heartbeat),
// `reap` flips expired Doing back to Open. Pure function of (files,
// now): --now injects the instant for deterministic tests, and every
// writer re-validates through the BAML parser with restore-on-failure.
// An unparseable lease reads as expired (reclaim, never jam).
function flagVal(name: string): string | null {
	const i = argv.indexOf(name);
	return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
}
function parseDuration(s: string): number | null {
	const m = /^(\d+)(s|m|h|d)$/.exec(s);
	if (!m) return null;
	const mult = m[2] === "s" ? 1000 : m[2] === "m" ? 60000 : m[2] === "h" ? 3600000 : 86400000;
	return Number(m[1]) * mult;
}
function claimNowMs(): number {
	const n = flagVal("--now");
	if (n == null) return Date.now();
	const t = Date.parse(n);
	if (Number.isNaN(t)) {
		console.error(`bais: --now ${JSON.stringify(n)} does not parse as an instant`);
		process.exit(1);
	}
	return t;
}
function leaseExpired(lease: string | null, at: number): boolean {
	if (lease == null) return true;
	const t = Date.parse(lease);
	if (Number.isNaN(t)) return true;
	return t <= at;
}
// Millis-stripped ISO: the BAML shape is exactly 20 chars (`...SSZ`).
function toLeaseIso(at: number): string {
	return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function validHolder(h: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9.:@/_-]*$/.test(h);
}
// Surgical claim edit: strip existing holder/lease lines, then insert
// after the status line (claim sits with state). Null holder clears.
function setClaimLines(text: string, holder: string | null, lease: string | null): string {
	const stripped = text
		.split("\n")
		.filter((l) => !/^\s*holder\s*=/.test(l) && !/^\s*lease\s*=/.test(l))
		.join("\n");
	if (holder == null) return stripped;
	const m = /(^\s*status\s*=\s*"[^"]*".*$)/m.exec(stripped);
	if (!m) {
		console.error("bais: file has no status line");
		process.exit(1);
	}
	return stripped.replace(m[0], `${m[0]}\nholder = "${holder}"\nlease = "${lease ?? ""}"`);
}
async function writeClaimedFile(file: string, next: string): Promise<void> {
	const orig = readFileSync(file, "utf8");
	writeFileSync(file, next);
	try {
		await parseBaisFile(next);
	} catch (e: any) {
		writeFileSync(file, orig);
		console.error(`bais: edited ${file} rejected (${String(e?.message ?? e).split("\n")[0]}) — restored`);
		process.exit(1);
	}
	if (useStore) await ingestIssues(issuesDir);
}

if (cmd === "renew") {
	ensureInit();
	const id = argv[1];
	const asOwner = flagVal("--as");
	const dur = parseDuration(flagVal("--for") ?? "4h");
	if (!id || !asOwner) {
		console.error("bais renew <id> --as <owner> [--for 4h] [--now <instant>]");
		process.exit(1);
	}
	if (dur == null) {
		console.error(`bais renew: --for ${JSON.stringify(flagVal("--for"))} needs <n>s|m|h|d`);
		process.exit(1);
	}
	const file = join(issuesDir, `${id}.toml`);
	if (!existsSync(file)) {
		console.error(`bais renew: unknown issue ${id}`);
		process.exit(1);
	}
	const cur = (await parseBaisFile(readFileSync(file, "utf8"))) as { issue: { status: string }; holder: string | null };
	if (cur.issue.status !== "Doing") {
		console.error(`bais renew: ${id} is ${cur.issue.status}, not Doing (nothing to renew)`);
		process.exit(1);
	}
	if (cur.holder !== asOwner) {
		console.error(`bais renew: ${id} held by ${JSON.stringify(cur.holder)}, not ${JSON.stringify(asOwner)} (strangers cannot renew)`);
		process.exit(1);
	}
	const lease = toLeaseIso(claimNowMs() + dur);
	await writeClaimedFile(file, setClaimLines(readFileSync(file, "utf8"), asOwner, lease));
	console.log(`renewed\t${id}\t${asOwner}\t${lease}`);
	process.exit(0);
}

if (cmd === "reap") {
	ensureInit();
	const at = claimNowMs();
	const { issues } = await loadIssues(issuesDir);
	const reaped: { id: string; holder: string | null; lease: string | null }[] = [];
	for (const f of issues) {
		if (f.issue.status !== "Doing" || !leaseExpired(f.lease, at)) continue;
		const file = join(issuesDir, `${f.issue.id}.toml`);
		const orig = readFileSync(file, "utf8");
		const statusMatch = /^\s*status\s*=\s*"[^"]*"/m.exec(orig);
		if (!statusMatch) {
			console.error(`bais reap: ${f.issue.id}.toml has no status line`);
			process.exit(1);
		}
		await writeClaimedFile(file, setClaimLines(orig.replace(statusMatch[0], `status = "Open"`), null, null));
		reaped.push({ id: f.issue.id, holder: f.holder, lease: f.lease });
	}
	reaped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (asJson) {
		console.log(JSON.stringify({ reaped, now: new Date(at).toISOString() }, null, 2));
	} else {
		if (!reaped.length) console.log("reaped\t0");
		for (const r of reaped) console.log(`reaped\t${r.id}\t${r.holder ?? "unknown"}\t${r.lease ?? "no-lease"}`);
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
	// Doing is lease-bound: no anonymous claims (a dead agent's Doing
	// must name its holder, or reap cannot tell it apart from live work).
	let next = orig.replace(statusMatch[0], `status = "${to}"`);
	if (to === "Doing") {
		const asOwner = flagVal("--as");
		if (asOwner == null) {
			// Anonymous claim: allowed (bi#49 bare-move contract), but
			// instantly stale — no lease means reap reclaims on sight.
			// Pass --as for a live claim.
			next = setClaimLines(next, null, null);
		} else {
			if (!validHolder(asOwner)) {
				console.error(`bais move: --as ${JSON.stringify(asOwner)} is not an owner id (letters/digits/.:@/_/-)`);
				process.exit(1);
			}
			const dur = parseDuration(flagVal("--for") ?? "4h");
			if (dur == null) {
				console.error(`bais move: --for ${JSON.stringify(flagVal("--for"))} needs <n>s|m|h|d`);
				process.exit(1);
			}
			next = setClaimLines(next, asOwner, toLeaseIso(claimNowMs() + dur));
		}
	} else if (from === "Doing") {
		next = setClaimLines(next, null, null);
	}
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
		console.log(`rejected_events\t${o.rejected_events.length}`);
		for (const r of o.rejected_events) console.log(`  ${r.id}\t${r.author}\t${r.type}\t${r.reason}`);
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

// bi#139: handoff file spec (bais/spec/handoff.md) + validate gate.
// Append-only wiring: the validator lives in scripts/handoff-validate.mjs
// (resolved package-relative to this module first, then the same
// scriptsDirFor convention as close-evidence drills); this block only
// routes argv and renders the result.
if (cmd === "handoff") {
	// No ensureInit: validating a handoff file is project-independent
	// (the merger checks drafts anywhere, not just inside a .bais dir).
	if (argv[1] !== "--validate") {
		console.error("bais handoff --validate <file.handoff> [--base <sha>] [--json]");
		process.exit(1);
	}
	const file = argv[2];
	if (!file || file.startsWith("--")) {
		console.error("bais handoff --validate needs <file.handoff>");
		process.exit(1);
	}
	const baseFlag = argv.indexOf("--base");
	const base = baseFlag !== -1 ? argv[baseFlag + 1] : undefined;
	if (baseFlag !== -1 && (base == null || base.startsWith("--"))) {
		console.error("bais handoff --validate: --base needs <sha>");
		process.exit(1);
	}
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const { dirname } = await import("node:path");
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "..", "..", "scripts", "handoff-validate.mjs"),
		join(scriptsDirFor(issuesDir), "handoff-validate.mjs"),
	];
	const validator = candidates.find((c) => existsSync(c));
	if (!validator) {
		console.error("bais handoff: handoff-validate.mjs not found (expected in bais/scripts/)");
		process.exit(1);
	}
	const mod = await import(pathToFileURL(validator).href);
	const res = mod.validateHandoffFile(file, base == null ? {} : { base });
	if (asJson) printJson(res);
	else console.log(mod.formatText(res));
	process.exit(res.ok ? 0 : 1);
}

// bi#132: /goal interview/sketch/commit/status/switch (src lane).
// Goal logic lives ONLY in bais/scripts/goal.mjs (canonical — the hub#163
// single-source rule: this block routes argv, loads/saves per-directory
// .bais/goal.toml, and renders; never mirrors checklist/sketch/commit
// semantics). Candidates cover the compiled layout (dist/src ->
// pkg/scripts) and the dev layout (src -> pkg/scripts); a miss fails loud,
// never silent-drifted.
async function loadGoalModule(): Promise<any> {
	const { dirname } = await import("node:path");
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "..", "..", "scripts", "goal.mjs"),
		join(here, "..", "scripts", "goal.mjs"),
		join(scriptsDirFor(issuesDir), "goal.mjs"),
	];
	const found = candidates.find((c) => existsSync(c));
	if (!found) {
		console.error(`bais goal: goal.mjs not found (tried ${candidates.join(", ")})`);
		process.exit(1);
	}
	return await import(pathToFileURL(found).href);
}
// bi#80/bi#136: single-source scripts routing (hub#163 precedent — the
// goal/briefs lanes proved mirrors drift). stale.mjs owns the prune rules,
// lifecycle.mjs owns archive-budget/snapshot/retire. This CLI only routes
// argv, gathers filesystem facts, and renders; it never mirrors rule
// semantics. Candidates cover the compiled layout (dist/src ->
// pkg/scripts) and the dev layout (src -> pkg/scripts), then the
// scriptsDirFor convention; a miss fails loud, never silent-drifted.
async function loadScriptModule(name: string): Promise<any> {
	const { dirname } = await import("node:path");
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "..", "..", "scripts", name),
		join(here, "..", "scripts", name),
		join(scriptsDirFor(issuesDir), name),
	];
	const found = candidates.find((c) => existsSync(c));
	if (!found) {
		console.error(`bais: ${name} not found (tried ${candidates.join(", ")})`);
		process.exit(1);
	}
	return await import(pathToFileURL(found).href);
}
// bi#136: archive cap resolution — `--cap` flag wins, then
// .bais/config.toml `archive_cap_bytes`, then the 1MB default. The default
// exists so an unconfigured archive still has a threshold (the .baml-cache
// lesson: unbounded caches go unnoticed); over cap warns LOUD with exact
// bytes (warn-only on writes, nonzero gate on `archive --size`).
async function archiveCapBytes(): Promise<number | null> {
	const lm = await loadScriptModule("lifecycle.mjs");
	const flag = flagVal("--cap");
	if (flag != null) {
		const n = lm.parseCapBytes(flag);
		if (n == null) {
			console.error(`bais archive: --cap ${JSON.stringify(flag)} needs <bytes>[b|k|m]`);
			process.exit(1);
		}
		return n;
	}
	try {
		const cfg = readFileSync(join(root, "config.toml"), "utf8");
		const m = cfg.match(/^\s*archive_cap_bytes\s*=\s*"?([^"\s#]+)"?\s*(?:#.*)?$/m);
		if (m) {
			const n = lm.parseCapBytes(m[1]);
			if (n != null) return n;
		}
	} catch {}
	return 1048576;
}
// Loud over-cap warn after an archive write (warn-only: the write stands,
// the budget pressure is visible).
async function reportArchiveCap(archiveDir: string): Promise<void> {
	const lm = await loadScriptModule("lifecycle.mjs");
	const cap = await archiveCapBytes();
	const rep = lm.sizeReport(lm.archiveSize(archiveDir), cap);
	if (rep.warn) console.error(rep.warn);
}
if (cmd === "goal") {
	ensureInit();
	const gm = await loadGoalModule();
	const goalFile = join(root, "goal.toml");
	const verb = argv[1];
	const usage = `bais goal <start|sketch|commit|status|switch|snapshot|clear|retire|gate|e2e> — per-directory campaign interview (bi#132; snapshot/clear/retire are the bi#136 lifecycle binding; gate is hub#213; e2e is the hub#191 surface/case coverage join)`;
	const loadGoal = (): any => {
		if (!existsSync(goalFile)) {
			console.error(`bais goal: no campaign at ${goalFile} — run \`bais goal start "<statement>"\` first`);
			process.exit(1);
		}
		return gm.parseGoalToml(readFileSync(goalFile, "utf8"));
	};
	const saveGoal = (g: any): void => {
		writeFileSync(goalFile, gm.renderGoalToml(g));
	};
	// The scoping interview: print nextQuestion, read one line per box
	// (value | "waive" | "defaults" — the use-defaults escape), save after
	// every settled box so EOF/resume never loses progress. Settle failures
	// (e.g. the surface-spec loud validation) leave the box open and re-ask.
	const runInterview = async (g: any): Promise<void> => {
		const { createInterface } = await import("node:readline");
		const rl = createInterface({ input: process.stdin });
		const it = rl[Symbol.asyncIterator]();
		for (;;) {
			if (gm.checklistComplete(g)) break;
			const q = gm.nextQuestion(g);
			if (gm.checklistComplete(g)) {
				console.log(q);
				break; // rounds-cap notice: the rest auto-defaulted above
			}
			console.log(q);
			const box = gm.openBoxes(g)[0];
			const nxt = await it.next();
			if (nxt.done) {
				console.error(`bais goal: input closed — interview saved at ${goalFile}, rerun \`bais goal start\` to resume`);
				break;
			}
			const line = String(nxt.value ?? "");
			const t = line.trim().toLowerCase();
			try {
				if (t === "defaults") gm.useDefaults(g);
				else if (t === "waive") gm.waive(g, box);
				else gm.answer(g, box, line);
			} catch (e: any) {
				console.error(`bais goal: ${e?.message ?? e} (box still open)`);
				continue;
			}
			saveGoal(g);
		}
		rl.close();
		saveGoal(g);
		if (gm.checklistComplete(g)) console.log(`bais goal: checklist complete — \`bais goal sketch\` to dry-run the proposal`);
		if (asJson) printJson({ statement: g.statement, complete: gm.checklistComplete(g), open: gm.openBoxes(g) });
	};
	if (verb === "start") {
		const force = argv.includes("--force");
		if (existsSync(goalFile) && !force) {
			const cur = loadGoal();
			if (!gm.checklistComplete(cur)) {
				await runInterview(cur); // open interview: start resumes it
				process.exit(0);
			}
			console.error(`bais goal: campaign already complete at ${goalFile} — \`bais goal switch "<new statement>"\` to restructure, or \`bais goal start --force "<statement>"\` to restart`);
			process.exit(1);
		}
		const statement = argv[2];
		if (!statement || statement.startsWith("--")) {
			console.error(`bais goal start needs "<statement>"`);
			process.exit(1);
		}
		const g = gm.newGoal(statement);
		saveGoal(g);
		await runInterview(g);
	} else if (verb === "sketch") {
		const g = loadGoal();
		const res = gm.sketch(g);
		if (!res.ok) {
			console.error(`bais goal: ${res.error}`);
			process.exit(1);
		}
		if (asJson) printJson({ ok: true, proposal: res.proposal });
		else {
			console.log(`proposal (dry run — nothing written; edit, then \`bais goal commit --approve\`):`);
			console.log(JSON.stringify(res.proposal, null, 2));
		}
	} else if (verb === "commit") {
		// Load-bearing hunk (bi#132/bi#57 red-check target): approval is an
		// explicit human yes — the --approve flag and nothing else. Defaulting
		// this to true (or reading it from anywhere but argv) must trip the
		// dogfood check "commit refuses without approval".
		const approved = argv.includes("--approve");
		const g = loadGoal();
		// The sketch verb is the dry run; commit re-derives the proposal
		// fresh (sketch() side-effects goal.sketch, which commit() requires
		// — renderGoalToml persists no sketch, so there is nothing to load).
		// Refusal texts stay scripts-verbatim; note the precedence: an open
		// checklist reports the sketch refusal before the approval refusal
		// (commit() itself gates approval first — single-fault cases, which
		// the dogfood pins, read identically either way).
		const sk = gm.sketch(g);
		if (!sk.ok) {
			console.error(`bais goal: ${sk.error}`);
			process.exit(1);
		}
		// hub#184/hub#185: commit() returns .bais-relative paths (goal.toml,
		// sketch.toml, e2e/<slug>.mjs scaffolds, issues/goal#oracle-gap.toml
		// when the oracle is empty) — the CLI owns the filesystem, goal.mjs
		// owns the render. Parent dirs are created; wrote prints .bais/*.
		const res = gm.commit(g, {
			approved,
			write: (rel: string, content: string) => {
				const dest = join(root, rel);
				mkdirSync(dirname(dest), { recursive: true });
				writeFileSync(dest, content);
			},
		});
		if (!res.ok) {
			console.error(`bais goal: ${res.error}`);
			process.exit(1);
		}
		if (asJson) printJson({ ok: true, wrote: res.wrote });
		else for (const f of res.wrote) console.log(`committed\t${f}`);
	} else if (verb === "status") {
		const g = loadGoal();
		const st = gm.status(g);
		const gate = gm.validateGoal(readFileSync(goalFile, "utf8"));
		// hub#185: goal-level warns (oracle_absent) print on the warn
		// channel beside the file-gate warns, and ride --json as warns.
		const goalWarns: string[] = Array.isArray(st.warns) ? st.warns : [];
		if (asJson) printJson({ file: goalFile, ...st, errors: gate.errors, warns: [...goalWarns, ...gate.warns] });
		else {
			console.log(`statement\t${st.statement}`);
			for (const b of Object.keys(st.checklist)) console.log(`box\t${b}\t${st.checklist[b]}`);
			console.log(`acceptance\t${st.done}/${st.total}`);
			for (const o of st.open) console.log(`open\t${o}`);
			console.log(`sketched\t${st.sketched}`);
			console.log(`oracle\t${st.oracle ?? "present"}`);
			for (const w of goalWarns) console.error(`warn\t${w}`);
			for (const w of gate.warns) console.error(`warn\t${w}`);
			if (gate.errors.length) {
				for (const e of gate.errors) console.error(`error\t${e}`);
				process.exit(1);
			}
		}
	} else if (verb === "switch") {
		const newStatement = argv[2];
		if (!newStatement || newStatement.startsWith("--")) {
			console.error(`bais goal switch needs "<new statement>"`);
			process.exit(1);
		}
		const g = loadGoal();
		const res = gm.switchGoal(g, newStatement);
		saveGoal(res.fresh);
		// hub#195: the switch lists the old campaign's surfaces for an
		// explicit keep/retire decision (undecided surfaces keep their cases
		// but flagged), and the re-interview's surface-spec default is the
		// archived campaign's spec (edit, don't rewrite).
		if (asJson) printJson({ archived: res.archived, retire: res.retire, surfaces: res.surfaces, statement: res.fresh.statement });
		else {
			console.log(`archived\t${res.archived.statement}`);
			if (res.archived.snapshot_id) console.log(`archived-snapshot\t${res.archived.snapshot_id}`);
			for (const id of res.retire) console.log(`retire\t${id}`);
			for (const s of res.surfaces) console.log(`surface-undecided\t${s.case}\t${s.surface}\tauthored under ${s.snapshot_id || "no recorded snapshot"} — keep (rebinds to the new snapshot id) or retire with a reason (hub#195)`);
			if (res.archived.surface_spec) console.log(`surface-spec-default\t${res.archived.surface_spec}`);
		}
		await runInterview(res.fresh); // restructure flow ends in a fresh interview
	} else if (verb === "snapshot") {
		// bi#136: snapshot-first precondition for `goal clear`. Captures the
		// live statement + issue id set; `clear` refuses unless the snapshot
		// file still covers both (stale snapshots are never honored).
		const lm = await loadScriptModule("lifecycle.mjs");
		const g = loadGoal();
		const { issues } = await loadIssues(issuesDir);
		const snap = lm.snapshotForClear({ statement: g.statement, issueIds: issues.map((f) => f.issue.id) });
		const out = flagVal("--out");
		const text = JSON.stringify({ snapshot: snap }, null, 2);
		if (out) {
			writeFileSync(out, text);
			console.error(`goal snapshot → ${out}`);
			if (asJson) printJson({ snapshot: snap, out });
		} else if (asJson) {
			printJson({ snapshot: snap });
		} else {
			console.log(text);
		}
	} else if (verb === "clear") {
		// bi#136: recoverable clear. Refuses without --snapshot
		// (snapshot-first), without --confirm (explicit human yes — same
		// shape as commit's --approve), and when the snapshot no longer
		// covers the live statement + issue set. Issues are untouched; only
		// the campaign file is removed, and the snapshot is the recovery path.
		const lm = await loadScriptModule("lifecycle.mjs");
		const snapPath = flagVal("--snapshot");
		if (!snapPath) {
			console.error("bais goal clear refused: snapshot-first — run `bais goal snapshot --out <file>` then retry with --snapshot <file>");
			process.exit(1);
		}
		if (!existsSync(goalFile)) {
			console.error(`bais goal clear refused: no campaign at ${goalFile} (nothing to clear)`);
			process.exit(1);
		}
		let snap: any = null;
		try {
			const parsed = JSON.parse(readFileSync(snapPath, "utf8"));
			snap = parsed?.snapshot ?? parsed;
		} catch {
			snap = null;
		}
		if (snap == null) {
			console.error(`bais goal clear refused: snapshot-first — cannot read a goal snapshot from ${snapPath}`);
			process.exit(1);
		}
		const g = loadGoal();
		const { issues } = await loadIssues(issuesDir);
		const v = lm.verifySnapshotForClear(snap, { statement: g.statement, issueIds: issues.map((f) => f.issue.id) });
		if (!v.ok) {
			console.error(`bais goal ${v.error}`);
			process.exit(1);
		}
		if (!argv.includes("--confirm")) {
			console.error("bais goal clear refused: explicit confirm required (--confirm)");
			process.exit(1);
		}
		const { unlinkSync } = await import("node:fs");
		unlinkSync(goalFile);
		if (asJson) printJson({ cleared: goalFile, statement: g.statement, snapshot: snapPath });
		else console.log(`cleared\t${goalFile}\trecover with ${snapPath}`);
	} else if (verb === "retire") {
		// bi#136: restructured-away nodes become Dropped with reason (or move
		// to .bais/archive/ with --archive), never silent hard-delete. The
		// reason is mandatory and dated into the body; the edit re-parses
		// through the BAML parser with restore-on-failure (move precedent).
		const lm = await loadScriptModule("lifecycle.mjs");
		const id = argv[2];
		const reason = flagVal("--reason");
		if (!id || id.startsWith("--")) {
			console.error("bais goal retire <id> --reason <R> [--archive]");
			process.exit(1);
		}
		if (!reason) {
			console.error("bais goal retire refused: --reason is mandatory (retirements are never silent)");
			process.exit(1);
		}
		const file = join(issuesDir, `${id}.toml`);
		if (!existsSync(file)) {
			console.error(`bais goal retire: unknown issue ${id}`);
			process.exit(1);
		}
		const today = new Date().toISOString().slice(0, 10);
		if (argv.includes("--archive")) {
			const archiveDir = join(root, "archive");
			mkdirSync(archiveDir, { recursive: true });
			const dest = join(archiveDir, `${id}.toml`);
			if (existsSync(dest)) {
				console.error(`bais goal retire refused: ${id} already archived (no silent overwrite)`);
				process.exit(1);
			}
			const orig = readFileSync(file, "utf8");
			writeFileSync(dest, `# Retired ${today}: ${reason}\n${orig}`);
			const { unlinkSync } = await import("node:fs");
			unlinkSync(file);
			if (useStore) await ingestIssues(issuesDir);
			await reportArchiveCap(archiveDir);
			console.log(`archived\t${id}\t${reason}`);
		} else {
			const orig = readFileSync(file, "utf8");
			const withLine = lm.retireBodyInFile(orig, reason, today);
			if (withLine == null) {
				console.error(`bais goal retire refused: ${id}.toml has no closable body block`);
				process.exit(1);
			}
			const statusMatch = /^\s*status\s*=\s*"[^"]*"/m.exec(withLine);
			if (!statusMatch) {
				console.error(`bais goal retire: ${id}.toml has no status line`);
				process.exit(1);
			}
			const next = setClaimLines(withLine.replace(statusMatch[0], `status = "Dropped"`), null, null);
			writeFileSync(file, next);
			try {
				await parseBaisFile(next);
			} catch (e: any) {
				writeFileSync(file, orig);
				console.error(`bais goal retire: edited ${id}.toml rejected (${String(e?.message ?? e).split("\n")[0]}) — restored`);
				process.exit(1);
			}
			if (useStore) await ingestIssues(issuesDir);
			console.log(`retired\t${id}\tDropped\t${reason}`);
		}
	} else if (verb === "gate") {
		// hub#213: deterministic gates first, judge never wired here (null —
		// a red suite pauses with a named reason instead of reaching any
		// verdict). Gates: baml check/test for the bais package when present,
		// then the committed goal's e2e scaffolds (hub#184). The fingerprint
		// cache (.bais/gate-cache.json) replays results on an unchanged
		// workspace instead of re-running; retries bounded by
		// GATE_RETRY_DEFAULT, then auto-pause.
		const g = loadGoal();
		const hubRoot = resolve(issuesDir, "..", "..");
		const gates: { name: string; argv: string[]; cwd?: string; timeout?: number }[] = [];
		if (existsSync(join(hubRoot, "bais", "baml.toml"))) {
			gates.push(
				{ name: "baml check (bais)", argv: ["baml", "check", "--project", "bais"], cwd: hubRoot, timeout: 300000 },
				{ name: "baml test (bais)", argv: ["baml", "test", "--project", "bais"], cwd: hubRoot, timeout: 300000 },
			);
		}
		gates.push(...gm.goalGates(g, { e2eDir: ".bais/e2e" }));
		const res = gm.runGoalGate({
			gates,
			fingerprint: () => gm.workspaceFingerprint(process.cwd()),
			cache: gm.newFileGateCache(".bais/gate-cache.json"),
			retries: gm.GATE_RETRY_DEFAULT,
			judge: null,
			turnBudget: 0,
		});
		if (asJson) {
			printJson(res);
		} else {
			for (const r of res.results) console.log(`gate\t${r.status === 0 ? "ok" : "red"}\t${r.name}${r.replayed ? "\treplay" : ""}`);
			if (res.paused) console.error(`bais goal gate: paused — ${res.pause_reason}`);
			else console.log(`gates green (${res.results.length})`);
		}
		process.exit(res.ok ? 0 : 1);
	} else if (verb === "e2e") {
		// hub#191: the surface/case coverage join as the outside-agent-
		// parseable surface — tab rows like every other bais command, --json
		// for agents, no LLM in the run path. ok <surface> <file> /
		// missing <surface> <anchor> / stale <file> <anchor>; a goal.toml
		// with no declared testing_surface is a named no-surfaces line
		// (grandfathered, never silently empty). Exits 1 when any gap or
		// stale row exists so CI can pin zero — same drill-suite idiom.
		const goalText = existsSync(goalFile) ? readFileSync(goalFile, "utf8") : "";
		const surfaces = parseGoalTestingSurface(goalText);
		const cases = e2eCaseAnchorsIn(e2eDirFor(issuesDir));
		const drift = e2eDriftJoin(surfaces, cases);
		if (asJson) {
			printJson({ declared: drift.declared, surfaces, cases, ok: drift.ok, gaps: drift.gaps, stale: drift.stale });
		} else {
			if (!drift.declared) console.log(`e2e\tno-surfaces\tgoal.toml declares no testing_surface — the coverage join is vacuous (hub#191)`);
			for (const o of drift.ok) console.log(`ok\t${o.surface}\t${o.file}`);
			for (const g of drift.gaps) console.log(`missing\t${g.surface}\t${g.anchor}`);
			for (const s of drift.stale) console.log(`stale\t${s.file}\t${s.anchor ?? "(none embedded)"}`);
		}
		process.exit(drift.gaps.length + drift.stale.length > 0 ? 1 : 0);
	} else {
		console.error(usage);
		process.exit(1);
	}
	process.exit(0);
}

// bi#80: deterministic stale-issue pruning. Pure rules over the scan (files,
// mtimes, graph) plus pre-gathered repo facts — see bais/scripts/stale.mjs
// (canonical). TSV id/rule/reason; --json for gates; exit 1 with candidates
// so CI can pin zero-stale. Never mutates, never auto-closes (bi#55).
if (cmd === "stale") {
	ensureInit();
	const sm = await loadScriptModule("stale.mjs");
	const daysRaw = optValue("--days") ?? "30";
	const days = Number(daysRaw);
	if (!Number.isFinite(days) || days < 0) {
		console.error("bais stale needs --days <non-negative number of days>");
		process.exit(1);
	}
	const nowMs = claimNowMs();
	const { issues } = await loadIssues(issuesDir);
	const mtimes = new Map<string, number>();
	for (const f of issues) {
		try {
			mtimes.set(f.issue.id, statSync(join(issuesDir, `${f.issue.id}.toml`)).mtimeMs);
		} catch {
			// Absent on purpose: unknown age never inflates staleness.
		}
	}
	// PARKED-TYPO deduplicates against `check` by construction: the Missing
	// set below IS check's own dangling predicate (same function, Missing +
	// ordering kinds only — External cross-project refs never flag).
	const project = projectName(issuesDir);
	const missingRefs = danglingRefsIn(issues, project)
		.filter((d) => d.status === "Missing" && (d.kind === "DependsOn" || d.kind === "Blocks"))
		.map((d) => ({ declaredBy: d.declaredBy, id: d.id, side: d.side, kind: d.kind, from: d.from, to: d.to }));
	// SHIPPED-COUNT facts, hub-root-relative. An unresolvable source skips
	// its verifier instead of failing (a missing registry file degrades to
	// fewer verifiers, never a false positive).
	const hubRoot = resolve(issuesDir, "..", "..");
	let registryCount: number | null = null;
	try {
		const reg = readFileSync(join(hubRoot, "bi", "baml_src", "skills.baml"), "utf8");
		registryCount = reg.split("\n").filter((l) => /^\s+BuiltinSlashCommand \{$/.test(l)).length;
	} catch {}
	const fileLines = new Map<string, number>();
	const resolveFile = (claimed: string): string | null => {
		const base = claimed.split("/").pop() ?? claimed;
		const cands = [join(hubRoot, claimed), join(hubRoot, "bi", "src", base), join(hubRoot, "bais", "src", base)];
		for (const c of cands) {
			if (fileLines.has(c)) return c;
			try {
				// wc -l semantics: count of newline bytes, nothing inferred.
				const text = readFileSync(c, "utf8");
				fileLines.set(c, (text.match(/\n/g) ?? []).length);
				return c;
			} catch {}
		}
		return null;
	};
	const cands = sm.staleCandidates({ files: issues, mtimes, missingRefs, facts: { registryCount, fileLines, resolveFile }, days, nowMs });
	if (asJson) {
		printJson({ candidates: cands, days, now: new Date(nowMs).toISOString() });
	} else {
		for (const c of cands) console.log(`${c.id}\t${c.rule}\t${c.reason}`);
		if (!cands.length) console.log("(no stale candidates)");
	}
	process.exit(cands.length ? 1 : 0);
}

// hub#211: consent-first suggestion lane. Suggestions are a record class
// separate from Issue, living in the sibling .bais/suggestions lane
// (file-per-record like issues, so `bais ready` stays work-only by
// construction). list/dismiss never touch the issues dir; promote writes an
// issue ONLY through writePromotedIssue with explicit --yes consent, and
// the Promoted latch persists only after that write succeeds — a failed
// promote must never latch.
if (cmd === "suggestions") {
	ensureInit();
	const suggestionsDir = join(resolve(issuesDir, ".."), "suggestions");
	const sub = argv[1];
	const usage = `bais suggestions — consent-first suggestion lane (hub#211)
  bais suggestions list [--all] [--json]     # pending ascending by offered_at (+ terminal records with --all)
  bais suggestions dismiss <sug-id>          # latch the dedup_key forever
  bais suggestions promote <sug-id> <new-issue-id> --yes   # no --yes: preview only, writes nothing`;
	if (sub === "list") {
		const { suggestions, failures } = loadSuggestions(suggestionsDir);
		const showAll = argv.includes("--all");
		const rows = (showAll ? suggestions : pendingSuggestions(suggestions)).sort(
			(a, b) => a.offered_at - b.offered_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		if (asJson) {
			printJson({ suggestions: rows, pending: pendingSuggestions(suggestions).length, cap: MAX_PENDING, unparseable: failures });
		} else {
			for (const s of rows) console.log(`${s.id}\t${s.status}\t${s.offered_at}\t${s.title}${showAll && s.resolution != null ? `\t${s.resolution}` : ""}`);
			if (!rows.length) console.log(showAll ? "(no suggestions)" : "(no pending suggestions)");
			// A record that failed to parse is loud here, never silently dropped (bi#55).
			for (const f of failures) console.log(`bad\t${f.file}\t${f.error}`);
		}
		process.exit(0);
	}
	if (sub === "dismiss") {
		const id = argv[2];
		if (!id || id.startsWith("--")) {
			console.error(usage);
			process.exit(1);
		}
		try {
			// Dismissal IS the latch: the record flips to Dismissed on disk and
			// its dedup_key is never re-offered.
			const d = dismissSuggestion(suggestionsDir, id);
			if (asJson) printJson({ dismissed: d.id, dedup_key: d.dedup_key, status: d.status, resolution: d.resolution });
			else console.log(`dismissed\t${d.id}\t${d.dedup_key}`);
		} catch (e: any) {
			console.error(`bais suggestions dismiss: ${String(e?.message ?? e).split("\n")[0]}`);
			process.exit(1);
		}
		process.exit(0);
	}
	if (sub === "promote") {
		const id = argv[2];
		const newId = argv[3];
		if (!id || !newId || id.startsWith("--") || newId.startsWith("--")) {
			console.error(usage);
			process.exit(1);
		}
		const { suggestions } = loadSuggestions(suggestionsDir);
		const s = suggestions.find((x) => x.id === id);
		if (!s) {
			console.error(`bais suggestions promote: unknown suggestion ${id}`);
			process.exit(1);
		}
		if (s.status !== "Pending") {
			console.error(`bais suggestions promote refused: ${id} is ${s.status}, not Pending (terminal records latch their dedup_key forever)`);
			process.exit(1);
		}
		const derivation = promoteDerivation(s, newId);
		if (!argv.includes("--yes")) {
			// Consent-first: print the derivation preview, write nothing.
			if (asJson) printJson({ preview: derivation, consent: "refused — pass --yes to write the issue" });
			else {
				console.log("preview (dry run — nothing written; pass --yes to promote):");
				console.log(JSON.stringify(derivation, null, 2));
			}
			process.exit(0);
		}
		try {
			// Issue write first, latch second: a failed promote must never latch.
			const file = writePromotedIssue(issuesDir, s, newId, true);
			const latch = writeSuggestion(suggestionsDir, { ...s, status: "Promoted", resolution: `promoted-to-${newId}` });
			if (useStore) await ingestIssues(issuesDir);
			if (asJson) printJson({ promoted: { suggestion: s.id, issue: newId, file, latch, dedup_key: s.dedup_key } });
			else {
				console.log(`promoted\t${s.id}\t${newId}\t${file}`);
				console.log(`latched\t${s.dedup_key}`);
			}
		} catch (e: any) {
			console.error(`bais suggestions promote: ${String(e?.message ?? e).split("\n")[0]} — nothing latched`);
			process.exit(1);
		}
		process.exit(0);
	}
	console.error(usage);
	process.exit(1);
}

// hub#212: deterministic lifecycle sweep. Route-only (the hub#163
// single-source rule): bais/scripts/curator.mjs owns the policy; this block
// resolves argv + filesystem facts and renders. Default (no --apply) is a
// dry-run REPORT that writes nothing — no ledger, no state file, no
// snapshot. --apply passes the actor through and performs snapshot +
// ledger + archive via applyActions against the hub root. --now rides the
// same claimNowMs helper as move/renew/reap.
if (cmd === "curator") {
	ensureInit();
	const cm = await loadScriptModule("curator.mjs");
	if (argv.includes("--apply") && argv.includes("--dry-run")) {
		console.error("bais curator: --apply and --dry-run are mutually exclusive");
		process.exit(1);
	}
	const apply = argv.includes("--apply");
	const hubRoot = resolve(issuesDir, "..", "..");
	const nowMs = claimNowMs();
	const actor = flagVal("--actor") ?? process.env.USER ?? "curator";
	const nowDay = cm.dayOf(nowMs);
	const nowIso = new Date(nowMs).toISOString();
	const files = await cm.loadHub(hubRoot, nowMs);
	const state = cm.loadState(hubRoot);
	const actions = cm.curatorSweep(files.map((f: any) => f.issue), nowDay, state?.last_sweep_day ?? null);
	const mode = apply ? "apply" : "dry-run";
	if (asJson) {
		printJson({ hub: hubRoot, now: nowIso, mode, first_run: state == null, counts: cm.summarize(actions), actions });
	} else {
		process.stdout.write(cm.formatReport({ hub: hubRoot, nowIso, mode, firstRun: state == null, actions }));
	}
	if (apply) {
		const { snapDir } = cm.applyActions(hubRoot, files, actions, { nowMs, nowIso, nowDay, actor });
		console.error(`curator: snapshot ${snapDir}`);
		console.error(`curator: ledger ${join(hubRoot, ".bais", "curator-ledger.jsonl")} appended (actor ${actor})`);
		// Archiving moves files out of issues/ — rebuild the projection (move precedent).
		if (useStore) await ingestIssues(issuesDir);
	}
	process.exit(0);
}

// bi#136: archive budget + real delete. Archive is .bais/archive/ (flat
// <id>.toml layout); --size reports exact bytes with a loud over-cap warn
// (nonzero gate); `archive <id>` moves a file out of issues/ (projection
// rebuilt when a store exists, move precedent); `delete <id>` removes the
// file fully + rebuilds the projection — no manual cache-folder hunting.
if (cmd === "archive") {
	ensureInit();
	const lm = await loadScriptModule("lifecycle.mjs");
	const archiveDir = join(root, "archive");
	if (argv.includes("--size")) {
		const cap = await archiveCapBytes();
		const size = lm.archiveSize(archiveDir);
		const rep = lm.sizeReport(size, cap);
		if (asJson) {
			printJson({ bytes: size.bytes, files: size.files, entries: size.entries, cap_bytes: cap, over: rep.over });
		} else {
			console.log(rep.text);
		}
		if (rep.warn) console.error(rep.warn);
		process.exit(rep.over ? 1 : 0);
	}
	const id = argv[1];
	const reason = flagVal("--reason") ?? "";
	if (!id || id.startsWith("-")) {
		console.error("bais archive --size [--cap N] [--json] | bais archive <id> [--reason R]");
		process.exit(1);
	}
	const file = join(issuesDir, `${id}.toml`);
	if (!existsSync(file)) {
		console.error(`bais archive: unknown issue ${id}`);
		process.exit(1);
	}
	mkdirSync(archiveDir, { recursive: true });
	const dest = join(archiveDir, `${id}.toml`);
	if (existsSync(dest)) {
		console.error(`bais archive refused: ${id} already archived (no silent overwrite)`);
		process.exit(1);
	}
	const today = new Date().toISOString().slice(0, 10);
	const orig = readFileSync(file, "utf8");
	writeFileSync(dest, reason ? `# Archived ${today}: ${reason}\n${orig}` : orig);
	const { unlinkSync } = await import("node:fs");
	unlinkSync(file);
	if (useStore) await ingestIssues(issuesDir);
	if (asJson) {
		const size = lm.archiveSize(archiveDir);
		printJson({ archived: id, dest, bytes: size.bytes, files: size.files });
	} else {
		console.log(`archived\t${id}`);
	}
	await reportArchiveCap(archiveDir);
	process.exit(0);
}

if (cmd === "delete") {
	ensureInit();
	const id = argv[1];
	if (!id || id.startsWith("-")) {
		console.error("bais delete <id> [--json]");
		process.exit(1);
	}
	const file = join(issuesDir, `${id}.toml`);
	if (!existsSync(file)) {
		console.error(`bais delete: unknown issue ${id}`);
		process.exit(1);
	}
	const { unlinkSync } = await import("node:fs");
	unlinkSync(file);
	if (useStore) await ingestIssues(issuesDir);
	if (asJson) printJson({ deleted: id });
	else console.log(`deleted\t${id}`);
	process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
help();
process.exit(1);
