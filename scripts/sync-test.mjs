// bais/scripts/sync-test.mjs — Phase 4 steps 12–14 validation: keys,
// checkpoint verify, signed replication, ephemeral split, bounds, and a
// real `bais sync --from` bootstrap with cryptographic backfill verify.
// Run: npm run build --prefix bais && npm test --prefix bais
// (package.json "test" runs lease-race.mjs then this).
// NOTE: the CLI bootstrap step spawns `bais sync --from` as a child process
// that fetches the test hub over localhost. Sandboxed runners that block
// grandchild loopback IPC will stall there — run hub + CLI as sibling
// processes instead (verified manually 2026-09-03: import + backfill +
// delta + root verify + unlock, peers converged, want/have empty).

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const BAIS = "/Users/adrian/code/orion/orion-learn-baml/bais";
const { createHub } = await import(`${BAIS}/dist/src/hub.js`);
const { ingestIssues, storeList, appendForeignEvents: _unused } = await import(`${BAIS}/dist/src/store.js`);
void _unused;
const keys = await import(`${BAIS}/dist/src/keys.js`);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
process.on("unhandledRejection", (e) => console.error(`UNHANDLED REJECTION: ${(e && e.message) || e}`));
process.on("uncaughtException", (e) => console.error(`UNCAUGHT: ${(e && e.message) || e}`));

// --- keys unit: base58, did:key, sign/verify, chain ---
{
	const raw = new Uint8Array([0, 0, 1, 2, 3, 250]);
	const rt = keys.base58Decode(keys.base58Encode(raw));
	check(rt.length === raw.length && rt.every((b, i) => b === raw[i]), "base58 round-trips incl leading zeros");
	const k = keys.generatePeerKey();
	check(k.did.startsWith("did:key:z"), "did:key shape");
	const back = keys.pubkeyFromDid(k.did);
	const k2 = keys.generatePeerKey();
	check(keys.verifyPayload(k.did, { a: 1 }, keys.signPayload(k.privateJwk, { a: 1 })), "sign verifies");
	check(!keys.verifyPayload(k.did, { a: 2 }, keys.signPayload(k.privateJwk, { a: 1 })), "tampered payload fails");
	check(!keys.verifyPayload(k2.did, { a: 1 }, keys.signPayload(k.privateJwk, { a: 1 })), "wrong key fails");
	check(keys.canonicalize({ b: 1, a: [3, 2] }) === '{"a":[3,2],"b":1}', "canonical key order");
	const ev = (id, author, seq, prev) => ({
		id, author, seq, prev, project: "p", refs: [], type: "Heartbeat", entity: "t", body: {}, sig: null,
	});
	check(keys.verifyChain([ev("a", "x", 0, null), ev("b", "x", 1, "a")]).length === 0, "clean chain passes");
	check(keys.verifyChain([ev("a", "x", 0, null), ev("b", "x", 2, "a")]).length > 0, "seq gap breaks");
	check(keys.verifyChain([ev("a", "x", 1, null)]).length > 0, "nonzero genesis breaks");
}

// --- fixtures: hub A (2 tasks), peer B dir (empty) ---
const root = mkdtempSync(join(tmpdir(), "bais-sync-"));
const dirA = join(root, "a", ".bais", "issues");
const dirB = join(root, "b", ".bais", "issues");
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });
const toml = (id, title) => `id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "Feat"\nbody = "sync fixture"\n`;
writeFileSync(join(dirA, "t1.toml"), toml("t1", "alpha"));
writeFileSync(join(dirA, "t2.toml"), toml("t2", "beta"));
await ingestIssues(dirA);
const { hub: hubA } = await createHub(dirA, { port: 0 });
const baseA = `http://127.0.0.1:${hubA.port}`;
const postA = async (path, body) => {
	const r = await fetch(baseA + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, json: await r.json() };
};
const getA = async (path) => await (await fetch(baseA + path)).json();

// --- claim + checkpoint + verify ---
const claim = await postA("/claim", { task: "t1", holder: "did:key:a", ttl: 100000, epoch: 0, idem: "s1" });
check(claim.status === 200, "A claim admitted");
const cp = await postA("/checkpoint", {});
check(cp.status === 200 && cp.json.checkpoint.state_root.length === 64, "checkpoint published with root");
const got = await getA("/checkpoint");
check(got.verified === true, "checkpoint verifies on recompute");

