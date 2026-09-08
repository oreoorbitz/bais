// bais/src/suggestion.ts — host mirror of baml_src/suggestion.baml (hub#211).
//
// Consent-first Suggestion lane: a Suggestion is a ready-to-run spec the
// user may accept; NOTHING in this module creates an Issue except
// writePromotedIssue, and that function refuses unless the caller passes
// { consent: true } explicitly (the guard the bi#57 red-check neuters).
// Suggestions are a record class separate from Issue (not a new Kind), so
// `bais ready` stays work-only by construction; the lane lives in
// .bais/suggestions/*.toml, file-per-suggestion like issues.
//
// BAML owns the rules and proves them with `baml test`
// (suggestion_test.baml); this file mirrors them for the CLI because the
// committed baml_sdk cannot carry new functions (same FFI rationale as
// graph.ts's header). Change a rule in suggestion.baml, change it here.
//
// SELF-CONTAINED: only type-level imports from ./graph.js (erased at
// compile) — no runtime dependency on the BAML bridge, the store, or the
// strict TOML parser, so this module loads standalone (node type-stripping
// included) for the consent red-check.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaisEdge, BaisIssue } from "./graph.js";

// Mirrors of BAML max_pending() / cap_eviction_reason() — the names must
// agree (same convention as URGENCY_COST_CAP_TOKENS / urgency_cost_cap()).
export const MAX_PENDING = 5;
export const CAP_EVICTION_REASON = "cap-evicted-oldest";

export type SuggestionStatus = "Pending" | "Dismissed" | "Promoted" | "Evicted";

export type SuggestionRecord = {
	id: string; // lane-local id, e.g. sug#001 — NOT an issue id
	dedup_key: string; // terminal status latches this key forever
	title: string;
	body: string; // the ready-to-run spec markdown the user accepts
	status: SuggestionStatus;
	offered_at: number; // monotone offer sequence (host clock); cap evicts the lowest
	evidence: string[]; // issue ids the suggestion cites; promote links to them
	resolution: string | null; // named reason once terminal; null while Pending
};

// What one offer did to the lane — mirror of BAML LaneUpdate. Carries NO
// Issue: offering can never create one.
export type LaneDecision = "offered" | "offered-evicted-oldest" | "refused-latched" | "refused-pending-duplicate";
export type LaneUpdate = {
	lane: SuggestionRecord[];
	decision: LaneDecision;
	evicted_id: string | null;
	eviction_reason: string | null;
};

// ── Lane rules (mirrors of the BAML functions) ───────────────────────────

// Latched = some record already carries this key in a terminal status.
// A latched key is never re-offered. Dismissal is the acceptance case;
// Promoted latches (re-offering duplicates live work), Evicted latches
// (re-offering defeats the cap).
export function isLatched(dedupKey: string, lane: SuggestionRecord[]): boolean {
	return lane.some((s) => s.dedup_key === dedupKey && s.status !== "Pending");
}

// The lane listing: only Pending records are offered. Terminal records stay
// on disk as the latch + audit trail but never list.
export function pendingSuggestions(lane: SuggestionRecord[]): SuggestionRecord[] {
	return lane.filter((s) => s.status === "Pending");
}

// Oldest Pending by offered_at (ties: first seen). Null when none pending.
export function oldestPending(lane: SuggestionRecord[]): SuggestionRecord | null {
	let best: SuggestionRecord | null = null;
	for (const s of lane) {
		if (s.status !== "Pending") continue;
		if (best === null || s.offered_at < best.offered_at) best = s;
	}
	return best;
}

function withStatus(s: SuggestionRecord, status: SuggestionStatus, resolution: string | null): SuggestionRecord {
	return { ...s, status, resolution };
}

// Mirror of BAML offer_suggestion. Check order is the contract:
//   1. latched key (any terminal record) -> refused-latched, lane unchanged
//   2. key already Pending               -> refused-pending-duplicate
//   3. Pending count at cap              -> evict oldest (named reason), then admit
//   4. otherwise                         -> admit
// Never mutates the input lane.
export function offerSuggestion(lane: SuggestionRecord[], candidate: SuggestionRecord): LaneUpdate {
	if (isLatched(candidate.dedup_key, lane)) {
		return { lane, decision: "refused-latched", evicted_id: null, eviction_reason: null };
	}
	if (lane.some((s) => s.dedup_key === candidate.dedup_key && s.status === "Pending")) {
		return { lane, decision: "refused-pending-duplicate", evicted_id: null, eviction_reason: null };
	}
	let evicted_id: string | null = null;
	let eviction_reason: string | null = null;
	let next: SuggestionRecord[];
	if (pendingSuggestions(lane).length >= MAX_PENDING) {
		const victim = oldestPending(lane);
		if (victim) {
			evicted_id = victim.id;
			eviction_reason = CAP_EVICTION_REASON;
			next = lane.map((s) => (s.id === victim.id ? withStatus(s, "Evicted", CAP_EVICTION_REASON) : s));
		} else {
			next = [...lane];
		}
	} else {
		next = [...lane];
	}
	next.push(candidate);
	return { lane: next, decision: evicted_id === null ? "offered" : "offered-evicted-oldest", evicted_id, eviction_reason };
}

