// bais/src/graph.ts — host mirrors of the graph rules in baml_src/main.baml.
//
// BAML owns every rule here and proves it with `baml test`; this file
// reproduces them for the CLI. They are mirrors rather than SDK calls for two
// independent reasons, both currently unfixable from inside this package:
//
//   1. bais's committed baml_sdk is a 0.17.0 artifact while the source now
//      needs toolchain 0.18.0 (`ctx.output_format()`), so `baml generate`
//      cannot run without a bridge upgrade — new BAML functions cannot reach
//      the SDK at all.
//   2. Even reachable, an enum nested in a class field (Issue.status,
//      Edge.kind) is encoded as a bare string inbound, so `==` against an enum
//      literal inside the VM is always false. `ready_issues` returns empty and
//      `is_blocked` always false, silently. See proposals/05 for the
//      direct-parameter form, which at least panics.
//
// So: change a rule in main.baml, change it here, and keep the `baml test`
// cases as the specification of what "here" must do.
//
// Unlike bi/bagl, bais imports its own parser directly — same package, no
// dynamic pathToFileURL resolution needed.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseBaisFile } from "./toml.js";

export type BaisIssue = {
	id: string;
	title: string;
	status: string;
	kind: string;
	area: string | null;
	severity: number | null;
	source: string | null;
	body: string;
};

export type BaisEdge = { from: string; to: string; kind: string };
// File-envelope claim (lease-bound Doing): holder + RFC3339 UTC lease.
// Null when unclaimed. The BAML parser owns the shape; the host owns
// the instant comparison (unparseable lease reads as expired).
export type BaisFile = { issue: BaisIssue; edges: BaisEdge[]; holder: string | null; lease: string | null };

// A file the parser rejected. Kept as its own shape rather than coerced into a
// BaisIssue: an unparseable file has no trustworthy id, status or edges, and
// anything invented for those fields is a lie the rest of the graph acts on.
export type BaisLoadFailure = { file: string; error: string };
export type BaisLoad = { issues: BaisFile[]; failures: BaisLoadFailure[] };

export async function loadIssues(issuesDir: string): Promise<BaisLoad> {
	if (!existsSync(issuesDir)) return { issues: [], failures: [] };
	const files = readdirSync(issuesDir).filter((f) => f.endsWith(".toml")).sort();
	const issues: BaisFile[] = [];
	const failures: BaisLoadFailure[] = [];
	for (const f of files) {
		try {
			issues.push((await parseBaisFile(readFileSync(join(issuesDir, f), "utf8"))) as BaisFile);
		} catch (e: any) {
			failures.push({ file: f, error: String(e?.message ?? e) });
		}
	}
	return { issues, failures };
}

// Mirror of BAML ready_issues/is_blocked. Ready = Open, and no Blocks edge
// points at it from an issue that is neither Done nor Dropped. A Blocks edge
// naming an id we cannot see is unresolvable and blocks: we cannot prove the
// blocker is closed, so we do not hand the node out as work. `check` reports
// those so a typo is loud rather than parking an issue forever.
export function readyIssues(all: BaisFile[]): BaisFile[] {
	const byId = new Map(all.map((f) => [f.issue.id, f.issue]));
	const blocked = new Set<string>();
	for (const f of all) {
		for (const e of f.edges) {
			if (e.kind !== "Blocks") continue;
			const blocker = byId.get(e.from);
			if (!blocker || (blocker.status !== "Done" && blocker.status !== "Dropped")) {
				blocked.add(e.to);
			}
		}
	}
	return all.filter((f) => f.issue.status === "Open" && !blocked.has(f.issue.id));
}

// Mirror of BAML blast_radii (bi#122): per issue, the TRANSITIVE dependents
// through the two ordering kinds (DependsOn/Blocks — the same `precedes`
// relation the cycle detector uses), split into open_downstream (work
// actually held, what dispatchers sort on) and total_downstream (every
// declared dependent, including Done/Dropped/unseen). A dependent naming an
// id that was never loaded counts in total but never in open; the hub never
// counts itself, so cycles terminate without self-credit.
export type BlastRadius = { id: string; open_downstream: number; total_downstream: number };

export function blastRadii(all: BaisFile[]): BlastRadius[] {
	const edges = all.flatMap((f) => f.edges);
	const statusById = new Map(all.map((f) => [f.issue.id, f.issue.status]));
	const directDependents = (id: string): string[] => {
		const out: string[] = [];
		for (const e of edges) {
			if ((e.kind === "DependsOn" || e.kind === "Blocks") && e.to === id && !out.includes(e.from)) {
				out.push(e.from);
			}
		}
		return out;
	};
	return all.map((f) => {
		const seen: string[] = [];
		let frontier = directDependents(f.issue.id);
		while (frontier.length > 0) {
			const next: string[] = [];
			for (const id of frontier) {
				if (seen.includes(id)) continue;
				seen.push(id);
				for (const d of directDependents(id)) {
					if (!seen.includes(d)) next.push(d);
				}
			}
			frontier = next;
		}
		let open = 0;
		let total = 0;
		for (const id of seen) {
			if (id === f.issue.id) continue;
			total += 1;
			if (statusById.get(id) === "Open") open += 1;
		}
		return { id: f.issue.id, open_downstream: open, total_downstream: total };
	});
}

// Mirror of BAML parse_file_claims (bi#123): `Files:` body lines declare the
// issue's file footprint (space-separated paths, `#` comments stripped,
// multiple lines union, first-seen order). The CLI dry-runs packs against
// these; undeclared issues pack freely but are flagged `files: unknown`.
export function parseFileClaims(body: string): string[] {
	const out: string[] = [];
	for (const line of (body ?? "").split("\n")) {
		const t = line.trim();
		if (!t.startsWith("Files:")) continue;
		let rest = t.slice("Files:".length).trim();
		const hash = rest.indexOf("#");
		if (hash !== -1) rest = rest.slice(0, hash).trim();
		for (const part of rest.split(" ")) {
			const p = part.trim();
			if (p !== "" && !out.includes(p)) out.push(p);
		}
	}
	return out;
}

