// bais/scripts/lease-race.mjs — Phase 3 step 9 validation: concurrent
// claims serialize (one 200, one 409) and zombie writes are rejected.
// Run: npm run build --prefix bais && npm test --prefix bais
// (package.json "test" points here). Exits non-zero on any failure.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../dist/src/hub.js";
import { ingestIssues } from "../dist/src/store.js";

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "bais-race-"));
const issues = join(dir, ".bais", "issues");
mkdirSync(issues, { recursive: true });
writeFileSync(join(issues, "t1.toml"), 'id = "t1"\ntitle = "race task"\nstatus = "Open"\nkind = "Feat"\nbody = "race fixture"\n');
const ing = await ingestIssues(issues);
check(ing.events > 0, `ingested fixture store (${ing.events} events)`);

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

// 1. Two holders race the same task: exactly one wins.
const [a, b] = await Promise.all([
	post("/claim", { task: "t1", holder: "did:key:a", ttl: 1000, epoch: 0, idem: "a1" }),
	post("/claim", { task: "t1", holder: "did:key:b", ttl: 1000, epoch: 0, idem: "b1" }),
]);
const win = a.status === 200 ? a : b;
const lose = a.status === 200 ? b : a;
check(win.status === 200 && lose.status === 409, "race: one 200, one 409");
check(/lease-held/.test(lose.json.reason ?? ""), `loser told lease-held (got ${lose.json.reason})`);

// 2. A zombie with a HIGHER epoch still cannot steal a held lease.
const z = await post("/claim", { task: "t1", holder: "did:key:z", ttl: 1000, epoch: 7, idem: "z7" });
check(z.status === 409, "zombie epoch-7 claim rejected while held");

// 3. Winner renews; a zombie renew with the same ref is refused.
const renew = await post("/renew", { lease_ref: win.json.lease_id, holder: win.json.holder });
check(renew.status === 200 && renew.json.expires_lc > win.json.expires_lc, "winner renew extends expiry");
const zrenew = await post("/renew", { lease_ref: win.json.lease_id, holder: "did:key:z" });
check(zrenew.status === 409 && zrenew.json.reason === "not-holder", "zombie renew refused");

// 4. Release frees; the loser reclaims.
const rel = await post("/release", { lease_ref: win.json.lease_id, holder: win.json.holder });
check(rel.status === 200, "winner release frees");
const reclaim = await post("/claim", { task: "t1", holder: "did:key:b", ttl: 1000, epoch: 0, idem: "b2" });
check(reclaim.status === 200, "task reclaimable after release");

// 5. Live lease is visible to oversight.
const leases = await (await fetch(`${base}/leases`)).json();
check(leases.leases.length === 1 && leases.leases[0].entity === "t1", "GET /leases shows the live lease");

// 6. Renewing the released (zombie) lease is rejected.
const zold = await post("/renew", { lease_ref: win.json.lease_id, holder: win.json.holder });
check(zold.status === 409, `renew of released lease rejected (got ${zold.status})`);

await hub.close();
if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("lease race: all green");
