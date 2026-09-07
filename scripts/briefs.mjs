// bais/scripts/briefs.mjs — bi#125: spawn-ready agent brief renderer.
//
// Reads a dispatch pack (`bais dispatch --agents N --json` against --dir)
// and renders one paste-ready spawn brief per slot: file ownership from
// Files: (or UNKNOWN-must-confirm), acceptance bullets from the body,
// fresh zero-context default (fork only when the slot builds on live
// conversation), trust scope, worktree path per bi#73, and the
// /tmp/<task>-deliver pre-finish clause per bi#56.
//
// bi#126: partial packs warn loudly here too — stderr
// `[bais] budget B, packed P: U slot(s) unfilled (only P
// ready+unleased+clash-free)` plus an `unfilled` field under --json.
// Exit stays 0: a partial pack is valid work, just never silent.
//
// hub#175: unknown footprints (no Files: line) are mutually exclusive in
// swipe packs — empty file lists never collide vacuously, so two unknowns
// sharing a pack is a blessed collision. buildPack keeps the first unknown
// in slot order, withholds the rest LOUD (warnUnknownWithheld), and warns
// naming the kept unknown whenever it shares the pack with declared slots
// (warnUnknownShared — declare-first per bi#125 is the companion).
// Declared-empty (a bare Files: line) is a real touches-nothing claim and
// still packs freely. Warnings ride --json `warnings` (+ `withheld`) and
// human-mode stderr; --json stderr stays at the §8-pinned single partial
// line so machines parse one schema.
//
// SRC-LANE WIRING (not this file — needs bais/src/cli.ts + bi/src/cli.ts,
// both outside this lane's footprint): in the dispatch block, when
// `--briefs` is present print renderBrief() per slot instead of the slot
// rows; add `unfilled: budget - slots.length` to the --json object; when
// unfilled > 0 print warnPartial()'s line to stderr. The JSON contract
// below (slot/issue/files/files_state/open_downstream) is already what
// the CLI emits, so the wiring is ~10 lines per host. Until then the
// operator runs: node bais/scripts/briefs.mjs --agents N --dir bi
//
// bi#134: per-node style overrides. An issue may carry a top-level
// `style = "<pack>"` field (a .bais/styles/<pack>.toml taste pack: the
// hero governs workflow, the override governs taste). renderBrief takes
// the override as `style` and renders one Style line per brief; readIssue
// parses the field. Nothing else in this file changes for bi#134.
// SRC-LANE WIRING (needs bais/src/cli.ts + bi/src/cli.ts, both outside
// this lane): pass the issue's style field through the dispatch --json
// slot into renderBrief (same spread buildPack already does below).
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Dist CLI, resolved from this file so worktree checkouts keep working
// (dispatch.mjs pins the main-checkout absolute path; same binary).
const CLI = join(HERE, "..", "dist", "src", "cli.js");

// Load-bearing hunk (bi#125/bi#57 red-check target): the UNKNOWN flag.
// Reverting renderBrief to always print a file list (dropping the
// files_state branch) must trip dispatch.mjs §7 with
// "unknown slot flagged UNKNOWN".
export function taskTag(id) {
	return String(id).replace(/[^A-Za-z0-9]/g, "");
}

// Mirror of graph.parseFileClaims (bais/src/graph.ts): space-separated
// paths after a Files: prefix, # starts a comment. Returns the declared
// set plus whether any Files: line exists at all (declared vs unknown:
// a Files: prefix means declared even when empty — touches-no-files is
// a real claim; no prefix means unknown: packs freely, flagged).
export function parseFiles(body) {
	const files = [];
	let declared = false;
	for (const line of String(body ?? "").split("\n")) {
		const t = line.trim();
		if (!t.startsWith("Files:")) continue;
		declared = true;
		let rest = t.slice("Files:".length).trim();
		const hash = rest.indexOf("#");
		if (hash !== -1) rest = rest.slice(0, hash).trim();
		for (const part of rest.split(" ")) {
			const p = part.trim();
			if (p !== "" && !files.includes(p)) files.push(p);
		}
	}
	return { files, declared };
}