// bi#130: swarm membership is a holder convention, not a schema change.
// A holder of the form `swarm-id/agent-id` names its swarm by prefix;
// anything else (no `/`, empty side) is a plain holder and coexists
// untouched. `validHolder` (cli.ts) already admits `/`, so no parser or
// envelope change was needed — this predicate is the whole stamp.
export type SwarmMember = { swarm: string; agent: string };
export function parseSwarmHolder(holder: string | null): SwarmMember | null {
	if (holder == null) return null;
	const i = holder.indexOf("/");
	if (i <= 0 || i === holder.length - 1) return null;
	const swarm = holder.slice(0, i);
	const agent = holder.slice(i + 1);
	if (swarm === "" || agent === "") return null;
	return { swarm, agent };
}

// bi#130: group live claims by swarm prefix for `list --claims` and
// `dispatch` occupancy. Plain holders (and nulls) are excluded, never
// renamed — mixed plain + swarm holders coexist in the same output.
export type SwarmGroup = { swarm: string; members: { id: string; holder: string; agent: string }[] };
export function groupSwarmClaims(claims: { id: string; holder: string | null }[]): SwarmGroup[] {
	const bySwarm = new Map<string, SwarmGroup>();
	for (const c of claims) {
		const m = parseSwarmHolder(c.holder);
		if (m == null || c.holder == null) continue;
		let g = bySwarm.get(m.swarm);
		if (!g) {
			g = { swarm: m.swarm, members: [] };
			bySwarm.set(m.swarm, g);
		}
		g.members.push({ id: c.id, holder: c.holder, agent: m.agent });
	}
	for (const g of bySwarm.values()) g.members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return [...bySwarm.values()].sort((a, b) => (a.swarm < b.swarm ? -1 : a.swarm > b.swarm ? 1 : 0));
}

// Mirror of BAML dispatch_pack (bi#123): the workload-aware swarm pack as a
// pure function. Candidates are ready (Open + unblocked) and unleased;
// greedy by open blast radius (ties: id ascending), skipping packed/leased
// issues and file clashes with already-packed slots. `leased` is the
// precomputed live-claim set (the host owns the clock); `footprints` maps
// issue id to declared files. Never mutates — the CLI dry-runs it and each
// agent claims for itself.
//
// hub#175: unknown footprints (no `Files:` line — a bare `Files:` still
// counts as declared: touches-nothing is a real claim) are mutually
// exclusive in a swipe pack. Empty file lists never collide vacuously, so
// the clash predicate above cannot see them: the greedy pick below still
// fills the budget, then the first unknown in slot order keeps its slot
// and the rest are withheld (same kept/withheld semantics as the
// scripts-lane splitUnknownPack in bais/scripts/briefs.mjs, which stays a
// no-op second filter over these slots). Kept slots renumber dense. The
// call site warns LOUD via warnUnknownWithheld / warnUnknownShared.
export type FileClaim = { issue_id: string; files: string[] };
export type AgentSlot = { slot: number; issue_id: string };

// A `Files:` prefix means declared — even `Files:` empty. No prefix means
// unknown. Same test as parseFileClaims's prefix scan and the dispatch call
// sites; kept beside dispatchPack because the exclusion reads bodies while
// the clash predicate reads the footprints map.
export function isDeclaredFootprint(body: string): boolean {
	return (body ?? "").split("\n").some((l) => l.trim().startsWith("Files:"));
}

// hub#175 warning lines — verbatim mirrors of warnUnknownWithheld /
// warnUnknownShared in bais/scripts/briefs.mjs (the scripts lane owns the
// exact shapes; dispatch.mjs §13 pins them). Duplicated, not imported:
// the CLI runtime must not depend on scripts/ (same requirement class as
// the hub#163 renderer resolution). mirror-parity.mjs pins these against
// the scripts canonical.
export function warnUnknownWithheld(ids: string[]): string {
	const list = [...ids].map(String);
	const noun = list.length === 1 ? "footprint" : "footprints";
	return `[bais] unknown ${noun} withheld from swipe pack: ${list.join(", ")} (no Files: line proves no clash-freedom — at most one unknown per pack; declare Files: first per bi#125)`;
}

export function warnUnknownShared(unknownId: string, declaredIds: string[]): string {
	return `[bais] unknown footprint ${unknownId} shares a swipe pack with declared ${[...declaredIds].map(String).join(", ")} (no Files: — confirm scope with the operator before writing)`;
}

export function dispatchPack(
	all: BaisFile[],
	leased: string[],
	footprints: Map<string, string[]> | FileClaim[],
	budget: number,
): AgentSlot[] {
	const slots: AgentSlot[] = [];
	if (budget <= 0) return slots;
	const fp = Array.isArray(footprints) ? new Map(footprints.map((f) => [f.issue_id, f.files])) : footprints;
	const radii = new Map(blastRadii(all).map((r) => [r.id, r]));
	const ready = readyIssues(all);
	const bodies = new Map(all.map((f) => [f.issue.id, f.issue.body ?? ""]));
	const filesFor = (id: string): string[] => fp.get(id) ?? [];
	const clash = (a: string[], b: string[]): boolean => a.some((x) => b.includes(x));
	const packed: string[] = [];
	const packedFiles: string[] = [];
	while (slots.length < budget) {
		let bestId = "";
		let bestOpen = -1;
		for (const c of ready) {
			if (packed.includes(c.issue.id) || leased.includes(c.issue.id)) continue;
			const open = radii.get(c.issue.id)?.open_downstream ?? 0;
			if (clash(filesFor(c.issue.id), packedFiles)) continue;
			if (open > bestOpen || (open === bestOpen && (bestId === "" || c.issue.id < bestId))) {
				bestId = c.issue.id;
				bestOpen = open;
			}
		}
		if (bestId === "") break;
		packed.push(bestId);
		for (const f of filesFor(bestId)) {
			if (!packedFiles.includes(f)) packedFiles.push(f);
		}
		slots.push({ slot: slots.length, issue_id: bestId });
	}
	const kept: AgentSlot[] = [];
	let seenUnknown = false;
	for (const s of slots) {
		if (!isDeclaredFootprint(bodies.get(s.issue_id) ?? "")) {
			if (seenUnknown) continue;
			seenUnknown = true;
		}
		kept.push({ slot: kept.length, issue_id: s.issue_id });
	}
	return kept;
}

// Mirror of BAML id_project: "bi#04" -> "bi". An id with no "#" has no scope.
export function idProject(id: string): string {
	const i = id.indexOf("#");
	return i === -1 ? "" : id.slice(0, i);
}

