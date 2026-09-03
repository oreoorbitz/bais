// bais/src/hub.ts — linearizable lease/verify/budget coordinator (fusion
// Phase 3, step 9). Optional local dev process: `bais hub [--port N]`.
//
// Split: BAML (ns_event/*.baml) DECIDES admission — every claim/renew/
// release is reduced through the reference reducer and only appended when
// the candidate is not excluded. The hub SERIALIZES (single writer per
// process: concurrent claims reduce in arrival order, losers get 409),
// PERSISTS (append-only events table + leases/verifies/budgets projection
// refresh), and rate-limits (hysteresis freeze + renew budgets).
//
// v1 limits (documented, Phase 4+ removes them):
// - Requires an ingested store (`bais ingest` first); hub-only boot with no
//   store.db errors out. `bais ingest` rebuilds from the TOML seed and
//   DROPS hub-appended events — the TOML seed is still the migration
//   bridge; durable per-actor logs are Phase 4 (plan item 12).
// - Event ids are `hub:<type>:<lc>` (dev identities, not bafy hashes);
//   per-author seq is hub-tracked, so external writers sharing an author
//   string will fork that chain (fork detection is Phase 4).
// - `expires_at` projects as '' — expiry is lc-derived in the reducer,
//   never wall-clock; the leases table holds ACTIVE leases only so
//   `storeReady` ("no live lease") keeps its meaning.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { event } from "../baml_sdk/index.js";

export interface HubLimits {
	maxChangesPerWindow?: number;
	windowMs?: number;
	maxRenewsPerLease?: number;
}

export interface Hub {
	port: number;
	close(): Promise<void>;
}

type WireEvent = {
	id: string;
	author: string;
	seq: number;
	prev: string | null;
	project: string;
	entity: string;
	refs: string[];
	lc: number;
	ts: string;
	type: string;
	body: Record<string, unknown>;
	admitted: boolean;
	drop_reason: string | null;
};

