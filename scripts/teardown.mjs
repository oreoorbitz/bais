// bais/scripts/teardown.mjs — close-swarm protocol checker (bi#141).
//
// No teardown existed: killed sessions could orphan processes, handoffs
// could rot in /tmp, claims could linger past their agents. This module
// is the scripts-lane half of the close-swarm protocol: a READ-ONLY
// checker over a hub root. It never reaps, drains, kills, or deletes —
// it reports each checklist line loud so the operator (or the merger)
// can close it. Draining/re-queueing itself runs through inbox semantics
// (bais/spec/inbox.md §§5-6: dead-owner mail reroutes to _requeue loud,
// live mail drains via read+ack); this checker verifies the result.
//
// Lines (one verdict per line, always printed):
//   agents    — no live Doing claims (Doing + holder + future lease, the
//               same liveness rule as inbox.md §4 and the dispatcher lease
//               filter). A live claim at teardown is an agent not stopped.
//               Loud: TEARDOWN STRAY-CLAIM <issue> holder=<h> lease=<l>.
//               (BAIS sessions ARE lease-bound claims — claim.mjs + hub —
//               so this line also covers "sessions killed" for the claim
//               half; the OS half is `processes` below.)
//   claims    — no dead Doing claims awaiting reap (expired / unparseable /
//               missing lease, or anonymous bare-Doing). Loud with issue +
//               holder-or-unknown + reason; reap returns them to Open.
//   handoffs  — no unfolded *.handoff under the handoff dirs (--handoffs,
//               plus <hub>/.bais/handoffs when present). Folded-or-returned
//               means gone from the dir; anything left is loud with path.
//   inbox     — owner queues drained (.bais/inbox/<owner>/*.msg) and no
//               _requeue/<owner>/* backlog awaiting operator triage. Loud
//               with owner + id + path.
//   processes — every probed pid dead. Pids come from --pid (operator-named
//               sessions) plus writers harvested from *.tmp.<pid> partials
//               (the handoff.md §5 / inbox.md §1 atomic-write discipline).
//               kill(pid, 0) alive → TEARDOWN STRAY-PROCESS <pid> (loud).
//   files     — no *.tmp.<pid> partial writes under the scanned dirs. A
//               partial whose writer is gone is still a stray file, but the
//               verdict says so (safe to delete); writer-live partials are
//               listed under `processes` too.
//
// Missing hub root or missing .bais/ is TEARDOWN REFUSED, exit 2 (a typo'd
// --hub must never read as clean). Missing subdirs (issues/inbox/handoffs)
// pass with a named reason — never silent, never fail-closed (bi#55).
//
// Usage (run from bais/):
//   node scripts/teardown.mjs check --hub <root> [--handoffs <dir>...]
//     [--pid <n>...] [--now <RFC3339-Z>]
// Operator close-out:
//   node scripts/teardown.mjs check --hub <hub> --handoffs /tmp/<task>-deliver
// Exit 0 + TEARDOWN CLOSED when every line passes; exit 1 + TEARDOWN OPEN
// naming each violation; exit 2 on refused usage. Pure ESM, zero
// dependencies: `node` only. --now pins the clock for hermetic fixtures.
//
// CHECK-COMMAND WIRING (not this file — needs bais/src/cli.ts, outside
// this lane's footprint; briefs.mjs precedent): `bais close-swarm [--hub
// <root>] [--handoffs <dir>...] [--pid <n>...] [--now <ts>]` maps 1:1 onto
// `check` above with --hub defaulting to the hub root. Until then the
// operator runs the node line directly.
//
// Red-check (bi#57, recorded 2026-09-06 by teard-141): removed the
// stray-claim fail branch in checkAgents (live claims reported as PASS),
// then ran the fixture gate over untouched fixtures: scenario 1 went red
// with `FAIL stray-live-claim (code 0, no STRAY-CLAIM line)` — a live
// agent at teardown read as clean, the exact rot this line exists to
// prevent; with the hunk restored all assertions return to green. A gate
// that cannot go red on a live claim is camouflage, not coverage.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";

const HANDOFF_SUFFIX = ".handoff";
const MSG_SUFFIX = ".msg";

/** Top-level `key = "value"` TOML string fields (same shape as inbox.mjs). */
export function parseIssueFields(text) {
	const fields = {};
	for (const line of text.split("\n")) {
		const m = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line.trim());
		if (m) fields[m[1]] = m[2];
	}
	return fields;
}

/**
 * Claim liveness (inbox.md §4, dispatcher lease filter): status Doing +
 * holder + parseable future lease. Missing/unparseable/expired/anonymous/
 * non-Doing all read as dead.
 */
export function claimState(fields, nowMs) {
	if (fields.status !== "Doing") return { live: false, reason: "not-doing" };
	if (!fields.holder) return { live: false, reason: "no-lease" };
	const exp = Date.parse(fields.lease ?? "");
	if (!Number.isFinite(exp)) return { live: false, reason: "no-lease" };
	if (exp <= nowMs) return { live: false, reason: "expired" };
	return { live: true, reason: "live" };
}

