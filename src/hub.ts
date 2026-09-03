// bais/src/hub.ts — relay + indexer + lease coordinator + rate limiter
// (fusion Phase 4: hub-deployed, P2P-ready). Optional local dev process:
// `bais hub [--port N]`.
//
// Split: BAML (ns_event/*.baml) DECIDES admission — every appended event
// is reduced through the reference reducer and only kept when not
// excluded. The hub SERIALIZES (single writer: concurrent claims reduce in
// arrival order, losers get 409), PERSISTS (append-only events table +
// full projection refresh), RATE-LIMITS (hysteresis freeze, renew budgets,
// per-write bounds, budget-exhaustion 402), SIGNS (own checkpoint events;
// verifies peer sigs when present), and RELAYS (want/have sync,
// snapshots, ephemeral pubsub).
//
// v1 limits (documented, later phases remove them):
// - `bais ingest` rebuilds from the TOML seed and DROPS hub/sync-appended
//   events — back up store.db (or export a snapshot) before re-ingesting.
// - Coordinator-built events (claim/renew/release) carry sig=null
//   (envelope-legal pre-signing): the hub is a trusted-local coordinator.
//   Peer replication (POST /sync) verifies sigs when present and enforces
//   chain continuity always; hubs started with requireSigs reject
//   unsigned peer events outright. Full sig-required mode is later.
// - Event ids are `hub:<type>:<lc>` (dev identities, not bafy hashes).
// - `expires_at` projects as '' — expiry is lc-derived in the reducer.
// - No row-deletion prune: the reducer is whole-log, so deleting covered
//   rows would corrupt re-derivation. Checkpoints enable verified
//   bootstrap + divergence alarms; storage prune needs incremental
//   reduce (follow-up).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { event } from "../baml_sdk/index.js";
import { projectName } from "./graph.js";
import { refreshProjectionTables, ensureSchema, exportSnapshot } from "./store.js";
import {
	generatePeerKey,
	signPayload,
	verifyPayload,
	signableOf,
	verifyChain,
	canonicalize,
	sha256Hex,
	type PeerKey,
} from "./keys.js";

export interface HubLimits {
	maxChangesPerWindow?: number;
	windowMs?: number;
	maxRenewsPerLease?: number;
	maxBodyBytes?: number;
	maxRefs?: number;
	maxBatchEvents?: number;
	requireSigs?: boolean;
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
	sig: string | null;
	admitted: boolean;
	drop_reason: string | null;
};

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

// Peer identity: .bais/key.json (mode 600), generated on first use.
// One key per directory — the hub and the local CLI sign as the same peer.
export function loadPeerKey(baisDir: string): PeerKey {
	const p = resolve(baisDir, "key.json");
	if (existsSync(p)) {
		return JSON.parse(readFileSync(p, "utf8")) as PeerKey;
	}
	const key = generatePeerKey();
	mkdirSync(baisDir, { recursive: true });
	writeFileSync(p, JSON.stringify(key, null, 2), { mode: 0o600 });
	return key;
}

// state_root: sha256 over the canonical materialization. Shared by
// publish and verify so the two cannot drift — the anchor both agree on.
export function computeStateRoot(reduction: any): string {
	return sha256Hex(
		canonicalize({
			issues: reduction.issues,
			rels: reduction.rels,
			leases: reduction.leases,
			submissions: reduction.submissions,
			verifications: reduction.verifications,
			budgets: reduction.budgets,
			costs: reduction.costs,
			conflicts: reduction.conflicts,
		}),
	);
}

export function verifyCheckpointRoot(reduction: any, stateRoot: string): boolean {
	return computeStateRoot(reduction) === stateRoot;
}

function rowToWire(r: any): WireEvent {
	return {
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
		drop_reason: r.drop_reason,
	};
}

function loadLog(db: DatabaseSync): WireEvent[] {
	return (db.prepare("SELECT * FROM events ORDER BY lc, id").all() as any[]).map(rowToWire);
}