const SCHEMA_TOUCH = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, seq INTEGER NOT NULL,
  prev TEXT, project TEXT NOT NULL, entity TEXT NOT NULL,
  refs TEXT NOT NULL, lc INTEGER NOT NULL, ts TEXT NOT NULL,
  type TEXT NOT NULL, body TEXT NOT NULL,
  admitted INTEGER NOT NULL, drop_reason TEXT
);
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, task TEXT NOT NULL, holder TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL, read_set TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS verifies (id TEXT PRIMARY KEY, task TEXT NOT NULL, submit_ref TEXT NOT NULL, verdict TEXT NOT NULL, verifier TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budgets (principal TEXT PRIMARY KEY, cap REAL NOT NULL, incurred REAL NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function readJson(req: IncomingMessage, limit = 1 << 20): Promise<any> {
	return new Promise((resolve, reject) => {
		let n = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			n += c.length;
			if (n > limit) reject(new Error("body too large"));
			else chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (e: any) {
				reject(new Error(`bad json: ${String(e?.message ?? e).split("\n")[0]}`));
			}
		});
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, obj: unknown): void {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

export async function createHub(
	issuesDir: string,
	opts: { port?: number; project?: string; limits?: HubLimits } = {},
): Promise<{ hub: Hub; server: Server }> {
	// Same location as store.ts dbPathFor (unexported there): .bais/store.db.
	const db = new DatabaseSync(resolve(issuesDir, "..", "store.db"));
	db.exec(SCHEMA_TOUCH);
	// Fresh file (no ingest): the tasks table may not even exist — probe
	// defensively. Hub refuses without a log to coordinate (see header).
	let usable = false;
	try {
		const ev = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n as number;
		const tk = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n as number;
		usable = ev > 0 || tk > 0;
	} catch {
		usable = false;
	}
	if (!usable) {
		db.close();
		throw new Error(`no log to coordinate: run \`bais ingest\` in ${issuesDir} first`);
	}
	const project = opts.project ?? "bais";
	const limits = {
		maxChangesPerWindow: opts.limits?.maxChangesPerWindow ?? 10,
		windowMs: opts.limits?.windowMs ?? 60_000,
		maxRenewsPerLease: opts.limits?.maxRenewsPerLease ?? 32,
	};

	const loadEvents = (): WireEvent[] =>
		(db.prepare("SELECT * FROM events ORDER BY lc, id").all() as any[]).map((r) => ({
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
			admitted: r.admitted === 1,
			drop_reason: r.drop_reason,
		}));

	let log: WireEvent[] = loadEvents();
	let maxLc = log.reduce((m, e) => Math.max(m, e.lc), 0);
	const authorSeq = new Map<string, number>();
	for (const e of log) authorSeq.set(e.author, Math.max(authorSeq.get(e.author) ?? -1, e.seq));
	let lastReduction: any = await (event as any).reduce(log);
	const submitTask = new Map<string, string>();
	const syncSubmitTasks = (): void => {
		submitTask.clear();
		for (const s of lastReduction.submissions as any[]) submitTask.set(s.submit_id, s.entity);
	};
	syncSubmitTasks();

	const changesByTask = new Map<string, number[]>();
	const frozenUntil = new Map<string, number>();
	const renewsByLease = new Map<string, number>();

	const isFrozen = (task: string): number => {
		const until = frozenUntil.get(task) ?? 0;
		if (Date.now() >= until) {
			frozenUntil.delete(task);
			return 0;
		}
		return until;
	};

	const recordChange = (task: string): void => {
		const now = Date.now();
		const win = (changesByTask.get(task) ?? []).filter((t) => now - t < limits.windowMs);
		win.push(now);
		changesByTask.set(task, win);
		// Hysteresis: N admitted changes in the window freezes the task
		// pending a human (flapping protection, fusion-report livelock
		// mitigation). Freeze expires with the window; the frozen list is
		// visible on GET /leases for the Phase 5 exception feed.
		if (win.length > limits.maxChangesPerWindow) frozenUntil.set(task, now + limits.windowMs);
	};

	const persist = (e: WireEvent, reduction: any): void => {
		db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			e.id, e.author, e.seq, e.prev, e.project, e.entity,
			JSON.stringify(e.refs), e.lc, e.ts, e.type, JSON.stringify(e.body),
			e.admitted ? 1 : 0, e.drop_reason,
		);
		// Projection refresh: leases holds ACTIVE leases only (storeReady =
		// "no live lease"); verifies/budgets mirror the reduction.
		db.exec("DELETE FROM leases; DELETE FROM verifies; DELETE FROM budgets;");
		const insLease = db.prepare("INSERT INTO leases(id, task, holder, epoch, expires_at, read_set) VALUES (?, ?, ?, ?, ?, ?)");
		for (const l of reduction.leases as any[]) {
			if (l.status === "active") insLease.run(l.lease_id, l.entity, l.holder, l.epoch, "", JSON.stringify(l.read_set));
		}
		const insVerify = db.prepare("INSERT INTO verifies(id, task, submit_ref, verdict, verifier) VALUES (?, ?, ?, ?, ?)");
		for (const v of reduction.verifications as any[]) {
			insVerify.run(v.verify_id, submitTask.get(v.submit_id) ?? "", v.submit_id, v.verdict, v.verifier);
		}
		const insBudget = db.prepare("INSERT INTO budgets(principal, cap, incurred) VALUES (?, ?, ?)");
		for (const b of reduction.budgets as any[]) insBudget.run(b.principal, b.cap_usd, b.incurred_usd);
		db.prepare("INSERT INTO meta(k, v) VALUES ('as_of', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(
			JSON.stringify({ heads: log.map((x) => x.id), lc: maxLc, wall_ts: new Date().toISOString() }),
		);
	};

	const decide = async (candidate: WireEvent): Promise<{ ok: true; reduction: any } | { ok: false; reason: string }> => {
		const reduction = await (event as any).reduce([...log, candidate]);
		const hit = (reduction.excluded as any[]).find((x) => x.event_id === candidate.id);
		if (hit) return { ok: false, reason: hit.reason };
		return { ok: true, reduction };
	};

	const admit = (candidate: WireEvent, reduction: any): void => {
		log.push(candidate);
		maxLc = candidate.lc;
		authorSeq.set(candidate.author, candidate.seq);
		lastReduction = reduction;
		syncSubmitTasks();
		persist(candidate, reduction);
	};

	const nextLc = (): number => maxLc + 1;
	const nextSeq = (author: string): number => (authorSeq.get(author) ?? -1) + 1;

	const handlers: Record<string, (body: any, res: ServerResponse) => Promise<void>> = {
		"POST /claim": async (b, res) => {
			const { task, holder, ttl, epoch, idem, read_set } = b ?? {};
			if (typeof task !== "string" || typeof holder !== "string" || typeof ttl !== "number" || typeof epoch !== "number" || typeof idem !== "string") {
				send(res, 400, { error: "claim needs {task, holder, ttl, epoch, idem}" });
				return;
			}
			const frozen = isFrozen(task);
			if (frozen) {
				send(res, 409, { reason: "frozen", until: new Date(frozen).toISOString() });
				return;
			}
			const lc = nextLc();
			const candidate: WireEvent = {
				id: `hub:claim:${lc}`, author: holder, seq: nextSeq(holder), prev: null,
				project, entity: task, refs: [], lc, ts: new Date().toISOString(),
				type: "LeaseClaim", body: { ttl, epoch, idem, read_set: Array.isArray(read_set) ? read_set : [] },
				admitted: true, drop_reason: null,
			};
			const d = await decide(candidate);
			if (!d.ok) {
				send(res, 409, { reason: d.reason });
				return;
			}
			admit(candidate, d.reduction);
			recordChange(task);
			const lease = (d.reduction.leases as any[]).find((l) => l.lease_id === candidate.id);
			send(res, 200, { lease_id: candidate.id, task, holder, fencing: lease.fencing, expires_lc: lease.expires_lc });
		},
		"POST /renew": async (b, res) => {
			const { lease_ref, holder } = b ?? {};
			if (typeof lease_ref !== "string" || typeof holder !== "string") {
				send(res, 400, { error: "renew needs {lease_ref, holder}" });
				return;
			}
			const known = (lastReduction.leases as any[]).some((l) => l.lease_id === lease_ref);
			if (!known) {
				send(res, 404, { reason: "unknown-lease" });
				return;
			}
			if ((renewsByLease.get(lease_ref) ?? 0) >= limits.maxRenewsPerLease) {
				send(res, 409, { reason: "retry-budget-exhausted", lease_ref });
				return;
			}
			const lc = nextLc();
			const candidate: WireEvent = {
				id: `hub:renew:${lc}`, author: holder, seq: nextSeq(holder), prev: null,
				project, entity: "", refs: [], lc, ts: new Date().toISOString(),
				type: "LeaseRenew", body: { lease_ref }, admitted: true, drop_reason: null,
			};
			// Entity is cosmetic for renew/release; resolve it for the log.
			const rec = (lastReduction.leases as any[]).find((l) => l.lease_id === lease_ref);
			candidate.entity = rec.entity;
			const d = await decide(candidate);
			if (!d.ok) {
				send(res, 409, { reason: d.reason });
				return;
			}
			admit(candidate, d.reduction);
			renewsByLease.set(lease_ref, (renewsByLease.get(lease_ref) ?? 0) + 1);
			recordChange(rec.entity);
			const lease = (d.reduction.leases as any[]).find((l) => l.lease_id === lease_ref);
			send(res, 200, { lease_id: lease_ref, expires_lc: lease.expires_lc });
		},
		"POST /release": async (b, res) => {
			const { lease_ref, holder } = b ?? {};
			if (typeof lease_ref !== "string" || typeof holder !== "string") {
				send(res, 400, { error: "release needs {lease_ref, holder}" });
				return;
			}
			const rec = (lastReduction.leases as any[]).find((l) => l.lease_id === lease_ref);
			if (!rec) {
				send(res, 404, { reason: "unknown-lease" });
				return;
			}
			const lc = nextLc();
			const candidate: WireEvent = {
				id: `hub:release:${lc}`, author: holder, seq: nextSeq(holder), prev: null,
				project, entity: rec.entity, refs: [], lc, ts: new Date().toISOString(),
				type: "LeaseRelease", body: { lease_ref }, admitted: true, drop_reason: null,
			};
			const d = await decide(candidate);
			if (!d.ok) {
				send(res, 409, { reason: d.reason });
				return;
			}
			admit(candidate, d.reduction);
			recordChange(rec.entity);
			send(res, 200, { lease_id: lease_ref, status: "released" });
		},
		"GET /leases": async (_b, res) => {
			const now = Date.now();
			for (const [t, u] of [...frozenUntil]) if (now >= u) frozenUntil.delete(t);
			send(res, 200, {
				leases: (lastReduction.leases as any[]).filter((l) => l.status === "active"),
				frozen: [...frozenUntil].map(([task, until]) => ({ task, until: new Date(until).toISOString() })),
			});
		},
	};

	const server = createServer((req, res) => {
		const key = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
		const h = handlers[key];
		if (!h) {
			send(res, 404, { error: `no route ${key}` });
			return;
		}
		// GET routes carry no body (reading one would hang on keep-alive).
		if (req.method === "GET") {
			h({}, res).catch(() => send(res, 500, { error: "handler failed" }));
			return;
		}
		readJson(req).then(
			(body) => h(body, res).catch(() => send(res, 500, { error: "handler failed" })),
			(e: any) => send(res, 400, { error: e.message }),
		);
	});

	const port = opts.port ?? 0;
	await new Promise<void>((resolve) => server.listen(port, resolve));
	const addr = server.address();
	const bound = typeof addr === "object" && addr ? addr.port : port;
	return {
		hub: {
			port: bound,
			close: () =>
				new Promise<void>((resolve, reject) => {
					server.close((e) => (e ? reject(e) : resolve()));
					db.close();
				}),
		},
		server,
	};
}
