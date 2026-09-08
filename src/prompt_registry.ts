// bais/src/prompt_registry.ts — host mirror of the prompt registry policy
// (hub#210). Records live file-per-record under .bais/prompts/ (new lane,
// same file-per-record + rg + git idiom as .bais/issues/): each record binds
// a prompt version to the eval run that justified it (cookbook
// PromptVersionEntry), carrying spec_ref (a REFERENCE to the baml_src prompt
// spec, never an embedded copy) + the bits eval-run edge + an Evidence:
// drill(<name>) cite (hub#153).
//
// BAML owns the policy: bais/baml_src/prompt_registry.baml is proved by
// `baml test` on literals (prompt_registry_test.baml) and is the spec this
// module mirrors. The host mirrors the arithmetic because the SDK cannot
// carry the new functions until `baml generate` runs at fold — the same FFI
// rationale as graph.ts's urgency mirror (proposals/05) — and because the
// record files need a reader (BAML has no filesystem).
//
// Rollout (warn-first-then-fail, style/hero precedent hub#158): the caller
// picks the phase — "warn" (default) prints problems and passes, "fail"
// (behind a flag) makes any problem fatal. Never auto-mutating, always a
// named reason per row (bi#55).
//
// Self-contained: imports read-only types from ./graph.js for the issue-side
// join; graph.ts/store.ts are never edited by this lane.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PromptStatus = "Proposed" | "Active" | "Superseded";

export type PromptRecord = {
	id: string; // "<prompt>@v<version>", e.g. turn-prompt@v2 — also the file stem
	prompt: string; // prompt family key, e.g. turn-prompt
	version: number; // monotonic within the family; revert mints max+1
	status: PromptStatus;
	spec_ref: string; // repo-relative path#symbol to the baml_src prompt spec — a REFERENCE, never a copy
	prompt_text: string | null; // MUST be null — embedding the prompt is the duplication this registry prevents
	eval_issue: string | null; // issue id of the eval run that justified this version (bits eval-run edge)
	evidence: string | null; // Evidence: drill(<name>) cite per hub#153
	supersedes: string | null; // record id this version replaces
	timestamp: string; // RFC3339; host owns clocks (bi#42)
};

export type PromptProblemKind =
	| "EmbeddedPromptText"
	| "SpecRefNotBaml"
	| "MissingEvalEdge"
	| "UnresolvedEvalIssue"
	| "EvalNotPassing"
	| "MissingEvidence"
	| "DuplicateVersion";

export type PromptProblem = { record: string; kind: PromptProblemKind; detail: string };

export type RegistryPhase = "warn" | "fail";
export type RegistryVerdict = { phase: RegistryPhase; problems: PromptProblem[]; passed: boolean };

// Minimal issue-side view for the eval-edge join; structurally compatible
// with graph.ts's BaisIssue (id/status) and store rows, so cli.ts can pass
// whichever projection it already loaded.
export type IssueRef = { id: string; status: string };

export type PromptRecordFile = { file: string; record: PromptRecord };
export type PromptLoadFailure = { file: string; error: string };
export type PromptLoad = { records: PromptRecordFile[]; failures: PromptLoadFailure[] };

// issuesDir is <root>/.bais/issues; prompt records live in the sibling lane
// <root>/.bais/prompts (same shape as scriptsDirFor in graph.ts).
export function promptsDirFor(issuesDir: string): string {
	return join(resolve(issuesDir, ".."), "prompts");
}

const RECORD_KEYS = new Set([
	"id",
	"prompt",
	"version",
	"status",
	"spec_ref",
	"prompt_text",
	"eval_issue",
	"evidence",
	"supersedes",
	"timestamp",
]);