// Acceptance bullets: the Acceptance: paragraph, split on semicolons
// (the backlog convention — see bi#105/bi#115). No Acceptance: line
// means unscoped work: say so instead of inventing bullets.
export function parseAcceptance(body) {
	const text = String(body ?? "");
	const m = text.match(/^Acceptance:(.*)/m);
	if (!m) return ["(no Acceptance: line in issue — confirm scope with operator before starting)"];
	const para = [m[1]];
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.startsWith("Acceptance:"));
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i].trim();
		if (l === "" || l === '"""' || /^[A-Z][A-Za-z ]*:/.test(l) || l.startsWith("Files:")) break;
		para.push(lines[i]);
	}
	return para
		.join(" ")
		.split(";")
		.map((s) => s.replace(/^Acceptance:\s*/, "").trim())
		.filter((s) => s !== "");
}

// Prior /tmp/<task>-deliver handoffs named in the body: fork candidates
// ONLY if the slot builds on that live state, never by default.
export function priorHandoffs(body) {
	const out = [];
	const re = /\/tmp\/[A-Za-z0-9_-]+-deliver\/?/g;
	let m;
	while ((m = re.exec(String(body ?? ""))) !== null) {
		if (!out.includes(m[0])) out.push(m[0]);
	}
	return out;
}

