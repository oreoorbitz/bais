// bais/scripts/contract-test.mjs — bi#84 consumer contract tests.
//
// bi/bagl consume bais through generated dist (`file://` interop until
// Phase-B workspace deps). This script pins every surface consumers
// import, against dist, with EXACT shapes: any additive change updates
// this file explicitly; any breaking change fails here before it fails
// in bi. Run: node scripts/contract-test.mjs (offline, tmp dirs, plain
// node). Exits non-zero on any failure. Fully in-process: node:sqlite +
// direct imports from bais/dist/src/*.js, no sockets, no loopback, no
// child processes. All state lives under mkdtemp dirs — real .bais dirs
// are never touched. Mirrors fault-drills.mjs imports.
//
// Pinned surfaces:
//   storeOversight() return (incl. rejected_events columns/order),
//   appendForeignEvents() result shape,
//   ensureSchema() table set,
//   ingestIssues() return.
//
// Consumers name the contract version they last verified against:
// bi/bagl record CONTRACT_VERSION below.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, appendForeignEvents, encodeBodyArrays } from "../dist/src/hub.js";
import { eventId } from "../dist/src/ids.js";
import { ingestIssues, ensureSchema, storeOversight } from "../dist/src/store.js";
void createHub; // imported to pin the hub surface; never called (binds a port).

export const CONTRACT_VERSION = "bais-contract@1";

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
// EXACT key order (insertion order is part of the contract: consumers
// destructure / spread in order, and reordered SELECT columns break them).
const checkKeysExact = (obj, expected, label) => {
	const got = Object.keys(obj);
	check(JSON.stringify(got) === JSON.stringify(expected),
		`${label} keys exactly [${expected.join(",")}] (got [${got.join(",")}])`);
};
const checkKeysSorted = (obj, expected, label) => {
	const got = [...Object.keys(obj)].sort();
	const want = [...expected].sort();
	check(JSON.stringify(got) === JSON.stringify(want),
		`${label} key set {${want.join(",")}} (got {${got.join(",")}})`);
};

const toml = (id, title, status = "Open") =>
	`id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "Feat"\nbody = "contract fixture"\n`;
const mkTree = (tag) => {
	const root = mkdtempSync(join(tmpdir(), `bais-contract-${tag}-`));
	const issues = join(root, ".bais", "issues");
	mkdirSync(issues, { recursive: true });
	return { root, issues };
};
// Event ids are content hashes: eventId() over encodeBodyArrays() bodies
// (dev-style ids are dead by policy — store drops them on merge).
const mkForeign = (o) => {
	const body = encodeBodyArrays(o.body ?? {});
	const base = {
		author: o.author, seq: o.seq, prev: o.prev ?? null, project: o.project ?? "g",
		entity: o.entity, refs: o.refs ?? [], lc: o.lc, ts: o.ts ?? "2026-09-04T00:00:00.000Z",
		type: o.type, body,
	};
	const id = eventId(base);
	return { ...base, id, sig: null, admitted: true, drop_reason: null };
};

// ---------------------------------------------------------------- version
check(typeof CONTRACT_VERSION === "string" && /^bais-contract@\d+$/.test(CONTRACT_VERSION),
	`contract version pinned (${CONTRACT_VERSION})`);
for (const [name, fn] of Object.entries({ ingestIssues, ensureSchema, storeOversight, appendForeignEvents, encodeBodyArrays, eventId })) {
	check(typeof fn === "function", `dist exports ${name}()`);
}

// ---------------------------------------------------------------- ensureSchema table set
{
	const db = new DatabaseSync(":memory:");
	ensureSchema(db);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all().map((r) => r.name);
	const EXPECTED_TABLES = ["budgets", "caps", "checkpoints", "conflicts", "events", "excluded",
		"failures", "leases", "meta", "rejected_evidence", "rels", "submissions", "tasks", "verifies"];
	check(JSON.stringify(tables) === JSON.stringify(EXPECTED_TABLES),
		`ensureSchema table set exactly (${tables.length} tables)`);
	const eventCols = new Set(db.prepare("PRAGMA table_info(events)").all().map((c) => c.name));
	check(eventCols.has("sig"), "ensureSchema migrates events.sig onto live tables");
	const leaseCols = new Set(db.prepare("PRAGMA table_info(leases)").all().map((c) => c.name));
	check(leaseCols.has("expires_lc"), "ensureSchema migrates leases.expires_lc onto live tables");
	db.close();
}

// ---------------------------------------------------------------- ingestIssues return
{
	const t = mkTree("ingest");
	writeFileSync(join(t.issues, "a.toml"), toml("a", "alpha"));
	writeFileSync(join(t.issues, "b.toml"), toml("b", "beta", "Done"));
	const ing = await ingestIssues(t.issues);
	checkKeysExact(ing, ["events", "failures"], "ingestIssues()");
	check(typeof ing.events === "number" && typeof ing.failures === "number",
		`ingestIssues() values are numbers (events=${ing.events}, failures=${ing.failures})`);
	check(ing.events === 3 && ing.failures === 0,
		`ingestIssues() exact counts for the 2-file fixture (2 creates + 1 transition = 3 events, 0 failures)`);
}