// The project owning a .bais directory, from .bais/config.toml
// (`project = "bais"`), falling back to the directory containing .bais. Only
// this one key is read, so a regex is enough — routing config.toml through the
// BAML parser would mean forcing it into the Issue shape it is not.
export function projectName(issuesDir: string): string {
	const cfg = join(resolve(issuesDir, ".."), "config.toml");
	if (existsSync(cfg)) {
		try {
			const m = readFileSync(cfg, "utf8").match(/^\s*project\s*=\s*"([^"]*)"/m);
			if (m) return m[1];
		} catch {}
	}
	return basename(resolve(issuesDir, "..", ".."));
}

export type BaisRefStatus = "Missing" | "External";
export type BaisDanglingRef = {
	declaredBy: string; // id of the issue whose file declared the edge
	from: string;
	to: string;
	kind: string;
	id: string;
	side: "from" | "to";
	status: BaisRefStatus;
};

// Mirror of BAML dangling_edge_refs. Per-file parsing cannot catch these — an
// edge naming an id that does not exist is only visible once the whole
// directory is loaded.
export function danglingRefsIn(issues: BaisFile[], project: string): BaisDanglingRef[] {
	const known = new Set(issues.map((f) => f.issue.id));
	const out: BaisDanglingRef[] = [];
	for (const f of issues) {
		for (const e of f.edges) {
			for (const side of ["from", "to"] as const) {
				const id = e[side];
				if (known.has(id)) continue;
				const scope = idProject(id);
				out.push({
					declaredBy: f.issue.id,
					from: e.from,
					to: e.to,
					kind: e.kind,
					id,
					side,
					// An unscoped id is Missing, not excused as another project's.
					status: scope !== "" && scope !== project ? "External" : "Missing",
				});
			}
		}
	}
	return out;
}

// Mirror of BAML precedes: Blocks{from,to} => from before to;
// DependsOn{from,to} => to before from (JIRA sense: A depends on B). The other
// five kinds carry no ordering.
function precedes(e: BaisEdge, before: string, after: string): boolean {
	if (e.kind === "Blocks") return e.from === before && e.to === after;
	if (e.kind === "DependsOn") return e.to === before && e.from === after;
	return false;
}

// Mirror of BAML cyclic_ids — Kahn's algorithm keeping the leftovers instead of
// the topological order. Whatever cannot be dropped is in a dependency cycle or
// downstream of one. Matters because ready_issues reports a cycle as "nothing
// to do", which is indistinguishable from a finished backlog.
export function cyclicIds(all: BaisFile[]): string[] {
	const edges = all.flatMap((f) => f.edges);
	let remaining = all.map((f) => f.issue.id);
	for (;;) {
		const next = remaining.filter((id) =>
			edges.some((e) => remaining.some((other) => precedes(e, other, id))),
		);
		if (next.length === remaining.length) return next;
		remaining = next;
	}
}

// bi#83: close-evidence — verdicts as types. A Done issue must carry
// machine-resolvable evidence refs ON the issue itself; `bais check`
// verifies they resolve and refuses prose-only closes loudly.
//
// Encoding: the strict TOML parser rejects unknown top-level keys, so
// refs ride in `body` markdown, one per line:
//
//   Evidence: drill(b)            # red-check / injection drill that ran (bi#57/bi#60)
//   Evidence: verdict(bi#59)      # reviewer-verdict issue filed in this .bais (bi#59)
//
// `drill(NAME)` resolves iff NAME is a known drill: a fault-drills letter
// (a/b/c/d/r) or a script stem present in the hub's drill namespace
// (scripts/ plus co-located sibling-package scripts/ — knownDrillNames).
// `verdict(ID)` resolves iff ID is a loaded issue id; a cross-project id
// is reported External (advisory, never fatal — same convention as
// dangling refs). A Done issue with zero refs fails as missing-close-
// evidence. Non-Done issues carry no requirement. Advisory-first: only
// one resolvable ref is required (not one of each kind); `move` semantics
// are untouched — this is a `check` failure, not a transition guard.
// Mirror of BAML WhyNotKind/IssueLease/WhyNot/why_not (`ready --why-not`).
// Field names match the BAML classes exactly (snake_case on both sides —
// preserve-case SDK) so `--json` reasons round-trip through the generated
// baml_sdk types unchanged: only the fields for `kind` are set, the rest are
// null. Only Open issues omitted from ready are reasoned about: Done/Dropped
// are finished, not jammed, Doing/Blocked statuses are self-describing in
// `list`, and an issue still listed as ready carries no reason (a
// DependsOn-only cycle never blocks, so `check` stays its diagnosis).
export type WhyNotKind = "BlockedBy" | "DanglingRef" | "InCycle" | "Leased";
export type HostLease = { entity: string; holder: string; expires_lc: number | null };
export type WhyNot = {
	id: string;
	kind: WhyNotKind;
	blocker: string | null;
	blocker_status: string | null;
	edge_from: string | null;
	edge_to: string | null;
	edge_kind: string | null;
	ref_id: string | null;
	ref_side: "from" | "to" | null;
	ref_status: "Missing" | "External" | null;
	cycle: string[] | null;
	holder: string | null;
	expires_lc: number | null;
};

const nullWhyNot = (id: string, kind: WhyNotKind): WhyNot => ({
	id,
	kind,
	blocker: null,
	blocker_status: null,
	edge_from: null,
	edge_to: null,
	edge_kind: null,
	ref_id: null,
	ref_side: null,
	ref_status: null,
	cycle: null,
	holder: null,
	expires_lc: null,
});

