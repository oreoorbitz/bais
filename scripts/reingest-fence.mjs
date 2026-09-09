// bais/scripts/reingest-fence.mjs — hub#228 drill: re-ingest must not fence
// out file-marked Done via a stale fence from a released lease.
//
// Race shape (from the bi#40 attempt-4 transcript, /tmp/lane-c2-deliver/):
// a LeaseClaim with a huge lc ttl is live when the seed
// TaskTransition{to:Done} reduces, but a LeaseRelease later in total order
// already freed it. On re-ingest the seed (fresh content-hash id, small lc)
// reduces BEFORE the carried-over release, so the BAML fencing gate sees a
// live lease, excludes the seed Done as `stale-fence`, and the file-marked
// Done goes blind (sample total:0, scan=Done store=Open).
//
// The drill compresses hub lc for determinism (claim lc 2 ties only a
// TaskCreate, which no fence gate guards) but keeps the load-bearing
// relation exact: claim.lc <= seedDone.lc < release.lc, lc-only lease
// (wall-inert), release unseen at the seed point. The transcript's tied
// lc-3 variant is the same rule through a coin flip; this variant fences
// on every run. Run: npm run build --prefix bais && node
// bais/scripts/reingest-fence.mjs. Exits non-zero on any failure.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { dbPathFor, ingestIssues, storeList, storeSample } from "../dist/src/store.js";
import { eventId, verifyEventId } from "../dist/src/ids.js";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const RACE = 'id = "race"\ntitle = "contested"\nstatus = "STATUS"\nkind = "Feat"\nbody = "race fixture"\n';
const OTHER = 'id = "other"\ntitle = "spare"\nstatus = "Open"\nkind = "Feat"\nbody = "spare fixture"\n';

// 1. Fixture: two Open issues, ingest seeds only.
const dir = mkdtempSync(join(tmpdir(), "bais-reingest-"));
const issues = join(dir, ".bais", "issues");
mkdirSync(issues, { recursive: true });
writeFileSync(join(dir, ".bais", "config.toml"), 'project = "drill"\n');
writeFileSync(join(issues, "race.toml"), RACE.replace("STATUS", "Open"));
writeFileSync(join(issues, "other.toml"), OTHER);
const first = await ingestIssues(issues);
check(first.events === 2, `seed ingest writes 2 create events (got ${first.events})`);

// 2. Hub history, appended the way the hub would write it: an lc-immortal
// lc-only claim (ttl 60000, no wall bound) plus its later release. lc 2
// ties only a TaskCreate (fence gates guard transitions, never creates),
// lc 4 sorts strictly after every re-ingest seed — the release is unseen
// when the seed Done reduces, exactly the transcript relation.
const claimFields = {
	author: "did:key:drill-a",
	seq: 0,
	prev: null,
	project: "drill",
	entity: "race",
	refs: [],
	lc: 2,
	ts: "2026-01-01T00:00:00.000Z",
	type: "LeaseClaim",
	body: { ttl: 60000, epoch: 0, idem: "k1", read_set: "[]" },
};
const claimId = eventId(claimFields);
check(verifyEventId({ ...claimFields, id: claimId }), "claim id self-verifies before insert");
const releaseFields = {
	author: "did:key:drill-a",
	seq: 1,
	prev: claimId,
	project: "drill",
	entity: "race",
	refs: [],
	lc: 4,
	ts: "2026-01-01T00:01:00.000Z",
	type: "LeaseRelease",
	body: { lease_ref: claimId },
};
const releaseId = eventId(releaseFields);
check(verifyEventId({ ...releaseFields, id: releaseId }), "release id self-verifies before insert");
{
	const db = new DatabaseSync(dbPathFor(issues));
	try {
		const ins = db.prepare(
			"INSERT INTO events(id, author, seq, prev, project, entity, refs, lc, ts, type, body, sig, admitted, drop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		ins.run(claimId, claimFields.author, claimFields.seq, claimFields.prev, claimFields.project, claimFields.entity,
			JSON.stringify(claimFields.refs), claimFields.lc, claimFields.ts, claimFields.type,
			JSON.stringify(claimFields.body), null, 1, null);
		ins.run(releaseId, releaseFields.author, releaseFields.seq, releaseFields.prev, releaseFields.project, releaseFields.entity,
			JSON.stringify(releaseFields.refs), releaseFields.lc, releaseFields.ts, releaseFields.type,
			JSON.stringify(releaseFields.body), null, 1, null);
	} finally {
		db.close();
	}
}

// 3. The race winner marks the file Done (disk truth), then re-ingest.
writeFileSync(join(issues, "race.toml"), RACE.replace("STATUS", "Done"));
const second = await ingestIssues(issues);
check(second.events === 5, `re-ingest merges 3 seeds + 2 hub rows (got ${second.events})`);

// 4. Mechanism pin: the seed Done was fenced out by the live-at-that-point lease.
let fencedSeed = null;
{
	const db = new DatabaseSync(dbPathFor(issues));
	try {
		const rows = db.prepare(
			`SELECT e.id FROM events e JOIN excluded x ON x.event_id = e.id
			 WHERE e.type = 'TaskTransition' AND e.entity = 'race' AND e.author = 'did:key:bais-seed'
			   AND x.reason = 'stale-fence'`,
		).all();
		fencedSeed = rows.length ? rows[0].id : null;
	} finally {
		db.close();
	}
}
check(fencedSeed !== null, "seed TaskTransition{to:Done} excluded as stale-fence (mechanism pin)");

// 5. Projection: scan-Done implies store-Done.
const { tasks } = storeList(issues);
const race = tasks.find((t) => t.entity === "race");
check(race?.status === "Done", `store lists race Done (got ${race?.status ?? "(absent)"})`);
const sample = storeSample(issues, 5);
check(sample.total === 1 && sample.sample[0]?.entity === "race", `store sample returns the Done work (total=${sample.total})`);

// 6. cross-check scan/store agreement on the drill dir (unpiped; piped exit codes lie).
try {
	execFileSync("node", [join(here, "cross-check.mjs"), issues], { stdio: "inherit" });
	console.log("ok: cross-check agrees on the drill dir");
} catch {
	failures++;
	console.error("FAIL: cross-check diverges on the drill dir");
}

if (failures) {
	console.error(`${failures} failure(s) — hub#228 present: re-ingest fenced out file-marked Done`);
	process.exit(1);
}
console.log("reingest-fence: all green (hub#228 fixed: scan-Done implies store-Done)");