// Line-oriented reader for the flat record shape (goal.mjs's parseGoalToml
// idiom: a per-lane flat subset, not a general TOML parser). Values are basic
// strings ("..." with \" and \\ escapes) or bare integers; `#` starts a
// comment outside quotes. Unknown keys and section headers are parse errors —
// fail-closed with a named reason (bi#55), so a malformed record is loud in
// the failures list rather than silently half-read. Note prompt_text IS a
// known key: it parses, and the CHECK rejects it non-null — that is the
// no-duplication policy doing its job, not the parser.
export function parsePromptRecordText(text: string, file: string = "<record>"): PromptRecord {
	const fields = new Map<string, string | number>();
	const lines = text.split("\n");
	for (let n = 0; n < lines.length; n++) {
		let line = lines[n];
		// Strip comments: `#` outside a basic string.
		let out = "";
		let inStr = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (c === "\\" && inStr) {
				out += c + (line[i + 1] ?? "");
				i++;
				continue;
			}
			if (c === '"') inStr = !inStr;
			if (c === "#" && !inStr) break;
			out += c;
		}
		line = out.trim();
		if (line === "") continue;
		if (line.startsWith("[")) throw new Error(`${file}:${n + 1}: sections are not part of the prompt-record shape`);
		const eq = line.indexOf("=");
		if (eq === -1) throw new Error(`${file}:${n + 1}: expected key = value`);
		const key = line.slice(0, eq).trim();
		if (!RECORD_KEYS.has(key)) throw new Error(`${file}:${n + 1}: unknown key '${key}'`);
		const raw = line.slice(eq + 1).trim();
		if (raw.startsWith('"')) {
			if (raw.length < 2 || !raw.endsWith('"')) throw new Error(`${file}:${n + 1}: unterminated string for '${key}'`);
			fields.set(key, raw.slice(1, -1).replace(/\\(["\\])/g, "$1"));
		} else if (/^-?\d+$/.test(raw)) {
			fields.set(key, Number(raw));
		} else {
			throw new Error(`${file}:${n + 1}: '${key}' must be a basic string or integer`);
		}
	}
	const str = (k: string): string | null => {
		const v = fields.get(k);
		return typeof v === "string" ? v : null;
	};
	const req = (k: string): string => {
		const v = str(k);
		if (v == null) throw new Error(`${file}: missing required key '${k}'`);
		return v;
	};
	const version = fields.get("version");
	if (typeof version !== "number") throw new Error(`${file}: missing required key 'version' (integer)`);
	const status = req("status");
	if (status !== "Proposed" && status !== "Active" && status !== "Superseded") {
		throw new Error(`${file}: status '${status}' is not Proposed|Active|Superseded`);
	}
	return {
		id: req("id"),
		prompt: req("prompt"),
		version,
		status,
		spec_ref: req("spec_ref"),
		prompt_text: str("prompt_text"),
		eval_issue: str("eval_issue"),
		evidence: str("evidence"),
		supersedes: str("supersedes"),
		timestamp: req("timestamp"),
	};
}

// Load every *.toml record in the prompts lane. A missing lane is an empty
// registry, not an error — the check is advisory until records exist.
// Unparseable files land in `failures` (never silently dropped, bi#55).
export function loadPromptRecords(promptsDir: string): PromptLoad {
	const records: PromptRecordFile[] = [];
	const failures: PromptLoadFailure[] = [];
	if (!existsSync(promptsDir)) return { records, failures };
	for (const f of readdirSync(promptsDir).filter((f) => f.endsWith(".toml")).sort()) {
		const file = join(promptsDir, f);
		try {
			records.push({ file, record: parsePromptRecordText(readFileSync(file, "utf8"), f) });
		} catch (e: any) {
			failures.push({ file, error: String(e?.message ?? e).split("\n")[0] });
		}
	}
	return { records, failures };
}

// ── Policy mirror of prompt_registry.baml (baml test is the spec) ──────────

function evalStatus(id: string, issues: IssueRef[]): string | null {
	for (const i of issues) {
		if (i.id === id) return i.status;
	}
	return null;
}

export function recordProblems(rec: PromptRecord, issues: IssueRef[]): PromptProblem[] {
	const out: PromptProblem[] = [];
	if (rec.prompt_text != null) {
		out.push({
			record: rec.id,
			kind: "EmbeddedPromptText",
			detail: "record embeds prompt text — the registry references the baml_src spec (spec_ref), never carries a copy",
		});
	}
	if (!rec.spec_ref.includes(".baml")) {
		out.push({
			record: rec.id,
			kind: "SpecRefNotBaml",
			detail: `spec_ref '${rec.spec_ref}' does not name a .baml spec path — records REFERENCE the baml_src prompt spec`,
		});
	}
	if (rec.eval_issue == null) {
		out.push({
			record: rec.id,
			kind: "MissingEvalEdge",
			detail: "prompt change with no eval-run edge — name the eval issue that justified this version",
		});
	} else {
		const st = evalStatus(rec.eval_issue, issues);
		if (st == null) {
			out.push({
				record: rec.id,
				kind: "UnresolvedEvalIssue",
				detail: `eval issue ${rec.eval_issue} does not resolve to a loaded issue`,
			});
		} else if (st !== "Done") {
			out.push({
				record: rec.id,
				kind: "EvalNotPassing",
				detail: `eval issue ${rec.eval_issue} is ${st}, not Done — no passing eval run justifies this change`,
			});
		}
	}
	if (rec.evidence == null || rec.evidence === "") {
		out.push({
			record: rec.id,
			kind: "MissingEvidence",
			detail: "no Evidence: drill(<name>) cite (hub#153) — provenance without a drill is prose",
		});
	}
	return out;
}

function duplicateVersions(records: PromptRecord[]): PromptProblem[] {
	const seen = new Map<string, string>();
	const out: PromptProblem[] = [];
	for (const r of records) {
		const key = `${r.prompt}@v${r.version}`;
		const first = seen.get(key);
		if (first == null) {
			seen.set(key, r.id);
		} else {
			out.push({
				record: r.id,
				kind: "DuplicateVersion",
				detail: `${r.prompt} version ${r.version} also claimed by ${first}`,
			});
		}
	}
	return out;
}

export function promptRegistryProblems(records: PromptRecord[], issues: IssueRef[]): PromptProblem[] {
	const out: PromptProblem[] = [];
	for (const r of records) out.push(...recordProblems(r, issues));
	out.push(...duplicateVersions(records));
	return out;
}

// Warn-first-then-fail rollout: "warn" always passes (advisories while the
// lane beds in); "fail" makes any problem fatal. The phase is caller-chosen
// so the flip is a deliberate, named decision — never a silent policy change.
export function registryVerdict(records: PromptRecord[], issues: IssueRef[], phase: RegistryPhase): RegistryVerdict {
	const problems = promptRegistryProblems(records, issues);
	return { phase, problems, passed: phase === "warn" ? true : problems.length === 0 };
}

// Cookbook revert_to_version(), registry form: mint a NEW record at max+1
// carrying the target version's spec_ref / eval_issue / evidence — the older
// prompt reference restored with its justification trail intact — superseding
// the currently Active record. History is append-only; returns null when the
// target version does not exist (loud, never a silent no-op, bi#55).
export function revertToVersion(
	records: PromptRecord[],
	prompt: string,
	toVersion: number,
	timestamp: string,
): PromptRecord | null {
	const target = records.find((r) => r.prompt === prompt && r.version === toVersion);
	if (!target) return null;
	let latest = 0;
	for (const r of records) {
		if (r.prompt === prompt && r.version > latest) latest = r.version;
	}
	const current = records.find((r) => r.prompt === prompt && r.status === "Active");
	const next = latest + 1;
	return {
		id: `${prompt}@v${next}`,
		prompt,
		version: next,
		status: "Active",
		spec_ref: target.spec_ref,
		prompt_text: null,
		eval_issue: target.eval_issue,
		evidence: target.evidence,
		supersedes: current?.id ?? null,
		timestamp,
	};
}

// One TSV line per problem, same posture as the check command's
// dangling/evidence/swarm renderers: `prompt-registry\t<id>\t<kind>\t<detail>`.
export function renderProblemLine(p: PromptProblem): string {
	return `prompt-registry\t${p.record}\t${p.kind}\t${p.detail}`;
}
