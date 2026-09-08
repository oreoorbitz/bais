// bais/scripts/baseline-activate.mjs — hub#219 item 6 (hub#186→hub#193):
// sketch baseline activation. The hub#186 sketch always emits a
// [[node]] id = "baseline", but the layer-drift audit (hub#193) stays
// dormant until that node names the real issue it materialized as —
// issue = "<id>" on the baseline node is the audit's ONLY activation
// switch (baselineIssueFromSketch, bais/src/graph.ts). This module owns
// the stamp; `bais goal baseline <issue-id>` (bais/src/cli.ts) routes it.
//
// The stamp is materialization metadata, not plan drift: nodes/edges are
// untouched, so the campaign version (goal_snapshot — the e2e case-header
// join key, hub#195) MUST NOT move or every case file goes stale at once.
// goal.toml's approved_sketch_hash IS restamped over the new sketch bytes
// (the explicit `bais goal baseline` command IS the re-approval — loud,
// operator-driven, never silent). A goal.toml without the hash is
// grandfathered (pre-195 campaigns carry none) and passes through
// unchanged.
//
// Red-check record (hub#219/bi#57, observed 2026-09-08): with the
// issue-line insertion neutered in stampBaselineIssue (the
// `lines.splice(i + 1, 0, stamped)` push replaced by a no-op),
// `node scripts/baseline-activate.mjs` failed LOUD with 6 failure(s)
// FOR THE RIGHT REASON —
//   FAIL selftest: stamp inserts issue= on the baseline node
//   FAIL selftest: baselineIssueFromSketch reads the stamp (the audit's activation switch)
//   FAIL selftest: re-stamp replaces the materialized issue
//   FAIL selftest: restamped goal.toml verifies against the stamped sketch
//   FAIL selftest: activation flips the audit-phase line from undeclared
//   FAIL selftest: layer-drift row names the Doing enhancement + Open baseline ("(none)")
// (the stamp never landed, so every downstream consumer — the audit
// switch, the re-approval, the CLI activation — went red behind it; the
// refusal/idempotence/grandfather pins stayed green: they never needed
// the insertion). Restored, green. An activation stamp that cannot go
// red on a missing issue= key is camouflage, not coverage.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Insert or replace `issue = "<id>"` inside the [[node]] id = "baseline"
// block. Line-oriented over the exact renderSketchToml shape (goal.mjs);
// every other node/edge byte is untouched. Returns:
//   { ok, text, error } — error names the refusal (bi#55), never silent.
export function stampBaselineIssue(sketchText, issueId) {
	const id = String(issueId ?? "").trim();
	if (id === "") return { ok: false, text: String(sketchText ?? ""), error: "baseline activation refused: empty issue id" };
	const lines = String(sketchText ?? "").split("\n");
	// Find the [[node]] block whose id line is exactly id = "baseline".
	let blockStart = -1;
	let blockEnd = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "[[node]]" || lines[i].trim() === "[[edge]]") {
			if (blockStart !== -1) {
				blockEnd = i;
				break;
			}
			if (lines[i].trim() === "[[node]]") {
				const idLine = lines.slice(i + 1, i + 4).find((l) => /^id\s*=/.test(l.trim()));
				if (idLine !== undefined && /^id\s*=\s*"baseline"\s*$/.test(idLine.trim())) {
					blockStart = i;
				}
			}
		}
	}
	if (blockStart === -1) {
		return { ok: false, text: String(sketchText ?? ""), error: 'baseline activation refused: no [[node]] id = "baseline" in sketch.toml — run `bais goal sketch` + `bais goal commit --approve` first (hub#186)' };
	}
	const stamped = `issue = ${JSON.stringify(id)}`;
	for (let i = blockStart + 1; i < blockEnd; i++) {
		if (/^issue\s*=/.test(lines[i].trim())) {
			if (lines[i].trim() === stamped) return { ok: true, text: lines.join("\n"), error: null }; // already active
			lines[i] = stamped; // re-materialization moves loud: replace, never duplicate
			return { ok: true, text: lines.join("\n"), error: null };
		}
	}
	// Insert directly after the id line (before title/radius).
	for (let i = blockStart + 1; i < blockEnd; i++) {
		if (/^id\s*=/.test(lines[i].trim())) {
			lines.splice(i + 1, 0, stamped);
			return { ok: true, text: lines.join("\n"), error: null };
		}
	}
	return { ok: false, text: String(sketchText ?? ""), error: "baseline activation refused: baseline node carries no id line (sketch.toml hand-edited?)" };
}

