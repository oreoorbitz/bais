// bais/scripts/drill-registry.mjs — hub#164: close-evidence drill registry.
//
// Done closes cite scripts-lane suites as `Evidence: drill(<stem>)`. drill()
// resolves iff the stem is a fault-drill letter or a *.mjs stem in the hub's
// drill namespace: <hub>/scripts plus every co-located sibling-package
// scripts/ dir (bais/scripts + bi/scripts for the root hub — knownDrillNames
// in bais/src/graph.ts). No fake refs: a cite resolves only when the file
// exists; prose never counts (parseCloseEvidence); greenness is proven by
// running the suites (gates), not by the resolve predicate.
//
// What this pins (tmpdir fixture hubs — never live issues):
//   1. drill(audit) resolves iff scripts/audit.mjs exists in the hub tree.
//   2. A stale cite (drill(stale-suite), no such file) fails unresolvable-drill.
//   3. A hub with no scripts/ at all resolves letters only (drill(b) clean,
//      drill(audit) unresolvable) — the check-evidence.mjs contract at graph level.
//   4. Live tree: every drill stem cited by a live Done issue resolves
//      (enumerated 2026-09-06 — re-enumerate with
//      grep -rhoE "drill\([A-Za-z0-9_-]+\)" .bais/issues/ | sort -u).
//   5. The audit suite itself is green right now (run live, exit 0).
//   6. End-to-end: `bais check` on a fixture hub with drill(audit) is clean.
// Every failure names the stem.
//
// Red-check record (hub#164/bi#57, observed live 2026-09-06; bais/ is a
// nested repo — stash inside it, not from the parent which git-ignores bais/):
//   $ cd bais && git stash push -- src/graph.ts && npm run build
//     (tsc prints one TS7006 at src/cli.ts:447 in this franken-state — HEAD
//     graph.ts types dispatchPack differently than the worktree's; emit
//     still lands, so the runtime red below is valid)
//     $ node scripts/drill-registry.mjs
//     => FAIL: live cite drill(audit) resolves against the root-hub namespace
//     => FAIL: live cite drill(keeper) resolves against bi/scripts (…)
//     => (+ 6 more live stems) drill-registry: N failure(s), exit 1
//   $ git stash pop && npm run build && node scripts/drill-registry.mjs
//     => drill-registry: all green, exit 0
// A passing gate that cannot go red is camouflage, not coverage.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // bais/scripts
const ROOT = join(HERE, "..", ".."); // repo root (root hub)
const gmod = await import(pathToFileURL(join(HERE, "..", "dist", "src", "graph.js")).href);
const { closeEvidenceIn, knownDrillNames, scriptsDirFor } = gmod;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const issue = (id, status, body) =>
	`id = "${id}"\ntitle = "${id} fixture"\nstatus = "${status}"\nkind = "Feat"\nbody = """\n${body}\n"""\n`;