function readIssues(hub) {
	const dir = join(hub, ".bais", "issues");
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".toml")).sort();
	} catch {
		return null;
	}
	return files.map((f) => ({ file: f, id: f.replace(/\.toml$/, ""), fields: parseIssueFields(readFileSync(join(dir, f), "utf8")) }));
}

function checkAgents(issues, nowMs) {
	const out = [];
	if (issues === null) {
		out.push("TEARDOWN PASS agents (no .bais/issues dir; nothing can hold a claim)");
		return { out, fail: 0 };
	}
	let fail = 0;
	for (const { id, fields } of issues) {
		const st = claimState(fields, nowMs);
		if (st.live) {
			fail++;
			out.push(`TEARDOWN STRAY-CLAIM ${id} holder=${fields.holder} lease=${fields.lease} (agent not stopped; stop it or wait for expiry then reap)`);
		}
	}
	if (!fail) out.push(`TEARDOWN PASS agents (no live claims across ${issues.length} issue(s))`);
	return { out, fail };
}

function checkClaims(issues, nowMs) {
	const out = [];
	if (issues === null) {
		out.push("TEARDOWN PASS claims (no .bais/issues dir; nothing to reap)");
		return { out, fail: 0 };
	}
	let fail = 0;
	for (const { id, fields } of issues) {
		if (fields.status !== "Doing") continue;
		const st = claimState(fields, nowMs);
		if (!st.live) {
			fail++;
			out.push(`TEARDOWN REAP-NEEDED ${id} holder=${fields.holder ?? "unknown"} reason=${st.reason} (claim not reaped; reap returns it to Open)`);
		}
	}
	if (!fail) out.push("TEARDOWN PASS claims (no Doing issue awaiting reap)");
	return { out, fail };
}

function handoffDirs(hub, extra) {
	const dirs = [];
	const def = join(hub, ".bais", "handoffs");
	if (existsSync(def)) dirs.push(def);
	for (const d of extra) dirs.push(resolve(d));
	return dirs;
}

function checkHandoffs(dirs) {
	const out = [];
	if (!dirs.length) {
		out.push("TEARDOWN PASS handoffs (no handoff dir; pass --handoffs /tmp/<task>-deliver to scan drops)");
		return { out, fail: 0 };
	}
	let fail = 0;
	for (const dir of dirs) {
		let files;
		try {
			files = readdirSync(dir).sort();
		} catch {
			out.push(`TEARDOWN PASS handoffs (${dir} unreadable-or-missing; nothing folded there)`);
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(HANDOFF_SUFFIX)) continue;
			const p = join(dir, f);
			try {
				if (!statSync(p).isFile()) continue;
			} catch { continue; }
			fail++;
			out.push(`TEARDOWN UNFOLDED-HANDOFF ${p} (fold it or return it before closing)`);
		}
	}
	if (!fail) out.push(`TEARDOWN PASS handoffs (no unfolded *.handoff in ${dirs.length} dir(s))`);
	return { out, fail };
}

function msgId(path) {
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const m = /^([A-Za-z0-9_-]+): (.*)$/.exec(line);
			if (!m) break;
			if (m[1] === "id") return m[2];
		}
	} catch { /* fall through */ }
	return "?";
}

function checkInbox(hub) {
	const out = [];
	const root = join(hub, ".bais", "inbox");
	let owners;
	try {
		owners = readdirSync(root).sort();
	} catch {
		out.push("TEARDOWN PASS inbox (no .bais/inbox dir; no queues to drain)");
		return { out, fail: 0 };
	}
	let fail = 0;
	for (const owner of owners) {
		if (owner === "_requeue") continue;
		const dir = join(root, owner);
		let files;
		try { files = readdirSync(dir).filter((f) => f.endsWith(MSG_SUFFIX)).sort(); }
		catch { continue; }
		for (const f of files) {
			fail++;
			out.push(`TEARDOWN UNDRAINED-INBOX ${owner} ${msgId(join(dir, f))} ${join(dir, f)} (drain via inbox read+ack or re-queue to Open)`);
		}
	}
	const rq = join(root, "_requeue");
	let rqOwners = [];
	try { rqOwners = readdirSync(rq).sort(); } catch { rqOwners = []; }
	for (const owner of rqOwners) {
		const dir = join(rq, owner);
		let files;
		try { files = readdirSync(dir).filter((f) => f.endsWith(MSG_SUFFIX)).sort(); }
		catch { continue; }
		for (const f of files) {
			fail++;
			out.push(`TEARDOWN REQUEUE-BACKLOG ${owner} ${msgId(join(dir, f))} ${join(dir, f)} (operator triage before closing)`);
		}
	}
	if (!fail) out.push("TEARDOWN PASS inbox (queues drained, no _requeue backlog)");
	return { out, fail };
}