// Re-approval: approved_sketch_hash re-derives over the STAMPED sketch
// bytes. goal_snapshot deliberately untouched — the campaign version did
// not change (no node/edge edit), and moving it would stale every e2e
// case header via e2eSnapshotDrift (hub#195). Grandfathered goal.toml (no
// hash) passes through. hashFn injected (lifecycle.approvedSketchHash) so
// the rule stays pure over text.
export function restampGoalApproval(goalText, newSketchText, hashFn) {
	const text = String(goalText ?? "");
	const m = text.match(/^approved_sketch_hash *= *("(?:[^"\\]|\\.)*")/m);
	if (!m) return { ok: true, text, restamped: false };
	const next = text.replace(m[0], `approved_sketch_hash = ${JSON.stringify(hashFn(newSketchText))}`);
	return { ok: true, text: next, restamped: next !== text };
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const HERE = dirname(fileURLToPath(import.meta.url));
	const CLI = join(HERE, "..", "dist", "src", "cli.js");
	const lm = await import(pathToFileURL(join(HERE, "lifecycle.mjs")).href);
	const gm = await import(pathToFileURL(join(HERE, "..", "dist", "src", "graph.js")).href);
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) {
			failures++;
			console.error(`FAIL selftest: ${msg}`);
		} else console.log(`ok selftest: ${msg}`);
	};
	const sketchA = `# .bais/sketch.toml — approved goal sketch (hub#184). Nodes + edges; e2e scaffolds live in .bais/e2e/.
[[node]]
id = "baseline"
title = "walking skeleton"
radius = []

[[node]]
id = "c1"
title = "first layer"
radius = []

[[edge]]
from = "baseline"
to = "c1"
kind = "precedes"
`;
	// 1. The stamp inserts issue= on the baseline node only.
	const s1 = stampBaselineIssue(sketchA, "t#01");
	check(s1.ok && s1.text.includes('id = "baseline"\nissue = "t#01"\ntitle = "walking skeleton"'), `stamp inserts issue= on the baseline node`);
	check(!s1.text.includes('id = "c1"\nissue'), `other nodes untouched`);
	check(gm.baselineIssueFromSketch(s1.text) === "t#01", `baselineIssueFromSketch reads the stamp (the audit's activation switch)`);
	// 2. Re-materialization replaces, never duplicates; idempotent re-stamp.
	const s2 = stampBaselineIssue(s1.text, "t#09");
	check(s2.ok && s2.text.includes('issue = "t#09"') && !s2.text.includes('issue = "t#01"'), `re-stamp replaces the materialized issue`);
	check(stampBaselineIssue(s2.text, "t#09").text === s2.text, `idempotent re-stamp is a no-op`);
	// 3. No baseline node refuses with a named reason.
	const s3 = stampBaselineIssue('[[node]]\nid = "c1"\ntitle = "x"\nradius = []\n', "t#01");
	check(!s3.ok && s3.error.includes("refused") && s3.error.includes("baseline"), `missing baseline node refuses loud (${JSON.stringify(s3.error.slice(0, 60))}…)`);
	// 4. Re-approval restamps the hash; goal_snapshot untouched;
	//    grandfathered goal.toml passes through.
	const goalA = `[goal]\nstatement = "x"\ngoal_snapshot = "goal-snapshot-deadbeef0000"\napproved_sketch_hash = ${JSON.stringify(lm.approvedSketchHash(sketchA))}\n`;
	const r1 = restampGoalApproval(goalA, s1.text, lm.approvedSketchHash);
	check(r1.restamped && lm.verifyApprovedSketch({ goalTomlText: r1.text, sketchTomlText: s1.text }).ok, `restamped goal.toml verifies against the stamped sketch`);
	check(r1.text.includes('goal_snapshot = "goal-snapshot-deadbeef0000"'), `goal_snapshot untouched (campaign version did not change)`);
	const r2 = restampGoalApproval("[goal]\nstatement = \"legacy\"\n", s1.text, lm.approvedSketchHash);
	check(r2.ok && !r2.restamped && r2.text === "[goal]\nstatement = \"legacy\"\n", `grandfathered goal.toml (no hash) passes through`);
	// 5. End-to-end: fixture hub, `bais goal baseline t#01` flips the
	//    audit-phase line from undeclared AND activates the layer-drift
	//    audit (a Doing enhancement with an Open baseline ancestor rows).
	const d = mkdtempSync(join(tmpdir(), "probe-baseline-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	writeFileSync(join(is, "t#01.toml"), `id = "t#01"\ntitle = "baseline"\nstatus = "Open"\nkind = "Feat"\nbody = """\nwalking skeleton.\n"""\n`);
	writeFileSync(
		join(is, "t#02.toml"),
		`id = "t#02"\ntitle = "enhancement"\nstatus = "Doing"\nkind = "Feat"\nbody = """\nenhancement layer.\n"""\n[[edge]]\nfrom = "t#02"\nto = "t#01"\nkind = "DependsOn"\n`,
	);
	writeFileSync(join(d, ".bais", "sketch.toml"), sketchA);
	writeFileSync(join(d, ".bais", "goal.toml"), goalA);
	const runC = (args) => {
		const r = spawnSync("node", [CLI, ...args], { cwd: d, encoding: "utf8", timeout: 60000 });
		return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
	};
	const before = runC(["check"]);
	check(before.out.includes("layer-drift baseline: undeclared"), `pre-activation the audit-phase line names undeclared`);
	const act = runC(["goal", "baseline", "t#01"]);
	check(act.code === 0 && act.out.includes("baseline\tt#01\tactivated"), `bais goal baseline stamps loud (${JSON.stringify(act.out.trim().split("\n")[0])})`);
	const after = runC(["check"]);
	check(after.out.includes("layer-drift baseline: t#01") && !after.out.includes("undeclared"), `activation flips the audit-phase line from undeclared`);
	check(/audit\tt#02\tlayer-drift.*t#01/.test(after.out), `layer-drift row names the Doing enhancement + Open baseline (${JSON.stringify(after.out.split("\n").find((l) => l.startsWith("audit\t")) ?? "(none)")})`);
	check(!after.out.includes("goal-sketch-stale"), `the restamped approval keeps goal-sketch-stale quiet`);
	// 6. Refusals: unknown issue, second hub without sketch.
	const bad = runC(["goal", "baseline", "t#99"]);
	check(bad.code !== 0 && bad.out.includes("unknown issue t#99"), `unknown issue refuses loud`);
	if (failures) {
		console.error(`${failures} failure(s)`);
		process.exit(1);
	}
	console.log("baseline-activate: all green");
}