export function whyNotIn(all: BaisFile[], project: string, leases: HostLease[] = []): WhyNot[] {
	const byId = new Map(all.map((f) => [f.issue.id, f.issue]));
	const edges = all.flatMap((f) => f.edges);
	const cyclicList = cyclicIds(all);
	const cyclic = new Set(cyclicList);
	const leaseByEntity = new Map(leases.map((l) => [l.entity, l]));
	// Omission gate, same rule as readyIssues plus the lease exclusion the
	// store path applies: an issue listed as ready carries no reason, so every
	// reason marks an omission (and, with the loops below, every omission of
	// an Open issue carries a reason).
	const blocked = new Set<string>();
	for (const f of all) {
		for (const e of f.edges) {
			if (e.kind !== "Blocks") continue;
			const blocker = byId.get(e.from);
			if (!blocker || (blocker.status !== "Done" && blocker.status !== "Dropped")) {
				blocked.add(e.to);
			}
		}
	}
	const out: WhyNot[] = [];
	for (const f of all) {
		if (f.issue.status !== "Open") continue;
		if (!blocked.has(f.issue.id) && !leaseByEntity.has(f.issue.id)) continue;
		for (const e of edges) {
			if (e.to !== f.issue.id || e.kind !== "Blocks") continue;
			const blocker = byId.get(e.from);
			if (blocker) {
				if (blocker.status !== "Done" && blocker.status !== "Dropped") {
					out.push({
						...nullWhyNot(f.issue.id, "BlockedBy"),
						blocker: blocker.id,
						blocker_status: blocker.status,
						edge_from: e.from,
						edge_to: e.to,
						edge_kind: e.kind,
					});
				}
			} else {
				const scope = idProject(e.from);
				out.push({
					...nullWhyNot(f.issue.id, "DanglingRef"),
					edge_from: e.from,
					edge_to: e.to,
					edge_kind: e.kind,
					ref_id: e.from,
					ref_side: "from",
					ref_status: scope !== "" && scope !== project ? "External" : "Missing",
				});
			}
		}
		if (cyclic.has(f.issue.id)) {
			out.push({ ...nullWhyNot(f.issue.id, "InCycle"), cycle: [...cyclicList] });
		}
		const lease = leaseByEntity.get(f.issue.id);
		if (lease) {
			out.push({ ...nullWhyNot(f.issue.id, "Leased"), holder: lease.holder, expires_lc: lease.expires_lc });
		}
	}
	return out;
}

// bi#83 close-evidence core (dependency-free: no imports beyond node:fs
// already at top, so it stays probeable without the BAML runtime).
// hub#188: third ref kind e2e(<stem>) — a Done issue cites the goal-e2e
// case it kept green, resolving iff .bais/e2e/<stem>.mjs exists (exactly
// the knownDrillNames rule: existence is resolvability; greenness is
// proven by running the case, not by this predicate). One auditable
// evidence channel: the Swarm:-verdict line (below) proved the
// add-a-ref-kind pattern, and a separate top-level E2E: line would
// splinter what this gate already audits. Rollout is warn-first: in the
// warn phase cli.ts renders unresolvable-e2e as advisory (never fatal);
// --e2e-strict flips it to fatal (the style/hero precedent).
export type CloseEvidenceKind = "drill" | "verdict" | "e2e";
export type CloseEvidenceRef = { kind: CloseEvidenceKind; ref: string };
export type CloseEvidenceProblem = {
	id: string; // Done issue carrying the bad / missing evidence
	reason: "missing-close-evidence" | "unresolvable-drill" | "unresolvable-verdict" | "unresolvable-e2e";
	ref: string | null; // the raw ref text, null when nothing was cited
	kind: CloseEvidenceKind | null;
	status: "Missing" | "External"; // External (cross-project verdict) is advisory, never fatal
};

// Fault-drill letters (scripts/fault-drills.mjs drill (a)/(b)/(c)/(d)/(r))
// always resolve; script stems resolve iff a matching *.mjs exists in the
// hub's drill namespace: scriptsDir plus every co-located sibling-package
// scripts/ dir under the same hub root (hub#164). The root hub lives at the
// repo root where <root>/scripts does not exist — without the union, closes
// citing drill(audit)/drill(keeper)/... fail unresolvable-drill even though
// bais/scripts/audit.mjs and bi/scripts/keeper.mjs are real green suites.
// Absent dirs contribute nothing, so a tmpdir or single-package hub still
// resolves letters only (check-evidence.mjs pins that contract). Existence
// is resolvability: check does not execute suites — suite-greenness is proven
// by running them (dispatch/audit/tiers gates), not by this predicate.
// issuesDir is <root>/.bais/issues; drill scripts live at <root>/scripts.
export function scriptsDirFor(issuesDir: string): string {
	return join(resolve(issuesDir, "..", ".."), "scripts");
}

export function knownDrillNames(scriptsDir: string): string[] {
	const names = ["a", "b", "c", "d", "r"];
	const dirs = [resolve(scriptsDir)];
	try {
		const hubRoot = resolve(scriptsDir, "..");
		for (const sub of readdirSync(hubRoot).sort()) {
			const d = join(hubRoot, sub, "scripts");
			if (d === dirs[0]) continue;
			try {
				if (existsSync(d)) dirs.push(d);
			} catch {}
		}
	} catch {}
	for (const dir of dirs) {
		try {
			for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
				const stem = f.slice(0, -4);
				if (!names.includes(stem)) names.push(stem);
			}
		} catch {}
	}
	return names;
}

// hub#188: e2e case stems resolve iff a matching *.mjs exists in the
// hub's .bais/e2e/ dir (the goal-commit scaffold namespace, hub#184).
// issuesDir is <root>/.bais/issues; cases live at <root>/.bais/e2e.
// Absent dir contributes nothing (a tmpdir or pre-goal hub resolves no
// stems — an e2e cite there is unresolvable-e2e, loud, never silent).
export function e2eDirFor(issuesDir: string): string {
	return join(resolve(issuesDir, ".."), "e2e");
}

export function knownE2eStems(e2eDir: string): string[] {
	try {
		return readdirSync(e2eDir)
			.filter((f) => f.endsWith(".mjs"))
			.map((f) => f.slice(0, -4))
			.sort();
	} catch {
		return [];
	}
}

// One `Evidence: drill(x)` / `Evidence: verdict(y)` / `Evidence: e2e(z)`
// ref per matching body line (case-sensitive kind, trimmed ref; trailing
// `#` comment stripped). Anything else on the line is not a ref — prose
// never counts.
export function parseCloseEvidence(body: string): CloseEvidenceRef[] {
	const out: CloseEvidenceRef[] = [];
	for (const line of (body ?? "").split("\n")) {
		const m = /^\s*Evidence\s*:\s*(drill|verdict|e2e)\s*\(\s*([^)]*?)\s*\)\s*(?:#.*)?$/.exec(line);
		if (m) out.push({ kind: m[1] as CloseEvidenceKind, ref: m[2].trim() });
	}
	return out;
}