export function slug(title) {
	return (
		String(title ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "slot"
	);
}

export function renderBrief({ slot, id, title, status = "Open", body = "", files = [], files_state = "unknown", open_downstream = 0, dir = "<issues-dir>", style = "" }) {
	const tag = taskTag(id);
	const L = [];
	L.push(`=== brief slot${slot}: ${id} — ${title} ===`);
	L.push(`Issue: ${id} (status ${status}, open downstream ${open_downstream})`);
	L.push(`Role: implement ${id}. FIRST: claim it with`);
	L.push(`  bais move ${id} Doing --as <owner> --for 2h`);
	L.push(`  (run from ${dir}; never start unclaimed — Doing without --as is instantly stale)`);
	L.push(`Restart (bi#144): on start/resume, re-read this issue + inbox before touching code. Ground-first (.agents/skills/ground-first/SKILL.md, hub#159): enumerate before theorizing.`);
	L.push(`Objective: ${title}`);
	L.push(`Acceptance (from issue body — every bullet is binding):`);
	for (const b of parseAcceptance(body)) L.push(`- ${b}`);
	L.push(`File ownership (exact paths, never shared):`);
	if (files_state === "declared") {
		if (files.length) for (const f of files) L.push(`  ${f}`);
		else L.push(`  (none — declared touches-nothing claim: verification/coordination only)`);
		L.push(`  Change only these lines; read before editing; anything else goes to the operator, never sideways.`);
	} else {
		L.push(`  UNKNOWN — no Files: declaration in ${id}; confirm scope with the operator before writing anything.`);
	}
	L.push(`Context policy: fresh zero-context spawn (default). Fork the live conversation ONLY if this slot builds on live conversation state.`);
	const priors = priorHandoffs(body);
	if (priors.length) L.push(`  Prior handoffs mentioned (${priors.join(", ")}) are fork candidates only in that case.`);
	L.push(`Trust scope: ${dir} read-only except owned files above; claims via bais move --as/--for with heartbeat (bais renew); never adopt another holder's live claim; no access changes.`);
	L.push(`Stop-and-report (bi#144): ambiguity/contradiction goes to the operator, never sideways to peer notes.`);
	L.push(`Lossy wake-ups (bi#144): wake-ups are lossy — process the queue in order; ignore wake-ups while busy.`);
	// bi#134: per-node style override (append-only — placed after Trust
	// scope so the dispatch.mjs §7 File-ownership/Context-policy window
	// is untouched). The hero governs workflow, the override governs taste.
	if (style) L.push(`Style override: ${style} (per-node taste — hero governs workflow, this pack governs taste; constraints/anti-patterns in .bais/styles/${style}.toml).`);
	else L.push(`Style: inherits goal style (no per-node override on this issue).`);
	L.push(`Worktree (bi#73): isolated worktree for parallel work; branch agent/${tag}-${slug(title)} (path assigned by operator).`);
	L.push(`PRE-FINISH DELIVERY (mandatory, bi#56): copy deliverables to /tmp/${tag}-deliver/, cmp-confirm, report that path. Terminal reports without a confirmed handoff are rejected.`);
	return L.join("\n");
}

// bi#144: the six required spawn-brief lines — restart, stop-and-report,
// lossy wake-ups (added in renderBrief above) plus ownership, acceptance,
// handoff (pre-existing). assertBriefLines fails loud naming the missing
// line; `node briefs.mjs --selftest` proves it both ways (positive +
// one negative per header).
export const REQUIRED_BRIEF_LINES = [
	"Restart (bi#144)",
	"Stop-and-report (bi#144)",
	"Lossy wake-ups (bi#144)",
	"File ownership",
	"Acceptance",
	"PRE-FINISH DELIVERY",
];

export function missingBriefLines(brief) {
	return REQUIRED_BRIEF_LINES.filter((h) => !String(brief ?? "").includes(h));
}

export function assertBriefLines(brief) {
	const missing = missingBriefLines(brief);
	if (missing.length) throw new Error(`brief missing required line(s): ${missing.join("; ")}`);
	return true;
}

// bi#126: loud partial-pack line. Exact spec from the issue:
// `[bais] budget 8, packed 5: 3 slots unfilled (only N ready+unleased+clash-free)`.
// Returns null on a full pack (full packs stay quiet).
export function warnPartial(budget, packed) {
	const unfilled = budget - packed;
	if (unfilled <= 0) return null;
	const s = unfilled === 1 ? "slot" : "slots";
	return `[bais] budget ${budget}, packed ${packed}: ${unfilled} ${s} unfilled (only ${packed} ready+unleased+clash-free)`;
}

// bi#129: one outstanding pack per dispatcher turn. warnReentry(leased)
// names held slots LOUD when a re-dispatch lands while a previous pack
// still holds live claims; null (quiet) when nothing is held. Exit stays
// 0: held slots are valid in-flight work, just never silent.
// SRC-LANE WIRING (not this file — needs bais/src/cli.ts + bi/src/cli.ts,
// both outside this lane's footprint): in the dispatch block, when
// leased.length > 0 print warnReentry()'s line to stderr (kimi-veto shape:
// name the held slots, point at the fold confirmation).
export function warnReentry(leased) {
	const held = (leased ?? []).map(String);
	if (!held.length) return null;
	const s = held.length === 1 ? "slot" : "slots";
	return `[bais] reentry: ${held.length} held ${s} still claimed (${held.join(", ")}); next pack after the merger confirms the fold`;
}

// Minimal TOML field reader for issue files (id/title/status/body only —
// the BAML validator owns real parsing; this never validates).
export function readIssue(dir, id) {
	const raw = readFileSync(join(dir, ".bais", "issues", `${id}.toml`), "utf8");
	const field = (name) => {
		const m = raw.match(new RegExp(`^${name} *= *"(.*)"`, "m"));
		return m ? m[1] : "";
	};
	const bm = raw.match(/body\s*=\s*"""([\s\S]*?)"""/);
	// bi#134: per-node style override (top-level `style = "<pack>"`, same
	// convention as the goal.toml style field). Absent means inherit.
	return { id: field("id") || id, title: field("title"), status: field("status") || "Open", body: bm ? bm[1] : "", style: field("style") };
}

// hub#175: unknown footprints are mutually exclusive in swipe packs.
// Loud withholding line (pinned by dispatch.mjs §13). Exact shape:
// `[bais] unknown footprint<s> withheld from swipe pack: <ids> (no Files:
// line proves no clash-freedom — at most one unknown per pack; declare
// Files: first per bi#125)`.
export function warnUnknownWithheld(ids) {
	const list = [...ids].map(String);
	const noun = list.length === 1 ? "footprint" : "footprints";
	return `[bais] unknown ${noun} withheld from swipe pack: ${list.join(", ")} (no Files: line proves no clash-freedom — at most one unknown per pack; declare Files: first per bi#125)`;
}

// hub#175: declared+unknown coexistence line (pinned by dispatch.mjs §13).
// Names the unknown issue — the declared partners are context. Exact shape:
// `[bais] unknown footprint <id> shares a swipe pack with declared <ids>
// (no Files: — confirm scope with the operator before writing)`.
export function warnUnknownShared(unknownId, declaredIds) {
	return `[bais] unknown footprint ${unknownId} shares a swipe pack with declared ${[...declaredIds].map(String).join(", ")} (no Files: — confirm scope with the operator before writing)`;
}

// hub#175 (bi#57 red-check target): the mutual-exclusion filter. Pure over
// CLI slot rows ({ issue: { id }, files_state }) — keeps the first unknown
// in slot order, withholds the rest, warns naming every unknown involved.
// Neutering this to keep-all must trip dispatch.mjs §13 LOUD as `two
// unknowns never share a swipe pack`.
export function splitUnknownPack(slots) {
	const kept = [];
	const withheld = [];
	let seenUnknown = null;
	for (const s of slots) {
		if (s.files_state !== "declared") {
			if (seenUnknown === null) { seenUnknown = s.issue.id; kept.push(s); }
			else withheld.push(s.issue.id);
		} else kept.push(s);
	}
	const warnings = [];
	if (withheld.length) warnings.push(warnUnknownWithheld(withheld));
	if (seenUnknown !== null) {
		const partners = kept.filter((s) => s.files_state === "declared").map((s) => s.issue.id);
		if (partners.length) warnings.push(warnUnknownShared(seenUnknown, partners));
	}
	return { kept, withheld, warnings };
}

export function buildPack(dir, budget) {
	const raw = execFileSync("node", [CLI, "dispatch", "--agents", String(budget), "--json"], { cwd: dir, encoding: "utf8", timeout: 60000 });
	const j = JSON.parse(raw);
	// hub#175: enforce mutual exclusion before rendering — kept slots are
	// renumbered sequentially so brief slot addresses stay dense.
	const { kept, withheld, warnings } = splitUnknownPack(j.slots);
	const slots = kept.map((s, i) => {
		const issue = readIssue(dir, s.issue.id);
		return { ...s, slot: i, brief: renderBrief({ ...s, ...issue, slot: i, dir }) };
	});
	return { budget: j.budget, leased: j.leased ?? [], slots, unfilled: budget - slots.length, warnings, withheld };
}

// hub#162: affinity-batched cohort dispatch (scripts lane; bais/src/*
// untouched). Swipe packs are clash-free parallel slots (one issue per
// agent); cohort packs are the inverse the operator ran on instinct —
// bi#125+bi#126 (dispatch briefs + partial-pack warn, same lane, one
// agent in sequence), bi#150+bi#151 (read-only + bash executors, same
// area bi/agent), hub#163+hub#164 (renderer single-sourcing +
// close-evidence, same multi-agent surface) — issues that shared a
// surface and were each independently closable went to ONE agent
// SEQUENTIALLY (one writer per surface, no interface risk between
// related issues, amortized context). buildCohorts formalizes that:
// affinity from shared Files: footprints + shared area + small size;
// guards (each loud with reason): independently closable members only
// (own Acceptance: line), bounded total footprint (file + member caps;
// oversized affinity groups split loud), DependsOn still orders over
// cohesion (a member ordered after unfinished work excludes, never
// pulls ahead). Unknown footprints cannot cohort (surface unproven).
// Ground-first (.agents/skills/ground-first/SKILL.md, hub#159): the
// candidate enumeration below reads the fixture/live issue files and
// the dispatch --json leased set — observed state, never assumed.
export const COHORT = {
	MIN_AFFINITY: 3, // pair cohorts at >= 3 (shared file 2 + area 2 = 4; area 2 + small 1 = 3; one shared file alone is 2: not enough)
	SHARED_FILE: 2, // per shared declared file
	SAME_AREA: 2, // same non-empty area
	BOTH_SMALL: 1, // both small: <= SMALL_FILES declared files and <= SMALL_BODY body chars each
	SMALL_FILES: 2,
	SMALL_BODY: 2000,
	MAX_MEMBERS: 3, // cohort size cap (one agent holds the whole sequence in context)
	MAX_FILES: 5, // union-footprint cap (cohorts must not sprawl)
};

// Full issue read for cohorting: readIssue (id/title/status/body/style)
// plus area, live-claim fields, and DependsOn/Blocks edges. Minimal
// TOML reader (the BAML validator owns real parsing; this never
// validates) — mirrors the loadIssues-known keys only (id, title,
// status, kind, area, holder, lease, body, [[edge]]).
export function readCohortIssue(dir, id) {
	const raw = readFileSync(join(dir, ".bais", "issues", `${id}.toml`), "utf8");
	const base = readIssue(dir, id);
	const field = (name) => {
		const m = raw.match(new RegExp(`^${name} *= *"(.*)"`, "m"));
		return m ? m[1] : "";
	};
	const edges = [];
	const re = /\[\[edge\]\]\s*from\s*=\s*"([^"]+)"\s*to\s*=\s*"([^"]+)"\s*kind\s*=\s*"([^"]+)"/g;
	let m;
	while ((m = re.exec(raw)) !== null) edges.push({ from: m[1], to: m[2], kind: m[3] });
	const { files, declared } = parseFiles(base.body);
	return { ...base, area: field("area"), holder: field("holder"), lease: field("lease"), files, declared, edges };
}