// ---------------------------------------------------------------- appendForeignEvents result shape
{
	const t = mkTree("append");
	writeFileSync(join(t.issues, "a.toml"), toml("a", "alpha"));
	await ingestIssues(t.issues);
	const ev1 = mkForeign({
		author: "did:key:contract-1", seq: 0, entity: "task:contract-1",
		lc: 9100, type: "TaskCreate", body: { title: "one", kind: "Feat", body: "x" },
	});
	const r1 = await appendForeignEvents(t.issues, [ev1]);
	checkKeysExact(r1, ["accepted", "rejected"], "appendForeignEvents() result");
	check(Array.isArray(r1.accepted) && Array.isArray(r1.rejected), "appendForeignEvents() accepted/rejected are arrays");
	check(r1.accepted.length === 1 && r1.accepted[0] === ev1.id && r1.rejected.length === 0,
		"appendForeignEvents() admits the fresh event (accepted=[id], rejected=[])");
	// Same author+seq under a new id is a fork: named rejection, exact entry shape.
	const ev2 = mkForeign({
		author: "did:key:contract-1", seq: 0, entity: "task:contract-2",
		lc: 9101, type: "TaskCreate", body: { title: "two", kind: "Feat", body: "x" },
	});
	const r2 = await appendForeignEvents(t.issues, [ev2]);
	check(r2.accepted.length === 0 && r2.rejected.length === 1, "appendForeignEvents() fork admits nothing, rejects one");
	checkKeysExact(r2.rejected[0], ["id", "reason"], "appendForeignEvents() rejected entry");
	check(r2.rejected[0].id === ev2.id && r2.rejected[0].reason === "chain-break",
		`appendForeignEvents() fork reason is chain-break (got ${JSON.stringify(r2.rejected)})`);

	// ------------------------------------------------- storeOversight() return
	// Second rejection at a higher lc pins the rejected_events ordering.
	const ev3 = mkForeign({
		author: "did:key:contract-2", seq: 0, entity: "task:contract-3",
		lc: 9102, type: "TaskCreate", body: { title: "three", kind: "Feat", body: "x" },
	});
	await appendForeignEvents(t.issues, [ev3]);
	const ev4 = mkForeign({
		author: "did:key:contract-2", seq: 0, entity: "task:contract-4",
		lc: 9103, type: "TaskCreate", body: { title: "four", kind: "Feat", body: "x" },
	});
	await appendForeignEvents(t.issues, [ev4]);
	const ov = storeOversight(t.issues);
	checkKeysExact(ov, ["conflicts", "budget_overruns", "unverified_submits", "stalled_leases",
		"caps_over_budget", "rejected_events", "as_of", "completeness"], "storeOversight()");
	for (const feed of ["conflicts", "budget_overruns", "unverified_submits", "stalled_leases", "caps_over_budget", "rejected_events"]) {
		check(Array.isArray(ov[feed]), `storeOversight().${feed} is an array (${ov[feed].length} rows)`);
	}
	checkKeysExact(ov.as_of, ["heads", "lc", "wall_ts"], "storeOversight().as_of");
	check(Array.isArray(ov.as_of.heads) && typeof ov.as_of.lc === "number" && typeof ov.as_of.wall_ts === "string",
		"storeOversight().as_of value types (heads[], lc number, wall_ts string)");
	check(ov.completeness === "complete" || ov.completeness === "partial",
		`storeOversight().completeness is an enum (${ov.completeness})`);
	// Element shapes where the fixture populates them; guarded shape
	// assertions elsewhere so empty feeds still pin their contract.
	for (const c of ov.conflicts) checkKeysExact(c, ["entity", "field", "options", "winner", "event_ids", "at_lc"], "storeOversight().conflicts[]");
	for (const b of ov.budget_overruns) checkKeysExact(b, ["principal", "cap", "incurred"], "storeOversight().budget_overruns[]");
	for (const s of ov.unverified_submits) checkKeysExact(s, ["submit_id", "task", "producer", "status"], "storeOversight().unverified_submits[]");
	for (const l of ov.stalled_leases) checkKeysExact(l, ["id", "task", "holder", "epoch", "expires_lc"], "storeOversight().stalled_leases[]");
	for (const c of ov.caps_over_budget) checkKeysExact(c, ["grant_id", "audience", "budget_cap_usd", "incurred"], "storeOversight().caps_over_budget[]");
	// rejected_events: exact columns AND lc-DESC order — the consumer contract.
	check(ov.rejected_events.length === 2, `storeOversight().rejected_events holds both rejections (${ov.rejected_events.length})`);
	for (const r of ov.rejected_events) checkKeysExact(r, ["id", "author", "type", "reason", "lc"], "storeOversight().rejected_events[]");
	if (ov.rejected_events.length === 2) {
		const [hi, lo] = ov.rejected_events;
		check(hi.lc > lo.lc, `storeOversight().rejected_events ordered lc DESC (${hi.lc} before ${lo.lc})`);
		check(hi.id === ev4.id && lo.id === ev2.id, "storeOversight().rejected_events carries the fork ids in order");
		check(typeof hi.author === "string" && typeof hi.type === "string" && typeof hi.reason === "string" && typeof hi.lc === "number",
			"storeOversight().rejected_events[] value types (id/author/type/reason strings, lc number)");
	}
}

console.log(failures === 0 ? `contract ${CONTRACT_VERSION}: all green` : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
