// bais/scripts/fixtures/playbook/check.mjs — bi#61 fixture gate.
//
// Seven checks over the canonical playbook (bais/spec/playbook.md) via the
// assembler (../playbook.mjs). Stub hubs are hermetic tmp dirs (fixed
// --now, like the teardown fixtures); nothing here touches the live hub.
// Pure ESM, zero dependencies: `node` only — plus the already-built
// bais/dist/src/cli.js for the claim/move steps (same precedent as
// claim.mjs and move-unblocked.mjs).
//
// Usage (run from bais/):
//   node scripts/fixtures/playbook/check.mjs --all   # all seven, exit 0 iff each behaves
// Red-check: see ../playbook.mjs header (neutering the budget refusal
// turns budget-red's expected PLAYBOOK BUDGET REFUSED into a silent
// ASSEMBLED — recorded there).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..");
const PLAYBOOK = join(SCRIPTS, "playbook.mjs");
const HANDOFF = join(SCRIPTS, "handoff-validate.mjs");
const CLI = join(HERE, "..", "..", "..", "dist", "src", "cli.js");
const BUDGET = 4000;

const T0 = "2026-09-06T12:00:00Z";
const T1 = "2026-09-06T12:30:00Z";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const run = (cmd, args, cwd) => {
	try {
		const out = execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};

// Candidate agent verbs; only those the BLOCK itself quotes are allowed —
// the stub agent may not run anything it was not taught.
const CANDIDATES = ["bais move", "bais renew", "bais reap", "bais verify",
	"handoff-validate.mjs", "interop.mjs", "teardown.mjs", "inbox.mjs"];

function assemble(cwd) {
	return run("node", [PLAYBOOK, "assemble"], cwd);
}

function mkHub(interop) {
	const d = mkdtempSync(join(tmpdir(), "playbook-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"),
		`project = "stub"\n${interop ? `interop_version = ${interop}\n` : ""}`);
	const issue = (id, status, edges = "") =>
		`id = "${id}"\ntitle = "stub ${id}"\nstatus = "${status}"\nkind = "Feat"\nbody = "stub"\n${edges}`;
	writeFileSync(join(d, ".bais", "issues", "pb#01.toml"), issue("pb#01", "Open"));
	writeFileSync(join(d, ".bais", "issues", "pb#02.toml"),
		issue("pb#02", "Open", '[[edge]]\nfrom = "pb#01"\nto = "pb#02"\nkind = "Blocks"\n'));
	return d;
}

// The stub agent's own version gate, built ONLY from the block text + files:
// read the hub config, compare against the block's PLAYBOOK_VERSION line.
function stubVersionGate(block, hub) {
	const cfg = readFileSync(join(hub, ".bais", "config.toml"), "utf8");
	const m = cfg.match(/^\s*interop_version\s*=\s*(\d+)\s*$/m);
	const declared = m ? parseInt(m[1], 10) : 1;
	const cap = block.match(/hub interop_version <= (\d+)/);
	const max = cap ? parseInt(cap[1], 10) : NaN;
	if (!Number.isFinite(max)) return { ok: false, line: "STUB VERSION UNREADABLE (block states no interop cap)" };
	if (declared > max) {
		return { ok: false, line: `PLAYBOOK VERSION MISMATCH ${hub} (playbook caps interop at ${max}, hub declares ${declared})` };
	}
	return { ok: true, line: `STUB VERSION OK (hub interop ${declared} <= cap ${max})` };
}

function checkAssembleGreen(cwd) {
	const r = assemble(cwd);
	const block = r.out;
	const anchors = ["PLAYBOOK_VERSION = 1", "bais move", "--as", "--for",
		"bais renew", "handoff-validate.mjs", "Evidence:", "base:",
		"ack", "teardown", "GROUND FIRST", "bais verify", "MISMATCH"];
	const missing = anchors.filter((a) => !block.includes(a));
	check("playbook.assemble-green",
		r.code === 0 && missing.length === 0 && [...block].length <= BUDGET,
		`code=${r.code} missing=[${missing.join(",")}] chars=${[...block].length}`);
	return r.code === 0 ? block : null;
}

function checkBudgetRed(cwd) {
	const r = run("node", [PLAYBOOK, "assemble", "--budget", "100"], cwd);
	check("playbook.budget-red",
		r.code === 1 && r.out.includes("PLAYBOOK BUDGET REFUSED"),
		`expected PLAYBOOK BUDGET REFUSED, got ${r.code === 0 ? "ASSEMBLED" : JSON.stringify(r.out)}`);
}

// bi#128: swarm injection is mode-gated — present on dispatch-class
// requests (--mode swarm), absent on regular ones (default assemble).
function checkSwarmPresent(cwd) {
	const r = run("node", [PLAYBOOK, "assemble", "--mode", "swarm"], cwd);
	const anchors = ["SWARM MODE", "dispatch --agents", "MERGE IN BUILD ORDER"];
	const missing = anchors.filter((a) => !r.out.includes(a));
	check("playbook.swarm-present",
		r.code === 0 && missing.length === 0 && [...r.out].length <= BUDGET,
		`code=${r.code} missing=[${missing.join(",")}]`);
}

function checkSwarmAbsent(block) {
	check("playbook.swarm-absent",
		!block.includes("SWARM MODE") && !block.includes("MERGE IN BUILD ORDER"),
		"standard block carries swarm text");
}

function checkStubProbe(block) {
	const hub = mkHub(null);
	const calls = [];
	// The stub agent's hands: every command is canonicalized (the `bais`
	// binary resolves to the dist CLI here) and must match a verb the
	// block itself quotes — anything else is an off-script call, refused
	// before execution.
	const allowed = CANDIDATES.filter((t) => block.includes(t));
	const call = (argv) => {
		const canon = argv.join(" ").replace(/^node \S+cli\.js/, "bais");
		if (!allowed.some((t) => canon.includes(t))) {
			calls.push(`OFF-SCRIPT:${canon}`);
			return { code: 99, out: `OFF-SCRIPT REFUSED ${canon} (not quoted in the playbook block)` };
		}
		calls.push(`ON-SCRIPT:${canon}`);
		return run(argv[0], argv.slice(1), hub);
	};
	let ok = true;
	const gate = stubVersionGate(block, hub);
	ok = ok && gate.ok;
	const claim = call(["node", CLI, "move", "pb#01", "Doing", "--as", "stub-1", "--for", "2h", "--now", T0]);
	ok = ok && claim.code === 0 && claim.out.includes("moved\tpb#01\tOpen\tDoing");
	const held = readFileSync(join(hub, ".bais", "issues", "pb#01.toml"), "utf8");
	ok = ok && /^holder = "stub-1"$/m.test(held) && /^lease = /m.test(held);
	const renew = call(["node", CLI, "renew", "pb#01", "--as", "stub-1", "--for", "2h", "--now", T1]);
	ok = ok && renew.code === 0;
	const stranger = call(["node", CLI, "renew", "pb#01", "--as", "stub-2", "--for", "2h", "--now", T1]);
	ok = ok && stranger.code !== 0;
	// Work: the owned file.
	writeFileSync(join(hub, "owned.txt"), "after\n");
	// Submit: handoff diff + validate.
	const hf = "00_20260906T120000_001_from_stub-1.handoff";
	const base = "a".repeat(40);
	writeFileSync(join(hub, hf),
		["id: pb-handoff-001", "from: stub-1", "to: merger", "priority: 00",
			"type: diff", "created_at: 2026-09-06T12:00:00Z", "",
			`base: ${base}`, "diff --git a/owned.txt b/owned.txt",
			"--- a/owned.txt", "+++ b/owned.txt", "@@ -1 +1 @@",
			"-before", "+after", "Evidence: stub(pb#01-work)", ""].join("\n"));
	const val = call(["node", HANDOFF, join(hub, hf)]);
	ok = ok && val.code === 0 && val.out.includes("HANDOFF VALID");
	// Move announces: the echo IS the announcement; re-read confirms.
	const move = call(["node", CLI, "move", "pb#01", "Done"]);
	ok = ok && move.code === 0 && move.out.includes("moved\tpb#01");
	const done = readFileSync(join(hub, ".bais", "issues", "pb#01.toml"), "utf8");
	ok = ok && /^status = "Done"$/m.test(done);
	// Leave nothing open (agent-observable half of block line 9): no Doing
	// claims left, handoff folded away by the merger, no inbox backlog.
	renameSync(join(hub, hf), join(hub, "folded.handoff"));
	const off = calls.filter((c) => c.startsWith("OFF-SCRIPT:"));
	check("playbook.stub-probe",
		ok && off.length === 0,
		`gate=${gate.line} calls=[${calls.join(" | ")}]`);
	// The gate must bite: one deliberate off-script call is refused.
	const bad = call(["node", CLI, "sync", "--from", "http://example.invalid"]);
	check("playbook.stub-probe-offscript-refused",
		bad.code === 99 && bad.out.includes("OFF-SCRIPT REFUSED"),
		JSON.stringify(bad.out));
}

function checkVersionMismatch() {
	const hub = mkHub(2);
	const r = run("node", [PLAYBOOK, "check-version", "--hub", hub], process.cwd());
	check("playbook.version-mismatch",
		r.code === 1 && r.out.includes("PLAYBOOK VERSION MISMATCH"),
		`expected PLAYBOOK VERSION MISMATCH, got code=${r.code} ${JSON.stringify(r.out)}`);
}

function checkOutsideReader(block) {
	// No repo imports, no child processes in this check: stdlib string ops
	// alone — the hub#154 conformance posture. A non-BAML reader recovers:
	const lines = block.split("\n");
	const claimLine = lines.find((l) => l.includes("bais move") && l.includes("--as") && l.includes("--for"));
	const trio = block.includes("base:") && block.includes("hunk") && block.includes("Evidence:");
	const inboxVerbs = lines.some((l) => l.includes("read lists your queue")) &&
		lines.some((l) => l.includes("ack <id>"));
	const teardownNouns = ["agents", "claims", "handoffs", "inbox", "processes", "files"]
		.every((n) => block.includes(n));
	const versionLine = lines[0].startsWith("PLAYBOOK_VERSION = 1");
	const chunks = block.split(/(?=^\d+\. )/m).filter((c) => /^\d+\. /.test(c));
	const pointed = chunks.filter((c) => /\(.*?(md §|bi#|mjs|cli\.ts|§\d)/s.test(c));
	check("playbook.outside-reader",
		Boolean(claimLine) && trio && inboxVerbs && teardownNouns && versionLine &&
		chunks.length === 10 && pointed.length === 10,
		`claim=${Boolean(claimLine)} trio=${trio} inbox=${inboxVerbs} teardown=${teardownNouns} ` +
		`version=${versionLine} steps=${chunks.length} pointed=${pointed.length}`);
}

const only = process.argv[2];
const cwd = process.cwd();
if (only === "--all" || !only) {
	const block = checkAssembleGreen(cwd);
	checkBudgetRed(cwd);
	checkSwarmPresent(cwd);
	if (block) checkSwarmAbsent(block);
	else check("playbook.swarm-absent", false, "no block assembled");
	if (block) checkStubProbe(block);
	else check("playbook.stub-probe", false, "no block assembled");
	checkVersionMismatch();
	if (block) checkOutsideReader(block);
	else check("playbook.outside-reader", false, "no block assembled");
	console.log(`playbook fixtures: ${pass} pass, ${fail} fail`);
	process.exit(fail ? 1 : 0);
} else {
	console.log(`PLAYBOOK REFUSED (usage: check.mjs --all), got ${only}`);
	process.exit(2);
}
