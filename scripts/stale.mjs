// bais/scripts/stale.mjs — bi#80: deterministic stale-issue pruning (canonical).
//
// `bais stale` flags prune/archive candidates with named reasons and NEVER
// auto-closes (moves stay explicit per bi#55). Pure functions over injected
// data only — issue files, mtimes, graph edges, and pre-gathered repo facts.
// No LLM judgment, no filesystem reads inside the predicates (the CLI caller
// gathers facts; the --selftest injects fixture facts), so every rule is a
// deterministic function of its arguments plus --now/--days.
//
// Flag rules:
//   (1) UNBLOCKED-IDLE: Open, >= 1 DependsOn edge, every DependsOn target
//       Done/Dropped, file mtime older than N days (--days, default 30).
//       The >= 1-dep guard is deliberate: a dep-less Open issue is merely
//       ready, not unblocked-after-blocked (that is `ready`'s beat, and
//       flagging all of it would drown the prune list).
//   (2) SHIPPED-COUNT: body states a countable claim a script re-verifies
//       false today, any status. Verifiers (registry-total, file-lines)
//       take pre-gathered facts, so the predicate stays pure.
//   (3) SHIPPED: Done/Dropped whose body carries a dated closure note
//       (Closed/Sweep/SUPERSEDED + YYYY-MM-DD) — landed work, archive
//       candidate (the bi#136 loop). Content-based, no mtime gate. This is
//       the "-or-shipped" bucket bi#80's acceptance names: Done issues can
//       never be UNBLOCKED-IDLE (Open-only by definition), so landed work
//       flags here instead.
//   (4) EPIC-DRIFT: Open issue titled/kinded "epic" with >= 1 child and
//       every linked child Done/Dropped. Children = DependsOn edges
//       pointing at the epic + Blocks edges sourced at the epic.
//   (5) PARKED-TYPO: a DependsOn/Blocks edge naming a Missing id. The
//       Missing set is INJECTED — the CLI builds it with the same
//       danglingRefsIn() predicate `bais check` uses, so the two commands
//       cannot disagree (deduplicated by construction, never re-derived
//       here). External (cross-project) refs never flag.
//
// Output: candidates [{id, rule, reason}] sorted by (id, rule). Reasons are
// single-line (tabs/newlines collapsed) for the TSV render. Exit contract
// (CLI): candidates>0 -> exit 1 so CI can pin zero-stale; empty -> exit 0.
//
// RED-CHECK (bi#57, bi#80): the load-bearing hunk is the registry-total
// comparison in shippedCountReasons (claimed !== registryCount). Reverting
// it to always-equal must trip the selftest with exactly:
//   "FAIL selftest: bi#31 flags SHIPPED-COUNT (registry 6+17=23 vs 34)"
// (verified 2026-09-06: comparison neutered -> that FAIL observed -> restored).

export const STALE_RULES = ["UNBLOCKED-IDLE", "SHIPPED-COUNT", "SHIPPED", "EPIC-DRIFT", "PARKED-TYPO"];

export const TERMINAL = new Set(["Done", "Dropped"]);
export const MS_PER_DAY = 86400000;

// Single-line a reason for TSV (collapse tabs/newlines/runs of whitespace).
export function oneLine(s) {
	return String(s ?? "").replace(/\s+/g, " ").trim();
}

// --- rule (1): UNBLOCKED-IDLE -------------------------------------------
export function unblockedIdleReasons(files, mtimes, days, nowMs) {
	const byId = new Map(files.map((f) => [f.issue.id, f.issue]));
	const out = [];
	for (const f of files) {
		if (f.issue.status !== "Open") continue;
		const deps = (f.edges ?? []).filter((e) => e.kind === "DependsOn" && e.from === f.issue.id);
		if (deps.length === 0) continue;
		const targets = deps.map((e) => e.to);
		if (!targets.every((t) => TERMINAL.has(byId.get(t)?.status ?? ""))) continue;
		const mtime = mtimes.get(f.issue.id);
		if (mtime == null) continue; // unknown age never inflates staleness
		const idleDays = Math.floor((nowMs - mtime) / MS_PER_DAY);
		if (idleDays < days) continue;
		out.push({
			id: f.issue.id,
			rule: "UNBLOCKED-IDLE",
			reason: oneLine(`unblocked-idle ${idleDays}d: deps ${targets.join(",")} all Done/Dropped, no touch since ${new Date(mtime).toISOString().slice(0, 10)}`),
		});
	}
	return out;
}

