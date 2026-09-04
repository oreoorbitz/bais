// bais/scripts/content-ids.mjs — bi#38 acceptance: event ids are
// self-verifying content hashes (CIDv1-raw), not dev `hub:`/`seed:` ids.
// Run: node scripts/content-ids.mjs (offline, tmp dirs, plain node).
// Exits non-zero on any failure. Style follows lease-race.mjs.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHub } from "../dist/src/hub.js";
import { ingestIssues } from "../dist/src/store.js";
import { eventId, verifyEventId, canonicalize } from "../dist/src/ids.js";

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const BID = /^b[abcdefghijklmnopqrstuvwxyz234567]+$/;

// 1. Cross-process determinism: same payload, same id, two processes.
const payload = {
	author: "did:key:z6Mk-test",
	seq: 0,
	prev: null,
	project: "t",
	entity: "t1",
	refs: [],
	lc: 1,
	ts: "2026-09-04T00:00:00.000Z",
	type: "TaskCreate",
	body: { title: "fixture" },
	sig: null,
};
const local = eventId(payload);
const probe = `import("../dist/src/ids.js").then(m=>console.log(m.eventId(${JSON.stringify(payload)})))`;
const remote = execFileSync("node", ["--input-type=module", "-e", probe], { cwd: new URL(".", import.meta.url).pathname }).toString().trim();
check(local === remote, `cross-process determinism (${local.slice(0, 12)}…)`);

// 2. Shape: multibase-base32 CID (59 chars: 'b' + 58 base32 of 36 CID bytes).
check(local.length === 59 && BID.test(local), `id is CIDv1-raw base32 shape (${local.slice(0, 16)}… len ${local.length})`);
// The cross-process equality in (1) is the real guard; a golden vector
// would only pin the digest of this exact fixture, so it lives there.

// 3. Fresh ingest: zero dev ids, every stored event re-verifies.
const dir = mkdtempSync(join(tmpdir(), "bais-ids-"));
const issues = join(dir, ".bais", "issues");
mkdirSync(issues, { recursive: true });
writeFileSync(join(issues, "t1.toml"), 'id = "t1"\ntitle = "ids fixture"\nstatus = "Open"\nkind = "Feat"\nbody = "x"\n');
writeFileSync(join(issues, "t2.toml"), 'id = "t2"\ntitle = "done fixture"\nstatus = "Done"\nkind = "Bug"\nbody = "y"\n');
const ing = await ingestIssues(issues);
check(ing.events > 0, `ingested fixture store (${ing.events} events)`);
const db = new DatabaseSync(join(dir, ".bais", "store.db"));
const rows = db.prepare("SELECT id, author, seq, prev, project, entity, refs, lc, ts, type, body FROM events").all();
check(rows.length > 0, `events table non-empty (${rows.length})`);
let devIds = 0;
let unverified = 0;
for (const r of rows) {
	if (!BID.test(r.id)) devIds++;
	const ok = verifyEventId({
		author: r.author, seq: r.seq, prev: r.prev, project: r.project, entity: r.entity,
		refs: JSON.parse(r.refs), lc: r.lc, ts: r.ts, type: r.type, body: JSON.parse(r.body), sig: null, id: r.id,
	});
	if (!ok) unverified++;
}
check(devIds === 0, `no dev ids in fresh ingest (${rows.length} events)`);
check(unverified === 0, `every stored event re-verifies (${rows.length}/${rows.length})`);
db.close();

// 4. Id-equality premise: identical bytes, identical id; ts is committed.
check(eventId(payload) === eventId(JSON.parse(JSON.stringify(payload))), "identical payload bytes hash equal");
check(eventId(payload) !== eventId({ ...payload, ts: "2026-09-04T00:00:01.000Z" }), "ts is committed (no silent coalescing)");

// 5. Hub-issued ids end to end: claim returns a b-id that re-verifies.
const { hub, server } = await createHub(issues, { port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const claim = await fetch(base + "/claim", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ task: "t1", holder: "did:key:a", ttl: 1000, epoch: 0, idem: "a1" }),
}).then((r) => r.json());
check(typeof claim.lease_id === "string" && BID.test(claim.lease_id), `claim returns content-hash lease_id (${String(claim.lease_id).slice(0, 16)}…)`);
const db2 = new DatabaseSync(join(dir, ".bais", "store.db"));
const stored = db2.prepare("SELECT id, author, seq, prev, project, entity, refs, lc, ts, type, body, sig FROM events WHERE id = ?").get(claim.lease_id);
check(!!stored, "claimed event persisted under its hash id");
if (stored) {
	const ok = verifyEventId({
		author: stored.author, seq: stored.seq, prev: stored.prev, project: stored.project, entity: stored.entity,
		refs: JSON.parse(stored.refs), lc: stored.lc, ts: stored.ts, type: stored.type,
		body: JSON.parse(stored.body), sig: stored.sig ? stored.sig : null, id: stored.id,
	});
	check(ok, "hub-issued claim event re-verifies by id equality (structural dedup, no lc comparison)");
}
db2.close();
server.close();

console.log(failures === 0 ? "content ids: all green" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
