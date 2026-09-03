// bais/src/store.ts — SQLite projection over the event log (fusion Phase 2).
//
// BAML owns event -> datom reduction (ns_event/reduce.baml, pure); the host
// owns storage. This file seeds a log from .bais/issues/*.toml (one
// task.create + rel.add per file — no migration lock, the TOML stays
// readable), reduces via the BAML SDK, and serves ready/graph/list/check from
// indexed tables. Queries carry as_of + completeness so "empty" is
// distinguishable from "not synced".
//
// node:sqlite (built-in, no deps). DB lives at .bais/store.db; every read
// command falls back to the readdir scan when it is absent.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { event } from "../baml_sdk/index.js";
import { parseBaisFile } from "./toml.js";
import { projectName } from "./graph.js";

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
  type TEXT NOT NULL, body TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, task TEXT NOT NULL, holder TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL, read_set TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS verifies (id TEXT PRIMARY KEY, task TEXT NOT NULL, submit_ref TEXT NOT NULL, verdict TEXT NOT NULL, verifier TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budgets (principal TEXT PRIMARY KEY, cap REAL NOT NULL, incurred REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_rels_source ON rels(source);
CREATE INDEX IF NOT EXISTS idx_rels_target ON rels(target);
`;

export function dbPathFor(issuesDir: string): string {
	return resolve(issuesDir, "..", "store.db");
}

function openDb(issuesDir: string): DatabaseSync {
	const db = new DatabaseSync(dbPathFor(issuesDir));
	db.exec(SCHEMA);
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
// persist events + materialization + failures. Rebuilds from scratch: dropping
// store.db and re-ingesting is always safe (log seeding is append-only).
export async function ingestIssues(issuesDir: string): Promise<{ events: number; failures: number }> {
	const project = projectName(issuesDir);
	const files = existsSync(issuesDir) ? readdirSync(issuesDir).filter((f) => f.endsWith(".toml")).sort() : [];
	const wireEvents: any[] = [];
	const failures: { file: string; error: string }[] = [];
	let lc = 0;
	for (const f of files) {
		try {
			// Migration bridge: seed entities ARE the directory ids (bi#09).
			// Real event-sourced entities (task:01J...) will share these
			// tables in Phase 4; until then every query stays in user space
			// and no alias map is needed anywhere downstream.
			const parsed = (await parseBaisFile(readFileSync(join(issuesDir, f), "utf8"))) as any;
			lc += 1;
			wireEvents.push({
				id: `seed:${project}:${lc}:create`,
				author: "did:key:bais-seed",
				seq: lc,
				prev: null,
				project,
				entity: parsed.issue.id,
				refs: [],
				lc,
				ts: new Date().toISOString(),
				type: "TaskCreate",
				body: {
					title: parsed.issue.title,
					kind: parsed.issue.kind,
					area: parsed.issue.area,
					severity: parsed.issue.severity,
					source: parsed.issue.source,
					body: parsed.issue.body,
				},
				admitted: true,
				drop_reason: null,
			});
			for (const [j, e] of parsed.edges.entries()) {
				wireEvents.push({
					id: `seed:${project}:${lc}:edge:${j}`,
					author: "did:key:bais-seed",
					seq: lc,
					prev: null,
					project,
					entity: parsed.issue.id,
					refs: [],
					lc,
					ts: new Date().toISOString(),
					type: "RelAdd",
					body: {
						rel_id: `rel:seed:${parsed.issue.id}:${j}`,
						source: e.from,
						type: e.kind,
						target: e.to,
						declaredBy: parsed.issue.id,
					},
					admitted: true,
					drop_reason: null,
				});
			}
			// Seed status: files already Done/Doing carry it via a transition.
			if (parsed.issue.status && parsed.issue.status !== "Open") {
				wireEvents.push({
					id: `seed:${project}:${lc}:status`,
					author: "did:key:bais-seed",
					seq: lc,
					prev: null,
					project,
					entity: parsed.issue.id,
					refs: [],
					lc,
					ts: new Date().toISOString(),
					type: "TaskTransition",
					body: { to: parsed.issue.status },
					admitted: true,
					drop_reason: null,
				});
			}
		} catch (e: any) {
			failures.push({ file: f, error: String(e?.message ?? e).split("\n")[0] });
		}
	}
	const reduction = (await event.reduce(wireEvents)) as any;
	if (reduction.version !== "bais.reduce@1") throw new Error(`reducer version skew: ${reduction.version}`);
	const db = openDb(issuesDir);
	try {
		db.exec("DELETE FROM events; DELETE FROM tasks; DELETE FROM rels; DELETE FROM conflicts; DELETE FROM excluded; DELETE FROM failures;");
		const insEv = db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const e of wireEvents) {
			insEv.run(e.id, e.author, e.seq, e.prev, e.project, e.entity, JSON.stringify(e.refs), e.lc, e.ts, e.type, JSON.stringify(e.body), e.admitted ? 1 : 0, e.drop_reason);
		}
		const insTask = db.prepare(
			"INSERT INTO tasks(entity, title, status, kind, area, severity, source, body, labels, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const t of reduction.issues) {
			insTask.run(t.entity, t.title, t.status, t.kind, t.area, t.severity, t.source, t.body, JSON.stringify(t.labels), JSON.stringify(t.comments));
		}
		const insRel = db.prepare("INSERT INTO rels(id, source, type, target) VALUES (?, ?, ?, ?)");
		for (const r of reduction.rels) insRel.run(r.id, r.source, r.type, r.target);
		const insConf = db.prepare("INSERT INTO conflicts(entity, field, options, winner, event_ids, at_lc) VALUES (?, ?, ?, ?, ?, ?)");
		for (const c of reduction.conflicts) insConf.run(c.entity, c.field, JSON.stringify(c.options), c.winner, JSON.stringify(c.event_ids), c.at_lc);
		const insExcl = db.prepare("INSERT INTO excluded(event_id, reason) VALUES (?, ?)");
		for (const x of reduction.excluded) insExcl.run(x.event_id, x.reason);
		const insFail = db.prepare("INSERT INTO failures(file, error) VALUES (?, ?)");
		for (const fl of failures) insFail.run(fl.file, fl.error);
		const maxLc = wireEvents.reduce((m, e) => Math.max(m, e.lc), 0);
		setMeta(db, "as_of", JSON.stringify({ heads: wireEvents.map((e) => e.id), lc: maxLc, wall_ts: new Date().toISOString() }));
		setMeta(db, "completeness", failures.length ? "partial" : "complete");
		setMeta(db, "reducer_version", reduction.version);
		setMeta(db, "project", project);
	} finally {
		db.close();
	}
	return { events: wireEvents.length, failures: failures.length };
}

export function hasStore(issuesDir: string): boolean {
	return existsSync(dbPathFor(issuesDir));
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
