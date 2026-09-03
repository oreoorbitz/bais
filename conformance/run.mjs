// bais/conformance/run.mjs — replay src/__tests__/reduce.conformance.json
// through the REAL SDK (host -> BAML FFI path, not baml test in-VM).
// CI fails on any divergent tiebreak. Usage: node bais/conformance/run.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const suite = JSON.parse(readFileSync(join(root, "src/__tests__/reduce.conformance.json"), "utf8"));
const { event } = await import(join(root, "dist/baml_sdk/index.js"));

const sort = (xs) => [...xs].sort();
let failures = 0;

for (const v of suite.vectors) {
	const got = await event.reduce(v.events);
	const problems = [];
	if (got.version !== suite.reducer_version) problems.push(`version ${got.version} != ${suite.reducer_version}`);
	const gotIssues = got.issues.map((i) => ({ entity: i.entity, title: i.title, status: i.status, labels: sort(i.labels) }));
	const wantIssues = v.expect.issues.map((i) => ({ ...i, labels: sort(i.labels) }));
	if (JSON.stringify(gotIssues) !== JSON.stringify(wantIssues))
		problems.push(`issues\n got  ${JSON.stringify(gotIssues)}\n want ${JSON.stringify(wantIssues)}`);
	const gotConf = got.conflicts.map((c) => ({ entity: c.entity, field: c.field, winner: c.winner }));
	if (JSON.stringify(gotConf) !== JSON.stringify(v.expect.conflicts))
		problems.push(`conflicts\n got  ${JSON.stringify(gotConf)}\n want ${JSON.stringify(v.expect.conflicts)}`);
	const gotExcl = sort(got.excluded.map((e) => e.reason));
	if (JSON.stringify(gotExcl) !== JSON.stringify(sort(v.expect.excluded_reasons)))
		problems.push(`excluded\n got  ${JSON.stringify(gotExcl)}\n want ${JSON.stringify(sort(v.expect.excluded_reasons))}`);
	if (problems.length) {
		failures += 1;
		console.error(`FAIL ${v.name}\n  ${problems.join("\n  ")}`);
	} else {
		console.log(`PASS ${v.name}`);
	}
}
if (failures) {
	console.error(`${failures} vector(s) diverged`);
	process.exit(1);
}
console.log(`conformance green: ${suite.vectors.length} vectors @ ${suite.reducer_version}`);
