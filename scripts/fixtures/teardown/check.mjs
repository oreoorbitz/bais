// bais/scripts/fixtures/teardown/check.mjs — close-swarm fixture runner (bi#141).
//
// Exercises ../teardown.mjs `check` end to end over hermetic tmp hubs
// (fixed --now, so every run prints byte-identical verdicts except the
// self-pid probe, which names the runner's own pid by construction).
// Six scenarios: stray live claim is loud with its holder; orphaned
// handoff is loud with its path; dead claims (expired + anonymous) need
// reap with reason named; undrained inbox + _requeue backlog are loud
// with owner + id; dead-writer partials are stray files (safe to delete)
// and a live --pid is a stray process; the clean tree closes all lines.
// Pure ESM, zero dependencies: `node` only.
//
// Usage (run from bais/):
//   node scripts/fixtures/teardown/check.mjs --all   # all scenarios, exit 0 iff each behaves
// Red-check: see ../teardown.mjs header (stray-claim branch removal turns
// scenario 1's expected STRAY-CLAIM into a silent PASS — recorded there).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEARDOWN = join(HERE, "..", "..", "teardown.mjs");
const NOW = "2026-09-06T12:00:00Z";
const FUTURE = "2026-09-06T14:00:00Z";
const PAST = "2026-09-06T10:00:00Z";
// ESRCH-certain on macOS/Linux (max pid far below this).
const DEAD_PID = 2147483647;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const run = (args) => {
	try {
		const out = execFileSync("node", args, { encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const td = (hub, args) => run([TEARDOWN, "check", "--hub", hub, "--now", NOW, ...args]);

const issue = (id, status, holder, lease) =>
	`id = "${id}"\ntitle = "t"\nstatus = "${status}"\nkind = "Feat"\n` +
	(holder ? `holder = "${holder}"\n` : "") + (lease ? `lease = "${lease}"\n` : "");

function mkHub() {
	const hub = mkdtempSync(join(tmpdir(), "teardown-"));
	mkdirSync(join(hub, ".bais", "issues"), { recursive: true });
	writeFileSync(join(hub, ".bais", "config.toml"), 'project = "t"\n');
	return hub;
}
const putIssue = (hub, name, text) => writeFileSync(join(hub, ".bais", "issues", name), text);

const HANDOFF = `id: handoff-001
from: hero
to: titan-1
priority: 00
type: note
directed-by: operator
created_at: 2026-09-06T02:00:00Z

operator ping
`;

const MSG = (id) => `id: ${id}
from: operator
to: titan-1
priority: 00
created_at: 2026-09-06T02:00:00Z

restart: re-read t#01
`;

// 1. Stray live claim: loud with its holder (agents line fails, claims passes).
function strayLiveClaim() {
	const hub = mkHub();
	putIssue(hub, "t#09.toml", issue("t#09", "Doing", "titan-1", FUTURE));
	const r = td(hub, []);
	check("stray-live-claim", r.code === 1 && r.out.includes("TEARDOWN STRAY-CLAIM t#09 holder=titan-1 lease=" + FUTURE), `code=${r.code} ${r.out.trim().split("\n").join(" | ")}`);
	check("stray-live-claim-not-reap", !r.out.includes("REAP-NEEDED"), r.out.trim().split("\n").join(" | "));
}

// 2. Orphaned handoff: loud with its path.
function orphanedHandoff() {
	const hub = mkHub();
	putIssue(hub, "t#01.toml", issue("t#01", "Open"));
	const drops = join(hub, "deliver");
	mkdirSync(drops, { recursive: true });
	const drop = join(drops, "00_20260906T120000_001_from_hero.handoff");
	writeFileSync(drop, HANDOFF);
	const r = td(hub, ["--handoffs", drops]);
	check("orphaned-handoff", r.code === 1 && r.out.includes("TEARDOWN UNFOLDED-HANDOFF") && r.out.includes(drop), `code=${r.code} ${r.out.trim().split("\n").join(" | ")}`);
}

// 3. Clean tree: all lines pass, swarm closes.
function cleanTree() {
	const hub = mkHub();
	putIssue(hub, "t#01.toml", issue("t#01", "Open"));
	putIssue(hub, "t#02.toml", issue("t#02", "Doing", "ghost-9", PAST));
	const r0 = td(hub, []);
	// t#02 is expired — not clean yet: reap-needed must fire (setup guard).
	check("clean-setup-guard", r0.code === 1 && r0.out.includes("TEARDOWN REAP-NEEDED t#02"), `code=${r0.code}`);
	putIssue(hub, "t#02.toml", issue("t#02", "Open"));
	mkdirSync(join(hub, ".bais", "handoffs"), { recursive: true });
	const r = td(hub, []);
	check("clean-closes", r.code === 0 && r.out.includes("TEARDOWN CLOSED all 6 lines pass"), `code=${r.code} ${r.out.trim().split("\n").join(" | ")}`);
	for (const line of ["agents", "claims", "handoffs", "inbox", "processes", "files"]) {
		check(`clean-pass-${line}`, r.out.includes(`TEARDOWN PASS ${line}`), r.out.trim().split("\n").join(" | "));
	}
}

// 4. Dead claims need reap: expired names holder + reason, anonymous names unknown.
function deadClaimsNeedReap() {
	const hub = mkHub();
	putIssue(hub, "t#02.toml", issue("t#02", "Doing", "ghost-9", PAST));
	putIssue(hub, "t#03.toml", issue("t#03", "Doing"));
	const r = td(hub, []);
	check("reap-expired", r.code === 1 && r.out.includes("TEARDOWN REAP-NEEDED t#02 holder=ghost-9 reason=expired"), `code=${r.code} ${r.out.trim().split("\n").join(" | ")}`);
	check("reap-anonymous", r.out.includes("TEARDOWN REAP-NEEDED t#03 holder=unknown reason=no-lease"), r.out.trim().split("\n").join(" | "));
}

// 5. Undrained inbox + _requeue backlog: loud with owner + id.
function undrainedInbox() {
	const hub = mkHub();
	putIssue(hub, "t#01.toml", issue("t#01", "Doing", "titan-1", FUTURE));
	mkdirSync(join(hub, ".bais", "inbox", "titan-1"), { recursive: true });
	mkdirSync(join(hub, ".bais", "inbox", "_requeue", "ghost-9"), { recursive: true });
	writeFileSync(join(hub, ".bais", "inbox", "titan-1", "00_20260906T120000_001_from_operator.msg"), MSG("msg-live"));
	writeFileSync(join(hub, ".bais", "inbox", "_requeue", "ghost-9", "00_20260906T120000_001_from_operator.msg"), MSG("msg-dead"));
	const r = td(hub, []);
	check("undrained-inbox", r.code === 1 && r.out.includes("TEARDOWN UNDRAINED-INBOX titan-1 msg-live"), `code=${r.code} ${r.out.trim().split("\n").join(" | ")}`);
	check("requeue-backlog", r.out.includes("TEARDOWN REQUEUE-BACKLOG ghost-9 msg-dead"), r.out.trim().split("\n").join(" | "));
}

// 6. Dead-writer partial is a stray file (safe to delete); live --pid is a stray process.
function strayPartialAndProcess() {
	const hub = mkHub();
	putIssue(hub, "t#01.toml", issue("t#01", "Open"));
	mkdirSync(join(hub, ".bais", "handoffs"), { recursive: true });
	writeFileSync(join(hub, ".bais", "handoffs", `00_20260906T120000_001_from_hero.handoff.tmp.${DEAD_PID}`), "partial");
	const r = td(hub, ["--pid", String(process.pid)]);
	check("stray-file", r.code === 1 && r.out.includes("TEARDOWN STRAY-FILE") && r.out.includes("safe to delete"), `code=${r.code} ${r.out.trim().split("\n").join(" | ")}`);
	check("stray-process", r.out.includes(`TEARDOWN STRAY-PROCESS ${process.pid}`), r.out.trim().split("\n").join(" | "));
}

const arg = process.argv[2];
if (arg !== undefined && arg !== "--all") {
	console.log("usage: check.mjs --all");
	process.exit(1);
}
strayLiveClaim();
orphanedHandoff();
cleanTree();
deadClaimsNeedReap();
undrainedInbox();
strayPartialAndProcess();
console.log(`${pass}/${pass + fail} assertions green across 6 scenarios`);
process.exit(fail ? 1 : 0);