// ── Promote: pure derivation, then the consent-gated write ───────────────

export type PromoteDerivation = { issue: BaisIssue; edges: BaisEdge[] };

// Mirror of BAML promote_derivation: the Issue to file (Open, kind
// Proposal) plus Related edges linking it to the suggestion's evidence.
// PURE — no I/O. Safe to call anywhere; it still creates nothing.
export function promoteDerivation(s: SuggestionRecord, newIssueId: string): PromoteDerivation {
	return {
		issue: {
			id: newIssueId,
			title: s.title,
			status: "Open",
			kind: "Proposal",
			area: null,
			severity: null,
			source: null,
			body: s.body,
		},
		edges: s.evidence.map((to) => ({ from: newIssueId, to, kind: "Related" })),
	};
}

// Render the derived issue as a .bais/issues/<id>.toml document in the
// canonical shape (same envelope parseBaisFile reads). The suggestion's
// provenance rides in the body header so the link survives rg.
export function renderIssueToml(d: PromoteDerivation, promotedFrom: SuggestionRecord): string {
	if (d.issue.body.includes("'''")) {
		throw new Error("unrenderable-body: suggestion body contains a triple quote");
	}
	const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const lines = [
		`id = "${esc(d.issue.id)}"`,
		`title = "${esc(d.issue.title)}"`,
		`status = "${d.issue.status}"`,
		`kind = "${d.issue.kind}"`,
		`body = '''`,
		`Promoted-From: ${promotedFrom.id} (dedup_key ${promotedFrom.dedup_key})`,
		``,
		d.issue.body,
		`'''`,
	];
	for (const e of d.edges) {
		lines.push(``, `[[edge]]`, `from = "${esc(e.from)}"`, `to = "${esc(e.to)}"`, `kind = "${e.kind}"`);
	}
	return lines.join("\n") + "\n";
}

// THE ONLY path from Suggestion to Issue on disk — consent-first.
// The guard is the load-bearing hunk the bi#57 red-check neuters:
// consent must be literally `true`; anything else (undefined, "yes", 1)
// refuses BEFORE any path is touched. Refuses to overwrite an existing
// issue file. Returns the written path. Every other function in this
// module — load/parse/offer/derive/render — performs no write to
// issuesDir at all; offer flows return LaneUpdate (no Issue), and the
// only other writes this module performs are suggestion-lane files under
// the suggestions dir (dismiss/offer persistence), never issue files.
//
// Red-check record (bi#57), run via /tmp/bais-suggest-redcheck.mjs:
//   hunk:     `if (consent !== true)` guard below neutered to `if (false)`
//   expected: FAIL consent-guard-missing — issue file written without consent
//   observed: baseline printed "ok consent-guard: refused without consent, no
//             file" (+3 more ok, REDCHECK GREEN); neutered run printed
//             "FAIL consent-guard-missing: hub#777.toml written without
//             consent (consent=undefined)" and the same for false/0/"yes"/1
//             (the script's later explicit-consent step then tripped the
//             never-overwrite guard on the file the neutered writes had
//             leaked — collateral of the neutered state, not the baseline);
//             restored run printed all four ok lines + REDCHECK GREEN.
//             Full outputs in the hub#211 report.
export function writePromotedIssue(
	issuesDir: string,
	s: SuggestionRecord,
	newIssueId: string,
	consent: boolean,
): string {
	if (consent !== true) {
		throw new Error("consent-required: promote writes an issue only on explicit consent (consent: true)");
	}
	const d = promoteDerivation(s, newIssueId);
	const file = join(issuesDir, `${newIssueId}.toml`);
	if (existsSync(file)) {
		throw new Error(`promote-target-exists: ${file} already exists — never overwrite an issue`);
	}
	writeFileSync(file, renderIssueToml(d, s));
	return file;
}

// ── Suggestion-lane persistence (writes ONLY under the suggestions dir) ──

export type SuggestionLoadFailure = { file: string; error: string };
export type SuggestionLoad = { suggestions: SuggestionRecord[]; failures: SuggestionLoadFailure[] };