// Shape gate for foreign events: every field the reducer and chain check
// touch must be present and typed. Returns a reason, or null when clean.
function checkEventShape(e: any): string | null {
	if (!e || typeof e !== "object") return "malformed";
	if (typeof e.id !== "string" || !e.id) return "malformed";
	if (typeof e.author !== "string" || !e.author) return "malformed";
	if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 0) return "malformed";
	if (e.prev !== null && typeof e.prev !== "string") return "malformed";
	if (typeof e.project !== "string" || typeof e.entity !== "string") return "malformed";
	if (!Array.isArray(e.refs) || !e.refs.every((r: any) => typeof r === "string")) return "malformed";
	if (typeof e.lc !== "number" || !Number.isInteger(e.lc)) return "malformed";
	if (typeof e.ts !== "string" || typeof e.type !== "string" || !e.type) return "malformed";
	if (!e.body || typeof e.body !== "object" || Array.isArray(e.body)) return "malformed";
	if (e.sig !== null && e.sig !== undefined && typeof e.sig !== "string") return "malformed";
	return null;
}

export interface AppendResult {
	accepted: string[];
	rejected: { id: string; reason: string }[];
}

// Append foreign events to a directory's log (POST /sync handler + CLI
// sync share this). Mode delta: per-event continuity against the local
// log (seq/prev must link). Mode backfill: the SET must be internally
// chain-clean (verifyChain) and cover the checkpoint heads; used once
// after a snapshot import, before writes unlock.
//
// Invalid events are stored as evidence (admitted=0 + drop_reason) per
// the report — no writer to reject at ingest time — EXCEPT malformed
// shapes, which cannot be represented and are dropped with a reason.
// Signatures verify when present; requireSigs rejects unsigned peer
// events. Bounds (size/fan-out) apply per event.
export async function appendForeignEvents(
	issuesDir: string,
	incoming: any[],
	opts: { requireSigs?: boolean; mode?: "delta" | "backfill"; maxBodyBytes?: number; maxRefs?: number; maxBatchEvents?: number } = {},
): Promise<AppendResult> {
	const maxBodyBytes = opts.maxBodyBytes ?? 262144;
	const maxRefs = opts.maxRefs ?? 64;
	const maxBatchEvents = opts.maxBatchEvents ?? 500;
	if (!Array.isArray(incoming)) throw new Error("events must be an array");
	if (incoming.length > maxBatchEvents) throw new Error("over-batch");
	const db = new DatabaseSync(resolve(issuesDir, "..", "store.db"));
	try {
		ensureSchema(db);
		const log = loadLog(db);
		const known = new Set(log.map((e) => e.id));
		const accepted: string[] = [];
		const rejected: { id: string; reason: string }[] = [];
		const staged: WireEvent[] = [];
		const evidence: { e: WireEvent; reason: string }[] = [];

		const checkBounds = (body: any, refs: any[]): string | null => {
			if (Buffer.byteLength(JSON.stringify(body ?? {}), "utf8") > maxBodyBytes) return "over-size";
			if ((refs ?? []).length > maxRefs) return "over-fanout";
			return null;
		};
		const checkSig = (e: any): string | null => {
			if (e.sig != null) {
				// Signatures cover the wire form: list bodies must already
				// be JSON-encoded (encode-before-sign, SPEC §5.3), because
				// the hub normalizes arrays on store and a sig over raw
				// arrays would break for every downstream verifier.
				if (Object.values(e.body ?? {}).some((v) => Array.isArray(v))) return "unencoded-lists";
				const { project, prev, refs, type, entity, body } = e;
				if (!verifyPayload(e.author, { project, prev, refs, type, entity, body }, e.sig)) return "bad-sig";
				return null;
			}
			return opts.requireSigs ? "sig-required" : null;
		};

		if (opts.mode === "backfill") {
			// Whole-set chain verification; coverage of the anchor heads is
			// the caller's job (CLI sync checks checkpoint.heads explicitly).
			const clean = incoming.filter((e) => !checkEventShape(e));
			const breaks = verifyChain(clean as any[]);
			const broken = new Set(breaks.map((b) => b.id));
			for (const raw of incoming) {
				const shape = checkEventShape(raw);
				if (shape || raw == null || typeof raw.id !== "string") {
					rejected.push({ id: String(raw?.id ?? "?"), reason: shape ?? "malformed" });
					continue;
				}
				if (known.has(raw.id)) continue; // idempotent re-pull
				if (broken.has(raw.id)) {
					const reason = breaks.find((b) => b.id === raw.id)?.reason ?? "chain-break";
					rejected.push({ id: raw.id, reason });
					evidence.push({ e: toWire(raw), reason });
					continue;
				}
				const sig = checkSig(raw);
				const bounds = checkBounds(raw.body, raw.refs);
				if (sig || bounds) {
					const reason = sig ?? bounds ?? "rejected";
					rejected.push({ id: raw.id, reason });
					evidence.push({ e: toWire(raw), reason });
					continue;
				}
				staged.push(toWire(raw));
				accepted.push(raw.id);
			}
		} else {
			// Delta mode: continuity against the local log, per author.
			// Max-seq wins for lastId (log order is lc-order, which can
			// disagree with author order across a fork — deterministic).
			const nextSeq = new Map<string, number>();
			const lastId = new Map<string, string>();
			const maxSeq = new Map<string, number>();
			for (const e of log) {
				nextSeq.set(e.author, Math.max(nextSeq.get(e.author) ?? 0, e.seq + 1));
				if (e.seq >= (maxSeq.get(e.author) ?? -1)) {
					maxSeq.set(e.author, e.seq);
					lastId.set(e.author, e.id);
				}
			}
			for (const raw of incoming) {
				const shape = checkEventShape(raw);
				if (shape || raw == null || typeof raw.id !== "string") {
					rejected.push({ id: String(raw?.id ?? "?"), reason: shape ?? "malformed" });
					continue;
				}
				if (known.has(raw.id) || staged.some((s) => s.id === raw.id)) continue; // idempotent
				const want = nextSeq.get(raw.author) ?? 0;
				if (raw.seq !== want) {
					rejected.push({ id: raw.id, reason: "chain-break" });
					evidence.push({ e: toWire(raw), reason: "chain-break" });
					continue;
				}
				// Genesis (want 0) needs null prev; otherwise prev must link
				// to the author's last known id — a fork or gap breaks here.
				const lastKnown = lastId.get(raw.author);
				if (want === 0 ? raw.prev !== null : raw.prev !== lastKnown) {
					rejected.push({ id: raw.id, reason: want === 0 ? "genesis-prev" : "prev-mismatch" });
					evidence.push({ e: toWire(raw), reason: want === 0 ? "genesis-prev" : "prev-mismatch" });
					continue;
				}
				const sig = checkSig(raw);
				const bounds = checkBounds(raw.body, raw.refs);
				if (sig || bounds) {
					const reason = sig ?? bounds ?? "rejected";
					rejected.push({ id: raw.id, reason });
					evidence.push({ e: toWire(raw), reason });
					continue;
				}
				staged.push(toWire(raw));
				accepted.push(raw.id);
				nextSeq.set(raw.author, want + 1);
				lastId.set(raw.author, raw.id);
			}
		}

		// Spam lever on the sync path (mirrors the claim endpoint's 402):
		// authors exhausted in both budget dimensions open no new state.
		// Wind-down (renew/release), funding (budget events), and protocol
		// (checkpoints) stay open — otherwise exhaustion deadlocks top-up.
		if (staged.length) {
			const current = await (event as any).reduce(log);
			const exhausted = new Set(
				((current.budgets as any[]) ?? [])
					.filter((b) => b.incurred_usd >= b.cap_usd && b.incurred_tokens >= b.cap_tokens)
					.map((b) => b.principal),
			);
			const OPEN = new Set(["LeaseRenew", "LeaseRelease", "CheckpointPublish", "BudgetAuthorize", "CostReserve", "CostIncurred", "ReceiptAttach"]);
			for (let i = staged.length - 1; i >= 0; i--) {
				const e = staged[i];
				if (!OPEN.has(e.type) && exhausted.has(e.author)) {
					staged.splice(i, 1);
					accepted.splice(accepted.indexOf(e.id), 1);
					rejected.push({ id: e.id, reason: "budget-exhausted" });
					evidence.push({ e, reason: "budget-exhausted" });
				}
			}
		}

		const ins = db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, sig, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const e of staged) {
			ins.run(e.id, e.author, e.seq, e.prev, e.project, e.entity, JSON.stringify(e.refs), e.lc, e.ts, e.type, JSON.stringify(e.body), e.sig, 1, null);
		}
		for (const { e, reason } of evidence) {
			try {
				ins.run(
					e.id, e.author, e.seq, e.prev, e.project, e.entity, JSON.stringify(e.refs), e.lc, e.ts, e.type,
					JSON.stringify(e.body), e.sig, 0, reason,
				);
			} catch {
				// Evidence insert races (same id twice): the first copy stands.
			}
		}
		const full = loadLog(db);
		const reduction = await (event as any).reduce(full);
		refreshProjectionTables(
			db,
			reduction,
			full.map((x) => x.id),
			full.reduce((m, e) => Math.max(m, e.lc), 0),
		);
		return { accepted, rejected };
	} finally {
		db.close();
	}
}

