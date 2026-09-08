// bais/scripts/curator.mjs — hub#212: deterministic lifecycle sweep (canonical).
//
// Host mirror of baml_src/curator.baml — the `baml test` cases in
// baml_src/curator_test.baml are the specification this file implements.
// Hermes' curator, deterministic half: unused 30d -> stale, 90d -> archived
// (recoverable; NEVER delete), pinned and live-lease-claimed issues exempt
// (bi#56), first run records a baseline and defers every transition one
// interval. Phase 2 (LLM ConsolidateIssues) is opt-in and lives entirely in
// BAML — this script never calls it; consolidation reports are filed for
// human approval, never applied.
//
// Modes:
//   --dry-run (default)  prints a REPORT, writes nothing — no ledger, no
//                        state file, no snapshot. Safe against the real hub.
//   --apply              pre-run snapshot of the whole issues dir BEFORE any
//                        mutation, then appends to the append-only JSONL
//                        ledger (.bais/curator-ledger.jsonl) with
//                        actor/action/sha256 before-after per entry, moves
//                        Archived files to .bais/archive/, and stamps
//                        .bais/curator-state.json.
//
// Inputs (all host-derived, matching the BAML plain-data boundary):
//   activity day  = file mtime, whole days (host owns clocks)
//   pinned        = id listed in .bais/curator_pins (one per line, # comments;
//                   the strict TOML parser rejects unknown issue keys, so pins
//                   cannot live inside issue files)
//   live_lease    = holder set and lease instant > --now
//   last_sweep    = .bais/curator-state.json last_sweep_day (absent = first run)
//
// Archive never deletes: there is no unlink/rm in this file. Archive is
// fs.rename into .bais/archive/; a name collision there skips loudly
// (archive-skip ledger entry), never overwrites.
//
// RED-CHECK (bi#57): the load-bearing boundary is the 30d stale threshold —
// pinned in BAML (`idle >= curator_stale_days()` in curator.baml; flipping
// to `>` fails "30 days idle is Stale, not Active" — recorded in
// curator.baml's header) and mirrored here as `idle >= STALE_DAYS`. The
// --selftest pins the same boundary host-side: f30 flags STALE, f29 does
// not. Verified 2026-09-07 on the BAML side: flipped -> 1 FAIL (that test),
// restored -> green.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	utimesSync,
	writeFileSync,
	appendFileSync,
	copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { parseBaisFile } = await import(join(HERE, "..", "dist", "src", "toml.js"));

// Policy constants — must agree with curator_stale_days() /
// curator_archive_days() in baml_src/curator.baml.
export const STALE_DAYS = 30;
export const ARCHIVE_DAYS = 90;
export const MS_PER_DAY = 86400000;

export const dayOf = (ms) => Math.floor(ms / MS_PER_DAY);

// Unknown age never inflates: future activity clamps to fresh.
export function idleDays(issue, nowDay) {
	return Math.max(0, nowDay - issue.last_activity_day);
}

// Pure per-issue transition — mirror of CuratorTransition. Exemptions win
// over age: pinned, live lease, non-Open status.
export function curatorTransition(issue, nowDay) {
	if (issue.pinned) return "Active";
	if (issue.live_lease) return "Active";
	if (issue.status !== "Open") return "Active";
	const idle = idleDays(issue, nowDay);
	if (idle >= ARCHIVE_DAYS) return "Archived";
	if (idle >= STALE_DAYS) return "Stale"; // RED-CHECK HUNK: >= is load-bearing
	return "Active";
}

export function curatorReason(issue, nowDay, state) {
	const idle = idleDays(issue, nowDay);
	if (issue.pinned) return `pinned: exempt from lifecycle sweep (idle ${idle}d ignored)`;
	if (issue.live_lease) return `live lease: claimed issue is in use (idle ${idle}d ignored)`;
	if (issue.status !== "Open") return `status ${issue.status}: only Open issues are curated`;
	if (state === "Archived") return `idle ${idle}d >= ${ARCHIVE_DAYS}d: archive (move to .bais/archive/, never delete)`;
	if (state === "Stale") return `idle ${idle}d >= ${STALE_DAYS}d: mark stale`;
	return `idle ${idle}d < ${STALE_DAYS}d: active`;
}