// ── Computed urgency (bi#51) + cost join (bi#52) ──────────────────────────
// Mirror of BAML urgency/urgency_severity/blocks_fan_out/is_sole_blocker/
// sole_unblocks/urgency_blocks/urgency_stalled_days/urgency_stalled/
// urgency_cost_cap/urgency_cost (bais/baml_src/main.baml urgency section)
// plus the budget.baml accumulators task_incurred_tokens/task_incurred_usd.
// Same FFI rationale as the header: BAML
// owns the definition proved by `baml test` (tests "urgency orders fan-out
// hub above leaf", "severity-5 overrides a high structural score", "60-day
// trivia loses to fresh severity-4", "staleness saturates: older alone never
// keeps winning", "urgency receipt adds up and names every component",
// "missing or future creation day counts as fresh", "null severity
// contributes nothing", "shared blockers split the one-away bonus but keep
// fan-out"); the host mirrors the arithmetic because the SDK cannot carry
// the new functions (proposals/05) AND because BAML has no wall time.
//
// Clock split (bi#42): the host owns clocks, BAML owns policy. The host
// stamps each issue's creation day (whole days since epoch, from file mtime
// — the "file mtime / git log day" unit main.baml:788-794 names) into the
// live-signal table and passes wall-clock `now` in the same unit. A missing
// entry — or a creation day in the future — counts as fresh (0 days).
// Urgency is DERIVED: it never rewrites human severity, and every score
// ships with its components (the anti-Goodhart receipt).
export type Urgency = {
	issue_id: string;
	score: number;
	severity_part: number;
	fan_out: number;
	sole_unblocks: number;
	blocks_part: number;
	stalled_days: number;
	stalled_part: number;
	incurred_tokens: number;
	cost_part: number;
};

// Declared signal: 1-4 linear (capped below the structural max of 6); 5 is
// the override hatch (15, above the max non-override total of 12).
export function urgencySeverity(severity: number | null): number {
	if (severity == null) return 0;
	if (severity >= 5) return 15;
	if (severity <= 0) return 0;
	return severity;
}

// Structural signal: Blocks fan-out counts EDGES, not distinct targets
// (same as BAML blocks_fan_out — a doubled edge declaration double-counts).
export function blocksFanOut(issueId: string, edges: BaisEdge[]): number {
	let n = 0;
	for (const e of edges) {
		if (e.from === issueId && e.kind === "Blocks") n += 1;
	}
	return n;
}

// One-completion-away: no OTHER issue blocks `target` (edges only).
export function isSoleBlocker(issueId: string, target: string, edges: BaisEdge[]): boolean {
	for (const e of edges) {
		if (e.kind === "Blocks" && e.to === target && e.from !== issueId) return false;
	}
	return true;
}

export function soleUnblocks(issueId: string, edges: BaisEdge[]): number {
	let n = 0;
	for (const e of edges) {
		if (e.from === issueId && e.kind === "Blocks" && isSoleBlocker(issueId, e.to, edges)) n += 1;
	}
	return n;
}

export function urgencyBlocks(issueId: string, edges: BaisEdge[]): number {
	return Math.min(blocksFanOut(issueId, edges), 4) + Math.min(soleUnblocks(issueId, edges), 2);
}

export function urgencyStalledDays(issueId: string, costs: Map<string, number>, now: number): number {
	const created = costs.has(issueId) ? (costs.get(issueId) as number) : now;
	const parked = now - created;
	return parked < 0 ? 0 : parked;
}

// A week per point, saturating at 2 (BAML int division truncates; days are
// clamped >= 0 above, so Math.floor agrees exactly).
export function urgencyStalled(stalledDays: number): number {
	return Math.min(Math.floor(stalledDays / 7), 2);
}

// ── Cost attribution join (bi#52) ─────────────────────────────────────────
// BAML owns the accumulation policy (ns_event/budget.baml
// task_incurred_tokens/task_incurred_usd, pure fold over admitted incurred
// rows); the host owns METERING (measuring tokens and emitting CostIncurred
// through the reserve/drawdown checks). This mirror lets urgency serve the
// join without a bridge round-trip. Burn-to-look-important defense (see
// main.baml urgency header): the component saturates at 2, so the max
// non-override total is 4 + 6 + 2 + 2 = 14, below the severity-5 hatch
// (15); the receipt names cost_part + incurred_tokens so burn is visible;
// only admitted incurred rows count (unknown spend reads as 0); oversight
// outlier review (budget_overruns/caps_over_budget) is the second eye.
// URGENCY_COST_CAP_TOKENS must agree with BAML urgency_cost_cap().
export const URGENCY_COST_CAP_TOKENS = 1000;

// Minimal structural row for the accumulator: the projection's CostEntry
// carries more, but the fold only reads these three fields.
export type CostSpend = { task: string; kind: string; tokens: number };

export function taskIncurredTokens(costs: CostSpend[], task: string): number {
	let total = 0;
	for (const c of costs) {
		if (c.kind === "incurred" && c.task === task) total += c.tokens;
	}
	return total;
}

export function taskIncurredUsd(costs: (CostSpend & { usd: number })[], task: string): number {
	let total = 0;
	for (const c of costs) {
		if (c.kind === "incurred" && c.task === task) total += c.usd;
	}
	return total;
}

// Half the cap nudges (+1), at/over the cap saturates (+2). Mirror of BAML
// urgency_cost — integer thresholds, no float drift.
export function urgencyCost(incurredTokens: number): number {
	if (incurredTokens <= 0) return 0;
	if (incurredTokens >= URGENCY_COST_CAP_TOKENS) return 2;
	if (incurredTokens >= URGENCY_COST_CAP_TOKENS / 2) return 1;
	return 0;
}

// Per-task metered spend. Optional (defaults to unmetered) so existing
// callers keep their exact behavior — unknown spend never inflates. The
// --json rows carry incurred_tokens + cost_part for audit either way.
export function urgencySpentTokens(
	issueId: string,
	spent: Map<string, number> | undefined,
): number {
	const raw = spent?.has(issueId) ? (spent.get(issueId) as number) : 0;
	return raw < 0 ? 0 : raw;
}

export function urgencyFor(
	issue: { id: string; severity: number | null },
	edges: BaisEdge[],
	costs: Map<string, number>,
	now: number,
	spent?: Map<string, number>,
): Urgency {
	const sev = urgencySeverity(issue.severity);
	const fan = blocksFanOut(issue.id, edges);
	const sole = soleUnblocks(issue.id, edges);
	const blocks = urgencyBlocks(issue.id, edges);
	const days = urgencyStalledDays(issue.id, costs, now);
	const stalled = urgencyStalled(days);
	const incurred = urgencySpentTokens(issue.id, spent);
	const cost = urgencyCost(incurred);
	return {
		issue_id: issue.id,
		score: sev + blocks + stalled + cost,
		severity_part: sev,
		fan_out: fan,
		sole_unblocks: sole,
		blocks_part: blocks,
		stalled_days: days,
		stalled_part: stalled,
		incurred_tokens: incurred,
		cost_part: cost,
	};
}