/** Collect *.tmp.<pid> partials under dirs (recursive walk). */
function collectPartials(dirs) {
	const found = [];
	const seen = new Set();
	const walk = (dir) => {
		if (seen.has(dir)) return;
		seen.add(dir);
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) { walk(p); continue; }
			if (!e.isFile()) continue;
			const m = /\.tmp\.([0-9]+)$/.exec(e.name);
			if (m) found.push({ path: p, pid: Number(m[1]) });
		}
	};
	for (const d of dirs) walk(d);
	return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function checkProcesses(namedPids, partials) {
	const out = [];
	let fail = 0;
	for (const pid of namedPids) {
		if (pidAlive(pid)) {
			fail++;
			out.push(`TEARDOWN STRAY-PROCESS ${pid} (named via --pid; session not killed)`);
		}
	}
	for (const { path, pid } of partials) {
		if (pidAlive(pid)) {
			fail++;
			out.push(`TEARDOWN STRAY-PROCESS ${pid} (writer of ${path} still alive; session not killed)`);
		}
	}
	if (!fail) {
		const n = namedPids.length + partials.length;
		out.push(`TEARDOWN PASS processes (no live pids across ${n} probed)`);
	}
	return { out, fail };
}

function checkFiles(partials) {
	const out = [];
	let fail = 0;
	for (const { path, pid } of partials) {
		fail++;
		const note = pidAlive(pid)
			? `writer ${pid} live (stop it first)`
			: `writer ${pid} gone (safe to delete)`;
		out.push(`TEARDOWN STRAY-FILE ${path} (partial write; ${note})`);
	}
	if (!fail) out.push("TEARDOWN PASS files (no *.tmp.<pid> partials under scanned dirs)");
	return { out, fail };
}

function parseOpts(argv) {
	const o = { handoffs: [], pid: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--hub") o.hub = argv[++i];
		else if (a === "--handoffs") o.handoffs.push(argv[++i]);
		else if (a === "--pid") o.pid.push(Number(argv[++i]));
		else if (a === "--now") o.now = argv[++i];
		else if (!a.startsWith("--") && o._pos === undefined) o._pos = a;
	}
	return o;
}

export function checkSwarm({ hub, handoffs = [], pids = [], nowMs = Date.now() }) {
	if (!hub || !existsSync(join(hub, ".bais"))) {
		return { code: 2, lines: [`TEARDOWN REFUSED missing hub ${JSON.stringify(hub ?? "(none)")} (pass --hub <root> holding .bais/)`] };
	}
	const lines = [];
	let fail = 0;
	const issues = readIssues(hub);
	for (const r of [checkAgents(issues, nowMs), checkClaims(issues, nowMs)]) {
		lines.push(...r.out);
		fail += r.fail;
	}
	const dirs = handoffDirs(hub, handoffs);
	const rh = checkHandoffs(dirs);
	lines.push(...rh.out);
	fail += rh.fail;
	const ri = checkInbox(hub);
	lines.push(...ri.out);
	fail += ri.fail;
	const partials = collectPartials([join(hub, ".bais"), ...dirs]);
	const rp = checkProcesses(pids, partials);
	lines.push(...rp.out);
	fail += rp.fail;
	const rf = checkFiles(partials);
	lines.push(...rf.out);
	fail += rf.fail;
	const names = ["agents", "claims", "handoffs", "inbox", "processes", "files"];
	if (fail) lines.push(`TEARDOWN OPEN ${fail} violation(s) across ${names.join(",")} (close each line above before closing the swarm)`);
	else lines.push(`TEARDOWN CLOSED all ${names.length} lines pass (${names.join(",")})`);
	return { code: fail ? 1 : 0, lines };
}

const isMain = process.argv[1] != null && basename(process.argv[1]) === "teardown.mjs";
if (isMain) {
	const [sub, ...rest] = process.argv.slice(2);
	const o = parseOpts(rest);
	const hub = o.hub ?? process.cwd();
	if (sub !== "check" && sub !== undefined) {
		console.log("usage: teardown.mjs check --hub <root> [--handoffs <dir>...] [--pid <n>...] [--now <RFC3339-Z>]");
		process.exit(2);
	}
	let nowMs = Date.now();
	if (o.now != null) {
		nowMs = Date.parse(o.now);
		if (!Number.isFinite(nowMs)) {
			console.log(`TEARDOWN REFUSED bad --now ${JSON.stringify(o.now)} (expected RFC3339 UTC)`);
			process.exit(2);
		}
	}
	const badPid = o.pid.find((n) => !Number.isInteger(n) || n <= 0);
	if (badPid !== undefined) {
		console.log(`TEARDOWN REFUSED bad --pid ${JSON.stringify(String(badPid))} (expected positive integer)`);
		process.exit(2);
	}
	const { code, lines } = checkSwarm({ hub, handoffs: o.handoffs, pids: o.pid, nowMs });
	for (const l of lines) console.log(l);
	process.exit(code);
}
