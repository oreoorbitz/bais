// bais/src/sync_delta.ts — bi#47: BAML-backed delta serving.
//
// Standing split: BAML (ns_event/delta.baml, pure) owns the diff policy
// (diff_since + projection_fingerprint); THIS module owns serving it —
// version gate, anchor mapping, and the backup-lane directive. The hub's
// GET /sync (heads mode) and GET /sync/digest both serve through here;
// the CLI snapshot lane (`bais sync --from`) is the backup when a delta
// comes back incomplete.
//
// File ownership (bi#47): delta/diff/serve/sync-endpoint files only.
// Do not grow this into verify/dispatch/pub/budget/oversight/store
// concerns — those lanes own their files.

import { event } from "../baml_sdk/index.js";

// Host log row (superset of the BAML WireEvent: carries sig + raw body).
export type HostLogEvent = {
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
	sig?: string | null;
};

// Prune anchor as the hub stores it (meta.prune_anchor). lc == 0 / null
// means "never pruned" — the surviving log IS the full history.
export type DeltaAnchor = { lc: number; state_root: string } | null;

export type DeltaResponse = {
	complete: boolean;
	events: HostLogEvent[];
	floor: number;
	heads: string[];
	reason: string | null;
	reducer_version: string;
	// Backup lane: where to go when complete=false. Always present so a
	// rejoining peer never has to guess the recovery path.
	backup: { snapshot: string; cli: string };
};

const BACKUP = (hubBase: string | null): DeltaResponse["backup"] => ({
	snapshot: "/snapshot",
	cli: `bais sync --from ${hubBase ?? "http://HUB_HOST:HUB_PORT"}`,
});

// Strip host-only fields before the FFI boundary. BAML's WireEvent is
// plain data (string provider tag era — proposals/05); sig must not
// cross, and body passes through untouched (diff policy never reads it).
export function toBamlWire(log: HostLogEvent[]): Record<string, unknown>[] {
	return log.map((e) => ({
		id: e.id,
		author: e.author,
		seq: e.seq,
		prev: e.prev,
		project: e.project,
		entity: e.entity,
		refs: e.refs,
		lc: e.lc,
		ts: e.ts,
		type: e.type,
		body: e.body,
		admitted: e.admitted,
		drop_reason: e.drop_reason,
	}));
}

// Parse the `heads` query param (CSV of event ids, git/IPLD want/have
// style). Empty/missing means "bootstrap me" — a complete delta over the
// anchor floor, never an error.
export function parseHeadsParam(raw: string | null): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const h of raw.split(",")) {
		const t = h.trim();
		if (t && !seen.has(t)) seen.add(t);
	}
	return [...seen];
}

// RED-CHECK hunk (bi#47): the version gate below. Reverting it to always
// serve the delta must trip delta-soak.mjs §0 with
// "expected version-skew rebootstrap for a stale client".
export async function serveDelta(opts: {
	log: HostLogEvent[];
	heads: string[];
	anchor: DeltaAnchor;
	// The caller's reducer version (GET /sync?reducer_version=...). null
	// means "did not say" — served optimistically with the server version
	// stamped on the response so the peer can pin it next poll.
	clientVersion: string | null;
	hubBase: string | null;
}): Promise<DeltaResponse> {
	const backup = BACKUP(opts.hubBase);
	const serverVersion: string = await (event as any).reducer_version();
	if (opts.clientVersion !== null && opts.clientVersion !== serverVersion) {
		return {
			complete: false,
			events: [],
			floor: opts.anchor?.lc ?? 0,
			heads: opts.log.map((e) => e.id),
			reason:
				`version-skew: client ${opts.clientVersion} != server ${serverVersion}; ` +
				`fetch snapshot ${backup.snapshot} then delta (never replay across versions)`,
			reducer_version: serverVersion,
			backup,
		};
	}
	const anchor =
		opts.anchor && opts.anchor.lc > 0
			? await (event as any).anchor_at(opts.anchor.lc, opts.anchor.state_root)
			: await (event as any).no_anchor();
	const d = (await (event as any).diff_since(opts.heads, anchor, toBamlWire(opts.log))) as {
		complete: boolean;
		events: HostLogEvent[];
		floor: number;
		heads: string[];
		reason: string | null;
	};
	return {
		complete: d.complete,
		events: d.events as HostLogEvent[],
		floor: d.floor,
		heads: d.heads,
		reason: d.reason,
		reducer_version: serverVersion,
		backup,
	};
}