// Tmpdir hub: issues + an optional scripts/ dir (stems as empty .mjs files —
// resolution is existence-based, so content never matters here).
const mkTree = (tag, issueFiles, stems) => {
	const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bi-drillreg-${tag}-`)));
	const issues = join(root, ".bais", "issues");
	mkdirSync(issues, { recursive: true });
	writeFileSync(join(root, ".bais", "config.toml"), 'project = "t"\n');
	for (const [name, content] of issueFiles) writeFileSync(join(issues, name), content);
	if (stems) {
		mkdirSync(join(root, "scripts"), { recursive: true });
		for (const s of stems) writeFileSync(join(root, "scripts", `${s}.mjs`), "// drill-registry fixture stem\n");
	}
	return { root, issues };
};
const evidenceFor = (entries, project, issuesDir) =>
	closeEvidenceIn(entries, project, knownDrillNames(scriptsDirFor(issuesDir)));

// 1. drill(audit) resolves iff scripts/audit.mjs exists.
{
	const { issues } = mkTree("exists", [[
		"done.toml",
		issue("t#01", "Done", "Evidence: drill(audit) # audit suite ran green"),
	]], ["audit"]);
	const probs = evidenceFor([{ id: "t#01", status: "Done", body: "Evidence: drill(audit)" }], "t", issues);
	check(probs.length === 0, `drill(audit) resolves when scripts/audit.mjs exists (got ${JSON.stringify(probs)})`);
}
{
	const { issues } = mkTree("absent", [[
		"done.toml",
		issue("t#01", "Done", "Evidence: drill(audit) # suite file removed upstream"),
	]], ["unrelated"]);
	const probs = evidenceFor([{ id: "t#01", status: "Done", body: "Evidence: drill(audit)" }], "t", issues);
	check(probs.length === 1 && probs[0].reason === "unresolvable-drill" && probs[0].ref === "drill(audit)",
		`drill(audit) fails unresolvable-drill when the suite file is absent (got ${JSON.stringify(probs)})`);
}

// 2. Stale cite fails naming the stem.
{
	const { issues } = mkTree("stale", [[
		"done.toml",
		issue("t#02", "Done", "Evidence: drill(stale-suite)"),
	]], ["audit"]);
	const probs = evidenceFor([{ id: "t#02", status: "Done", body: "Evidence: drill(stale-suite)" }], "t", issues);
	check(probs.length === 1 && probs[0].reason === "unresolvable-drill" && probs[0].ref === "drill(stale-suite)" && probs[0].status === "Missing",
		`stale cite fails unresolvable-drill naming drill(stale-suite) (got ${JSON.stringify(probs)})`);
}

// 3. No scripts/ at all: letters only.
{
	const { issues } = mkTree("bare", [], null);
	const drills = knownDrillNames(scriptsDirFor(issues));
	check(JSON.stringify(drills) === JSON.stringify(["a", "b", "c", "d", "r"]),
		`scriptless hub resolves letters only (got ${JSON.stringify(drills)})`);
	const okLetter = evidenceFor([{ id: "t#03", status: "Done", body: "Evidence: drill(b)" }], "t", issues);
	check(okLetter.length === 0, `drill(b) resolves on a scriptless hub`);
	const badStem = evidenceFor([{ id: "t#04", status: "Done", body: "Evidence: drill(audit)" }], "t", issues);
	check(badStem.length === 1 && badStem[0].reason === "unresolvable-drill",
		`drill(audit) fails on a scriptless hub (got ${JSON.stringify(badStem)})`);
}

// 4. Live tree: every stem cited by a live issue resolves.
{
	const liveIssues = join(ROOT, ".bais", "issues");
	const names = knownDrillNames(scriptsDirFor(liveIssues));
	for (const stem of ["a", "audit", "keeper", "e2e-pty", "prompt", "ready-shape", "notify", "leased-flags", "footer-pin", "auth-chain", "action-log"]) {
		check(names.includes(stem), `live cite drill(${stem}) resolves against the root-hub namespace`);
	}
}

// 5. The audit suite itself is green right now (the "and is green" half).
{
	const r = spawnSync("node", [join(HERE, "audit.mjs")], { encoding: "utf8", timeout: 120000 });
	check(r.status === 0, `audit suite green live (exit ${r.status ?? -1}, tail ${JSON.stringify((r.stdout ?? "").trim().split("\n").pop())})`);
}

// 6. End-to-end: `bais check` on a fixture hub citing drill(audit) is clean.
{
	const { root } = mkTree("e2e", [[
		"done.toml",
		issue("t#05", "Done", "Evidence: drill(audit) # e2e fixture"),
	]], ["audit"]);
	const r = spawnSync("node", [join(HERE, "..", "dist", "src", "cli.js"), "check"], { cwd: root, encoding: "utf8", timeout: 60000 });
	const lines = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("evidence"));
	check(r.status === 0 && lines.length === 0,
		`bais check clean on fixture hub citing drill(audit) (exit ${r.status ?? -1}, evidence lines ${lines.length})`);
}

if (failures) {
	console.error(`drill-registry: ${failures} failure(s) — no fake refs: cite a stem that exists in the hub namespace`);
	process.exit(1);
}
console.log("drill-registry: all green (exists ⟺ resolves, stale fails, audit green)");