// --- rule (2): SHIPPED-COUNT --------------------------------------------
// facts: { registryCount: number|null, fileLines: Map<resolvedPath, number>|null,
//          resolveFile: (claimed:string) => resolvedPath|null }
// resolveFile maps a body-claimed filename to the facts key (CLI: hub-root
// candidates); null = unresolvable, verifier skips (never a false positive).
export function shippedCountReasons(files, facts = {}) {
	const { registryCount = null, fileLines = null, resolveFile = null } = facts;
	const out = [];
	for (const f of files) {
		const body = f.issue.body ?? "";
		// Verifier R1: slash-registry total. "Bi has 6 builtin slashes ...
		// Port the missing 17" claims have+missing == registry size today.
		const have = /(\d+)\s+builtin slashes/i.exec(body);
		const missing = /(?:port\s+the\s+)?missing\s+(\d+)/i.exec(body);
		if (have && missing && registryCount != null) {
			const claimed = Number(have[1]) + Number(missing[1]);
			if (claimed !== registryCount) {
				out.push({
					id: f.issue.id,
					rule: "SHIPPED-COUNT",
					reason: oneLine(`shipped-count: body claims ${have[1]} builtin + missing ${missing[1]} = ${claimed} slashes, registry holds ${registryCount}`),
				});
			}
		}
		// Verifier R2: file line counts. "Bi `session.ts` is 66 lines".
		const lineRe = /`?([\w][\w./-]*\.ts)`?\s+is\s+(\d+)\s+lines?/g;
		let m;
		while ((m = lineRe.exec(body)) !== null) {
			if (fileLines == null || resolveFile == null) break;
			const key = resolveFile(m[1]);
			if (key == null || !fileLines.has(key)) continue;
			const actual = fileLines.get(key);
			if (actual !== Number(m[2])) {
				out.push({
					id: f.issue.id,
					rule: "SHIPPED-COUNT",
					reason: oneLine(`shipped-count: body claims ${m[1]} is ${m[2]} lines, today ${actual}`),
				});
			}
		}
	}
	return out;
}

// --- rule (3): SHIPPED ---------------------------------------------------
// Dated closure notes: "Closed 2026-09-05 (sweep)", "Sweep 2026-09-05:",
// "SUPERSEDED (closed 2026-09-05, ...)", "Dropped 2026-09-05 (sweep)".
const CLOSURE_RE = /(closed|sweep|superseded)[^\n]{0,48}(\d{4}-\d{2}-\d{2})/i;
export function shippedReasons(files) {
	const out = [];
	for (const f of files) {
		if (!TERMINAL.has(f.issue.status)) continue;
		const m = CLOSURE_RE.exec(f.issue.body ?? "");
		if (!m) continue;
		out.push({
			id: f.issue.id,
			rule: "SHIPPED",
			reason: oneLine(`shipped ${m[2]}: ${f.issue.status} with dated closure note (${m[1].toLowerCase()}), archive candidate`),
		});
	}
	return out;
}

// --- rule (4): EPIC-DRIFT ------------------------------------------------
export function epicDriftReasons(files) {
	const byId = new Map(files.map((f) => [f.issue.id, f.issue]));
	const out = [];
	for (const f of files) {
		if (f.issue.status !== "Open") continue;
		if (!/epic/i.test(`${f.issue.title ?? ""} ${f.issue.kind ?? ""}`)) continue;
		const children = new Set();
		for (const g of files) {
			for (const e of g.edges ?? []) {
				if (e.kind === "DependsOn" && e.to === f.issue.id && e.from !== f.issue.id) children.add(e.from);
				if (e.kind === "Blocks" && e.from === f.issue.id && e.to !== f.issue.id) children.add(e.to);
			}
		}
		if (children.size === 0) continue;
		const open = [...children].filter((c) => !TERMINAL.has(byId.get(c)?.status ?? ""));
		if (open.length > 0) continue;
		out.push({
			id: f.issue.id,
			rule: "EPIC-DRIFT",
			reason: oneLine(`epic-drift: epic Open while all ${children.size} linked children Done/Dropped (${[...children].sort().join(",")})`),
		});
	}
	return out;
}

