// bais/scripts/ingest-durability.mjs — bi#34: hub history survives ingest.
//
// Run from the repo root: node bais/scripts/ingest-durability.mjs
// (plain node; rebuild dist/ first after src changes:
//  npm run build --prefix bais). Offline; everything in tmp dirs.
// Exits non-zero on any failure.
//
// (a) ingest-под: append exactly 10 events through a live hub (5 claims +
//     5 renews), snapshot the event rows, run ingestIssues, assert all 10
//     survive byte-identical (every events-table column) and the projection
//     (tasks + live leases) is intact.
// (b) snapshot round-trip: publish a checkpoint, exportSnapshot, import into
//     a fresh dir, backfill the log, assert every hub event survives
//     byte-identical and the projections converge with the source.
//
// BAML owns merge/replay policy; this script only drives the compiled host
// (dist/) and compares bytes.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	ingestIssues,
	storeEdges,
	exportSnapshot,
	dbPathFor,
} from "../dist/src/store.js";
import { createHub, publishCheckpoint, appendForeignEvents } from "../dist/src/hub.js";

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Canonical fingerprint of the materialized projection. Wall-clock fields
// (as_of.wall_ts, exported_at, as_of itself) are excluded — they are not
// reducer output. Mirrors reducer-determinism.mjs.
function fingerprint(issuesDir) {
	const snap = exportSnapshot(issuesDir);
	const stable = (v) => {
		if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
		if (v && typeof v === "object") {
			return `{${Object.keys(v)
				.sort()
				.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
				.join(",")}}`;
		}
		return JSON.stringify(v) ?? "null";
	};
	const body = stable({ tasks: snap.tables.tasks, edges: storeEdges(issuesDir), tables: snap.tables });
	return createHash("sha256").update(body, "utf8").digest("hex");
}

function readAllRows(issuesDir) {
	const db = new DatabaseSync(dbPathFor(issuesDir));
	try {
		return db.prepare("SELECT * FROM events ORDER BY lc, id").all();
	} finally {
		db.close();
	}
}

// Seed vs hub is an AUTHOR question, not an id-prefix question: with
// content-hash ids (bi#38) every id is a bafkrei CID, so seed rows are
// the ones authored by did:key:bais-seed.
const hubRows = (rows) => rows.filter((r) => r.author !== "did:key:bais-seed");
const canon = (rows) => JSON.stringify(rows);

const root = mkdtempSync(join(tmpdir(), "bais-durability-"));
const issues = join(root, "a", ".bais", "issues");
mkdirSync(issues, { recursive: true });
const toml = (id, title) => `id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "Feat"\nbody = "durability fixture"\n`;
for (const t of ["d1", "d2", "d3", "d4", "d5"]) writeFileSync(join(issues, `${t}.toml`), toml(t, `task ${t}`));

const first = await ingestIssues(issues);
check(first.events > 0, `ingested TOML fixture (${first.events} seed events)`);
const seedOnly = readAllRows(issues);
check(seedOnly.every((r) => r.author === "did:key:bais-seed"), "pre-hub log is seed-only");

// --- (a) 10 events through the live hub: 5 claims + 5 renews ---
const { hub } = await createHub(issues, { port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const post = async (path, body) => {
	const r = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: r.status, json: await r.json() };
};
const leaseIds = [];
for (let i = 1; i <= 5; i++) {
	const c = await post("/claim", { task: `d${i}`, holder: `did:key:h${i}`, ttl: 100000, epoch: 0, idem: `dur-${i}` });
	check(c.status === 200, `claim d${i} admitted`);
	leaseIds.push(c.json.lease_id);
}
for (let i = 1; i <= 5; i++) {
	const holder = `did:key:h${i}`;
	const rn = await post("/renew", { lease_ref: leaseIds[i - 1], holder });
	check(rn.status === 200, `renew d${i} admitted`);
}
await hub.close();

const preRows = hubRows(readAllRows(issues));
check(preRows.length === 10, `10 hub events in the log (${preRows.length})`);
const preCanon = canon(preRows);
const preFp = fingerprint(issues);
console.log(`pre-ingest projection: ${preFp}`);

const second = await ingestIssues(issues);
check(second.events === first.events + 10, `ingest keeps seed + 10 hub events (${second.events})`);
const postRows = hubRows(readAllRows(issues));
check(postRows.length === 10, `all 10 hub events still present (${postRows.length})`);
check(canon(postRows) === preCanon, "10 hub events survive ingest byte-identical (every column)");
check(fingerprint(issues) === preFp, "projection identical across ingest (tasks + leases intact)");
{
	const leases = exportSnapshot(issues).tables.leases;
	check(leases.length === 5, `5 live leases survive ingest (${leases.length})`);
}

// --- (b) snapshot export/import round-trip ---
const cp = await publishCheckpoint(issues);
check(!!cp.id && cp.state_root.length === 64, `checkpoint published (${cp.id})`);
const srcHubRows = canon(hubRows(readAllRows(issues)));
const srcFp = fingerprint(issues);
const snap = exportSnapshot(issues);
check(!!snap.checkpoint, "snapshot carries the checkpoint");

const issuesB = join(root, "b", ".bais", "issues");
mkdirSync(issuesB, { recursive: true });
const { importSnapshot } = await import("../dist/src/store.js");
importSnapshot(issuesB, snap, "durability-test");
const toWire = (r) => ({
	id: r.id, author: r.author, seq: r.seq, prev: r.prev, project: r.project,
	entity: r.entity, refs: JSON.parse(r.refs), lc: r.lc, ts: r.ts, type: r.type,
	body: JSON.parse(r.body), sig: r.sig ?? null,
	admitted: r.admitted === 1, drop_reason: r.drop_reason ?? null,
});
const backfill = await appendForeignEvents(issuesB, readAllRows(issues).map(toWire), { mode: "backfill" });
check(backfill.rejected.length === 0, `backfill admitted whole log (${backfill.accepted.length} events)`);
check(canon(hubRows(readAllRows(issuesB))) === srcHubRows, "hub events survive snapshot round-trip byte-identical");
check(fingerprint(issuesB) === srcFp, "round-tripped peer converges on the source projection");

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("ingest durability: all green");
