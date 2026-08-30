#!/usr/bin/env node
// bais — BAIS CLI (file-per-issue, git is the hosting). LLM's main path is --json.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function help(): void {
	console.log(`bais — Basically A made-up Issue Standard

Usage:
  bais init
  bais new "title" --kind bug [--area bridge/ffi] [--status open]
  bais list [--status open] [--json]
  bais graph --from bi#09 [--json]
  bais ready [--json]
  bais move <id> <status>
  bais check

One Issue = one file in .bais/issues/<id>.toml, git is the hosting.
`);
}

const root = ".bais";
const issuesDir = join(root, "issues");

function ensureInit(): void {
	if (!existsSync(root)) { console.error("No .bais — run bais init"); process.exit(1); }
}

if (process.argv[2] === "init") {
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(root, "config.toml"), 'project = "bais"\n');
	console.log("Initialized .bais");
	process.exit(0);
}
if (!process.argv[2] || process.argv.includes("--help") || process.argv.includes("-h")) { help(); process.exit(process.argv[2] ? 0 : 1); }

// stub: list via baml check is the real validator; this is the file-per-issue fast path
if (process.argv[2] === "list") {
	ensureInit();
	const files = existsSync(issuesDir) ? readdirSync(issuesDir).filter(f => f.endsWith(".toml")) : [];
	console.log(files.join("\n"));
	process.exit(0);
}
if (process.argv[2] === "check") {
	// baml check over bais/baml_src is the provable check
	const { execSync } = await import("node:child_process");
	execSync("baml check --project bais", { stdio: "inherit" });
	process.exit(0);
}
help();
process.exit(1);