// --- rule (5): PARKED-TYPO -----------------------------------------------
// missingRefs: [{declaredBy, id, side, kind, from, to}] — Missing only,
// built by the caller with check's own dangling predicate.
export function parkedTypoReasons(files, missingRefs = []) {
	const byFile = new Map();
	for (const r of missingRefs) {
		if (!byFile.has(r.declaredBy)) byFile.set(r.declaredBy, []);
		byFile.get(r.declaredBy).push(r);
	}
	const known = new Set(files.map((f) => f.issue.id));
	const out = [];
	for (const f of files) {
		for (const r of byFile.get(f.issue.id) ?? []) {
			if (!known.has(f.issue.id)) continue;
			out.push({
				id: f.issue.id,
				rule: "PARKED-TYPO",
				reason: oneLine(`parked-typo: ${r.kind} ${r.from} -> ${r.to} names Missing id ${r.side}=${r.id} (also reported by bais check as dangling)`),
			});
		}
	}
	return out;
}

// --- driver ---------------------------------------------------------------
export function staleCandidates({ files, mtimes = new Map(), missingRefs = [], facts = {}, days = 30, nowMs = Date.now() }) {
	const all = [
		...unblockedIdleReasons(files, mtimes, days, nowMs),
		...shippedCountReasons(files, facts),
		...shippedReasons(files),
		...epicDriftReasons(files),
		...parkedTypoReasons(files, missingRefs),
	];
	all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
	return all;
}

export function formatTsv(cands) {
	return cands.map((c) => `${c.id}\t${c.rule}\t${c.reason}`).join("\n") + (cands.length ? "\n" : "");
}

