// bais/src/ids.ts — content-hash event ids (bi#38).
//
// The envelope (ns_event/envelope.baml) always specified `bafy...`
// version identities; the host just never implemented them
// (`hub:<type>:<lc>` dev ids instead). This file is the implementation.
//
// Scheme (documented, deterministic, dependency-free):
//   id = 'b' + base32(CIDv1{ codec: raw(0x55), hash: sha2-256 } )
//   digest = sha256( UTF-8( canonicalJson(payload) ) )
// where payload is every Event field EXCEPT id, and canonicalJson is a
// JCS-style canonical form: object keys sorted by UTF-16 code unit
// order, recursively; arrays in order; strings JSON-escaped; numbers
// via JSON.stringify (deterministic in V8 for identical doubles);
// null/true/false as-is. The digest commits to `sig` too, so the id is
// assigned AFTER signing (or after sig:null is settled for trusted-local
// coordinator events) — same event bytes, same id, across processes.
//
// This is CIDv1 with the *raw* codec (0x55), not dag-cbor (0x71): the
// addressed bytes ARE the canonical JSON, honestly labeled. Anyone can
// re-verify: re-canonicalize the payload, re-hash, compare. See
// scripts/content-ids.mjs (golden vector + cross-process determinism).

import { createHash } from "node:crypto";

export interface EventPayload {
	author: string;
	seq: number;
	prev: string | null;
	project: string;
	entity: string;
	refs: string[];
	lc: number;
	ts: string;
	type: string;
	body: unknown;
	cost?: unknown;
	cap?: unknown;
	sig?: string | null;
}

// Canonical JSON over the JSON-value subset the log actually carries.
// Throws on undefined/functions/symbols/bigints — those have no
// canonical form and must never reach an event id.
export function canonicalize(v: unknown): string {
	if (v === null) return "null";
	switch (typeof v) {
		case "boolean":
			return v ? "true" : "false";
		case "number":
			if (!Number.isFinite(v)) throw new Error("canonicalize: non-finite number has no canonical form");
			return JSON.stringify(v);
		case "string":
			return JSON.stringify(v);
		case "object": {
			if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x)).join(",")}]`;
			const keys = Object.keys(v).sort();
			const parts: string[] = [];
			for (const k of keys) {
				const val = (v as Record<string, unknown>)[k];
				if (typeof val === "undefined") throw new Error("canonicalize: undefined has no canonical form");
				parts.push(`${JSON.stringify(k)}:${canonicalize(val)}`);
			}
			return `{${parts.join(",")}}`;
		}
		default:
			throw new Error(`canonicalize: ${typeof v} has no canonical form`);
	}
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let acc = 0;
	for (const byte of bytes) {
		acc = (acc << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += B32[(acc >>> bits) & 31];
		}
	}
	if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
	return out;
}

// CIDv1 bytes: version(0x01) + raw codec(0x55) + sha2-256(0x12) + len(0x20) + digest.
// Hashes exactly the Event-schema content fields: host bookkeeping
// (admitted, drop_reason) is excluded, absent optionals stay absent
// (present-but-undefined would be a different hash — callers pass the
// fields object, never the whole row).
export function eventId(p: EventPayload): string {
	const { author, seq, prev, project, entity, refs, lc, ts, type, body, cost, cap, sig } = p;
	const payload: Record<string, unknown> = { author, seq, prev, project, entity, refs, lc, ts, type, body };
	// Null ≡ absent for envelope optionals (both mean "unsigned" /
	// "uncapped"): seed paths omit the key, hub paths set null, and the
	// hash must not depend on which construction style was used.
	// (Nested nulls INSIDE body are content and stay hashed.)
	if (cost !== undefined && cost !== null) payload.cost = cost;
	if (cap !== undefined && cap !== null) payload.cap = cap;
	if (sig !== undefined && sig !== null) payload.sig = sig;
	const bytes = Buffer.from(canonicalize(payload), "utf8");
	const digest = createHash("sha256").update(bytes).digest();
	const cid = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
	return "b" + base32(cid);
}

// Recompute-and-compare: the self-verification primitive bi#41 builds on.
export function verifyEventId(e: EventPayload & { id: string }): boolean {
	const { id, ...payload } = e;
	try {
		return eventId(payload) === id;
	} catch {
		return false;
	}
}
