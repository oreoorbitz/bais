// bais/src/store.ts — SQLite projection over the event log (fusion Phase 2).
//
// BAML owns event -> datom reduction (ns_event/reduce.baml, pure); the host
// owns storage. This file seeds a log from .bais/issues/*.toml (one
// task.create + rel.add per file — no migration lock, the TOML stays
// readable), merges surviving hub/sync-appended history over the seed
// (bi#34: ingest never drops hub events), reduces via the BAML SDK, and
// serves ready/graph/list/check from indexed tables. Queries carry as_of +
// completeness so "empty" is distinguishable from "not synced".
//
// node:sqlite (built-in, no deps). DB lives at .bais/store.db; every read
// command falls back to the readdir scan when it is absent.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { event } from "../baml_sdk/index.js";
import { parseBaisFile } from "./toml.js";
import { eventId, verifyEventId } from "./ids.js";
import { createHash } from "node:crypto";
import { projectName } from "./graph.js";
import { whyNotIn } from "./graph.js";
import type { BaisEdge, BaisFile, HostLease, WhyNot } from "./graph.js";

export type AsOf = { heads: string[]; lc: number; wall_ts: string };
export type Completeness = "complete" | "partial";

export type StoredTask = {
	entity: string;
	title: string;
	status: string;
	kind: string;
	area: string | null;
	severity: number | null;
	source: string | null;
	body: string;
	labels: string[];
	comments: string[];
};

export type StoredEdge = StoredRel & { declaredBy: string };