export const MS_PER_DAY = 86400000;

export function nowDays(nowMs: number = Date.now()): number {
	return Math.floor(nowMs / MS_PER_DAY);
}

// Creation-day table from file mtimes (whole days). A file with no stat
// (renamed mid-read, filter views) is left ABSENT so urgencyStalledDays
// counts it fresh — unknown age must never inflate urgency.
export function creationDaysFromMtimes(issuesDir: string, ids: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const id of ids) {
		try {
			out.set(id, Math.floor(statSync(join(issuesDir, `${id}.toml`)).mtimeMs / MS_PER_DAY));
		} catch {
			// absent on purpose: reads as fresh downstream
		}
	}
	return out;
}

// Done-only gate: every Done entry needs >= 1 evidence ref and every
// cited ref must resolve. Entries are {id,status,body} so both the scan
// path (BaisFile) and the store path (tasks rows) share this predicate.
// e2eStems is optional (hub#188): callers that predate the e2e ref kind
// resolve no e2e stems, so an e2e cite there reports unresolvable-e2e —
// loud, never silently green.
export function closeEvidenceIn(
	entries: { id: string; status: string; body: string }[],
	project: string,
	drills: string[],
	e2eStems: string[] = [],
): CloseEvidenceProblem[] {
	const known = new Set(entries.map((e) => e.id));
	const out: CloseEvidenceProblem[] = [];
	for (const e of entries) {
		if (e.status !== "Done") continue;
		const refs = parseCloseEvidence(e.body);
		if (refs.length === 0) {
			out.push({ id: e.id, reason: "missing-close-evidence", ref: null, kind: null, status: "Missing" });
			continue;
		}
		for (const r of refs) {
			if (r.kind === "drill") {
				if (!drills.includes(r.ref)) {
					out.push({ id: e.id, reason: "unresolvable-drill", ref: `drill(${r.ref})`, kind: "drill", status: "Missing" });
				}
			} else if (r.kind === "e2e") {
				if (!e2eStems.includes(r.ref)) {
					out.push({ id: e.id, reason: "unresolvable-e2e", ref: `e2e(${r.ref})`, kind: "e2e", status: "Missing" });
				}
			} else {
				if (!known.has(r.ref)) {
					const scope = idProject(r.ref);
					const external = scope !== "" && scope !== project;
					out.push({ id: e.id, reason: "unresolvable-verdict", ref: `verdict(${r.ref})`, kind: "verdict", status: external ? "External" : "Missing" });
				}
			}
		}
	}
	return out;
}

// bi#131: swarm slot verdicts — the closing record of a dispatched issue.
// A dispatched close cites its pack with one body line shaped like
// Evidence: (bi#83) so `bais check` verifies it the same way:
//
//   Swarm: pack(<pack-id>) slot(<n>) (landed|failed) by(<merger>)  # optional comment
//
// pack/slot join back to the dispatch pack the issue filled (consumed by
// reviewer verdicts, bi#59 area — this shape is the join key, not the
// join); landed|failed is the slot outcome; by(merger) names who folded
// it. Gate posture mirrors close-evidence but weaker: the line is never
// required (most closes were never dispatched — requiring it would fail
// the existing Done graph), but a `Swarm:`-prefixed line that does not
// parse is LOUD and fatal (malformed fails, never silently ignored).
// Non-Done issues are checked too: a malformed shape is a shape
// violation wherever it sits; well-formed lines on Open issues are
// carried (oversight joins slots to packs off the parsed set).
export type SwarmVerdict = { pack: string; slot: number; verdict: "landed" | "failed"; merger: string };
export type SwarmProblem = {
	id: string; // issue carrying the malformed line
	reason: "malformed-swarm-verdict";
	ref: string | null; // the raw offending line (trimmed), null when never reached
	status: "Missing"; // always fatal — a shape violation, not an external ref
};

