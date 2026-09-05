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

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
export type BaisFile = { issue: BaisIssue; edges: BaisEdge[] };

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
// (a/b/c/d/r) or a script stem present in scripts/ (knownDrillNames).
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
export type CloseEvidenceKind = "drill" | "verdict";
export type CloseEvidenceRef = { kind: CloseEvidenceKind; ref: string };
export type CloseEvidenceProblem = {
	id: string; // Done issue carrying the bad / missing evidence
	reason: "missing-close-evidence" | "unresolvable-drill" | "unresolvable-verdict";
	ref: string | null; // the raw ref text, null when nothing was cited
	kind: CloseEvidenceKind | null;
	status: "Missing" | "External"; // External (cross-project verdict) is advisory, never fatal
};

// Fault-drill letters (scripts/fault-drills.mjs drill (a)/(b)/(c)/(d)/(r))
// always resolve; script stems resolve iff a matching *.mjs exists in
// scriptsDir (absent dir = letters only, so other projects still check).
// issuesDir is <root>/.bais/issues; drill scripts live at <root>/scripts.
export function scriptsDirFor(issuesDir: string): string {
	return join(resolve(issuesDir, "..", ".."), "scripts");
}

export function knownDrillNames(scriptsDir: string): string[] {
	const names = ["a", "b", "c", "d", "r"];
	try {
		for (const f of readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs")).sort()) {
			const stem = f.slice(0, -4);
			if (!names.includes(stem)) names.push(stem);
		}
	} catch {}
	return names;
}

// One `Evidence: drill(x)` / `Evidence: verdict(y)` ref per matching
// body line (case-sensitive kind, trimmed ref; trailing `#` comment
// stripped). Anything else on the line is not a ref — prose never counts.
export function parseCloseEvidence(body: string): CloseEvidenceRef[] {
	const out: CloseEvidenceRef[] = [];
	for (const line of (body ?? "").split("\n")) {
		const m = /^\s*Evidence\s*:\s*(drill|verdict)\s*\(\s*([^)]*?)\s*\)\s*(?:#.*)?$/.exec(line);
		if (m) out.push({ kind: m[1] as CloseEvidenceKind, ref: m[2].trim() });
	}
	return out;
}

// Done-only gate: every Done entry needs >= 1 evidence ref and every
// cited ref must resolve. Entries are {id,status,body} so both the scan
// path (BaisFile) and the store path (tasks rows) share this predicate.
export function closeEvidenceIn(
	entries: { id: string; status: string; body: string }[],
	project: string,
	drills: string[],
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