// --- --selftest ------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("stale.mjs") && process.argv.includes("--selftest")) {
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) { failures++; console.error(`FAIL selftest: ${msg}`); }
		else console.log(`ok selftest: ${msg}`);
	};
	const F = (id, status, body, edges = []) => ({ issue: { id, title: id, status, kind: "Feat", body }, edges });
	const NOW = Date.parse("2026-09-06T19:30:00Z");
	const DAY = MS_PER_DAY;
	const mt = (daysAgo) => NOW - daysAgo * DAY;

	// Fixture: mirrors the real bi#28/29/30/31 + bi#26 shapes (counts and
	// closure notes verbatim-class, ids stable).
	const files = [
		F("bi#26", "Open", "epic", [{ from: "bi#28", to: "bi#26", kind: "DependsOn" }]),
		F("bi#28", "Done", "Port pi `model-selector` (423).\n\nClosed 2026-09-05 (sweep): acceptance met.", [{ from: "bi#28", to: "bi#26", kind: "DependsOn" }]),
		F("bi#29", "Done", "Port pi `settings-selector` (929).\n\nClosed 2026-09-06: verifier re-run green.", [{ from: "bi#29", to: "bi#26", kind: "DependsOn" }]),
		F("bi#30", "Done", "Bi `session.ts` is 66 lines with no resume/fork.\n\nSweep 2026-09-05: `/resume` lists/restores.", [{ from: "bi#30", to: "bi#26", kind: "DependsOn" }]),
		F("bi#31", "Dropped", "Bi has 6 builtin slashes; port the missing 17.\n\nSUPERSEDED (closed 2026-09-05): registry now holds 33.", [{ from: "bi#31", to: "bi#26", kind: "DependsOn" }]),
		F("bi#90", "Open", "Ready work, blocked on nothing.", []),
		F("bi#91", "Open", "Was blocked, blockers landed.", [{ from: "bi#91", to: "bi#28", kind: "DependsOn" }]),
		F("bi#92", "Open", "Typo'd dep.", [{ from: "bi#92", to: "bi#999", kind: "DependsOn" }]),
		F("bi#93", "Open", "Drifted epic.", []),
		F("bi#94", "Done", "Child one.", [{ from: "bi#94", to: "bi#93", kind: "DependsOn" }]),
	];
	// bi#93 is an epic whose only child bi#94 is Done.
	files.find((f) => f.issue.id === "bi#93").issue.title = "Small epic";
	const mtimes = new Map([
		["bi#91", mt(10)], ["bi#28", mt(1)], ["bi#29", mt(0)], ["bi#30", mt(1)], ["bi#31", mt(1)],
	]);
	const facts = {
		registryCount: 34,
		fileLines: new Map([["<hub>/bi/src/session.ts", 375]]),
		resolveFile: (p) => (p === "session.ts" || p.endsWith("/session.ts") ? "<hub>/bi/src/session.ts" : null),
	};
	const missingRefs = [{ declaredBy: "bi#92", id: "bi#999", side: "to", kind: "DependsOn", from: "bi#92", to: "bi#999" }];

	const cands = staleCandidates({ files, mtimes, missingRefs, facts, days: 7, nowMs: NOW });
	const byId = (id) => cands.filter((c) => c.id === id).map((c) => c.rule);
	check(JSON.stringify(byId("bi#31")).includes("SHIPPED-COUNT"), `bi#31 flags SHIPPED-COUNT (registry 6+17=23 vs 34), got ${JSON.stringify(byId("bi#31"))}`);
	check(JSON.stringify(byId("bi#31")).includes("SHIPPED"), `bi#31 flags SHIPPED (dated SUPERSEDED note), got ${JSON.stringify(byId("bi#31"))}`);
	check(JSON.stringify(byId("bi#30")).includes("SHIPPED-COUNT"), `bi#30 flags SHIPPED-COUNT (session.ts 66 vs 375), got ${JSON.stringify(byId("bi#30"))}`);
	check(JSON.stringify(byId("bi#28")).includes("SHIPPED"), `bi#28 flags SHIPPED (sweep-closed Done), got ${JSON.stringify(byId("bi#28"))}`);
	check(JSON.stringify(byId("bi#29")).includes("SHIPPED"), `bi#29 flags SHIPPED (closed Done), got ${JSON.stringify(byId("bi#29"))}`);
	check(JSON.stringify(byId("bi#91")) === JSON.stringify(["UNBLOCKED-IDLE"]), `bi#91 flags UNBLOCKED-IDLE only (Open, dep Done, 10d idle), got ${JSON.stringify(byId("bi#91"))}`);
	check(JSON.stringify(byId("bi#92")) === JSON.stringify(["PARKED-TYPO"]), `bi#92 flags PARKED-TYPO only, got ${JSON.stringify(byId("bi#92"))}`);
	check(JSON.stringify(byId("bi#93")) === JSON.stringify(["EPIC-DRIFT"]), `bi#93 flags EPIC-DRIFT only (Open epic, child Done), got ${JSON.stringify(byId("bi#93"))}`);
	check(byId("bi#26").length === 0, `bi#26 (epic with Open-linked child) stays clean, got ${JSON.stringify(byId("bi#26"))}`);
	check(byId("bi#90").length === 0, `bi#90 (dep-less Open) stays clean — no vacuous UNBLOCKED-IDLE, got ${JSON.stringify(byId("bi#90"))}`);
	// Reasons are single-line with named evidence.
	const r31 = cands.find((c) => c.id === "bi#31" && c.rule === "SHIPPED-COUNT");
	check(!!r31 && /23/.test(r31.reason) && /34/.test(r31.reason) && !/[\t\n]/.test(r31.reason), `bi#31 reason names both numbers on one line: ${JSON.stringify(r31?.reason)}`);
	// mtime gate: bi#91 at 10d idle needs days<=10; re-run days=30 -> gone.
	const cands30 = staleCandidates({ files, mtimes, missingRefs, facts, days: 30, nowMs: NOW });
	check(!cands30.some((c) => c.id === "bi#91"), "UNBLOCKED-IDLE respects --days (bi#91 clean at days=30)");
	check(cands30.some((c) => c.id === "bi#31" && c.rule === "SHIPPED-COUNT"), "SHIPPED-COUNT ignores --days (content-based, bi#31 still flags at days=30)");
	// TSV shape.
	const tsv = formatTsv(cands.filter((c) => c.id === "bi#92"));
	check(tsv === "bi#92\tPARKED-TYPO\tparked-typo: DependsOn bi#92 -> bi#999 names Missing id to=bi#999 (also reported by bais check as dangling)\n", `TSV is id/rule/reason, got ${JSON.stringify(tsv)}`);

	console.log(failures === 0 ? "stale selftest: all green" : `${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}