export function curatorAction(issue, nowDay) {
	const state = curatorTransition(issue, nowDay);
	return {
		id: issue.id,
		state,
		idle_days: idleDays(issue, nowDay),
		action: state === "Archived" ? "Archive" : state === "Stale" ? "MarkStale" : "Keep",
		reason: curatorReason(issue, nowDay, state),
	};
}

// One sweep. lastSweepDay null = FIRST run: baseline only, every transition
// deferred one interval. Input order preserved (deterministic report).
export function curatorSweep(issues, nowDay, lastSweepDay) {
	if (lastSweepDay == null) {
		return issues.map((i) => ({
			id: i.id,
			state: "Active",
			idle_days: idleDays(i, nowDay),
			action: "Keep",
			reason: "first-run: baseline recorded, transitions deferred one interval",
		}));
	}
	return issues.map((i) => curatorAction(i, nowDay));
}

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// --- hub loading ------------------------------------------------------------

export function loadPins(hub) {
	const p = join(hub, ".bais", "curator_pins");
	if (!existsSync(p)) return new Set();
	return new Set(
		readFileSync(p, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#")),
	);
}

export function loadState(hub) {
	const p = join(hub, ".bais", "curator-state.json");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf8"));
}

export async function loadHub(hub, nowMs) {
	const issuesDir = join(hub, ".bais", "issues");
	if (!existsSync(issuesDir)) throw new Error(`curator: no .bais/issues under ${hub}`);
	const pins = loadPins(hub);
	const files = [];
	for (const name of readdirSync(issuesDir).filter((n) => n.endsWith(".toml")).sort()) {
		const path = join(issuesDir, name);
		const parsed = await parseBaisFile(readFileSync(path, "utf8"));
		const leaseMs = parsed.lease != null ? Date.parse(parsed.lease) : NaN;
		files.push({
			path,
			name,
			issue: {
				id: parsed.issue.id,
				status: parsed.issue.status,
				last_activity_day: dayOf(statSync(path).mtimeMs),
				pinned: pins.has(parsed.issue.id),
				live_lease: parsed.holder != null && Number.isFinite(leaseMs) && leaseMs > nowMs,
			},
		});
	}
	return files;
}

// --- reporting ----------------------------------------------------------------

export function summarize(actions) {
	const counts = { total: actions.length, keep: 0, stale: 0, archive: 0 };
	for (const a of actions) {
		if (a.action === "MarkStale") counts.stale++;
		else if (a.action === "Archive") counts.archive++;
		else counts.keep++;
	}
	return counts;
}

export function formatReport({ hub, nowIso, mode, firstRun, actions }) {
	const c = summarize(actions);
	const lines = [
		`curator report — hub ${hub} @ ${nowIso}`,
		`mode: ${mode}`,
		`sweep: ${firstRun ? "first-run baseline (transitions deferred one interval)" : "steady-state"}`,
		`issues: ${c.total}\tactive/kept: ${c.keep}\tstale: ${c.stale}\tarchived: ${c.archive}`,
	];
	for (const a of actions) {
		if (a.action === "Keep") continue;
		lines.push(`${a.id}\t${a.action === "MarkStale" ? "STALE" : "ARCHIVE"}\t${a.reason}`);
	}
	lines.push(`summary: curator ${mode}: ${c.total} issues, ${c.stale} stale, ${c.archive} archived`);
	return lines.join("\n") + "\n";
}

// --- live run -------------------------------------------------------------------

function ledgerAppend(hub, entry) {
	appendFileSync(join(hub, ".bais", "curator-ledger.jsonl"), JSON.stringify(entry) + "\n");
}

function snapshotIssues(hub, nowIso, actor) {
	const issuesDir = join(hub, ".bais", "issues");
	const snapDir = join(hub, ".bais", "curator", "snapshots", nowIso.replace(/[:.]/g, "-"));
	mkdirSync(join(snapDir, "issues"), { recursive: true });
	const manifest = { ts: nowIso, actor, kind: "curator-pre-run-snapshot", files: [] };
	for (const name of readdirSync(issuesDir).filter((n) => n.endsWith(".toml")).sort()) {
		const src = join(issuesDir, name);
		copyFileSync(src, join(snapDir, "issues", name));
		manifest.files.push({ path: `.bais/issues/${name}`, sha256: sha256hex(readFileSync(src)) });
	}
	writeFileSync(join(snapDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	return { snapDir, manifest };
}

export function applyActions(hub, files, actions, { nowMs, nowIso, nowDay, actor }) {
	const archiveDir = join(hub, ".bais", "archive");
	const byId = new Map(files.map((f) => [f.issue.id, f]));
	// Pre-run snapshot BEFORE any mutation.
	const { snapDir, manifest } = snapshotIssues(hub, nowIso, actor);
	ledgerAppend(hub, {
		ts: nowIso, actor, action: "snapshot", path: snapDir,
		files: manifest.files.length, sha256: sha256hex(JSON.stringify(manifest.files)),
	});
	for (const a of actions) {
		const f = byId.get(a.id);
		if (a.action === "MarkStale") {
			// Stale is a ledger designation only — the issue file is not
			// rewritten (Status has no Stale variant; `bais list` stays true).
			const sha = sha256hex(readFileSync(f.path));
			ledgerAppend(hub, { ts: nowIso, actor, action: "mark-stale", id: a.id, before_sha256: sha, after_sha256: sha, reason: a.reason });
		} else if (a.action === "Archive") {
			mkdirSync(archiveDir, { recursive: true });
			const before = sha256hex(readFileSync(f.path));
			const target = join(archiveDir, f.name);
			if (existsSync(target)) {
				// Loud skip, never overwrite: an archived file with this name
				// already exists — a human resolves the collision.
				ledgerAppend(hub, { ts: nowIso, actor, action: "archive-skip", id: a.id, before_sha256: before, after_sha256: null, reason: `archive target exists: .bais/archive/${f.name}` });
				continue;
			}
			renameSync(f.path, target);
			ledgerAppend(hub, {
				ts: nowIso, actor, action: "archive", id: a.id,
				from: `.bais/issues/${f.name}`, to: `.bais/archive/${f.name}`,
				before_sha256: before, after_sha256: sha256hex(readFileSync(target)), reason: a.reason,
			});
		}
	}
	writeFileSync(
		join(hub, ".bais", "curator-state.json"),
		JSON.stringify({ last_sweep_day: nowDay, last_sweep_at: nowIso, actor }, null, 2) + "\n",
	);
	const c = summarize(actions);
	ledgerAppend(hub, { ts: nowIso, actor, action: "sweep", issues: c.total, stale: c.stale, archived: c.archive, kept: c.keep });
	return { snapDir };
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
	const opt = { hub: ".", apply: false, json: false, nowMs: Date.now(), actor: process.env.USER ?? "curator" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--hub") opt.hub = argv[++i];
		else if (a === "--apply") opt.apply = true;
		else if (a === "--dry-run") opt.apply = false;
		else if (a === "--json") opt.json = true;
		else if (a === "--now") {
			opt.nowMs = Date.parse(argv[++i]);
			if (!Number.isFinite(opt.nowMs)) throw new Error(`curator: bad --now instant`);
		} else if (a === "--actor") opt.actor = argv[++i];
		else throw new Error(`curator: unknown flag ${a} (usage: curator.mjs [--hub <path>] [--dry-run|--apply] [--now <RFC3339>] [--actor <name>] [--json] [--selftest])`);
	}
	return opt;
}

async function main() {
	const opt = parseArgs(process.argv.slice(2));
	const nowDay = dayOf(opt.nowMs);
	const nowIso = new Date(opt.nowMs).toISOString();
	const files = await loadHub(opt.hub, opt.nowMs);
	const state = loadState(opt.hub);
	const firstRun = state == null;
	const actions = curatorSweep(files.map((f) => f.issue), nowDay, state?.last_sweep_day ?? null);
	const mode = opt.apply ? "apply" : "dry-run";
	if (opt.json) {
		console.log(JSON.stringify({ hub: opt.hub, now: nowIso, mode, first_run: firstRun, counts: summarize(actions), actions }, null, 2));
	} else {
		process.stdout.write(formatReport({ hub: opt.hub, nowIso, mode, firstRun, actions }));
	}
	if (opt.apply) {
		const { snapDir } = applyActions(opt.hub, files, actions, { nowMs: opt.nowMs, nowIso, nowDay, actor: opt.actor });
		console.error(`curator: snapshot ${snapDir}`);
		console.error(`curator: ledger ${join(opt.hub, ".bais", "curator-ledger.jsonl")} appended (actor ${opt.actor})`);
	}
}

// --- --selftest ---------------------------------------------------------------
// Fixture-only, /tmp only, every instant injected. Mirrors the BAML boundary
// tests host-side and proves the file contracts: dry-run writes nothing,
// first-run defers, live appends (never truncates), snapshot precedes
// mutation, archive moves and NEVER deletes.
if (process.argv[1] && process.argv[1].endsWith("curator.mjs") && process.argv.includes("--selftest")) {
	let failures = 0;
	// mustNot(failCond, msg): first arg is the FAILURE condition — the message
	// names the desired property, so a FAIL line reads "property violated".
	const mustNot = (failCond, msg) => {
		if (!failCond) console.log(`ok selftest: ${msg}`);
		else { failures++; console.error(`FAIL selftest: ${msg}`); }
	};
	const NOW = Date.parse("2026-09-07T00:00:00Z");
	const NOW_ISO = new Date(NOW).toISOString();
	const NOW_DAY = dayOf(NOW);
	const hub = mkdtempSync(join(tmpdir(), "curator-"));
	mkdirSync(join(hub, ".bais", "issues"), { recursive: true });
	writeFileSync(join(hub, ".bais", "config.toml"), 'project = "t"\n');
	const issueToml = (id, extra = "") => `id = "${id}"\ntitle = "${id}"\nstatus = "Open"\nkind = "Feat"\n${extra}body = "b"\n`;
	const put = (id, idleDaysAgo, extra = "") => {
		const p = join(hub, ".bais", "issues", `${id}.toml`);
		writeFileSync(p, issueToml(id, extra));
		const m = new Date(NOW - idleDaysAgo * MS_PER_DAY);
		utimesSync(p, m, m);
	};
	put("f#29", 29);
	put("f#30", 30);
	put("f#89", 89);
	put("f#90", 90);
	put("f#200", 200);
	put("f#pin", 200);
	put("f#lease", 200, 'holder = "agent-1"\nlease = "2026-09-08T00:00:00Z"\n');
	writeFileSync(join(hub, ".bais", "curator_pins"), "# pinned exemptions\nf#pin\n");

	const files = await loadHub(hub, NOW);
	const issues = files.map((f) => f.issue);
	const byId = (list, id) => list.find((a) => a.id === id);

	// Transitions mirror the BAML boundaries.
	mustNot(curatorTransition(byId(issues, "f#29"), NOW_DAY) !== "Active", "f#29 (29d idle) is Active");
	mustNot(curatorTransition(byId(issues, "f#30"), NOW_DAY) !== "Stale", "f#30 (30d idle) is Stale");
	mustNot(curatorTransition(byId(issues, "f#89"), NOW_DAY) !== "Stale", "f#89 (89d idle) is Stale, not Archived");
	mustNot(curatorTransition(byId(issues, "f#90"), NOW_DAY) !== "Archived", "f#90 (90d idle) is Archived");
	mustNot(curatorTransition(byId(issues, "f#pin"), NOW_DAY) !== "Active", "f#pin (pinned, 200d) is exempt");
	mustNot(curatorTransition(byId(issues, "f#lease"), NOW_DAY) !== "Active", "f#lease (live lease, 200d) is exempt");

	// Dry-run: report only, writes nothing.
	const report = formatReport({ hub, nowIso: NOW_ISO, mode: "dry-run", firstRun: true, actions: curatorSweep(issues, NOW_DAY, null) });
	mustNot(!/first-run baseline/.test(report), "dry-run report names first-run baseline");
	mustNot(existsSync(join(hub, ".bais", "curator-ledger.jsonl")), "dry-run writes no ledger");
	mustNot(existsSync(join(hub, ".bais", "curator-state.json")), "dry-run writes no state file");

	// Live run 1: first-run defers everything but stamps state + ledger.
	let actions = curatorSweep(issues, NOW_DAY, loadState(hub)?.last_sweep_day ?? null);
	mustNot(actions.some((a) => a.action !== "Keep"), "first run: every action is Keep (deferred)");
	applyActions(hub, files, actions, { nowMs: NOW, nowIso: NOW_ISO, nowDay: NOW_DAY, actor: "selftest" });
	mustNot(loadState(hub)?.last_sweep_day !== NOW_DAY, "first run stamps curator-state.json");
	mustNot(!existsSync(join(hub, ".bais", "curator", "snapshots")), "first run took a pre-run snapshot");
	const ledger1 = readFileSync(join(hub, ".bais", "curator-ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	mustNot(!ledger1.some((e) => e.action === "snapshot" && e.actor === "selftest"), "ledger records the snapshot with actor");
	mustNot(!ledger1.some((e) => e.action === "sweep"), "ledger records the sweep summary");
	mustNot(!existsSync(join(hub, ".bais", "issues", "f#200.toml")), "first run archives nothing (f#200 still in issues/)");

	// Live run 2 (steady-state): stale marked, 90d+ moved to archive/.
	const files2 = await loadHub(hub, NOW);
	const actions2 = curatorSweep(files2.map((f) => f.issue), NOW_DAY, loadState(hub)?.last_sweep_day ?? null);
	mustNot(byId(actions2, "f#30")?.action !== "MarkStale", "second run: f#30 MarkStale");
	mustNot(byId(actions2, "f#200")?.action !== "Archive", "second run: f#200 Archive");
	mustNot(byId(actions2, "f#pin")?.action !== "Keep", "second run: f#pin still Keep (pinned)");
	applyActions(hub, files2, actions2, { nowMs: NOW, nowIso: NOW_ISO, nowDay: NOW_DAY, actor: "selftest" });
	mustNot(existsSync(join(hub, ".bais", "issues", "f#200.toml")), "f#200 moved out of issues/");
	mustNot(!existsSync(join(hub, ".bais", "archive", "f#200.toml")), "f#200 landed in .bais/archive/ (moved, never deleted)");
	mustNot(!existsSync(join(hub, ".bais", "issues", "f#30.toml")), "f#30 file untouched (stale is a ledger designation)");
	const ledger2 = readFileSync(join(hub, ".bais", "curator-ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	mustNot(ledger2.length <= ledger1.length, "ledger is append-only (grows, never truncates)");
	const arch = ledger2.find((e) => e.action === "archive" && e.id === "f#200");
	mustNot(arch == null || arch.before_sha256 !== arch.after_sha256, "archive ledger entry: sha256 before == after (content preserved by the move)");
	const stale = ledger2.find((e) => e.action === "mark-stale" && e.id === "f#30");
	mustNot(stale == null || stale.before_sha256 !== stale.after_sha256, "mark-stale ledger entry carries before/after sha256");

	console.log(failures === 0 ? "curator selftest: all green" : `${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("curator.mjs") && !process.argv.includes("--selftest")) {
	main().catch((e) => {
		console.error(`curator: ${e.message}`);
		process.exit(2);
	});
}
