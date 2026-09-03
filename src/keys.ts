// bais/src/keys.ts — peer identity + event signing (fusion Phase 4).
//
// No new dependencies: ed25519 via node:crypto, did:key (base58btc,
// multicodec 0xed01) hand-rolled, canonicalization as JCS-lite (sorted
// keys, no whitespace; full RFC 8785 number normalization deferred —
// single-impl JS is deterministic, cross-impl floats may differ).
//
// Envelope rule (envelope.baml): the host signs; `sig` is null only
// pre-signing. Covered payload is project + prev + refs + body (report §5)
// PLUS type + entity: without them a signed body replays across tasks and
// types. Documented in SPEC §5 as a v1 clarification, not a deviation in
// spirit (same anti-replay goal, strictly stronger).

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createHash, createPrivateKey, createPublicKey } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
	const hex = Buffer.from(bytes).toString("hex");
	let n = hex === "" ? 0n : BigInt("0x" + hex);
	let out = "";
	while (n > 0n) {
		out = B58[Number(n % 58n)] + out;
		n = n / 58n;
	}
	for (const b of bytes) {
		if (b !== 0) break;
		out = "1" + out;
	}
	return out;
}

export function base58Decode(s: string): Uint8Array {
	let n = 0n;
	for (const ch of s) {
		const i = B58.indexOf(ch);
		if (i === -1) throw new Error("bad base58");
		n = n * 58n + BigInt(i);
	}
	let zeros = 0;
	for (const ch of s) {
		if (ch !== "1") break;
		zeros++;
	}
	let body = new Uint8Array(0);
	if (n !== 0n) {
		let hex = n.toString(16);
		if (hex.length % 2) hex = "0" + hex;
		body = new Uint8Array(Buffer.from(hex, "hex"));
	}
	const out = new Uint8Array(zeros + body.length);
	out.set(body, zeros);
	return out;
}

// did:key for an ed25519 raw public key (multicodec 0xed01, base58btc multibase).
export function didFromPubkey(raw: Uint8Array): string {
	const prefixed = new Uint8Array(2 + raw.length);
	prefixed[0] = 0xed;
	prefixed[1] = 0x01;
	prefixed.set(raw, 2);
	return "did:key:z" + base58Encode(prefixed);
}

export function pubkeyFromDid(did: string): Uint8Array {
	if (!did.startsWith("did:key:z")) throw new Error("not an ed25519 did:key");
	const raw = base58Decode(did.slice("did:key:z".length));
	if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an ed25519 did:key");
	return raw.slice(2);
}

export interface PeerKey {
	did: string;
	publicJwk: any;
	privateJwk: any;
}

export function generatePeerKey(): PeerKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const pubJwk = publicKey.export({ format: "jwk" }) as any;
	const privJwk = privateKey.export({ format: "jwk" }) as any;
	const raw = new Uint8Array(Buffer.from(pubJwk.x, "base64url"));
	return { did: didFromPubkey(raw), publicJwk: pubJwk, privateJwk: privJwk };
}

// JCS-lite: sorted keys, compact separators. Values pass through
// JSON.stringify (deterministic within one JS impl).
export function canonicalize(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
	const keys = Object.keys(v as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function sha256Hex(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

// Multibase base58btc signature: `z<base58>`.
export function signPayload(privateJwk: any, payload: unknown): string {
	const key = createPrivateKey({ key: privateJwk, format: "jwk" });
	const sig = cryptoSign(null, Buffer.from(canonicalize(payload), "utf8"), key);
	return "z" + base58Encode(new Uint8Array(sig));
}

export function verifyPayload(did: string, payload: unknown, sig: string): boolean {
	try {
		if (!sig.startsWith("z")) return false;
		const rawPub = pubkeyFromDid(did);
		const key = createPublicKey({
			key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(rawPub).toString("base64url") },
			format: "jwk",
		});
		return cryptoVerify(null, Buffer.from(canonicalize(payload), "utf8"), key, Buffer.from(base58Decode(sig.slice(1))));
	} catch {
		return false;
	}
}

// The signed envelope: exactly what a signature covers.
export function signableOf(e: {
	project: string;
	prev: string | null;
	refs: string[];
	type: string;
	entity: string;
	body: Record<string, unknown>;
}): Record<string, unknown> {
	return { project: e.project, prev: e.prev, refs: e.refs, type: e.type, entity: e.entity, body: e.body };
}

export type ChainBreak = { id: string; reason: string };

// Per-author chain verification: contiguous seq from 0, prev linkage,
// signature when present (null sig = pre-signing, accepted locally).
// Returns breaks; empty means the log is chain-clean.
export function verifyChain(events: { id: string; author: string; seq: number; prev: string | null; sig: string | null; project: string; refs: string[]; type: string; entity: string; body: Record<string, unknown> }[]): ChainBreak[] {
	const breaks: ChainBreak[] = [];
	const byAuthor = new Map<string, typeof events>();
	for (const e of events) {
		const l = byAuthor.get(e.author) ?? [];
		l.push(e);
		byAuthor.set(e.author, l);
	}
	for (const [, list] of byAuthor) {
		list.sort((a, b) => a.seq - b.seq);
		for (let i = 0; i < list.length; i++) {
			const e = list[i];
			if (e.seq !== i) {
				breaks.push({ id: e.id, reason: `seq-gap: want ${i}, got ${e.seq}` });
				continue;
			}
			if (i === 0) {
				if (e.prev !== null) breaks.push({ id: e.id, reason: "genesis-prev" });
			} else if (e.prev !== list[i - 1].id) {
				breaks.push({ id: e.id, reason: "prev-mismatch" });
			}
			if (e.sig !== null && !verifyPayload(e.author, signableOf(e), e.sig)) {
				breaks.push({ id: e.id, reason: "bad-sig" });
			}
		}
	}
	return breaks;
}
