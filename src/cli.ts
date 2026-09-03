#!/usr/bin/env node
// bais — BAIS CLI (file-per-issue, git is the hosting). LLM's main path is --json.
//
// Read commands load every .bais/issues/*.toml through the BAML parser and then
// apply the graph rules from baml_src/main.baml (mirrored in graph.ts). Note
// `check` validates the *issue files*; it is not `baml check`, which validates
// bais's own BAML source. The old stub conflated the two and shelled out to the
// latter, so it never looked at a single issue.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cyclicIds, danglingRefsIn, loadIssues, projectName, readyIssues } from "./graph.js";

const root = ".bais";
const issuesDir = join(root, "issues");

function help(): void {
	console.log(`bais — Basically A made-up Issue Standard

Usage:
  bais init
  bais list [--json]
  bais ready [--json]
  bais check [--json]

Not yet implemented (see .agents/plans — new/move/graph land with the event log):
  bais new "title" --kind bug [--area bridge/ffi] [--status open]
  bais move <id> <status>
  bais graph --from bi#09 [--json]

One Issue = one file in .bais/issues/<id>.toml, git is the hosting.
`);
}

function ensureInit(): void {
	if (!existsSync(root)) {
		console.error("No .bais — run bais init");
		process.exit(1);
	}
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const asJson = argv.includes("--json");

if (cmd === "init") {
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(root, "config.toml"), 'project = "bais"\n');
	console.log("Initialized .bais");
	process.exit(0);
}

if (!cmd || argv.includes("--help") || argv.includes("-h")) {
	help();
	process.exit(cmd ? 0 : 1);
}

if (cmd === "list") {
	ensureInit();
	const { issues, failures } = await loadIssues(issuesDir);
	if (asJson) {
		console.log(JSON.stringify({ issues, unparseable: failures }, null, 2));
	} else {
		for (const f of issues) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}`);
		for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
		if (!issues.length && !failures.length) console.error("(no .bais/issues/*.toml — run bais init or add issues)");
	}
	process.exit(0);
}

if (cmd === "ready") {
	ensureInit();
	const { issues, failures } = await loadIssues(issuesDir);
	const ready = readyIssues(issues);
	if (asJson) {
		console.log(JSON.stringify({ ready, unparseable: failures }, null, 2));
	} else {
		for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}`);
		if (!ready.length) console.log("(no ready issues)");
		// A file that failed to parse is absent from the graph, so both the
		// ready set and the edges that would have constrained it are short.
		if (failures.length) {
			console.error(`[bais] ${failures.length} unparseable file(s) excluded — \`bais check\` for details`);
		}
	}
	process.exit(0);
}

if (cmd === "check") {
	ensureInit();
	const { issues, failures } = await loadIssues(issuesDir);
	const dangling = danglingRefsIn(issues, projectName(issuesDir));
	const missing = dangling.filter((d) => d.status === "Missing");
	const external = dangling.filter((d) => d.status === "External");
	const cycles = cyclicIds(issues);

	if (asJson) {
		console.log(JSON.stringify({ ok: issues.length, bad: failures, dangling, cycles }, null, 2));
	} else {
		for (const f of issues) console.log(`ok\t${f.issue.id}`);
		for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
		// A Blocks edge naming an id that does not exist parks its target
		// indefinitely — is_blocked treats an unresolvable blocker as blocking.
		for (const d of missing) console.log(`dangling\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
		// Another project's id is not resolvable from here. Reported so a typo'd
		// prefix stays visible, but not a failure.
		for (const d of external) console.log(`external\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
		// Nothing in a dependency cycle can ever become ready.
		if (cycles.length) console.log(`cycle\t${cycles.join(", ")}`);
	}

	// External is reported, never fatal — a cross-project edge is legitimate and
	// unresolvable from one directory. Applies to --json too: the old check
	// exited 0 in JSON mode, which made it useless as a CI gate.
	if (failures.length || missing.length || cycles.length) process.exit(1);
	process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
help();
process.exit(1);