// FFI gap workaround (see body_string_list in lease.baml): JS arrays
// inside map<string,unknown> never narrow to string[] over the bridge,
// so list-typed body fields travel JSON-encoded. Central walk — any array
// value anywhere in a body is encoded, no per-type table to rot. BAML
// parses them back; BAML-native callers are unaffected (dual path).
export function encodeBodyArrays(body: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body ?? {})) out[k] = Array.isArray(v) ? JSON.stringify(v) : v;
	return out;
}

function toWire(raw: any): WireEvent {
	// admitted/drop_reason pass through: a peer's evidence rows stay
	// evidence here, never silently promoted by replication.
	return {
		id: raw.id,
		author: raw.author,
		seq: raw.seq,
		prev: raw.prev ?? null,
		project: raw.project,
		entity: raw.entity,
		refs: raw.refs ?? [],
		lc: raw.lc,
		ts: raw.ts,
		type: raw.type,
		body: encodeBodyArrays(raw.body ?? {}),
		sig: raw.sig ?? null,
		admitted: raw.admitted ?? true,
		drop_reason: raw.drop_reason ?? null,
	};
}

// Publish a checkpoint over a directory's current log: reduce, root,
// sign with the peer key, append, project. Shared by POST /checkpoint
// and `bais checkpoint`.
export async function publishCheckpoint(issuesDir: string): Promise<{
	id: string;
	publisher: string;
	lc: number;
	state_root: string;
	heads: string[];
	reducer_version: string;
}> {
	const baisDir = resolve(issuesDir, "..");
	const key = loadPeerKey(baisDir);
	const db = new DatabaseSync(resolve(baisDir, "store.db"));
	try {
		ensureSchema(db);
		const log = loadLog(db);
		if (!log.length) throw new Error("empty log — nothing to checkpoint");
		const reduction = await (event as any).reduce(log);
		const root = computeStateRoot(reduction);
		const lc = log.reduce((m, e) => Math.max(m, e.lc), 0);
		const heads = log.map((e) => e.id);
		const authorEvents = log.filter((e) => e.author === key.did);
		const seq = authorEvents.reduce((m, e) => Math.max(m, e.seq), -1) + 1;
		const prev = authorEvents.length ? authorEvents[authorEvents.length - 1].id : null;
		const body = encodeBodyArrays({ state_root: root, heads, reducer_version: reduction.version, lc });
		const candidate: WireEvent = {
			id: `hub:checkpoint:${lc}:${Date.now()}`,
			author: key.did,
			seq,
			prev,
			project: log[0].project,
			entity: heads[heads.length - 1],
			refs: [],
			lc: lc + 1,
			ts: new Date().toISOString(),
			type: "CheckpointPublish",
			body,
			sig: signPayload(key.privateJwk, signableOf({ project: log[0].project, prev, refs: [], type: "CheckpointPublish", entity: heads[heads.length - 1], body })),
			admitted: true,
			drop_reason: null,
		};
		const after = await (event as any).reduce([...log, candidate]);
		const hit = (after.excluded as any[]).find((x) => x.event_id === candidate.id);
		if (hit) throw new Error(`checkpoint excluded: ${hit.reason}`);
		db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, sig, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)",
		).run(
			candidate.id, candidate.author, candidate.seq, candidate.prev, candidate.project, candidate.entity,
			JSON.stringify(candidate.refs), candidate.lc, candidate.ts, candidate.type, JSON.stringify(candidate.body), candidate.sig,
		);
		const full = loadLog(db);
		refreshProjectionTables(
			db,
			after,
			full.map((x) => x.id),
			full.reduce((m, e) => Math.max(m, e.lc), 0),
		);
		return {
			id: candidate.id,
			publisher: key.did,
			lc,
			state_root: root,
			heads,
			reducer_version: reduction.version,
		};
	} finally {
		db.close();
	}
}