// --- digest matches local recompute (Negentropy shape) ---
{
	const full = await getA("/sync");
	const ids = full.events.map((e) => e.id).sort();
	const want = createHash("sha256").update(ids.join(","), "utf8").digest("hex");
	const d = await getA("/sync/digest");
	check(d.digest === want && d.count === ids.length, "digest matches id set");
	check(full.cursors.length > 0 && full.cursors.every((c) => c.author && c.id), "cursors report heads");
}

// --- signed replication: accept, tamper-evidence, requireSigs ---
const P = keys.generatePeerKey();
const proj = (await getA("/sync")).events[0].project;
const mkEv = (id, seq, prev, bodyExtra = {}) => {
	const e = {
		id, author: P.did, seq, prev, project: proj, entity: "t3", refs: [],
		lc: 9100 + seq, ts: new Date().toISOString(), type: "TaskCreate",
		body: { title: "gamma", kind: "Feat", body: "signed", ...bodyExtra },
		sig: null, admitted: true, drop_reason: null,
	};
	e.sig = keys.signPayload(P.privateJwk, { project: e.project, prev: e.prev, refs: e.refs, type: e.type, entity: e.entity, body: e.body });
	return e;
};
{
	const r = await postA("/sync", { events: [mkEv("sync-t3", 0, null)] });
	check(r.status === 200 && r.json.accepted.includes("sync-t3"), "signed peer event accepted");
	// Fresh authors per case: reusing P's seq 0 would trip chain-break
	// before the signature is even examined.
	const Q = keys.generatePeerKey();
	const qev = (id) => {
		const e = mkEv(id, 0, null);
		e.author = Q.did;
		e.sig = keys.signPayload(Q.privateJwk, { project: e.project, prev: e.prev, refs: e.refs, type: e.type, entity: e.entity, body: e.body });
		return e;
	};
	const bad = qev("sync-t3-bad");
	bad.body = { ...bad.body, title: "tampered" }; // same sig, changed body
	const r2 = await postA("/sync", { events: [bad] });
	check(r2.json.rejected.some((x) => x.id === "sync-t3-bad" && x.reason === "bad-sig"), "tampered event is bad-sig evidence");
	const R = keys.generatePeerKey();
	const unsigned = mkEv("sync-nous", 0, null);
	unsigned.author = R.did;
	unsigned.sig = null;
	const { appendForeignEvents } = await import(`${BAIS}/dist/src/hub.js`);
	const r3 = await appendForeignEvents(dirA, [unsigned], { requireSigs: true });
	check(r3.rejected.some((x) => x.id === "sync-nous" && x.reason === "sig-required"), "requireSigs rejects unsigned");
}

// --- ephemeral split: buffered, streamed, never persisted ---
{
	const before = (await getA("/sync")).events.length;
	const p = await postA("/pub", { type: "Heartbeat", entity: "t1", body: { note: "alive" } });
	check(p.status === 200, "ephemeral pub accepted");
	const buf = await getA("/pub?since=-1");
	check(buf.events.some((m) => m.type === "Heartbeat"), "pub buffered in memory");
	const after = (await getA("/sync")).events.length;
	check(after === before, "ephemeral never touches the log");
	const no = await postA("/pub", { type: "TaskCreate", body: {} });
	check(no.status === 400, "durable type refused on /pub");
}

