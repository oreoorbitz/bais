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