export async function createHub(
	issuesDir: string,
	opts: { port?: number; project?: string; limits?: HubLimits } = {},
): Promise<{ hub: Hub; server: Server }> {
	const baisDir = resolve(issuesDir, "..");
	// Same store.db as store.ts dbPathFor: .bais/store.db.
	const db = new DatabaseSync(resolve(baisDir, "store.db"));
	ensureSchema(db);
	// Fresh file (no ingest, no snapshot): the tasks table may not even
	// exist — probe defensively. A snapshot import leaves tables without
	// events: reads serve from tables, writes wait for backfill.
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
	const project = opts.project ?? projectName(issuesDir);
	const limits = {
		maxChangesPerWindow: opts.limits?.maxChangesPerWindow ?? 10,
		windowMs: opts.limits?.windowMs ?? 60_000,
		maxRenewsPerLease: opts.limits?.maxRenewsPerLease ?? 32,
		maxBodyBytes: opts.limits?.maxBodyBytes ?? 262144,
		maxRefs: opts.limits?.maxRefs ?? 64,
		maxBatchEvents: opts.limits?.maxBatchEvents ?? 500,
		requireSigs: opts.limits?.requireSigs ?? false,
	};
	// Ensure the hub identity exists (checkpoint signing loads it per
	// publish in publishCheckpoint; creation here keeps first-boot logs
	// intelligible — one "generated peer key" moment, not a surprise).
	loadPeerKey(baisDir);

	const loadEvents = (): WireEvent[] => loadLog(db);

	let log: WireEvent[] = loadEvents();
	let maxLc = log.reduce((m, e) => Math.max(m, e.lc), 0);
	const authorSeq = new Map<string, number>();
	const authorLastId = new Map<string, string>();
	for (const e of log) {
		if (e.seq >= (authorSeq.get(e.author) ?? -1)) {
			authorSeq.set(e.author, e.seq);
			authorLastId.set(e.author, e.id);
		}
	}
	let lastReduction: any = await (event as any).reduce(log);

	const changesByTask = new Map<string, number[]>();
	const frozenUntil = new Map<string, number>();
	const renewsByLease = new Map<string, number>();
	const rebuildRenews = (): void => {
		renewsByLease.clear();
		for (const e of log) {
			if (e.type === "LeaseRenew" && e.admitted) {
				const ref = (e.body as any)?.lease_ref;
				if (typeof ref === "string") renewsByLease.set(ref, (renewsByLease.get(ref) ?? 0) + 1);
			}
		}
	};
	rebuildRenews();

	// Ephemeral channel (report §2, Nostr model): memory ring + live SSE
	// fan-out only. Nothing here touches the log, the reducer, or SQLite.
	type PubMsg = { seq: number; type: string; entity: string | null; body: unknown; author: string | null; ts: string };
	let pubSeq = 0;
	const pubRing: PubMsg[] = [];
	const pubCap = 1000;
	const sseClients = new Set<ServerResponse>();

	const reload = async (): Promise<void> => {
		log = loadEvents();
		maxLc = log.reduce((m, e) => Math.max(m, e.lc), 0);
		authorSeq.clear();
		authorLastId.clear();
		for (const e of log) {
			if (e.seq >= (authorSeq.get(e.author) ?? -1)) {
				authorSeq.set(e.author, e.seq);
				authorLastId.set(e.author, e.id);
			}
		}
		lastReduction = await (event as any).reduce(log);
		rebuildRenews();
	};

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

	// Spam lever (Phase 3 step 11, enforced Phase 4): an author whose
	// budget is exhausted in EITHER dimension cannot open new state —
	// wind-down (renew/release) and protocol (checkpoint) stay open.
	const authorExhausted = (author: string): boolean => {
		const b = ((lastReduction.budgets as any[]) ?? []).find((x) => x.principal === author);
		return !!b && b.incurred_usd >= b.cap_usd && b.incurred_tokens >= b.cap_tokens;
	};

	// Per-write bounds (Phase 4 step 14): artifact size, fan-out, and —
	// at the batch level — event count. Hub-generated protocol events
	// (checkpoints) are exempt: heads[] legitimately grows with the log.
	const checkBounds = (body: any, refs: any[]): string | null => {
		if (Buffer.byteLength(JSON.stringify(body ?? {}), "utf8") > limits.maxBodyBytes) return "over-size";
		if ((refs ?? []).length > limits.maxRefs) return "over-fanout";
		return null;
	};

	// Writes block while a snapshot bootstrap awaits backfill+verify:
	// serving reads from unverified tables is fine, deriving new state
	// from them is not. Restart the hub after `bais sync --from` completes.
	const backfillPending = (): boolean => {
		try {
			const raw = (db.prepare("SELECT v FROM meta WHERE k = 'bootstrap'").get() as any)?.v;
			return !!raw && !(JSON.parse(raw) as any).complete;
		} catch {
			return false;
		}
	};

	const persist = (e: WireEvent, reduction: any): void => {
		db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, sig, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			e.id, e.author, e.seq, e.prev, e.project, e.entity,
			JSON.stringify(e.refs), e.lc, e.ts, e.type, JSON.stringify(e.body), e.sig,
			e.admitted ? 1 : 0, e.drop_reason,
		);
		refreshProjectionTables(db, reduction, log.map((x) => x.id), maxLc);
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
		authorLastId.set(candidate.author, candidate.id);
		lastReduction = reduction;
		persist(candidate, reduction);
	};

	const nextLc = (): number => maxLc + 1;
	const nextSeq = (author: string): number => (authorSeq.get(author) ?? -1) + 1;
	// Chain link: the author's last id, null at genesis. Every hub-built
	// event links, so peer chain checks pass on replication.
	const nextPrev = (author: string): string | null => authorLastId.get(author) ?? null;

	const handlers: Record<string, (body: any, res: ServerResponse, url: URL) => Promise<void>> = {
		"POST /claim": async (b, res) => {
			if (backfillPending()) {
				send(res, 503, { reason: "backfill-pending" });
				return;
			}
			const { task, holder, ttl, epoch, idem, read_set } = b ?? {};
			if (typeof task !== "string" || typeof holder !== "string" || typeof ttl !== "number" || typeof epoch !== "number" || typeof idem !== "string") {
				send(res, 400, { error: "claim needs {task, holder, ttl, epoch, idem}" });
				return;
			}
			const body = { ttl, epoch, idem, read_set: Array.isArray(read_set) ? read_set : [] };
			const bounded = checkBounds(body, []);
			if (bounded) {
				send(res, 413, { reason: bounded });
				return;
			}
			if (authorExhausted(holder)) {
				send(res, 402, { reason: "budget-exhausted" });
				return;
			}
			const frozen = isFrozen(task);
			if (frozen) {
				send(res, 409, { reason: "frozen", until: new Date(frozen).toISOString() });
				return;
			}
			const lc = nextLc();
			const candidate: WireEvent = {
				id: `hub:claim:${lc}`, author: holder, seq: nextSeq(holder), prev: nextPrev(holder),
				project, entity: task, refs: [], lc, ts: new Date().toISOString(),
				type: "LeaseClaim", body: encodeBodyArrays(body), sig: null,
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
			if (backfillPending()) {
				send(res, 503, { reason: "backfill-pending" });
				return;
			}
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
				id: `hub:renew:${lc}`, author: holder, seq: nextSeq(holder), prev: nextPrev(holder),
				project, entity: "", refs: [], lc, ts: new Date().toISOString(),
				type: "LeaseRenew", body: { lease_ref }, sig: null, admitted: true, drop_reason: null,
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
			if (backfillPending()) {
				send(res, 503, { reason: "backfill-pending" });
				return;
			}
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
				id: `hub:release:${lc}`, author: holder, seq: nextSeq(holder), prev: nextPrev(holder),
				project, entity: rec.entity, refs: [], lc, ts: new Date().toISOString(),
				type: "LeaseRelease", body: { lease_ref }, sig: null, admitted: true, drop_reason: null,
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
		// Whole-workspace catch-up (Phase 4 step 12): per-actor log via
		// author+since_seq, or everything past an lc. `have` carries the
		// requester's ids (git/IPLD-style want/have); cursors report every
		// actor's head so the peer knows what to ask for next.
		"GET /sync": async (_b, res, url) => {
			const author = url.searchParams.get("author");
			const sinceSeq = url.searchParams.get("since_seq");
			const sinceLc = url.searchParams.get("since_lc");
			const have = new Set((url.searchParams.get("have") ?? "").split(",").filter(Boolean));
			if (sinceSeq !== null && author === null) {
				send(res, 400, { error: "since_seq needs author" });
				return;
			}
			const sinceSeqN = sinceSeq !== null ? Number(sinceSeq) : null;
			const sinceLcN = sinceLc !== null ? Number(sinceLc) : null;
			if ((sinceSeqN !== null && !Number.isInteger(sinceSeqN)) || (sinceLcN !== null && !Number.isInteger(sinceLcN))) {
				send(res, 400, { error: "since_seq/since_lc must be integers" });
				return;
			}
			let out = log;
			if (author !== null) out = out.filter((e) => e.author === author);
			if (sinceSeqN !== null) out = out.filter((e) => e.seq > sinceSeqN);
			if (sinceLcN !== null) out = out.filter((e) => e.lc > sinceLcN);
			if (have.size) out = out.filter((e) => !have.has(e.id));
			const cursors = new Map<string, { author: string; seq: number; id: string }>();
			for (const e of log) {
				const cur = cursors.get(e.author);
				if (!cur || e.seq > cur.seq) cursors.set(e.author, { author: e.author, seq: e.seq, id: e.id });
			}
			send(res, 200, { events: out, cursors: [...cursors.values()], lc: maxLc });
		},
		// Negentropy-shape reconciliation stub: compare fingerprints before
		// fetching. Same filters as /sync; digest covers the sorted id set.
		"GET /sync/digest": async (_b, res, url) => {
			const author = url.searchParams.get("author");
			const sinceSeq = url.searchParams.get("since_seq");
			if (sinceSeq !== null && author === null) {
				send(res, 400, { error: "since_seq needs author" });
				return;
			}
			const sinceSeqN = sinceSeq !== null ? Number(sinceSeq) : null;
			if (sinceSeqN !== null && !Number.isInteger(sinceSeqN)) {
				send(res, 400, { error: "since_seq must be an integer" });
				return;
			}
			let out = log;
			if (author !== null) out = out.filter((e) => e.author === author);
			if (sinceSeqN !== null) out = out.filter((e) => e.seq > sinceSeqN);
			const ids = out.map((e) => e.id).sort();
			send(res, 200, { count: ids.length, digest: sha256Hex(ids.join(",")), head_lc: maxLc });
		},
		// Peer ingestion: cortical append through the shared validator.
		// Rejected events land as evidence (admitted=0), never silently.
		"POST /sync": async (b, res) => {
			if (backfillPending()) {
				send(res, 503, { reason: "backfill-pending" });
				return;
			}
			const events = b?.events;
			if (!Array.isArray(events)) {
				send(res, 400, { error: "sync needs {events: [...]}" });
				return;
			}
			if (events.length > limits.maxBatchEvents) {
				send(res, 400, { error: "over-batch" });
				return;
			}
			try {
				const r = await appendForeignEvents(issuesDir, events, {
					requireSigs: limits.requireSigs,
					mode: "delta",
					maxBodyBytes: limits.maxBodyBytes,
					maxRefs: limits.maxRefs,
					maxBatchEvents: limits.maxBatchEvents,
				});
				await reload();
				send(res, 200, r);
			} catch (e: any) {
				send(res, 400, { error: String(e?.message ?? e).split("\n")[0] });
			}
		},
		// Checkpoint publish + verify (Phase 4 step 13). GET recomputes
		// state_root live: `verified` is a divergence alarm, not a cache.
		"POST /checkpoint": async (_b, res) => {
			if (backfillPending()) {
				send(res, 503, { reason: "backfill-pending" });
				return;
			}
			try {
				const cp = await publishCheckpoint(issuesDir);
				await reload();
				send(res, 200, { checkpoint: cp });
			} catch (e: any) {
				send(res, 400, { error: String(e?.message ?? e).split("\n")[0] });
			}
		},
		"GET /checkpoint": async (_b, res) => {
			const cps = ((lastReduction.checkpoints as any[]) ?? []).slice().sort((a, b) => b.lc - a.lc);
			if (!cps.length) {
				send(res, 404, { error: "no checkpoint published" });
				return;
			}
			const cp = cps[0];
			send(res, 200, {
				checkpoint: { id: cp.id, publisher: cp.publisher, lc: cp.lc, state_root: cp.state_root, heads: cp.heads, reducer_version: cp.reducer_version },
				verified: verifyCheckpointRoot(lastReduction, cp.state_root),
			});
		},
		// Fast-bootstrap export: latest checkpoint + every materialized
		// table. Import with `bais sync --from` (TOFU reads, backfill then
		// verifies state_root before writes unlock).
		"GET /snapshot": async (_b, res) => {
			send(res, 200, { snapshot: exportSnapshot(issuesDir) });
		},
		// Ephemeral publish (Phase 4 step 14): Heartbeat/Progress ONLY.
		// Anything else is 400 — durable types go through the log.
		"POST /pub": async (b, res) => {
			const { type, entity, body, author } = b ?? {};
			if (typeof type !== "string") {
				send(res, 400, { error: "pub needs {type}" });
				return;
			}
			let ephemeral = false;
			try {
				ephemeral = await (event as any).is_ephemeral_async(type);
			} catch {
				ephemeral = type === "Heartbeat" || type === "Progress";
			}
			if (!ephemeral) {
				send(res, 400, { error: "not-ephemeral: durable types go through the log" });
				return;
			}
			const bounded = checkBounds(body ?? {}, []);
			if (bounded) {
				send(res, 413, { reason: bounded });
				return;
			}
			const msg: PubMsg = {
				seq: pubSeq++,
				type,
				entity: typeof entity === "string" ? entity : null,
				body: body ?? {},
				author: typeof author === "string" ? author : null,
				ts: new Date().toISOString(),
			};
			pubRing.push(msg);
			if (pubRing.length > pubCap) pubRing.splice(0, pubRing.length - pubCap);
			const line = `data: ${JSON.stringify(msg)}\n\n`;
			for (const c of sseClients) c.write(line);
			send(res, 200, { seq: msg.seq });
		},
		"GET /pub": async (_b, res, url) => {
			const since = Number(url.searchParams.get("since") ?? "-1");
			const type = url.searchParams.get("type");
			send(res, 200, {
				events: pubRing.filter((m) => m.seq > since && (type === null || m.type === type)),
			});
		},
		// Live-only SSE fan-out: no replay, no history — connect and listen.
		"GET /pub/stream": async (_b, res) => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sseClients.add(res);
			res.on("close", () => sseClients.delete(res));
		},
	};

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const key = `${req.method} ${url.pathname}`;
		const h = handlers[key];
		if (!h) {
			send(res, 404, { error: `no route ${key}` });
			return;
		}
		// SSE streams manage their own lifecycle, not the JSON body reader.
		if (key === "GET /pub/stream") {
			h({}, res, url).catch(() => {
				try {
					send(res, 500, { error: "handler failed" });
				} catch {}
			});
			return;
		}
		// GET routes carry no body (reading one would hang on keep-alive).
		if (req.method === "GET") {
			h({}, res, url).catch(() => send(res, 500, { error: "handler failed" }));
			return;
		}
		readJson(req).then(
			(body) => h(body, res, url).catch(() => send(res, 500, { error: "handler failed" })),
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
					for (const c of sseClients) {
						try {
							c.end();
						} catch {}
					}
					server.close((e) => (e ? reject(e) : resolve()));
					db.close();
				}),
		},
		server,
	};
}