// --- bounds: 413 over-size, 402 budget-exhausted ---
{
	const big = await postA("/claim", { task: "t2", holder: "did:key:big", ttl: 10, epoch: 0, idem: "x".repeat(300000) });
	check(big.status === 413, "oversize write is 413");
	const sp = "did:key:spammer";
	const chain = (i, t, b) => ({ id: `sp-${i}`, author: sp, seq: i, prev: i === 0 ? null : `sp-${i - 1}`, project: proj, entity: sp, refs: [], lc: 9200 + i, ts: new Date().toISOString(), type: t, body: b, sig: null, admitted: true, drop_reason: null });
	const fund = await postA("/sync", {
		events: [
			chain(0, "BudgetAuthorize", { cap_usd: 1.0, cap_tokens: 100 }),
			chain(1, "CostReserve", { task: "t9", usd: 1.0, tokens: 100 }),
			chain(2, "CostIncurred", { reserve_ref: "sp-1", task: "t9", usd: 1.0, tokens: 100 }),
		],
	});
	check(fund.json.rejected.length === 0, "spam budget chain funded");
	const gated = await postA("/claim", { task: "t2", holder: sp, ttl: 10, epoch: 0, idem: "s9" });
	check(gated.status === 402 && gated.json.reason === "budget-exhausted", "exhausted author gets 402");
	// Same lever on the sync path: new state from an exhausted author is
	// evidence (wind-down/funding/protocol stay open by type allowlist).
	const gatedSync = await postA("/sync", {
		events: [{ id: "sp-3", author: sp, seq: 3, prev: "sp-2", project: proj, entity: "t9", refs: [], lc: 9210, ts: new Date().toISOString(), type: "TaskCreate", body: { title: "gated", kind: "Feat", body: "x" }, sig: null, admitted: true, drop_reason: null }],
	});
	check(gatedSync.json.rejected.some((x) => x.id === "sp-3" && x.reason === "budget-exhausted"), "sync path gates exhausted authors");
	// Signed content with raw arrays is rejected: the hub normalizes on
	// store, so the sig could never verify downstream.
	const S = keys.generatePeerKey();
	const rawList = { id: "sync-raw", author: S.did, seq: 0, prev: null, project: proj, entity: "t3", refs: [], lc: 9220, ts: new Date().toISOString(), type: "WorkSubmit", body: { evidence: ["cid:x"] }, sig: null, admitted: true, drop_reason: null };
	rawList.sig = keys.signPayload(S.privateJwk, { project: rawList.project, prev: rawList.prev, refs: rawList.refs, type: rawList.type, entity: rawList.entity, body: rawList.body });
	const rawRes = await postA("/sync", { events: [rawList] });
	check(rawRes.json.rejected.some((x) => x.id === "sync-raw" && x.reason === "unencoded-lists"), "signed raw arrays rejected as unencoded-lists");
}

// --- real CLI bootstrap: snapshot + backfill-verify + delta ---
{
	const cli = resolve(BAIS, "dist/src/cli.js");
	try {
		await fetch(`${baseA}/leases`);
		console.log("ok: hub A reachable before CLI sync");
	} catch (e) {
		failures++;
		console.error(`FAIL: hub A unreachable before CLI sync: ${e.cause?.code ?? e.message}`);
	}
	let out = "";
	let errText = "";
	try {
		out = execFileSync("node", [cli, "sync", "--from", baseA], { cwd: join(root, "b"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		errText = e.stderr?.toString() ?? String(e.message);
		console.error(`CLI sync crashed; stderr: ${errText}`);
		failures++;
	}
	check(/writes unlocked/.test(out), "CLI sync verifies root and unlocks");
	const { createHub: hub2 } = await import(`${BAIS}/dist/src/hub.js`);
	const { hub: hubB } = await hub2(dirB, { port: 0 });
	const baseB = `http://127.0.0.1:${hubB.port}`;
	const tasksA = storeList(dirA).tasks.map((t) => t.entity).sort().join(",");
	const { storeList: listB } = await import(`${BAIS}/dist/src/store.js`);
	const tasksB = listB(dirB).tasks.map((t) => t.entity).sort().join(",");
	check(tasksA === tasksB && tasksA.length > 0, `peers converged (${tasksA})`);
	const c2 = await (await fetch(`${baseB}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "t2", holder: "did:key:bnew", ttl: 100, epoch: 0, idem: "nb" }) })).json();
	check(!!c2.lease_id, "bootstrapped peer writes (unlocked)");
	const leasesB = await (await fetch(`${baseB}/leases`)).json();
	check(leasesB.leases.some((l) => l.entity === "t1"), "A's lease replicated to B");
	// want/have: B already has everything A has.
	const idsB = (await (await fetch(`${baseB}/sync`)).json()).events.map((e) => e.id);
	const neg = await (await fetch(`${baseA}/sync?have=${idsB.join(",")}`)).json();
	check(neg.events.length === 0, "have-negotiation returns empty when converged");
	await hubB.close();
}

await hubA.close();
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("sync: all green");