// One `Swarm: ...` verdict per matching body line (trailing `#`
// comment stripped). Anything else on the line is not a verdict —
// prose never counts, same as parseCloseEvidence.
const SWARM_VERDICT_RE =
	/^\s*Swarm\s*:\s*pack\(\s*([^)\s]+)\s*\)\s*slot\(\s*(\d+)\s*\)\s*(landed|failed)\s+by\(\s*([^)\s]+)\s*\)\s*(?:#.*)?$/;
export function parseSwarmVerdicts(body: string): SwarmVerdict[] {
	const out: SwarmVerdict[] = [];
	for (const line of (body ?? "").split("\n")) {
		const m = SWARM_VERDICT_RE.exec(line);
		if (m) out.push({ pack: m[1].trim(), slot: Number(m[2]), verdict: m[3] as "landed" | "failed", merger: m[4].trim() });
	}
	return out;
}

// Malformed = a line whose left edge claims to be a verdict
// (`Swarm:` prefix, case-sensitive like `Evidence:`) but does not parse
// above. Entries are {id,status,body} so both the scan path and the
// store path share this predicate.
export function swarmVerdictProblemsIn(entries: { id: string; status: string; body: string }[]): SwarmProblem[] {
	const out: SwarmProblem[] = [];
	for (const e of entries) {
		for (const line of (e.body ?? "").split("\n")) {
			if (!/^\s*Swarm\s*:/.test(line)) continue;
			if (!SWARM_VERDICT_RE.test(line)) out.push({ id: e.id, reason: "malformed-swarm-verdict", ref: line.trim(), status: "Missing" });
		}
	}
	return out;
}

// ── Goal e2e drift joins (hub#191) ─────────────────────────────────────
// Surfaces and cases drift in both directions — goal.toml edited without
// touching case files, case files outliving their surface — and nothing
// detected it. Two deterministic joins over goal.toml text + the
// .bais/e2e/ listing (pure core here, the CLI owns the IO):
//
//   e2e-gap:   a declared testing_surface item whose anchor matches no
//              .bais/e2e/*.mjs scaffold header (the goal needs a case).
//   e2e-stale: a scaffold whose embedded goal anchor matches no declared
//              surface item (the case outlived its surface — renaming or
//              editing a surface in goal.toml turns the join red, naming
//              both sides; never auto-mutating, bi#55).
//
// The join key is the hub#184 goal anchor: sha256 of
// `surface + "=>" + exercise` (mirror of bais/scripts/goal.mjs
// surfaceAnchor — mirror-parity pins them equal). Grandfathering mirrors
// the hub#165/hub#166 file-gate posture: a goal.toml with no declared
// testing_surface reads as pre-surface, so BOTH joins are vacuous
// (declared=false) — deleting the whole surface list silences the stale
// join by design (rename/edit detection requires the list to stay
// declared). Rollout is warn-first: cli.ts renders rows as advisories
// that never touch the exit code; --e2e-strict flips to fatal.
export type GoalSurfaceItem = { surface: string; exercise: string };

// Declared testing surface: well-formed `{ surface = "...", exercise =
// "..." }` inline tables only. Missing list, empty list, and malformed
// items yield no item here — the validateGoal file gate (goal.mjs) owns
// loud failure for malformed items; this reader never validates. Mirrors
// goal.mjs's extractGoalList/splitGoalListItems (duplicated, not
// imported: the src runtime must not depend on scripts/ — the
// warnUnknownWithheld comment above names the requirement class).
export function parseGoalTestingSurface(goalTomlText: string): GoalSurfaceItem[] {
	const src = String(goalTomlText ?? "");
	const m = /^testing_surface\s*=\s*\[([\s\S]*?)\]/m.exec(src);
	if (!m) return [];
	const out: GoalSurfaceItem[] = [];
	for (const item of splitTopLevelItems(m[1])) {
		const t = item.trim();
		if (!t.startsWith("{")) continue; // bare strings fail the file gate, not this reader
		const surface = inlineTableString(t, "surface");
		const exercise = inlineTableString(t, "exercise");
		if (surface !== null && exercise !== null && surface.trim() !== "" && exercise.trim() !== "") {
			out.push({ surface, exercise });
		}
	}
	return out;
}

// Split a TOML array body on top-level commas: brace-, bracket- and
// string-aware, `#` comments skipped outside strings. Verbatim mirror of
// splitGoalListItems in bais/scripts/goal.mjs.
function splitTopLevelItems(body: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let cur = "";
	let inStr = false;
	let esc = false;
	const lines = String(body).split("\n");
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inStr) {
				cur += ch;
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') {
				inStr = true;
				cur += ch;
				continue;
			}
			if (ch === "#") break;
			if (ch === "{" || ch === "[") depth++;
			if (ch === "}" || ch === "]") depth--;
			if (ch === "," && depth === 0) {
				items.push(cur);
				cur = "";
				continue;
			}
			cur += ch;
		}
		if (inStr) cur += "\n";
		else cur += " ";
	}
	if (cur.trim() !== "") items.push(cur);
	return items.map((s) => s.trim()).filter((s) => s !== "");
}

// One JSON-string field out of an inline table (null when absent or
// unparseable — never invented).
function inlineTableString(item: string, name: string): string | null {
	const m = new RegExp(`${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(item);
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}

// Goal anchor: sha256 of `surface + "=>" + exercise` — verbatim mirror of
// surfaceAnchor in bais/scripts/goal.mjs (the eventId content-hash idiom,
// bais/scripts/fault-drills.mjs). Pure; mirror-parity recomputes both
// sides and pins them equal.
export function surfaceAnchor(surface: string, exercise: string): string {
	return createHash("sha256").update(`${surface}=>${exercise}`, "utf8").digest("hex");
}

// The anchor a scaffold embeds in its header
// (`// goal anchor: <hex> (sha256 of surface + "=>" + exercise — hub#184)`).
// A scaffold with no anchor line cannot join — null, never invented.
export function e2eScaffoldAnchor(content: string): string | null {
	const m = /^\/\/ goal anchor: ([0-9a-f]{64})\b/m.exec(String(content ?? ""));
	return m ? m[1] : null;
}

export type E2eCaseAnchor = { file: string; stem: string; anchor: string | null };

// Directory half of the join (IO, same exemption as knownDrillNames):
// every .bais/e2e/*.mjs with its embedded anchor, sorted by file. An
// absent dir yields no cases.
export function e2eCaseAnchorsIn(e2eDir: string): E2eCaseAnchor[] {
	let files: string[] = [];
	try {
		files = readdirSync(e2eDir).filter((f) => f.endsWith(".mjs")).sort();
	} catch {
		return [];
	}
	const out: E2eCaseAnchor[] = [];
	for (const f of files) {
		let anchor: string | null = null;
		try {
			anchor = e2eScaffoldAnchor(readFileSync(join(e2eDir, f), "utf8"));
		} catch {}
		out.push({ file: f, stem: f.slice(0, -4), anchor });
	}
	return out;
}

export type E2eDriftJoin = {
	declared: boolean; // false = pre-surface goal (grandfathered): both joins vacuous
	ok: { surface: string; file: string }[]; // matched surface/case pairs
	gaps: { surface: string; exercise: string; anchor: string }[]; // declared surface, no case (e2e-gap)
	stale: { file: string; anchor: string | null }[]; // case matching no declared surface (e2e-stale)
};

// Pure join over declared surfaces + case anchors. Surfaces keep
// declaration order, cases keep file-sorted order — deterministic rows.
// A case matching several surfaces pairs with each (duplicate declared
// surfaces are the file gate's problem, not hidden here); a surface with
// several cases is covered (no gap) and every pair lands in ok.
export function e2eDriftJoin(surfaces: GoalSurfaceItem[], cases: E2eCaseAnchor[]): E2eDriftJoin {
	const declared = surfaces.length > 0;
	const ok: E2eDriftJoin["ok"] = [];
	const gaps: E2eDriftJoin["gaps"] = [];
	const stale: E2eDriftJoin["stale"] = [];
	if (!declared) return { declared, ok, gaps, stale };
	const casesByAnchor = new Map<string, E2eCaseAnchor[]>();
	for (const c of cases) {
		if (c.anchor === null) continue;
		const list = casesByAnchor.get(c.anchor) ?? [];
		list.push(c);
		casesByAnchor.set(c.anchor, list);
	}
	const matched = new Set<string>();
	for (const s of surfaces) {
		const anchor = surfaceAnchor(s.surface, s.exercise);
		const hits = casesByAnchor.get(anchor) ?? [];
		if (hits.length === 0) gaps.push({ surface: s.surface, exercise: s.exercise, anchor });
		for (const h of hits) {
			ok.push({ surface: s.surface, file: h.file });
			matched.add(h.file);
		}
	}
	for (const c of cases) {
		if (!matched.has(c.file)) stale.push({ file: c.file, anchor: c.anchor });
	}
	return { declared, ok, gaps, stale };
}

// ── Progressive-enhancement audits (hub#193, warn-first) ───────────────
// Three violations that were invisible, as deterministic advisory rows
// with named reasons — same posture as bi#80 `bais stale`: never
// auto-mutates (bi#55), warn phase never touches the exit code,
// --audit-strict flips to fatal so CI can pin zero. Thresholds live in
// data (the exported constants), not literals buried in the rules.
export const RADIUS_EVIDENCE_MIN_OPEN_DOWNSTREAM = 3;
export const DECLARATION_DISTRIBUTION_WARN_PCT = 10;

// All ids that must land BEFORE `id`: the transitive closure of the
// precedes relation (Blocks/DependsOn — the same two ordering kinds
// blast_radii/cyclic_ids use). Cycle-safe (seen-bounded), the hub never
// counts itself. Host-owned audit helper, no BAML source (the M-bais10
// close-evidence precedent: check policy lives host-side).
export function precedesAncestors(id: string, edges: BaisEdge[]): string[] {
	const seen = new Set<string>([id]);
	let frontier = [id];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const cur of frontier) {
			for (const e of edges) {
				for (const c of [e.from, e.to]) {
					if (seen.has(c)) continue;
					if (precedes(e, c, cur)) {
						seen.add(c);
						next.push(c);
					}
				}
			}
		}
		frontier = next;
	}
	seen.delete(id);
	return [...seen].sort();
}

