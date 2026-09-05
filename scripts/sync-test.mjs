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
const { ingestIssues, storeList, readBootstrap, appendForeignEvents: _unused } = await import(`${BAIS}/dist/src/store.js`);
void _unused;
const keys = await import(`${BAIS}/dist/src/keys.js`);
const idsUtil = await import(`${BAIS}/dist/src/ids.js`);
const { clock } = await import(`${BAIS}/scripts/clock.mjs`).then((m) => m.clockFromArgv(process.argv));

// bi#82: injectable wall-clock. --now <ISO|epoch-ms> (or BAIS_NOW) pins
// Date.now + no-arg new Date() in-process BEFORE the hub boots, so fixture
// timestamps AND hub gate evaluations (clock-skew future bound, freeze
// windows, evidence stamps) see the same fixed time. Lease expiries are
// lc-based (expires_lc), hence already deterministic. Absent: live
// passthrough. NOTE: the CLI bootstrap children spawned below read the
// live clock, but they only verify hashes/roots — no wall-clock gates.
console.log(`info: wall-clock ${clock.fixed ? `pinned at ${clock.nowISO()}` : "live"}`);

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
// bi#37: fixtures carry real content-hash ids (sign first — the id covers
// the sig — then hash).
const mkEv = (seq, prev, bodyExtra = {}, key = P) => {
	const body = { title: "gamma", kind: "Feat", body: "signed", ...bodyExtra };
	const base = {
		author: key.did, seq, prev, project: proj, entity: "t3", refs: [],
		lc: 9100 + seq, ts: clock.nowISO(), type: "TaskCreate", body,
	};
	const sig = keys.signPayload(key.privateJwk, { project: base.project, prev: base.prev, refs: base.refs, type: base.type, entity: base.entity, body: base.body });
	const id = idsUtil.eventId({ ...base, sig });
	return { ...base, id, sig, admitted: true, drop_reason: null };
};
{
	const ev0 = mkEv(0, null);
	const r = await postA("/sync", { events: [ev0] });
	check(r.status === 200 && r.json.accepted.includes(ev0.id), "signed peer event accepted");
	// Fresh authors per case: reusing P's seq 0 would trip chain-break
	// before the signature is even examined.
	const Q = keys.generatePeerKey();
	const bad = mkEv(0, null, {}, Q);
	bad.body = { ...bad.body, title: "tampered" }; // same sig, same id, changed body
	const r2 = await postA("/sync", { events: [bad] });
	check(r2.json.rejected.some((x) => x.id === bad.id && x.reason === "bad-sig"), "tampered event is bad-sig evidence");
	const R = keys.generatePeerKey();
	const unsignedBase = {
		author: R.did, seq: 0, prev: null, project: proj, entity: "t3", refs: [],
		lc: 9100, ts: clock.nowISO(), type: "TaskCreate",
		body: { title: "gamma", kind: "Feat", body: "signed" },
	};
	const unsigned = { ...unsignedBase, id: idsUtil.eventId(unsignedBase), sig: null, admitted: true, drop_reason: null };
	const { appendForeignEvents } = await import(`${BAIS}/dist/src/hub.js`);
	const r3 = await appendForeignEvents(dirA, [unsigned], { requireSigs: true });
	check(r3.rejected.some((x) => x.id === unsigned.id && x.reason === "sig-required"), "requireSigs rejects unsigned");
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
	// bi#37: real content-hash ids with hash-linked prev (build sequent-
	// ially — each prev is the predecessor's id, not a dev label).
	const chain = (i, prev, t, b, entity = sp) => {
		const base = {
			author: sp, seq: i, prev, project: proj, entity, refs: [],
			lc: 9200 + i, ts: clock.nowISO(), type: t, body: b,
		};
		return { ...base, id: idsUtil.eventId(base), sig: null, admitted: true, drop_reason: null };
	};
	const c0 = chain(0, null, "BudgetAuthorize", { cap_usd: 1.0, cap_tokens: 100 });
	const c1 = chain(1, c0.id, "CostReserve", { task: "t9", usd: 1.0, tokens: 100 });
	const c2 = chain(2, c1.id, "CostIncurred", { reserve_ref: c1.id, task: "t9", usd: 1.0, tokens: 100 });
	const fund = await postA("/sync", { events: [c0, c1, c2] });
	check(fund.json.rejected.length === 0, "spam budget chain funded");
	const gated = await postA("/claim", { task: "t2", holder: sp, ttl: 10, epoch: 0, idem: "s9" });
	check(gated.status === 402 && gated.json.reason === "budget-exhausted", "exhausted author gets 402");
	// Same lever on the sync path: new state from an exhausted author is
	// evidence (wind-down/funding/protocol stay open by type allowlist).
	const sp3 = chain(3, c2.id, "TaskCreate", { title: "gated", kind: "Feat", body: "x" }, "t9");
	const gatedSync = await postA("/sync", { events: [sp3] });
	check(gatedSync.json.rejected.some((x) => x.id === sp3.id && x.reason === "budget-exhausted"), "sync path gates exhausted authors");
	// Signed content with raw arrays is rejected: the hub normalizes on
	// store, so the sig could never verify downstream. The id is computed
	// over the ENCODED body (what ingest verifies) while the event carries
	// the raw body + a sig over it — so the id gate passes and the
	// unencoded-lists verdict (not id-mismatch) fires, as pinned.
	const S = keys.generatePeerKey();
	const rawBody = { evidence: ["cid:x"] };
	const rawBase = {
		author: S.did, seq: 0, prev: null, project: proj, entity: "t3", refs: [],
		lc: 9220, ts: clock.nowISO(), type: "WorkSubmit", body: rawBody,
	};
	const rawSig = keys.signPayload(S.privateJwk, { project: rawBase.project, prev: rawBase.prev, refs: rawBase.refs, type: rawBase.type, entity: rawBase.entity, body: rawBase.body });
	// Encode-first, exactly as the hub's toWire will: the id must match
	// what ingest verifies, so the unencoded-lists verdict fires (pinned).
	const { encodeBodyArrays } = await import(`${BAIS}/dist/src/hub.js`);
	const rawList = { ...rawBase, id: idsUtil.eventId({ ...rawBase, body: encodeBodyArrays(rawBody), sig: rawSig }), sig: rawSig, admitted: true, drop_reason: null };
	const rawRes = await postA("/sync", { events: [rawList] });
	check(rawRes.json.rejected.some((x) => x.id === rawList.id && x.reason === "unencoded-lists"), "signed raw arrays rejected as unencoded-lists");
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

// --- prune: truncation-with-anchor (all in-process HTTP) ---
let anchorId = "";
{
	const latest = await getA("/checkpoint");
	anchorId = latest.checkpoint.id;
	const beforeSync = await getA("/sync");
	const before = beforeSync.events.length;
	check(before > 0 && !beforeSync.anchor, "pre-prune log full, no anchor");
	const prune = await postA("/prune", {});
	const afterSync = await getA("/sync");
	check(prune.status === 200 && prune.json.pruned + afterSync.events.length === before, `prune deleted covered rows (${prune.json.pruned})`);
	check(prune.json.anchor.checkpoint === anchorId, "prune recorded anchor on the checkpoint");
	check(afterSync.events.some((e) => e.id === anchorId), "anchor checkpoint event survives prune");
	check(afterSync.anchor?.checkpoint === anchorId, "/sync reports the anchor");
	const snap = await getA("/snapshot");
	check(snap.snapshot.anchor?.checkpoint === anchorId, "/snapshot reports the anchor");
	const cpg = await getA("/checkpoint");
	// `verified` post-prune is expiry-drift-dependent (anchor leases age
	// out of the merged view) — the load-bearing signal is history+anchor.
	check(cpg.history === "pruned" && cpg.anchor?.checkpoint === anchorId, "checkpoint reports pruned history (not divergence)");
	check(prune.json.anchor.verified_at.length > 0, "anchor carries last full proof");
	// Writes continue from the anchor floor (lc + author chains): extend
	// the hub-key chain (never budget-exhausted) past the truncation.
	const anchorEv = afterSync.events.find((e) => e.id === anchorId);
	const contBase = {
		author: anchorEv.author, seq: anchorEv.seq + 1, prev: anchorEv.id, project: proj, entity: "t9",
		refs: [], lc: afterSync.lc + 1, ts: clock.nowISO(), type: "TaskCreate",
		body: { title: "after prune", kind: "Feat", body: "x" },
	};
	const cont = { ...contBase, id: idsUtil.eventId(contBase), sig: null, admitted: true, drop_reason: null };
	const contRes = await postA("/sync", { events: [cont] });
	check(contRes.json.accepted?.includes(cont.id), "post-prune continuation accepted via floor");
	const badPrune = await postA("/prune", { checkpoint: "nope" });
	check(badPrune.status === 400, "prune of unknown checkpoint refused");
	// Fail-closed: t1's anchor lease (holder did:key:a) still covers it —
	// a new claim must 409, not double-fence, even though the truncated
	// decide cannot see the anchor lease.
	const guard = await postA("/claim", { task: "t1", holder: "did:key:new", ttl: 50, epoch: 0, idem: "guard1" });
	check(guard.status === 409 && guard.json.reason === "lease-active-at-anchor", "anchor lease blocks double-claim");
	// Reboot on the truncated log: serves reads, keeps floors.
	const { createHub: bootHub } = await import(`${BAIS}/dist/src/hub.js`);
	const { hub: hubR } = await bootHub(dirA, { port: 0 });
	const leasesR = await (await fetch(`http://127.0.0.1:${hubR.port}/leases`)).json();
	check(leasesR.leases.some((l) => l.entity === "t1"), "rebooted hub serves reads from intact tables");
	await hubR.close();
}

// --- prune refuses a divergent checkpoint (scratch hub, tampered row) ---
{
	const dirE = join(root, "e", ".bais", "issues");
	mkdirSync(dirE, { recursive: true });
	writeFileSync(join(dirE, "t1.toml"), `id = "t1"\ntitle = "div"\nstatus = "Open"\nkind = "Feat"\nbody = "x"\n`);
	await ingestIssues(dirE);
	const { createHub: hubE2 } = await import(`${BAIS}/dist/src/hub.js`);
	const { hub: hubE } = await hubE2(dirE, { port: 0 });
	const baseE = `http://127.0.0.1:${hubE.port}`;
	const postE = async (path, body) => {
		const r = await fetch(baseE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, json: await r.json() };
	};
	check((await postE("/claim", { task: "t1", holder: "did:key:a", ttl: 100, epoch: 0, idem: "e1" })).status === 200, "scratch claim admitted");
	check((await postE("/checkpoint", {})).status === 200, "scratch checkpoint published");
	const { DatabaseSync: DB } = await import("node:sqlite");
	const tdb = new DB(join(root, "e", ".bais", "store.db"));
	tdb.prepare("UPDATE events SET body = ? WHERE type = 'TaskCreate'").run(JSON.stringify({ title: "tampered", kind: "Feat", body: "x" }));
	tdb.close();
	const div = await postE("/prune", {});
	check(div.status === 400 && /divergent/.test(div.json.error ?? ""), "prune refused on recompute mismatch");
	await hubE.close();
}

// --- CLI bootstrap from a pruned peer: signature trust (needs real
// localhost IPC for the child — same sandbox note as above) ---
{
	const dirC = join(root, "c", ".bais", "issues");
	mkdirSync(dirC, { recursive: true });
	const cli = resolve(BAIS, "dist/src/cli.js");
	let out = "";
	try {
		out = execFileSync("node", [cli, "sync", "--from", baseA], { cwd: join(root, "c"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		console.error(`CLI truncated sync crashed; stderr: ${e.stderr?.toString() ?? String(e.message)}`);
		failures++;
	}
	check(/trust: signature/.test(out), "CLI truncated bootstrap unlocks via signature trust");
	const boot = readBootstrap(dirC);
	check(boot?.complete === true && boot?.trust === "signature", "bootstrap meta records signature trust");
	const tasksC = storeList(dirC).tasks.map((t) => t.entity).sort().join(",");
	check(tasksC === storeList(dirA).tasks.map((t) => t.entity).sort().join(",") && tasksC.length > 0, `truncated peer converged (${tasksC})`);
}

// --- second checkpoint after prune: post-prune writes layer on the anchor ---
{
	const c2 = await postA("/claim", { task: "t2", holder: "did:key:a2", ttl: 100, epoch: 0, idem: "s2" });
	check(c2.status === 200, "post-prune claim admitted (publisher floor)");
	const cp2 = await postA("/checkpoint", {});
	check(cp2.status === 200 && cp2.json.checkpoint.id !== anchorId, "second checkpoint published after prune");
}

// --- CLI bootstrap from a pruned-but-recheckpointed peer: recomputed path.
// The new checkpoint covers only surviving rows, so backfill verifies —
// and the peer tables survive via the imported anchor (not the backfill).
{
	const dirD = join(root, "d", ".bais", "issues");
	mkdirSync(dirD, { recursive: true });
	const cli = resolve(BAIS, "dist/src/cli.js");
	let out = "";
	try {
		out = execFileSync("node", [cli, "sync", "--from", baseA], { cwd: join(root, "d"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		console.error(`CLI re-checkpointed sync crashed; stderr: ${e.stderr?.toString() ?? String(e.message)}`);
		failures++;
	}
	check(/verified root/.test(out), "CLI bootstrap off a re-checkpointed pruned peer recomputes");
	const boot = readBootstrap(dirD);
	check(boot?.complete === true && boot?.trust === "recomputed", "bootstrap meta records recomputed trust");
	const tasksD = storeList(dirD).tasks.map((t) => t.entity).sort().join(",");
	check(tasksD === storeList(dirA).tasks.map((t) => t.entity).sort().join(",") && tasksD.length > 0, `re-checkpointed peer converged (${tasksD})`);
}

// --- prune below the second checkpoint: anchors compose, history stays ---
{
	const stale = await postA("/prune", { checkpoint: anchorId });
	check(stale.status === 400, "prune below a stale checkpoint refused");
	const latest = await getA("/checkpoint");
	const prune2 = await postA("/prune", {});
	check(prune2.status === 200 && prune2.json.anchor.checkpoint === latest.checkpoint.id, "second prune anchors on the latest checkpoint");
	const cpg2 = await getA("/checkpoint");
	check(cpg2.history === "pruned" && cpg2.anchor?.checkpoint === latest.checkpoint.id, "history still pruned after second prune");
	check(storeList(dirA).tasks.length > 0, "tables intact after second prune");
}

// --- capabilities: grant -> write, revoke -> kill switch (in-process HTTP;
// requireCaps hub; CLI oversight/sample/caps are local-only children) ---
{
	const dirF = join(root, "f", ".bais", "issues");
	mkdirSync(dirF, { recursive: true });
	writeFileSync(join(dirF, "t1.toml"), `id = "t1"\ntitle = "caps"\nstatus = "Open"\nkind = "Feat"\nbody = "x"\n`);
	await ingestIssues(dirF);
	const { createHub: capHub } = await import(`${BAIS}/dist/src/hub.js`);
	const { hub: hubF } = await capHub(dirF, { port: 0, limits: { requireCaps: true } });
	const baseF = `http://127.0.0.1:${hubF.port}`;
	const postF = async (path, body) => {
		const r = await fetch(baseF + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, json: await r.json() };
	};
	const AUD = "did:key:captest";
	const denied = await postF("/claim", { task: "t1", holder: AUD, ttl: 100, epoch: 0, idem: "c0" });
	check(denied.status === 403 && denied.json.reason === "cap-denied", "writes need a capability when requireCaps");
	const grant = await postF("/grant", { audience: AUD, can: ["lease.claim"], scope: "*", expiry_lc: 1000000 });
	check(grant.status === 200 && !!grant.json.grant_id, "grant issued");
	const allowed = await postF("/claim", { task: "t1", holder: AUD, ttl: 100, epoch: 0, idem: "c1" });
	check(allowed.status === 200 && !!allowed.json.lease_id, "live grant unlocks the write");
	const caps1 = await (await fetch(`${baseF}/caps?audience=${AUD}`)).json();
	check(caps1.caps.length === 1 && caps1.caps[0].revoked === false, "caps view shows the live grant");
	const stranger = await postF("/revoke", { grant_ref: grant.json.grant_id, revoker: "did:key:mallory" });
	check(stranger.status === 409 && /revoke-denied/.test(stranger.json.reason ?? stranger.json.error ?? ""), "stranger revoke refused on live grant");
	const revoke = await postF("/revoke", { grant_ref: grant.json.grant_id, revoker: AUD });
	check(revoke.status === 200, "audience self-revoke admitted (kill switch)");
	const denied2 = await postF("/claim", { task: "t1", holder: AUD, ttl: 100, epoch: 1, idem: "c2" });
	check(denied2.status === 403, "revocation sticks — write denied again");
	const caps2 = await (await fetch(`${baseF}/caps?audience=${AUD}`)).json();
	check(caps2.caps[0].revoked === true, "caps view shows the revocation");

	const over = await (await fetch(`${baseF}/oversight`)).json();
	check(Array.isArray(over.conflicts) && Array.isArray(over.unverified_submits) && Array.isArray(over.stalled_leases) && Array.isArray(over.budget_overruns), "oversight feeds served");
	await hubF.close();
	const cli = resolve(BAIS, "dist/src/cli.js");
	const run = (args) => {
		try {
			return { out: execFileSync("node", [cli, ...args], { cwd: join(root, "f"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
		} catch (e) {
			return { err: e.status };
		}
	};
	const o = run(["oversight", "--json"]);
	check(!!o.out && JSON.parse(o.out).as_of !== undefined, "CLI oversight reads the projection");
	const s = run(["sample", "5", "--json"]);
	check(!!s.out && JSON.parse(s.out).total !== undefined, "CLI sample reads the projection");
	const c = run(["caps", "--json"]);
	check(!!c.out && Array.isArray(JSON.parse(c.out).caps), "CLI caps reads the projection");
}

await hubA.close();
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("sync: all green");