const STATUSES: SuggestionStatus[] = ["Pending", "Dismissed", "Promoted", "Evicted"];

// Minimal strict reader for the suggestion record shape (self-contained —
// the BAML strict TOML parser owns the Issue envelope, not this shape).
// Admits: bare keys with basic-string / integer / string-array values, `#`
// comments, blank lines. Unknown keys and malformed lines reject loudly.
export function parseSuggestionFile(text: string): SuggestionRecord {
	const rec: Record<string, string | number | string[]> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const m = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
		if (!m) throw new Error(`malformed-line: ${line}`);
		const [, key, rhs] = m;
		if (rhs.startsWith('"')) {
			const sm = /^"((?:[^"\\]|\\.)*)"$/.exec(rhs);
			if (!sm) throw new Error(`malformed-string: ${line}`);
			rec[key] = sm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		} else if (rhs.startsWith("[")) {
			const am = /^\[(("(?:[^"\\]|\\.)*")(\s*,\s*"(?:[^"\\]|\\.)*")*)?\]$/.exec(rhs);
			if (!am) throw new Error(`malformed-array: ${line}`);
			rec[key] = am[1] ? [...am[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]) : [];
		} else if (/^-?\d+$/.test(rhs)) {
			rec[key] = Number(rhs);
		} else {
			throw new Error(`malformed-value: ${line}`);
		}
	}
	const required = ["id", "dedup_key", "title", "body", "status", "offered_at", "evidence"];
	for (const k of required) {
		if (!(k in rec)) throw new Error(`missing-key: ${k}`);
	}
	for (const k of Object.keys(rec)) {
		if (![...required, "resolution"].includes(k)) throw new Error(`unknown-key: ${k}`);
	}
	if (!STATUSES.includes(rec.status as SuggestionStatus)) throw new Error(`bad-status: ${rec.status}`);
	if (typeof rec.offered_at !== "number") throw new Error("bad-offered_at: not an integer");
	if (!Array.isArray(rec.evidence)) throw new Error("bad-evidence: not a string array");
	return {
		id: String(rec.id),
		dedup_key: String(rec.dedup_key),
		title: String(rec.title),
		body: String(rec.body),
		status: rec.status as SuggestionStatus,
		offered_at: rec.offered_at as number,
		evidence: rec.evidence as string[],
		resolution: rec.resolution == null ? null : String(rec.resolution),
	};
}

export function loadSuggestions(suggestionsDir: string): SuggestionLoad {
	if (!existsSync(suggestionsDir)) return { suggestions: [], failures: [] };
	const files = readdirSync(suggestionsDir).filter((f) => f.endsWith(".toml")).sort();
	const suggestions: SuggestionRecord[] = [];
	const failures: SuggestionLoadFailure[] = [];
	for (const f of files) {
		try {
			suggestions.push(parseSuggestionFile(readFileSync(join(suggestionsDir, f), "utf8")));
		} catch (e: any) {
			failures.push({ file: f, error: String(e?.message ?? e) });
		}
	}
	return { suggestions, failures };
}

export function renderSuggestionToml(s: SuggestionRecord): string {
	const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const lines = [
		`id = "${esc(s.id)}"`,
		`dedup_key = "${esc(s.dedup_key)}"`,
		`title = "${esc(s.title)}"`,
		`status = "${s.status}"`,
		`offered_at = ${s.offered_at}`,
		`evidence = [${s.evidence.map((e) => `"${esc(e)}"`).join(", ")}]`,
	];
	if (s.resolution !== null) lines.push(`resolution = "${esc(s.resolution)}"`);
	lines.push(`body = "${esc(s.body)}"`);
	return lines.join("\n") + "\n";
}

// Lane persistence — writes ONLY <suggestionsDir>/<id>.toml (never issues).
export function writeSuggestion(suggestionsDir: string, s: SuggestionRecord): string {
	mkdirSync(suggestionsDir, { recursive: true });
	const file = join(suggestionsDir, `${s.id}.toml`);
	writeFileSync(file, renderSuggestionToml(s));
	return file;
}

// Dismissal: flip the record to Dismissed on disk — this IS the latch, so
// it persists across sessions and the key is never re-offered.
export function dismissSuggestion(suggestionsDir: string, id: string): SuggestionRecord {
	const { suggestions } = loadSuggestions(suggestionsDir);
	const found = suggestions.find((s) => s.id === id);
	if (!found) throw new Error(`unknown-suggestion: ${id}`);
	const dismissed = withStatus(found, "Dismissed", "dismissed");
	writeSuggestion(suggestionsDir, dismissed);
	return dismissed;
}