const cohortIds = (dir) => {
	const raw = execFileSync("node", [CLI, "list", "--json"], { cwd: dir, encoding: "utf8", timeout: 60000 });
	return JSON.parse(raw).issues.map((f) => f.issue.id);
};

const cohortLeased = (dir) => {
	try {
		const raw = execFileSync("node", [CLI, "dispatch", "--agents", "1", "--json"], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return new Set(JSON.parse(raw).leased ?? []);
	} catch { return new Set(); }
};

// Pairwise affinity: shared declared files + shared area + both small.
// Returns { score, reasons } — reasons name every component so the
// cohort brief shows its work and the operator can audit the batching.
export function affinityScore(a, b) {
	let score = 0;
	const reasons = [];
	const shared = a.files.filter((f) => b.files.includes(f));
	if (shared.length) {
		score += COHORT.SHARED_FILE * shared.length;
		reasons.push(`+${COHORT.SHARED_FILE * shared.length} shared file(s) ${shared.join(",")}`);
	}
	if (a.area && a.area === b.area) {
		score += COHORT.SAME_AREA;
		reasons.push(`+${COHORT.SAME_AREA} shared area ${a.area}`);
	}
	const small = (c) => c.files.length <= COHORT.SMALL_FILES && c.body.length <= COHORT.SMALL_BODY;
	if (small(a) && small(b)) {
		score += COHORT.BOTH_SMALL;
		reasons.push(`+${COHORT.BOTH_SMALL} both small (<=${COHORT.SMALL_FILES} files, <=${COHORT.SMALL_BODY} body chars)`);
	}
	return { score, reasons };
}

// Candidacy: Open + unleased + unblocked + declared + independently
// closable. Every rejection carries its reason (never silent). Non-Open
// issues are outside the dispatch pool and skip quietly — same as the
// swipe lane, which only ever considers Open issues.
export function cohortCandidates(dir) {
	const leased = cohortLeased(dir);
	const byId = new Map();
	for (const id of cohortIds(dir)) {
		try { byId.set(id, readCohortIssue(dir, id)); } catch { /* unreadable: outside the pool */ }
	}
	const doneish = (s) => s === "Done" || s === "Dropped";
	const candidates = [];
	const excluded = [];
	for (const [id, c] of [...byId].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
		if (c.status !== "Open") continue;
		if (leased.has(id)) { excluded.push({ id, reason: `live-claimed${c.holder ? ` by ${c.holder}` : ""} (until ${c.lease || "unknown"})` }); continue; }
		// Load-bearing hunk (hub#162/bi#57 red-check target): the
		// DependsOn guard below. Neutering it must trip dispatch.mjs
		// §12 LOUD as `blocked member excluded with reason`. Cohesion
		// never overrides blockers: a member ordered after unfinished
		// (or missing) work excludes instead of pulling ahead.
		const dep = c.edges.find((e) => e.from === id && e.kind === "DependsOn" && (!byId.has(e.to) || !doneish(byId.get(e.to).status)));
		if (dep) {
			const st = byId.has(dep.to) ? byId.get(dep.to).status : "missing";
			excluded.push({ id, reason: `ordered after ${dep.to} via DependsOn (status ${st}); cohesion never overrides blockers` });
			continue;
		}
		const blocker = c.edges.find((e) => e.to === id && e.kind === "Blocks" && (!byId.has(e.from) || !doneish(byId.get(e.from).status)));
		if (blocker) {
			const st = byId.has(blocker.from) ? byId.get(blocker.from).status : "missing";
			excluded.push({ id, reason: `blocked by Blocks from ${blocker.from} (status ${st})` });
			continue;
		}
		if (!c.declared) { excluded.push({ id, reason: `unknown footprint (no Files: line) — surface unproven, cannot cohort` }); continue; }
		if (!/^Acceptance:/m.test(c.body)) { excluded.push({ id, reason: `no Acceptance: line — not independently closable` }); continue; }
		candidates.push(c);
	}
	return { candidates, excluded, byId };
}

// Greedy affinity grouping: connected components over pair edges >=
// MIN_AFFINITY (id order), each packed into cap-sized chunks (union
// footprint <= MAX_FILES, members <= MAX_MEMBERS). A component that
// needs > 1 chunk is an oversized cohort and splits LOUD via
// warnCohortSplit. Members order dependencies-first (DependsOn/Blocks
// intra-cohort edges), tie-break id ascending.
export function buildCohorts(dir) {
	const { candidates, excluded, byId } = cohortCandidates(dir);
	const mate = (x, y) => affinityScore(x, y).score >= COHORT.MIN_AFFINITY;
	const groups = [];
	const assigned = new Set();
	for (const seed of candidates) {
		if (assigned.has(seed.id)) continue;
		const group = [seed];
		assigned.add(seed.id);
		for (const other of candidates) {
			if (assigned.has(other.id)) continue;
			if (group.every((m) => mate(m, other))) { group.push(other); assigned.add(other.id); }
		}
		groups.push(group);
	}
	const cohorts = [];
	const uncohorted = [];
	const warnings = [];
	for (const group of groups) {
		if (group.length < 2) {
			uncohorted.push({ id: group[0].id, reason: `no affinity partner >= ${COHORT.MIN_AFFINITY} (stands alone)` });
			continue;
		}
		const chunks = [];
		let cur = [];
		let union = [];
		for (const m of group) {
			const next = [...new Set([...union, ...m.files])];
			if ((cur.length >= COHORT.MAX_MEMBERS || next.length > COHORT.MAX_FILES) && cur.length) { chunks.push(cur); cur = []; union = []; }
			cur.push(m);
			union = [...new Set([...union, ...m.files])];
		}
		if (cur.length) chunks.push(cur);
		if (chunks.length > 1) warnings.push(warnCohortSplit(group.map((m) => m.id), chunks.map((c) => c.map((m) => m.id))));
		for (const chunk of chunks) {
			if (chunk.length < 2) { uncohorted.push({ id: chunk[0].id, reason: `cap remainder: affinity group split left it standing alone` }); continue; }
			const inChunk = new Set(chunk.map((m) => m.id));
			const depsFirst = [...chunk].sort((x, y) => {
				const xWaits = x.edges.some((e) => e.from === x.id && (e.kind === "DependsOn" || e.kind === "Blocks") && inChunk.has(e.to));
				const yWaits = y.edges.some((e) => e.from === y.id && (e.kind === "DependsOn" || e.kind === "Blocks") && inChunk.has(e.to));
				if (xWaits !== yWaits) return xWaits ? 1 : -1;
				return x.id < y.id ? -1 : 1;
			});
			let affinity = 0;
			const reasons = [];
			for (let i = 0; i < chunk.length; i++) {
				for (let k = 0; k < i; k++) {
					const s = affinityScore(chunk[i], chunk[k]);
					affinity += s.score;
					for (const r of s.reasons) if (!reasons.includes(r)) reasons.push(r);
				}
			}
			cohorts.push({ members: depsFirst.map((m) => m.id), affinity, reasons, files: [...new Set(chunk.flatMap((m) => m.files))] });
		}
	}
	return { cohorts, excluded, uncohorted, warnings, byId };
}

// Loud split line. Exact shape (pinned by dispatch.mjs §11):
// `[bais] cohort split: <group> share affinity but exceed the <F>-file
// cap — <K> sequential cohorts (<c1> | <c2> ...)`.
export function warnCohortSplit(group, chunks) {
	const parts = chunks.map((c) => c.join("+")).join(" | ");
	return `[bais] cohort split: ${group.join(",")} share affinity but exceed the ${COHORT.MAX_FILES}-file cap — ${chunks.length} sequential cohorts (${parts})`;
}

// Loud exclusion line (pinned by dispatch.mjs §12).
export function warnCohortExclude(id, reason) {
	return `[bais] cohort exclude ${id}: ${reason}`;
}

// One agent, sequential steps: cohort header (affinity work shown,
// shared surface, order rationale, caps) then each member's full spawn
// brief as its step — every member keeps its own claim line, own
// acceptance bullets, own red-check, own handoff path, so each step is
// independently closable before the next starts.
export function renderCohortBrief({ members, affinity, reasons, files }, byId, dir) {
	const L = [];
	L.push(`=== cohort (sequential, ONE agent): ${members.join(" + ")} ===`);
	L.push(`Affinity ${affinity}: ${reasons.join("; ")}`);
	L.push(`Shared surface (union ${files.length}/${COHORT.MAX_FILES}-file cap): ${files.join(", ")}`);
	L.push(`Order: ${members.join(" -> ")} (DependsOn orders over cohesion; blockers excluded, never pulled ahead)`);
	L.push(`Run SEQUENTIALLY in order: claim each step as it starts (Doing --as/--for), close it independently (own move to Done, own red-check per bi#57) before starting the next. One writer per surface — never parallelize these steps.`);
	L.push(`Partition rule: these members belong to this cohort, NOT to swipe slots — the dispatcher withholds them from parallel packs.`);
	members.forEach((id, i) => {
		const c = byId.get(id);
		L.push(``);
		L.push(`--- step ${i + 1}/${members.length}: ${id} — ${c?.title ?? ""} ---`);
		L.push(renderBrief({ slot: i + 1, id, title: c?.title ?? "", status: c?.status ?? "Open", body: c?.body ?? "", files: c?.files ?? [], files_state: "declared", open_downstream: 0, dir }));
	});
	return L.join("\n");
}

const optValue = (argv, name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) {
		const sample = renderBrief({ slot: 1, id: "t#00", title: "selftest", body: "Acceptance: holds.", files: ["a.ts"], files_state: "declared", dir: "selftest" });
		assertBriefLines(sample);
		for (const h of REQUIRED_BRIEF_LINES) {
			const cut = sample.split("\n").filter((l) => !l.includes(h)).join("\n");
			let threw = null;
			try { assertBriefLines(cut); } catch (e) { threw = e; }
			if (!threw) { console.error(`selftest FAIL: stripping ${JSON.stringify(h)} did not reject`); process.exit(1); }
			if (!String(threw.message).includes(h)) { console.error(`selftest FAIL: rejection for ${JSON.stringify(h)} did not name the line: ${threw.message}`); process.exit(1); }
		}
		// hub#159: the Restart line cites ground-first (enumerate before
		// theorizing); a restart line without the citation fails loud.
		const restart = sample.split("\n").find((l) => l.includes("Restart (bi#144)")) ?? "";
		if (!restart.includes("ground-first")) { console.error(`selftest FAIL: Restart line does not cite ground-first: ${JSON.stringify(restart)}`); process.exit(1); }
		console.log("briefs selftest: all green (6 required lines, positive + 6 negatives, restart cites ground-first)");
		process.exit(0);
	}
	// hub#162 (additive): --cohorts prints cohort packs (one agent,
	// sequential) instead of swipe briefs. Early return — the --agents
	// swipe path below is untouched.
	if (argv.includes("--cohorts")) {
		const dir = resolve(optValue(argv, "--dir") ?? process.cwd());
		const asJson = argv.includes("--json");
		const { cohorts, excluded, uncohorted, warnings, byId } = buildCohorts(dir);
		for (const e of excluded) console.error(warnCohortExclude(e.id, e.reason));
		for (const w of warnings) console.error(w);
		if (asJson) {
			console.log(JSON.stringify({ cohorts, excluded, uncohorted, warnings }, null, 2));
		} else {
			if (!cohorts.length) console.log("(no cohortable issues: no affinity pair stands together)");
			for (const c of cohorts) console.log((c === cohorts[0] ? "" : "\n") + renderCohortBrief(c, byId, dir));
		}
		// Exit stays 0 (hub#162/bi#126): exclusions and splits are valid
		// dispatch decisions, just never silent.
		process.exit(0);
	}
	const rawAgents = optValue(argv, "--agents");
	const budget = rawAgents === undefined ? NaN : Number(rawAgents);
	if (!Number.isInteger(budget) || budget <= 0) {
		console.error("briefs needs --agents <positive integer>");
		process.exit(1);
	}
	const dir = resolve(optValue(argv, "--dir") ?? process.cwd());
	const asJson = argv.includes("--json");
	const only = optValue(argv, "--slots");
	const pack = buildPack(dir, budget);
	const slots = only === undefined ? pack.slots : pack.slots.filter((s) => only.split(",").map(Number).includes(s.slot));
	const w = warnPartial(pack.budget, pack.slots.length);
	if (w) console.error(w);
	// hub#175: unknown-pack warnings ride --json `warnings` (+ `withheld`)
	// in every mode; human-mode stderr also prints them loud. --json
	// stderr stays at the §8-pinned single partial line.
	if (asJson) {
		console.log(JSON.stringify({ budget: pack.budget, unfilled: pack.unfilled, leased: pack.leased, slots, warnings: pack.warnings, withheld: pack.withheld }, null, 2));
	} else {
		for (const line of pack.warnings) console.error(line);
		if (!slots.length) console.log("(no packable issues for this budget)");
		for (const s of slots) console.log((s === slots[0] ? "" : "\n") + s.brief);
	}
	// Exit stays 0 on partial packs (bi#126): valid work, never silent.
	process.exit(0);
}
