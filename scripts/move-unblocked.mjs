// Probe bi#49: move prints what it unblocked. Plain node, tmp fixtures only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = "/Users/adrian/code/orion/orion-learn-baml/bais/dist/src/cli.js";
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const run = (dir, args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const issue = (id, title, status, edges = []) => {
	const es = edges.map((e) => `[[edge]]\nfrom = "${e[0]}"\nto = "${e[1]}"\nkind = "${e[2]}"\n`).join("\n");
	return `id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "Feat"\nbody = "b"\n\n${es}`;
};
const mkfix = () => {
	const d = mkdtempSync(join(tmpdir(), "probe49-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	return d;
};

// --- scan path: blocker move frees downstream, exact output ---
{
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "blocker", "Open"));
	writeFileSync(join(is, "t#02.toml"), issue("t#02", "downstream work", "Open", [["t#01", "t#02", "Blocks"]]));
	writeFileSync(join(is, "t#03.toml"), issue("t#03", "lone", "Open"));
	const r = run(d, ["move", "t#01", "Done"]);
	check("49.scan.blocker.exit0", r.code === 0, JSON.stringify(r));
	check("49.scan.blocker.exact", r.out === "moved\tt#01\tOpen\tDone\nunblocked\tt#02\tdownstream work\n", JSON.stringify(r.out));
	check("49.scan.blocker.file-updated", /^status = "Done"$/m.test(readFileSync(join(is, "t#01.toml"), "utf8"))); // bi#58: line-anchored, not substring
	const r2 = run(d, ["ready"]);
	check("49.scan.blocker.ready-consistent", r2.code === 0 && r2.out === "t#02\tdownstream work\nt#03\tlone\n", JSON.stringify(r2.out)); // bi#58: exact ready set+order, not two includes
}
// --- scan path: non-blocker move prints nothing extra ---
{
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "blocker", "Open"));
	writeFileSync(join(is, "t#02.toml"), issue("t#02", "downstream work", "Open", [["t#01", "t#02", "Blocks"]]));
	const r = run(d, ["move", "t#02", "Doing"]);
	check("49.scan.nonblocker.exit0", r.code === 0, JSON.stringify(r));
	check("49.scan.nonblocker.no-extra", r.out === "moved\tt#02\tOpen\tDoing\n", JSON.stringify(r.out));
}
// --- scan path: --json includes unblocked ids ---
{
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "blocker", "Open"));
	writeFileSync(join(is, "t#02.toml"), issue("t#02", "downstream work", "Open", [["t#01", "t#02", "Blocks"]]));
	const r = run(d, ["move", "t#01", "Done", "--json"]);
	const j = JSON.parse(r.out);
	check("49.scan.json.shape", r.code === 0 && j.moved.id === "t#01" && j.moved.from === "Open" && j.moved.to === "Done"
		&& Array.isArray(j.unblocked) && j.unblocked.length === 1 && j.unblocked[0].id === "t#02" && j.unblocked[0].title === "downstream work", r.out);
}
// --- store path: ingest then move, output exact + projection consistent ---
{
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "blocker", "Open"));
	writeFileSync(join(is, "t#02.toml"), issue("t#02", "downstream work", "Open", [["t#01", "t#02", "Blocks"]]));
	const ing = run(d, ["ingest"]);
	check("49.store.ingest", ing.code === 0 && ing.out === "ingested 3 events (0 unparseable) → .bais/store.db\n", JSON.stringify(ing)); // bi#58: exact ingest report — 2 creates + 1 RelAdd from the Blocks edge
	const r = run(d, ["move", "t#01", "Done"]);
	check("49.store.blocker.exact", r.code === 0 && r.out === "moved\tt#01\tOpen\tDone\nunblocked\tt#02\tdownstream work\n", JSON.stringify(r));
	const rj = run(d, ["ready", "--json"]);
	const ready = JSON.parse(rj.out).ready.map((f) => f.issue.id);
	check("49.store.projection-consistent", JSON.stringify(ready) === '["t#02"]', rj.out); // bi#58: exact ready array, not includes-pair
}
// --- errors ---
{
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "blocker", "Open"));
	// bi#58: exit codes mask stderr — each error pins its exact message (a
	// silent `process.exit(1)` with no reason would pass the old checks).
	const e1 = run(d, ["move", "t#99", "Done"]);
	check("49.err.unknown-id", e1.code === 1 && e1.out === "bais move: unknown issue t#99\n", JSON.stringify(e1));
	const e2 = run(d, ["move", "t#01", "Finished"]);
	check("49.err.bad-status", e2.code === 1 && e2.out === "bais move <id> <status> — status one of Open|Doing|Blocked|Done|Dropped\n", JSON.stringify(e2));
	const e3 = run(d, ["move", "t#01"]);
	check("49.err.missing-args", e3.code === 1 && e3.out === "bais move <id> <status> — status one of Open|Doing|Blocked|Done|Dropped\n", JSON.stringify(e3));
	check("49.err.file-untouched", /^status = "Open"$/m.test(readFileSync(join(is, "t#01.toml"), "utf8")));
}
console.log(`\nprobe49: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