export type LayerDriftRow = { id: string; ancestor: string; baseline: string; reason: "layer-drift" };

// layer-drift: a Doing/Done enhancement whose foundation is not landed.
// The foundation set is the declared baseline plus its own precedes-
// ancestors (the hub#186 baseline); any Open foundation member the
// enhancement transitively depends on is big-bang made visible, one row
// per (enhancement, open ancestor) naming both ids. Rows sort by id then
// ancestor — deterministic. A baseline that cannot resolve (no sketch
// declaration) yields no rows; the CLI names that state on the phase
// line instead of inventing one.
export function layerDriftIn(all: BaisFile[], baselineId: string): LayerDriftRow[] {
	const edges = all.flatMap((f) => f.edges);
	const statusById = new Map(all.map((f) => [f.issue.id, f.issue.status]));
	const foundation = new Set([baselineId, ...precedesAncestors(baselineId, edges)]);
	const rows: LayerDriftRow[] = [];
	for (const f of all) {
		const st = f.issue.status;
		if (st !== "Doing" && st !== "Done") continue;
		if (foundation.has(f.issue.id)) continue;
		for (const anc of precedesAncestors(f.issue.id, edges)) {
			if (foundation.has(anc) && statusById.get(anc) === "Open") {
				rows.push({ id: f.issue.id, ancestor: anc, baseline: baselineId, reason: "layer-drift" });
			}
		}
	}
	return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.ancestor < b.ancestor ? -1 : a.ancestor > b.ancestor ? 1 : 0));
}

// The declared baseline (hub#186): .bais/sketch.toml carries a
// [[node]] id = "baseline"; the node names the issue it materialized as
// via an explicit `issue = "<issue-id>"` key. No node or no key → null —
// the audit stays silent rather than guessing (never fail-closed without
// a named reason, bi#55: the phase line names the undeclared state).
export function baselineIssueFromSketch(sketchText: string): string | null {
	for (const block of String(sketchText ?? "").split("[[node]]")) {
		if (!/^\s*id\s*=\s*"baseline"\s*$/m.test(block)) continue;
		const m = /^\s*issue\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(block);
		if (!m) return null;
		try {
			const id = JSON.parse(m[1]);
			return typeof id === "string" && id !== "" ? id : null;
		} catch {
			return null;
		}
	}
	return null;
}

export type RadiusEvidenceRow = { id: string; open_downstream: number; reason: "radius-vs-evidence" };

// radius-vs-evidence: a folded (Done) hub node holding >=
// RADIUS_EVIDENCE_MIN_OPEN_DOWNSTREAM open downstream whose fold carried
// no surface-observable change — no Evidence: e2e(<stem>) cite (hub#188)
// on the issue. Abstraction-first scaffolding is manufactured, unearned
// blast radius; a healthy campaign shows the top radius decaying as hubs
// land. open_downstream is the same blast_radii number dispatch sorts
// on, so the audit and the dispatcher agree on what "hub" means.
export function radiusVsEvidenceIn(
	all: BaisFile[],
	minOpenDownstream: number = RADIUS_EVIDENCE_MIN_OPEN_DOWNSTREAM,
): RadiusEvidenceRow[] {
	const radii = new Map(blastRadii(all).map((r) => [r.id, r]));
	const rows: RadiusEvidenceRow[] = [];
	for (const f of all) {
		if (f.issue.status !== "Done") continue;
		const open = radii.get(f.issue.id)?.open_downstream ?? 0;
		if (open < minOpenDownstream) continue;
		const citesE2e = parseCloseEvidence(f.issue.body).some((r) => r.kind === "e2e");
		if (!citesE2e) rows.push({ id: f.issue.id, open_downstream: open, reason: "radius-vs-evidence" });
	}
	return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type DeclarationDistributionRow = {
	reason: "declaration-distribution";
	open: number; // Open issues considered
	severity5: number; // of those, at the severity-5 override hatch
	pct: number; // severity5/open as a percentage, one decimal (floor)
	k: number; // the warn threshold in effect (data, not a literal)
};

// declaration-distribution: more than K% of Open issues holding the
// severity-5 override hatch (15, above every structural maximum) warns
// loud, naming the fraction. Measure only — policy unchanged; structural
// tie-breaks already blunt relevance inflation, and this audit covers
// the one uncapped hatch. Strictly greater than K warns; at or under is
// silent. K lives in DECLARATION_DISTRIBUTION_WARN_PCT, not a literal.
export function declarationDistributionIn(
	all: BaisFile[],
	kPct: number = DECLARATION_DISTRIBUTION_WARN_PCT,
): DeclarationDistributionRow | null {
	const open = all.filter((f) => f.issue.status === "Open");
	if (open.length === 0) return null;
	const sev5 = open.filter((f) => f.issue.severity !== null && f.issue.severity >= 5);
	if (sev5.length * 100 <= kPct * open.length) return null;
	return {
		reason: "declaration-distribution",
		open: open.length,
		severity5: sev5.length,
		pct: Math.floor((sev5.length * 1000) / open.length) / 10,
		k: kPct,
	};
}
