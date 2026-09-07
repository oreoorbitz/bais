// bais/scripts/fixtures/inbox/check.mjs — agent inbox fixture runner (bi#149).
//
// Exercises bais/spec/inbox.md end to end over a hermetic tmp hub
// (fixed --now, so every run prints byte-identical verdicts): a live
// owner holds a Doing claim with a future lease, a dead owner holds an
// expired one. Six checks: live-owner send lands and reads back; ack
// removes (second ack fails loud); dead-owner send re-queues loud;
// handoff-validate refuses the .msg drop; inbox-validate refuses the
// .handoff drop; bad-priority .msg fails with line-numbered guidance.
// Pure ESM, zero dependencies: `node` only.
//
// Usage (run from bais/):
//   node scripts/fixtures/inbox/check.mjs --all   # all 6 checks, exit 0 iff each behaves
// Red-check: see ../inbox.mjs header (liveness-gate hunk removal turns
// check 3's expected REQUEUED into a silent DELIVERED — recorded there).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INBOX = join(HERE, "..", "..", "inbox.mjs");
const HANDOFF = join(HERE, "..", "..", "handoff-validate.mjs");
const NOW = "2026-09-06T12:00:00Z";

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
const inbox = (hub, args) => run([INBOX, ...args.map((a) => (a === "@HUB" ? hub : a))]);

const issue = (id, status, holder, lease) =>
	`id = "${id}"\ntitle = "t"\nstatus = "${status}"\nkind = "Feat"\n` +
	(holder ? `holder = "${holder}"\n` : "") + (lease ? `lease = "${lease}"\n` : "");

function mkHub() {
	const hub = mkdtempSync(join(tmpdir(), "inbox-"));
	mkdirSync(join(hub, ".bais", "issues"), { recursive: true });
	writeFileSync(join(hub, ".bais", "config.toml"), 'project = "t"\n');
	// titan-1: live (Doing + future lease vs NOW). ghost-9: dead (expired).
	writeFileSync(join(hub, ".bais", "issues", "t#01.toml"), issue("t#01", "Doing", "titan-1", "2026-09-06T14:00:00Z"));
	writeFileSync(join(hub, ".bais", "issues", "t#02.toml"), issue("t#02", "Doing", "ghost-9", "2026-09-06T10:00:00Z"));
	return hub;
}

const common = ["--hub", "@HUB", "--now", NOW];

// 1. Message to a live owner lands and reads back.
function liveLands(hub) {
	const s = inbox(hub, ["send", ...common, "--as", "operator", "--to", "titan-1", "--priority", "00", "--id", "msg-live", "--body", "restart: re-read t#01"]);
	check("live-delivered", s.code === 0 && s.out.includes("INBOX DELIVERED") && s.out.includes(".bais/inbox/titan-1/"), s.out.trim());
	const r = inbox(hub, ["read", ...common, "--as", "titan-1", "--owner", "titan-1"]);
	check("live-reads-back", r.code === 0 && r.out.includes("INBOX MESSAGE msg-live from=operator priority=00") && r.out.includes("restart: re-read t#01"), r.out.trim());
}

// 2. Ack removes; second ack fails loud; read shows it gone.
function ackSemantics(hub) {
	const a = inbox(hub, ["ack", ...common, "--as", "titan-1", "--owner", "titan-1", "msg-live"]);
	check("ack-removes", a.code === 0 && a.out.includes("INBOX ACKED msg-live"), a.out.trim());
	const r = inbox(hub, ["read", ...common, "--as", "titan-1", "--owner", "titan-1"]);
	check("read-after-ack-empty", r.code === 0 && r.out.includes("INBOX EMPTY titan-1"), r.out.trim());
	const a2 = inbox(hub, ["ack", ...common, "--as", "titan-1", "--owner", "titan-1", "msg-live"]);
	check("second-ack-loud", a2.code === 1 && a2.out.includes("INBOX NO SUCH MESSAGE msg-live"), a2.out.trim());
}

// 3. Message to a dead owner re-queues loud (never lands silent).
function deadRequeues(hub) {
	const s = inbox(hub, ["send", ...common, "--as", "operator", "--to", "ghost-9", "--priority", "00", "--id", "msg-dead", "--body", "steer for a gone agent"]);
	const okLoud = s.code === 0 && s.out.includes("INBOX REQUEUED") && s.out.includes("no live claim");
	const landed = existsSync(join(hub, ".bais", "inbox", "ghost-9", `00_20260906T120000_001_from_operator.msg`));
	const rerouted = existsSync(join(hub, ".bais", "inbox", "_requeue", "ghost-9", `00_20260906T120000_001_from_operator.msg`));
	check("dead-requeues-loud", okLoud && !landed && rerouted, s.out.trim());
}

// 4. handoff-validate refuses an inbox drop (loud, not silent).
function handoffRefusesMsg() {
	const r = run([HANDOFF, join(HERE, "00_20260906T120000_001_from_operator.msg")]);
	check("handoff-refuses-msg", r.code === 1 && r.out.includes("HANDOFF INVALID") && r.out.includes("bad filename"), r.out.trim());
}

// 5. inbox-validate refuses a handoff drop (points at handoff-validate).
function inboxRefusesHandoff() {
	const r = run([INBOX, "validate", join(HERE, "..", "00_20260906T120000_001_from_hero.handoff")]);
	check("inbox-refuses-handoff", r.code === 1 && r.out.includes("INBOX INVALID") && r.out.includes("not an inbox file"), r.out.trim());
}

// 6. Bad-priority .msg fails with line-numbered repair guidance.
function badPriorityGuidance() {
	const r = run([INBOX, "validate", join(HERE, "00_20260906T120200_003_from_operator.msg")]);
	check("bad-priority-guidance", r.code === 1 && r.out.includes("INBOX INVALID") && r.out.includes("error\t4\tbad priority") && r.out.includes("expected:"), r.out.trim());
}

const arg = process.argv[2];
if (arg !== undefined && arg !== "--all") {
	console.log("usage: check.mjs --all");
	process.exit(1);
}
const hub = mkHub();
liveLands(hub);
ackSemantics(hub);
deadRequeues(hub);
handoffRefusesMsg();
inboxRefusesHandoff();
badPriorityGuidance();
console.log(`${pass}/${pass + fail} assertions green across 6 checks`);
process.exit(fail ? 1 : 0);
