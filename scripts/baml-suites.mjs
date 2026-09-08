// bais/scripts/baml-suites.mjs — standing drill: baml check + baml test for the
// sibling BAML projects (bits, bagl), offline literals only, no LLM calls.
// Exists so Done issues whose evidence is "the BAML suite covers it" have a
// resolvable drill() cite (close-evidence gate, graph.ts parseCloseEvidence).
// Run from the repo root: node bais/scripts/baml-suites.mjs — exits non-zero
// with a named FAIL line per failing project.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const projects = ["bits", "bagl", "bais"];

let failures = 0;
for (const p of projects) {
	for (const cmd of ["check", "test"]) {
		const r = spawnSync("baml", [cmd, "--project", p], { cwd: ROOT, encoding: "utf8" });
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		const tail = out.trim().split("\n").pop() ?? "";
		const failed = r.status !== 0 || /[1-9]\d* failed/.test(out);
		if (failed) {
			failures++;
			console.log(`FAIL baml ${cmd} --project ${p}: ${tail}`);
		} else {
			console.log(`ok: baml ${cmd} --project ${p} (${tail.trim()})`);
		}
	}
}
if (failures > 0) {
	console.log(`baml-suites: ${failures} failure(s)`);
	process.exit(1);
}
console.log("baml-suites: all green");