export type StoredRel = { id: string; source: string; type: string; target: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, seq INTEGER NOT NULL,
  prev TEXT, project TEXT NOT NULL, entity TEXT NOT NULL,
  refs TEXT NOT NULL, lc INTEGER NOT NULL, ts TEXT NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL, sig TEXT,
  admitted INTEGER NOT NULL, drop_reason TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  entity TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
  kind TEXT NOT NULL, area TEXT, severity INTEGER, source TEXT, body TEXT NOT NULL,
  labels TEXT NOT NULL, comments TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rels (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conflicts (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, field TEXT NOT NULL,
  options TEXT NOT NULL, winner TEXT, event_ids TEXT NOT NULL, at_lc INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS excluded (event_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failures (file TEXT PRIMARY KEY, error TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, task TEXT NOT NULL, holder TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL, read_set TEXT NOT NULL, expires_lc INTEGER);
CREATE TABLE IF NOT EXISTS verifies (id TEXT PRIMARY KEY, task TEXT NOT NULL, submit_ref TEXT NOT NULL, verdict TEXT NOT NULL, verifier TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (submit_id TEXT PRIMARY KEY, task TEXT NOT NULL, producer TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS caps (grant_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, audience TEXT NOT NULL, can TEXT NOT NULL, scope TEXT NOT NULL, expiry_lc INTEGER NOT NULL, budget_cap_usd REAL, budget_cap_tokens INTEGER, revoked INTEGER NOT NULL, revoked_by TEXT);
CREATE TABLE IF NOT EXISTS budgets (principal TEXT PRIMARY KEY, cap REAL NOT NULL, incurred REAL NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, publisher TEXT NOT NULL, lc INTEGER NOT NULL, state_root TEXT NOT NULL, heads TEXT NOT NULL, reducer_version TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_rels_source ON rels(source);
CREATE INDEX IF NOT EXISTS idx_rels_target ON rels(target);
`;

export function dbPathFor(issuesDir: string): string {
	return resolve(issuesDir, "..", "store.db");
}

// Shared schema bootstrap: full DDL plus additive migrations for
// pre-existing store.db files (CREATE TABLE IF NOT EXISTS never adds a
// column to a live table — events.sig arrived in Phase 4).
export function ensureSchema(db: DatabaseSync): void {
	db.exec(SCHEMA);
	const cols = new Set((db.prepare("PRAGMA table_info(events)").all() as any[]).map((c) => c.name as string));
	if (!cols.has("sig")) db.exec("ALTER TABLE events ADD COLUMN sig TEXT");
	const leaseCols = new Set((db.prepare("PRAGMA table_info(leases)").all() as any[]).map((c) => c.name as string));
	if (!leaseCols.has("expires_lc")) db.exec("ALTER TABLE leases ADD COLUMN expires_lc INTEGER");
}

// Content verification (bi#41): every projection table + the anchor meta
// that feeds reads is hashed at every write (sealProjection, called at the
// end of refreshProjectionTables) and re-hashed on every open. A mismatch
// THROWS — a silently flipped bit must never become a confident answer.
// Missing seal = pre-fingerprint legacy store: warn once, proceed, and let
// `bais ingest` (which reseals) be the upgrade path. Threat model is rot,
// not an active adversary (TOCTOU between verify and read is accepted).
const FP_TABLES = [
	"events",
	"tasks",
	"rels",
	"conflicts",
	"excluded",
	"leases",
	"verifies",
	"budgets",
	"checkpoints",
	"submissions",
	"caps",
];
// Anchor meta feeds merged reads, so it is fingerprinted too. Volatile
// operational keys (bootstrap, as_of wall clock is sealed at write) stay out.
const FP_META = ["anchor_reduction", "prune_anchor", "author_cursors"];

export function fingerprintProjection(db: DatabaseSync): string {
	const h = createHash("sha256");
	for (const t of FP_TABLES) {
		// SELECT * column order is schema order — deterministic across runs.
		for (const r of db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as any[]) {
			h.update(JSON.stringify(r));
		}
		h.update(`|${t}|`);
	}
	for (const k of FP_META) {
		h.update(`${k}=${getMeta(db, k) ?? ""}`);
	}
	return h.digest("hex");
}

export function sealProjection(db: DatabaseSync): void {
	setMeta(db, "projection_fp", fingerprintProjection(db));
}

// Deep verification (bi#41, for `bais verify --deep`): full BAML
// re-reduction over the stored log plus per-event id re-verification,
// compared field-by-field against the materialized tables. Slow
// (whole-log reduce) — the fingerprint above is the per-open fast path.
// Entry point for `bais verify`: fingerprint check on a throwaway connection.
export function verifyStore(issuesDir: string): { ok: boolean; detail: string } {
	const db = openDb(issuesDir, { skipVerify: true });
	try {
		return verifyProjection(db);
	} finally {
		db.close();
	}
}

export async function deepVerify(issuesDir: string): Promise<{ ok: boolean; problems: string[] }> {
	const problems: string[] = [];
	const db = openDb(issuesDir, { skipVerify: true });
	try {
		const rows = db.prepare("SELECT * FROM events ORDER BY lc, id").all() as any[];
		const wire = rows.map((r) => ({
			id: r.id, author: r.author, seq: r.seq, prev: r.prev, project: r.project,
			entity: r.entity, refs: JSON.parse(r.refs), lc: r.lc, ts: r.ts, type: r.type,
			body: JSON.parse(r.body), sig: r.sig ?? null,
			admitted: r.admitted === 1, drop_reason: r.drop_reason ?? null,
		}));
		for (const e of wire) {
			if (!verifyEventId(e)) problems.push(`id-mismatch: stored id does not re-hash (entity ${e.entity}, type ${e.type}, id ${String(e.id).slice(0, 16)}…)`);
		}
		const reduction = (await event.reduce(wire)) as any;
		const issues = new Map((reduction.issues as any[]).map((t: any) => [t.entity, t]));
		for (const r of db.prepare("SELECT entity, title, status FROM tasks").all() as any[]) {
			const t = issues.get(r.entity);
			if (!t) problems.push(`phantom-task: tasks row with no reduced issue (${r.entity})`);
			else if (t.status !== r.status || t.title !== r.title) {
				problems.push(`drift: ${r.entity} table=(${r.status}) reduced=(${t.status})`);
			}
		}
		for (const t of issues.values() as any) {
			const row = db.prepare("SELECT entity FROM tasks WHERE entity = ?").get((t as any).entity);
			if (!row) problems.push(`missing-task: reduced issue with no tasks row (${(t as any).entity})`);
		}
		return { ok: problems.length === 0, problems };
	} finally {
		db.close();
	}
}

export function verifyProjection(db: DatabaseSync): { ok: boolean; detail: string } {
	const sealed = getMeta(db, "projection_fp");
	if (!sealed) return { ok: true, detail: "unsealed-legacy (re-ingest to seal)" };
	const now = fingerprintProjection(db);
	if (now === sealed) return { ok: true, detail: "match" };
	return { ok: false, detail: "fingerprint-mismatch: store.db content changed outside a sealed write" };
}

const warnedUnsealed = new Set<string>();

function openDb(issuesDir: string, opts?: { skipVerify?: boolean }): DatabaseSync {
	const db = new DatabaseSync(dbPathFor(issuesDir));
	ensureSchema(db);
	if (!opts?.skipVerify) {
		const v = verifyProjection(db);
		if (!v.ok) {
			db.close();
			throw new Error(`store-integrity-mismatch (${v.detail}) — refusing to serve ${dbPathFor(issuesDir)}; restore store.db or re-ingest`);
		}
		if (v.detail.startsWith("unsealed-legacy")) {
			const p = dbPathFor(issuesDir);
			if (!warnedUnsealed.has(p)) {
				warnedUnsealed.add(p);
				console.error(`warn: ${p} predates content fingerprints — reads proceed unverified; run \`bais ingest\` to seal`);
			}
		}
	}
	return db;
}

function getMeta(db: DatabaseSync, k: string): string | null {
	const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
	return row?.v ?? null;
}

function setMeta(db: DatabaseSync, k: string, v: string): void {
	db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

// Seed one task.create + one rel.add per issue file, reduce through BAML, and
// persist events + materialization + failures.
//
// Merge-on-ingest (bi#34): the rebuild preserves hub/sync-appended history.
// Prior event rows outside the seed namespace (id not starting with "seed:")
// are carried over VERBATIM (every column, including sig/admitted/drop_reason)
// and reduced OVER the fresh TOML seed — the log, not the TOML alone, is the
// durable truth. Stale seed rows (TOML shrank) are dropped: the fresh seed
// regenerates them, and a fresh-seed id always wins a collision. No BAML
// policy change: the merge is host-side log concatenation, reduction is
// untouched (ingest-from-TOML == replay-from-log still holds, extended to
// seed + replayed hub history).
export async function ingestIssues(issuesDir: string): Promise<{ events: number; failures: number }> {
	const project = projectName(issuesDir);
	const files = existsSync(issuesDir) ? readdirSync(issuesDir).filter((f) => f.endsWith(".toml")).sort() : [];
	const wireEvents: any[] = [];
	const failures: { file: string; error: string }[] = [];
	let lc = 0;
	// Chain-legal seed (envelope: seq 0 is genesis, prev links the author's
	// prior id): one author, contiguous seq from 0, prev chained. lc stays
	// the per-file tiebreak clock; ids are content hashes (bi#38), so the
	// clock is carried in `lc`, not embedded in the id. seq is the author chain.
	const seedAuthor = "did:key:bais-seed";
	let seedSeq = 0;
	let seedPrev: string | null = null;
	const seedEvent = (entity: string, type: string, body: any): void => {
		// Causal order rides on lc, not on id order: the reducer applies in
		// total (lc, id) order, and content-hash ids (bi#38) sort randomly —
		// the old dev ids (create < edge < status lexically) carried order
		// implicitly. One lc tick per emitted event keeps create < edge <
		// status causally ordered within and across files.
		lc += 1;
		const fields = {
			author: seedAuthor,
			seq: seedSeq,
			prev: seedPrev,
			project,
			entity,
			refs: [],
			lc,
			ts: new Date().toISOString(),
			type,
			body,
		};
		const id = eventId(fields);
		wireEvents.push({ ...fields, id, admitted: true, drop_reason: null });
		seedPrev = id;
		seedSeq += 1;
	};
	for (const f of files) {
		try {
			// Migration bridge: seed entities ARE the directory ids (bi#09).
			// Real event-sourced entities (task:01J...) will share these
			// tables in Phase 4; until then every query stays in user space
			// and no alias map is needed anywhere downstream.
			const parsed = (await parseBaisFile(readFileSync(join(issuesDir, f), "utf8"))) as any;
			seedEvent(parsed.issue.id, "TaskCreate", {
				title: parsed.issue.title,
				kind: parsed.issue.kind,
				area: parsed.issue.area,
				severity: parsed.issue.severity,
				source: parsed.issue.source,
				body: parsed.issue.body,
			});
			for (const [j, e] of parsed.edges.entries()) {
				seedEvent(parsed.issue.id, "RelAdd", {
					rel_id: `rel:seed:${parsed.issue.id}:${j}`,
					source: e.from,
					type: e.kind,
					target: e.to,
					declaredBy: parsed.issue.id,
				});
			}
			// Seed status: files already Done/Doing carry it via a transition.
			if (parsed.issue.status && parsed.issue.status !== "Open") {
				seedEvent(parsed.issue.id, "TaskTransition", { to: parsed.issue.status });
			}
		} catch (e: any) {
			failures.push({ file: f, error: String(e?.message ?? e).split("\n")[0] });
		}
	}
	// Merge-on-ingest: carry over prior hub/sync-appended rows verbatim.
	// A row survives iff it is NOT regenerable from the TOML seed (id
	// outside the fresh seed set AND outside the seed namespace, so stale
	// seed rows from a shrunk TOML are dropped, not preserved). Raw
	// refs/body TEXT is kept for byte-identical reinsert; parsed copies
	// feed the reducer. A damaged store.db falls back to seed-only (same
	// as the old rebuild) instead of failing the ingest.
	const freshSeedIds = new Set(wireEvents.map((e) => e.id));
	const hubKept: { wire: any; rawRefs: string; rawBody: string }[] = [];
	let anchorLc = 0;
	const dbPath = dbPathFor(issuesDir);
	if (existsSync(dbPath)) {
		try {
			const prev = new DatabaseSync(dbPath);
			try {
				ensureSchema(prev);
				const rows = prev.prepare("SELECT * FROM events").all() as any[];
				for (const r of rows) {
					// Seeds are regenerable, never carried: with content-hash
					// ids (bi#38) the wall-clock ts in the hashed payload gives
					// every re-ingest fresh seed ids, so id-based dedup can
					// never match them — carrying seed-authored rows doubles
					// the log on every ingest. Only non-seed authors (hub,
					// sync) carry over; the guards below stay for old stores.
					if (r.author === seedAuthor) continue;
					if (freshSeedIds.has(r.id) || String(r.id).startsWith("seed:")) continue;
					// Legacy dev-id rows (pre-bi#38) cannot self-verify and
					// would trip the build-time sweep below: drop with a
					// LOUD record (completeness goes partial, failures table
					// names the row) instead of failing the whole ingest or
					// — worse — sealing the unverifiable.
					if (!/^b[abcdefghijklmnopqrstuvwxyz234567]+$/.test(String(r.id))) {
						failures.push({ file: `store.db:${r.id}`, error: "legacy dev-id row dropped on merge (cannot self-verify; re-issue via hub)" });
						continue;
					}
					hubKept.push({
						wire: {
							id: r.id,
							author: r.author,
							seq: r.seq,
							prev: r.prev,
							project: r.project,
							entity: r.entity,
							refs: JSON.parse(r.refs),
							lc: r.lc,
							ts: r.ts,
							type: r.type,
							body: JSON.parse(r.body),
							sig: r.sig ?? null,
							admitted: r.admitted === 1,
							drop_reason: r.drop_reason ?? null,
						},
						rawRefs: r.refs,
						rawBody: r.body,
					});
				}
				hubKept.sort((a, b) => a.wire.lc - b.wire.lc || (a.wire.id < b.wire.id ? -1 : 1));
				try {
					const rawAnchor = (prev.prepare("SELECT v FROM meta WHERE k = 'prune_anchor'").get() as any)?.v;
					if (rawAnchor) anchorLc = (JSON.parse(rawAnchor) as any).lc ?? 0;
				} catch {
					anchorLc = 0;
				}
			} finally {
				prev.close();
			}
		} catch {
			hubKept.length = 0;
			anchorLc = 0;
		}
	}
	// Prune-aware: fresh seed rows at/below the truncation floor are
	// covered by the preserved anchor reduction (refreshProjectionTables
	// merges it) — re-adding them would resurrect pruned rows and
	// double-count anchored state. Hub survivors always sit above the
	// floor (prune deletes lc <= floor), so they pass through untouched.
	// Assumes a stable TOML across prune+ingest (lc numbering restarts at
	// 1 per ingest); prune + edit-TOML + ingest stays operator territory.
	const seedKept = anchorLc > 0 ? wireEvents.filter((e) => e.lc > anchorLc) : wireEvents;
	const fullLog = [...seedKept, ...hubKept.map((h) => h.wire)];
	// Self-verifying ids (bi#38) are checked at build time: every event
	// must re-hash to its id, or the log is corrupt — fail closed here
	// rather than sealing a lie.
	for (const e of fullLog) {
		if (!verifyEventId(e)) {
			throw new Error(`ingest refusing: event id does not verify (entity ${e.entity}, type ${e.type}) — log corrupt, not sealing`);
		}
	}
	const reduction = (await event.reduce(fullLog)) as any;
	if (reduction.version !== "bais.reduce@1") throw new Error(`reducer version skew: ${reduction.version}`);
	// skipVerify: ingest wipes and rebuilds every fingerprinted table, then
	// reseals via refreshProjectionTables below — there is nothing to check yet.
	const db = openDb(issuesDir, { skipVerify: true });
	try {
		db.exec("DELETE FROM events; DELETE FROM tasks; DELETE FROM rels; DELETE FROM conflicts; DELETE FROM excluded; DELETE FROM failures; DELETE FROM leases; DELETE FROM verifies; DELETE FROM budgets; DELETE FROM checkpoints; DELETE FROM submissions; DELETE FROM caps;");
		// Prune floors, the anchor reduction, and bootstrap locks are
		// PRESERVED (they still describe the surviving rows): only the
		// regenerable tables are rebuilt. refreshProjectionTables re-derives
		// every materialized table from the merged log — including the
		// lease/verify/budget/submission/cap tables the old seed-only
		// rebuild dropped — and merges the anchor reduction when present.
		const insEv = db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, sig, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const putRow = (e: any, refsText: string, bodyText: string): void => {
			insEv.run(e.id, e.author, e.seq, e.prev, e.project, e.entity, refsText, e.lc, e.ts, e.type, bodyText, e.sig ?? null, e.admitted ? 1 : 0, e.drop_reason ?? null);
		};
		for (const e of seedKept) putRow(e, JSON.stringify(e.refs), JSON.stringify(e.body));
		for (const h of hubKept) putRow(h.wire, h.rawRefs, h.rawBody);
		const heads = fullLog.map((e) => e.id);
		const maxLc = fullLog.reduce((m, e) => Math.max(m, e.lc), 0);
		refreshProjectionTables(db, reduction, heads, maxLc);
		const insFail = db.prepare("INSERT INTO failures(file, error) VALUES (?, ?)");
		for (const fl of failures) insFail.run(fl.file, fl.error);
		setMeta(db, "completeness", failures.length ? "partial" : "complete");
		setMeta(db, "reducer_version", reduction.version);
		setMeta(db, "project", project);
	} finally {
		db.close();
	}
	return { events: fullLog.length, failures: failures.length };
}

export function hasStore(issuesDir: string): boolean {
	// A store counts as present only if it is structurally sound AND its
	// content fingerprint verifies (bi#41) — anything else reads as absent
	// so every caller falls back to the directory scan (fail-closed).
	const p = dbPathFor(issuesDir);
	try {
		if (!existsSync(p)) return false;
		if (statSync(p).size === 0) return false;
		const db = new DatabaseSync(p);
		try {
			const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
			if (!(rows.length === 1 && rows[0].quick_check === "ok")) return false;
			return verifyProjection(db).ok;
		} finally {
			db.close();
		}
	} catch (e) {
		console.error(`warn: store.db failed verification (${e instanceof Error ? e.message : e}) — falling back to directory scan`);
		return false;
	}
}

export function readAsOf(issuesDir: string): { as_of: AsOf; completeness: Completeness } {
	const db = openDb(issuesDir);
	try {
		const as_of = JSON.parse(getMeta(db, "as_of") ?? '{"heads":[],"lc":0,"wall_ts":""}') as AsOf;
		const completeness = (getMeta(db, "completeness") ?? "partial") as Completeness;
		return { as_of, completeness };
	} finally {
		db.close();
	}
}

function rowToTask(r: any): StoredTask {
	return {
		entity: r.entity,
		title: r.title,
		status: r.status,
		kind: r.kind,
		area: r.area,
		severity: r.severity,
		source: r.source,
		body: r.body,
		labels: JSON.parse(r.labels),
		comments: JSON.parse(r.comments),
	};
}

// Edges with their declaring file (mirrors BaisFile.edges = edges declared in
// that file). declaredBy rides in the RelAdd seed bodies.
export function storeEdges(issuesDir: string): StoredEdge[] {
	const db = openDb(issuesDir);
	try {
		const declaredByOf = new Map<string, string>();
		for (const r of db.prepare("SELECT body FROM events WHERE type = 'RelAdd'").all() as any[]) {
			try {
				const b = JSON.parse(r.body);
				if (b.rel_id && b.declaredBy) declaredByOf.set(b.rel_id, b.declaredBy);
			} catch {}
		}
		return (db.prepare("SELECT * FROM rels ORDER BY id").all() as any[]).map((r) => ({
			id: r.id,
			source: r.source,
			type: r.type,
			target: r.target,
			declaredBy: declaredByOf.get(r.id) ?? r.source,
		}));
	} finally {
		db.close();
	}
}

// The one agent-dispatch query: Open, no live lease, no unclosed Blocks
// predecessor — including dangling blockers (conservative, same rule as
// is_blocked). Leases table is empty until Phase 3; the clause stays so the
// query does not silently change shape when claims land.
export function storeReady(issuesDir: string): { ready: StoredTask[]; as_of: AsOf; completeness: Completeness } {
	const db = openDb(issuesDir);
	try {
		const rows = db
			.prepare(
				`SELECT t.* FROM tasks t
         WHERE t.status = 'Open'
           AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.task = t.entity)
           AND NOT EXISTS (
             SELECT 1 FROM rels d JOIN tasks p ON p.entity = d.source
             WHERE d.target = t.entity AND d.type = 'Blocks'
               AND p.status != 'Done' AND p.status != 'Dropped'
           )
           AND NOT EXISTS (
             SELECT 1 FROM rels d
             WHERE d.target = t.entity AND d.type = 'Blocks'
               AND NOT EXISTS (SELECT 1 FROM tasks p2 WHERE p2.entity = d.source)
           )`,
			)
			.all() as any[];
		const { as_of, completeness } = readAsOfFrom(db);
		return { ready: rows.map(rowToTask), as_of, completeness };
	} finally {
		db.close();
	}
}

function readAsOfFrom(db: DatabaseSync): { as_of: AsOf; completeness: Completeness } {
	const as_of = JSON.parse(getMeta(db, "as_of") ?? '{"heads":[],"lc":0,"wall_ts":""}') as AsOf;
	return { as_of, completeness: (getMeta(db, "completeness") ?? "partial") as Completeness };
}

// Leases materialize what BAML current_lease derives (ns_event/lease.baml):
// one row per live claim. Mirrors storeReady's exclusion exactly — any row
// for the task keeps it out of ready, so any row earns a Leased reason. At
// most one row per task survives the projection (only active leases are
// stored); the latest-expiring row wins if history ever lands here.
export function storeLeases(issuesDir: string): HostLease[] {
	const db = openDb(issuesDir);
	try {
		return (
			db
				.prepare(
					`SELECT task AS entity, holder, expires_lc FROM leases ORDER BY expires_lc DESC`,
				)
				.all() as { entity: string; holder: string; expires_lc: number | null }[]
		).filter((r, i, rows) => rows.findIndex((o) => o.entity === r.entity) === i);
	} finally {
		db.close();
	}
}

// Store-backed `ready --why-not`: the same whyNotIn mirror over the
// projection (tasks + rels + leases), so the store and scan paths agree the
// way storeReady/readyIssues do. Read-only; existing queries are untouched.
export function storeWhyNot(issuesDir: string): { reasons: WhyNot[]; as_of: AsOf; completeness: Completeness } {
	const { tasks, as_of, completeness } = storeList(issuesDir);
	const edges = storeEdges(issuesDir);
	const byDeclarer = new Map<string, BaisEdge[]>();
	for (const e of edges) {
		const list = byDeclarer.get(e.declaredBy) ?? [];
		list.push({ from: e.source, to: e.target, kind: e.type });
		byDeclarer.set(e.declaredBy, list);
	}
	const files: BaisFile[] = tasks.map((t) => ({
		issue: {
			id: t.entity,
			title: t.title,
			status: t.status,
			kind: t.kind,
			area: t.area,
			severity: t.severity,
			source: t.source,
			body: t.body,
		},
		edges: byDeclarer.get(t.entity) ?? [],
	}));
	const db = openDb(issuesDir);
	let project = "";
	try {
		project = getMeta(db, "project") ?? "";
	} finally {
		db.close();
	}
	return { reasons: whyNotIn(files, project, storeLeases(issuesDir)), as_of, completeness };
}

// Recursive CTE over rels (both directions — the traversal callers expect).
export function storeGraph(issuesDir: string, from: string): { nodes: StoredTask[]; as_of: AsOf; completeness: Completeness } {
	const db = openDb(issuesDir);
	try {
		const rows = db
			.prepare(
				`WITH RECURSIVE reach(id) AS (
           SELECT ? UNION
           SELECT r.target FROM rels r JOIN reach ON r.source = reach.id
           UNION
           SELECT r.source FROM rels r JOIN reach ON r.target = reach.id
         )
         SELECT t.* FROM tasks t WHERE t.entity IN (SELECT id FROM reach)`,
			)
			.all(from) as any[];
		const { as_of, completeness } = readAsOfFrom(db);
		return { nodes: rows.map(rowToTask), as_of, completeness };
	} finally {
		db.close();
	}
}

export function storeList(issuesDir: string): { tasks: StoredTask[]; as_of: AsOf; completeness: Completeness } {
	const db = openDb(issuesDir);
	try {
		const rows = db.prepare("SELECT * FROM tasks ORDER BY entity").all() as any[];
		const { as_of, completeness } = readAsOfFrom(db);
		return { tasks: rows.map(rowToTask), as_of, completeness };
	} finally {
		db.close();
	}
}

export function storeCaps(issuesDir: string): StoredCap[] {
	const db = openDb(issuesDir);
	try {
		return (db.prepare("SELECT * FROM caps ORDER BY grant_id").all() as any[]).map((r) => ({
			grant_id: r.grant_id,
			issuer: r.issuer,
			audience: r.audience,
			can: JSON.parse(r.can),
			scope: r.scope,
			expiry_lc: r.expiry_lc,
			budget_cap_usd: r.budget_cap_usd ?? null,
			budget_cap_tokens: r.budget_cap_tokens ?? null,
			revoked: r.revoked === 1,
			revoked_by: r.revoked_by ?? null,
		}));
	} finally {
		db.close();
	}
}

// Human-oversight exception feeds (Phase 5, step 16): queryable, not
// scrollable. All four read the projection — no log scan.
export type Oversight = {
	conflicts: { entity: string; field: string; options: string[]; winner: string | null; event_ids: string[]; at_lc: number }[];
	budget_overruns: { principal: string; cap: number; incurred: number }[];
	unverified_submits: StoredSubmit[];
	stalled_leases: { id: string; task: string; holder: string; epoch: number; expires_lc: number | null }[];
	caps_over_budget: { grant_id: string; audience: string; budget_cap_usd: number; incurred: number }[];
	as_of: AsOf;
	completeness: Completeness;
};
export function storeOversight(issuesDir: string): Oversight {
	const db = openDb(issuesDir);
	try {
		const { as_of, completeness } = readAsOfFrom(db);
		const conflicts = (db.prepare("SELECT * FROM conflicts ORDER BY at_lc DESC").all() as any[]).map((r) => ({
			entity: r.entity,
			field: r.field,
			options: JSON.parse(r.options),
			winner: r.winner,
			event_ids: JSON.parse(r.event_ids),
			at_lc: r.at_lc,
		}));
		const budget_overruns = db.prepare("SELECT principal, cap, incurred FROM budgets WHERE incurred > cap ORDER BY principal").all() as Oversight["budget_overruns"];
		const unverified_submits = db.prepare(
			`SELECT s.submit_id, s.task, s.producer, s.status FROM submissions s WHERE s.status = 'submitted'
			 AND NOT EXISTS (SELECT 1 FROM verifies v WHERE v.submit_ref = s.submit_id AND v.verdict = 'accept') ORDER BY s.submit_id`,
		).all() as StoredSubmit[];
		const stalled_leases = db.prepare(
			"SELECT id, task, holder, epoch, expires_lc FROM leases WHERE expires_lc IS NOT NULL AND expires_lc <= ? ORDER BY id",
		).all(as_of.lc) as Oversight["stalled_leases"];
		const caps_over_budget = db.prepare(
			`SELECT c.grant_id, c.audience, c.budget_cap_usd, b.incurred FROM caps c JOIN budgets b ON b.principal = c.audience
			 WHERE c.revoked = 0 AND c.budget_cap_usd IS NOT NULL AND b.incurred > c.budget_cap_usd ORDER BY c.grant_id`,
		).all() as Oversight["caps_over_budget"];
		return { conflicts, budget_overruns, unverified_submits, stalled_leases, caps_over_budget, as_of, completeness };
	} finally {
		db.close();
	}
}

// Deterministic sampling (Phase 5, step 16): FNV-1a over seed+entity,
// so the "random sample of completed work" is reproducible and auditable.
// Completed = Done (Accepted is a submission state, not a task status).
export function storeSample(issuesDir: string, n: number, seed = 0): { sample: StoredTask[]; total: number } {
	const db = openDb(issuesDir);
	try {
		const rows = db.prepare("SELECT * FROM tasks WHERE status = 'Done'").all() as any[];
		const tasks = rows.map(rowToTask);
		const hash = (s: string): number => {
			let h = (2166136261 ^ seed) >>> 0;
			for (let i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			return h >>> 0;
		};
		tasks.sort((a, b) => hash(a.entity) - hash(b.entity) || (a.entity < b.entity ? -1 : 1));
		return { sample: tasks.slice(0, Math.max(0, n)), total: tasks.length };
	} finally {
		db.close();
	}
}

export type SnapshotCheckpoint = {
	id: string;
	publisher: string;
	lc: number;
	state_root: string;
	heads: string[];
	reducer_version: string;
};

// Prune anchor (Phase 4, step 13): recorded when the hub deletes covered
// event rows. The log below `lc` is gone by operator action — future peers
// bootstrap from the signed checkpoint (signature trust) instead of a
// recomputed backfill. `verified_at` is the last full recompute proof,
// taken at prune time before deletion.
export type PruneAnchor = {
	checkpoint: string;
	publisher: string;
	lc: number;
	state_root: string;
	pruned_at: string;
	verified_at: string;
};

// Fast-bootstrap snapshot (Phase 4, step 13): the latest checkpoint plus
// every materialized table. A peer imports this for instant reads, then
// backfills the covered log and cryptographically verifies state_root
// before writing (trust-on-first-use reads, verify-before-write).
// When `anchor` is present the peer pruned below the checkpoint: covered
// heads are unrecoverable and bootstrap falls back to signature trust.
export type StoredSubmit = { submit_id: string; task: string; producer: string; status: string };
export type StoredCap = {
	grant_id: string; issuer: string; audience: string; can: string[]; scope: string; expiry_lc: number;
	budget_cap_usd: number | null; budget_cap_tokens: number | null; revoked: boolean; revoked_by: string | null;
};

export type Snapshot = {
	checkpoint: SnapshotCheckpoint | null;
	anchor: PruneAnchor | null;
	// Live anchor state, attached by the hub (not the file export): the
	// stored anchor reduction (deleted rows' contribution only) +
	// per-author chain cursors. Lets a peer bootstrapping from a pruned
	// hub anchor its tables, floors, and future refreshes exactly —
	// tables alone cannot re-derive lease expiry or silent-author floors.
	anchor_state?: any;
	cursors?: { author: string; seq: number; id: string }[];
	tables: {
		tasks: StoredTask[];
		rels: StoredRel[];
		leases: { id: string; task: string; holder: string; epoch: number; expires_at: string; read_set: string[]; expires_lc: number | null }[];
		verifies: { id: string; task: string; submit_ref: string; verdict: string; verifier: string }[];
		submissions: StoredSubmit[];
		caps: StoredCap[];
		budgets: { principal: string; cap: number; incurred: number }[];
		conflicts: { entity: string; field: string; options: string[]; winner: string | null; event_ids: string[]; at_lc: number }[];
		excluded: { event_id: string; reason: string }[];
		failures: { file: string; error: string }[];
	};
	as_of: AsOf;
	completeness: Completeness;
	exported_at: string;
};

export function exportSnapshot(issuesDir: string): Snapshot {
	const db = openDb(issuesDir);
	try {
		const cps = db.prepare("SELECT * FROM checkpoints ORDER BY lc DESC").all() as any[];
		const checkpoint: SnapshotCheckpoint | null = cps.length
			? {
					id: cps[0].id,
					publisher: cps[0].publisher,
					lc: cps[0].lc,
					state_root: cps[0].state_root,
					heads: JSON.parse(cps[0].heads),
					reducer_version: cps[0].reducer_version,
				}
			: null;
		const { as_of, completeness } = readAsOfFrom(db);
		let anchor: PruneAnchor | null = null;
		try {
			const raw = getMeta(db, "prune_anchor");
			anchor = raw ? (JSON.parse(raw) as PruneAnchor) : null;
		} catch {
			anchor = null;
		}
		return {
			checkpoint,
			anchor,
			tables: {
				tasks: (db.prepare("SELECT * FROM tasks ORDER BY entity").all() as any[]).map(rowToTask),
				rels: (db.prepare("SELECT * FROM rels ORDER BY id").all() as any[]).map((r) => ({
					id: r.id,
					source: r.source,
					type: r.type,
					target: r.target,
				})),
				leases: (db.prepare("SELECT * FROM leases ORDER BY id").all() as any[]).map((r) => ({
					id: r.id,
					task: r.task,
					holder: r.holder,
					epoch: r.epoch,
					expires_at: r.expires_at,
					read_set: JSON.parse(r.read_set),
					expires_lc: r.expires_lc ?? null,
				})),
				verifies: (db.prepare("SELECT * FROM verifies ORDER BY id").all() as any[]),
				submissions: (db.prepare("SELECT * FROM submissions ORDER BY submit_id").all() as any[]),
				caps: (db.prepare("SELECT * FROM caps ORDER BY grant_id").all() as any[]).map((r) => ({
					grant_id: r.grant_id,
					issuer: r.issuer,
					audience: r.audience,
					can: JSON.parse(r.can),
					scope: r.scope,
					expiry_lc: r.expiry_lc,
					budget_cap_usd: r.budget_cap_usd ?? null,
					budget_cap_tokens: r.budget_cap_tokens ?? null,
					revoked: r.revoked === 1,
					revoked_by: r.revoked_by ?? null,
				})),
				budgets: (db.prepare("SELECT * FROM budgets ORDER BY principal").all() as any[]),
				conflicts: (db.prepare("SELECT * FROM conflicts ORDER BY entity").all() as any[]).map((r) => ({
					entity: r.entity,
					field: r.field,
					options: JSON.parse(r.options),
					winner: r.winner,
					event_ids: JSON.parse(r.event_ids),
					at_lc: r.at_lc,
				})),
				excluded: (db.prepare("SELECT * FROM excluded ORDER BY event_id").all() as any[]),
				failures: (db.prepare("SELECT * FROM failures ORDER BY file").all() as any[]),
			},
			as_of,
			completeness,
			exported_at: new Date().toISOString(),
		};
	} finally {
		db.close();
	}
}

// Import a snapshot: tables land verbatim (instant reads), the checkpoint
// is recorded as an event row so the log knows its anchor, and bootstrap
// meta marks writes blocked until the covered log is backfilled and
// state_root reverified (see hub boot + `bais sync --from`).
export function importSnapshot(issuesDir: string, snap: Snapshot, peer: string): void {
	if (!snap.checkpoint) throw new Error("snapshot has no checkpoint — nothing to anchor to");
	const db = openDb(issuesDir);
	try {
		db.exec(
			"DELETE FROM tasks; DELETE FROM rels; DELETE FROM leases; DELETE FROM verifies; DELETE FROM budgets; DELETE FROM conflicts; DELETE FROM excluded; DELETE FROM failures; DELETE FROM checkpoints; DELETE FROM submissions; DELETE FROM caps;",
		);
		const insTask = db.prepare(
			"INSERT INTO tasks(entity, title, status, kind, area, severity, source, body, labels, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const t of snap.tables.tasks) {
			insTask.run(t.entity, t.title, t.status, t.kind, t.area, t.severity, t.source, t.body, JSON.stringify(t.labels), JSON.stringify(t.comments));
		}
		const insRel = db.prepare("INSERT INTO rels(id, source, type, target) VALUES (?, ?, ?, ?)");
		for (const r of snap.tables.rels) insRel.run(r.id, r.source, r.type, r.target);
		const insLease = db.prepare("INSERT INTO leases(id, task, holder, epoch, expires_at, read_set, expires_lc) VALUES (?, ?, ?, ?, ?, ?, ?)");
		for (const l of snap.tables.leases) insLease.run(l.id, l.task, l.holder, l.epoch, l.expires_at, JSON.stringify(l.read_set), l.expires_lc ?? null);
		const insVerify = db.prepare("INSERT INTO verifies(id, task, submit_ref, verdict, verifier) VALUES (?, ?, ?, ?, ?)");
		for (const v of snap.tables.verifies) insVerify.run(v.id, v.task, v.submit_ref, v.verdict, v.verifier);
		const insSubmit = db.prepare("INSERT INTO submissions(submit_id, task, producer, status) VALUES (?, ?, ?, ?)");
		for (const s of snap.tables.submissions ?? []) insSubmit.run(s.submit_id, s.task, s.producer, s.status);
		const insCap = db.prepare(
			"INSERT INTO caps(grant_id, issuer, audience, can, scope, expiry_lc, budget_cap_usd, budget_cap_tokens, revoked, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const c of snap.tables.caps ?? []) {
			insCap.run(c.grant_id, c.issuer, c.audience, JSON.stringify(c.can), c.scope, c.expiry_lc, c.budget_cap_usd ?? null, c.budget_cap_tokens ?? null, c.revoked ? 1 : 0, c.revoked_by ?? null);
		}
		const insBudget = db.prepare("INSERT INTO budgets(principal, cap, incurred) VALUES (?, ?, ?)");
		for (const b of snap.tables.budgets) insBudget.run(b.principal, b.cap, b.incurred);
		const insConf = db.prepare("INSERT INTO conflicts(entity, field, options, winner, event_ids, at_lc) VALUES (?, ?, ?, ?, ?, ?)");
		for (const c of snap.tables.conflicts) {
			insConf.run(c.entity, c.field, JSON.stringify(c.options), c.winner, JSON.stringify(c.event_ids), c.at_lc);
		}
		const insExcl = db.prepare("INSERT INTO excluded(event_id, reason) VALUES (?, ?)");
		for (const x of snap.tables.excluded) insExcl.run(x.event_id, x.reason);
		const insFail = db.prepare("INSERT INTO failures(file, error) VALUES (?, ?)");
		for (const f of snap.tables.failures) insFail.run(f.file, f.error);
		const cp = snap.checkpoint;
		db.prepare("INSERT INTO checkpoints(id, publisher, lc, state_root, heads, reducer_version) VALUES (?, ?, ?, ?, ?, ?)").run(
			cp.id,
			cp.publisher,
			cp.lc,
			cp.state_root,
			JSON.stringify(cp.heads),
			cp.reducer_version,
		);
		// No event row is faked for the checkpoint itself: the real
		// CheckpointPublish event (lc = covered lc + 1) arrives via the
		// post-backfill delta, keeping every author chain exactly as the
		// peer wrote it. Faking a seq-0 row would fork the publisher's
		// chain and break every later event from that author.
		setMeta(db, "as_of", JSON.stringify({ heads: cp.heads, lc: cp.lc, wall_ts: new Date().toISOString() }));
		setMeta(db, "completeness", snap.completeness);
		setMeta(db, "reducer_version", cp.reducer_version);
		setMeta(
			db,
			"bootstrap",
			JSON.stringify({ checkpoint_id: cp.id, backfill_before_lc: cp.lc, complete: false, peer, trust: "pending" }),
		);
	} finally {
		db.close();
	}
}

// Merge a pre-prune anchor reduction with a partial reduction over
// surviving rows (Phase 4, step 13). Sections merge by identity with the
// partial winning; budgets sum incurred spend across the truncation (caps:
// partial wins when present, else anchor); anchor leases past expiry are
// marked expired so reads never resurrect them. Everything else unknown
// passes through from the partial side.
export function mergeAnchorReduction(anchor: any, partial: any, maxLc: number): any {
	const byKey = (arr: any[], key: (x: any) => string): Map<string, any> => {
		const m = new Map<string, any>();
		for (const x of arr ?? []) m.set(key(x), x);
		return m;
	};
	const union = (a: any[], p: any[], key: (x: any) => string): any[] => {
		const m = byKey(a, key);
		for (const x of p ?? []) m.set(key(x), x);
		return [...m.values()];
	};
	const aIssues = byKey(anchor.issues, (x) => x.entity);
	for (const x of partial.issues ?? []) aIssues.set(x.entity, x);
	const aBudgets = byKey(anchor.budgets, (x) => x.principal);
	for (const p of partial.budgets ?? []) {
		const a = aBudgets.get(p.principal);
		aBudgets.set(p.principal, {
			...p,
			cap_usd: p.cap_usd ?? a?.cap_usd,
			cap_tokens: p.cap_tokens ?? a?.cap_tokens,
			incurred_usd: (a?.incurred_usd ?? 0) + (p.incurred_usd ?? 0),
			incurred_tokens: (a?.incurred_tokens ?? 0) + (p.incurred_tokens ?? 0),
		});
	}
	const leases = union(anchor.leases, partial.leases, (x) => x.lease_id).map((l) =>
		l.status === "active" && typeof l.expires_lc === "number" && l.expires_lc <= maxLc ? { ...l, status: "expired" } : l,
	);
	return {
		version: partial.version ?? anchor.version,
		issues: [...aIssues.values()],
		rels: union(anchor.rels, partial.rels, (x) => x.id),
		leases,
		submissions: union(anchor.submissions, partial.submissions, (x) => x.submit_id),
		verifications: union(anchor.verifications, partial.verifications, (x) => x.verify_id),
		budgets: [...aBudgets.values()],
		costs: union(anchor.costs, partial.costs, (x) => x.entry_id),
		conflicts: union(anchor.conflicts, partial.conflicts, (x) => JSON.stringify([x.entity, x.field])),
		excluded: union(anchor.excluded, partial.excluded, (x) => x.event_id),
		checkpoints: union(anchor.checkpoints, partial.checkpoints, (x) => x.id),
		caps: union(anchor.caps, partial.caps, (x) => x.grant_id),
	};
}

// Full projection refresh from a reduction (hub + sync path). Unlike
// ingestIssues this never touches the events table or failures: it
// re-derives every materialized table, so sync-appended task events land
// in tasks/rels/conflicts exactly as seeded ones do.
//
// Prune-aware: when a prune anchor is recorded, the reduction covers
// surviving rows only, so tables rebuild from the anchor merged with the
// partial — pruned state is preserved, new writes layer on top.
export function refreshProjectionTables(db: DatabaseSync, reduction: any, heads: string[], maxLc: number): void {
	let effective = reduction;
	try {
		const raw = (db.prepare("SELECT v FROM meta WHERE k = 'anchor_reduction'").get() as any)?.v;
		if (raw) effective = mergeAnchorReduction(JSON.parse(raw), reduction, maxLc);
	} catch {
		effective = reduction;
	}
	db.exec("DELETE FROM tasks; DELETE FROM rels; DELETE FROM conflicts; DELETE FROM excluded; DELETE FROM leases; DELETE FROM verifies; DELETE FROM budgets; DELETE FROM checkpoints; DELETE FROM submissions; DELETE FROM caps;");
	const insTask = db.prepare(
		"INSERT INTO tasks(entity, title, status, kind, area, severity, source, body, labels, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	for (const t of effective.issues as any[]) {
		insTask.run(t.entity, t.title, t.status, t.kind, t.area, t.severity, t.source, t.body, JSON.stringify(t.labels), JSON.stringify(t.comments));
	}
	const insRel = db.prepare("INSERT INTO rels(id, source, type, target) VALUES (?, ?, ?, ?)");
	for (const r of effective.rels as any[]) insRel.run(r.id, r.source, r.type, r.target);
	const insConf = db.prepare("INSERT INTO conflicts(entity, field, options, winner, event_ids, at_lc) VALUES (?, ?, ?, ?, ?, ?)");
	for (const c of effective.conflicts as any[]) {
		insConf.run(c.entity, c.field, JSON.stringify(c.options), c.winner, JSON.stringify(c.event_ids), c.at_lc);
	}
	const insExcl = db.prepare("INSERT INTO excluded(event_id, reason) VALUES (?, ?)");
	for (const x of effective.excluded as any[]) insExcl.run(x.event_id, x.reason);
	const insLease = db.prepare("INSERT INTO leases(id, task, holder, epoch, expires_at, read_set, expires_lc) VALUES (?, ?, ?, ?, ?, ?, ?)");
	for (const l of (effective.leases as any[]) ?? []) {
		if (l.status === "active") insLease.run(l.lease_id, l.entity, l.holder, l.epoch, "", JSON.stringify(l.read_set), l.expires_lc ?? null);
	}
	const submitTask = new Map<string, string>();
	const insSubmit = db.prepare("INSERT INTO submissions(submit_id, task, producer, status) VALUES (?, ?, ?, ?)");
	for (const s of (effective.submissions as any[]) ?? []) {
		submitTask.set(s.submit_id, s.entity);
		insSubmit.run(s.submit_id, s.entity, s.producer, s.status);
	}
	const insVerify = db.prepare("INSERT INTO verifies(id, task, submit_ref, verdict, verifier) VALUES (?, ?, ?, ?, ?)");
	for (const v of (effective.verifications as any[]) ?? []) {
		insVerify.run(v.verify_id, submitTask.get(v.submit_id) ?? "", v.submit_id, v.verdict, v.verifier);
	}
	const insBudget = db.prepare("INSERT INTO budgets(principal, cap, incurred) VALUES (?, ?, ?)");
	for (const b of (effective.budgets as any[]) ?? []) insBudget.run(b.principal, b.cap_usd, b.incurred_usd);
	const insCp = db.prepare("INSERT INTO checkpoints(id, publisher, lc, state_root, heads, reducer_version) VALUES (?, ?, ?, ?, ?, ?)");
	for (const c of (effective.checkpoints as any[]) ?? []) {
		insCp.run(c.id, c.publisher, c.lc, c.state_root, JSON.stringify(c.heads), c.reducer_version);
	}
	const insCap = db.prepare(
		"INSERT INTO caps(grant_id, issuer, audience, can, scope, expiry_lc, budget_cap_usd, budget_cap_tokens, revoked, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	for (const c of (effective.caps as any[]) ?? []) {
		insCap.run(c.grant_id, c.issuer, c.audience, JSON.stringify(c.can), c.scope, c.expiry_lc, c.budget_cap_usd ?? null, c.budget_cap_tokens ?? null, c.revoked ? 1 : 0, c.revoked_by ?? null);
	}
	setMeta(db, "as_of", JSON.stringify({ heads, lc: maxLc, wall_ts: new Date().toISOString() }));
	// Seal LAST: the fingerprint commits to every table + anchor meta above.
	sealProjection(db);
}

// Anchor inherited from a snapshot import (signature-trust bootstrap):
// the peer's anchor reduction (deleted rows' contribution, disjoint from
// the replicated delta) + chain cursors, so tables, floors, and future
// refreshes behave exactly as if the covered log were local.
export function recordImportedAnchor(
	issuesDir: string,
	anchor: PruneAnchor,
	reduction: any,
	cursors: { author: string; seq: number; id: string }[],
): void {
	const db = openDb(issuesDir);
	try {
		const upsert = db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
		upsert.run("prune_anchor", JSON.stringify({ ...anchor, source: "snapshot-import" }));
		upsert.run("anchor_reduction", JSON.stringify(reduction));
		// Anchor meta is fingerprinted: reseal after writing it.
		sealProjection(db);
		const floors: Record<string, { seq: number; id: string }> = {};
		for (const c of cursors) {
			const cur = floors[c.author];
			if (!cur || c.seq > cur.seq) floors[c.author] = { seq: c.seq, id: c.id };
		}
		upsert.run("author_cursors", JSON.stringify(floors));
	} finally {
		db.close();
	}
}

export type BootstrapTrust = "pending" | "recomputed" | "signature";
export function readBootstrap(issuesDir: string): { checkpoint_id: string; backfill_before_lc: number; complete: boolean; peer: string; trust: BootstrapTrust } | null {
	const db = openDb(issuesDir);
	try {
		const raw = getMeta(db, "bootstrap");
		return raw ? (JSON.parse(raw) as any) : null;
	} finally {
		db.close();
	}
}

export function markBootstrapComplete(issuesDir: string, trust: BootstrapTrust = "recomputed"): void {
	const db = openDb(issuesDir);
	try {
		const raw = getMeta(db, "bootstrap");
		if (!raw) return;
		const b = JSON.parse(raw) as any;
		b.complete = true;
		b.trust = trust;
		setMeta(db, "bootstrap", JSON.stringify(b));
	} finally {
		db.close();
	}
}

export function storeCheck(issuesDir: string): {
	ok: number;
	bad: { file: string; error: string }[];
	dangling: { declaredBy: string; from: string; to: string; kind: string; id: string; side: "from" | "to"; status: "Missing" | "External" }[];
	cycles: string[];
} {
	const db = openDb(issuesDir);
	let ok = 0;
	let bad: { file: string; error: string }[] = [];
	let project = "";
	let known = new Set<string>();
	try {
		ok = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n as number;
		bad = db.prepare("SELECT file, error FROM failures ORDER BY file").all() as { file: string; error: string }[];
		project = getMeta(db, "project") ?? "";
		known = new Set((db.prepare("SELECT entity FROM tasks").all() as any[]).map((r) => r.entity as string));
	} finally {
		db.close();
	}
	const rels = storeEdges(issuesDir);
	const scopeOf = (id: string): string => {
		const i = id.indexOf("#");
		return i === -1 ? "" : id.slice(0, i);
	};
	// Direct port of danglingRefsIn (graph.ts): per-file parsing cannot see
	// these, the loaded set can. Unscoped ids are Missing, never External.
	const dangling: { declaredBy: string; from: string; to: string; kind: string; id: string; side: "from" | "to"; status: "Missing" | "External" }[] = [];
	for (const r of rels) {
		for (const side of ["source", "target"] as const) {
			const id = r[side];
			if (known.has(id)) continue;
			const scope = scopeOf(id);
			dangling.push({
				declaredBy: r.declaredBy,
				from: r.source,
				to: r.target,
				kind: r.type,
				id,
				side: side === "source" ? "from" : "to",
				status: scope !== "" && scope !== project ? "External" : "Missing",
			});
		}
	}
	// Cycles via Kahn leftovers over Blocks/DependsOn ordering (cyclicIds).
	const precedes = (kind: string, from: string, to: string, before: string, after: string): boolean => {
		if (kind === "Blocks") return from === before && to === after;
		if (kind === "DependsOn") return to === before && from === after;
		return false;
	};
	let remaining = [...known];
	for (;;) {
		const next = remaining.filter((id) => rels.some((r) => remaining.some((o) => precedes(r.type, r.source, r.target, o, id))));
		if (next.length === remaining.length) break;
		remaining = next;
	}
	return { ok, bad, dangling, cycles: remaining };
}
