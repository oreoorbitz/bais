// bais/scripts/handoff-validate.mjs — handoff file validator (bi#139).
//
// Swarm handoffs used to be free-form /tmp NOTES.md with no base commit,
// which caused the bi#91 base-mismatch incident. This module enforces the
// file spec in bais/spec/handoff.md: headers id/from/to/priority/type/
// created_at (+ directed-by on notes only), two types (diff|note), priority
// filenames, and diff bodies carrying base commit + scoped hunks + test
// evidence. Pure ESM, zero dependencies: `node` only.
//
// Usage:
//   node bais/scripts/handoff-validate.mjs <file.handoff> [--base <sha>]
//   node bais/scripts/handoff-validate.mjs <file.handoff> [--base <sha>] [--json]
// Exit 0 when valid, 1 when invalid (text mirrors `bais check`: HANDOFF
// INVALID + per-line errors + expected format, all on stdout).
//
// Red-check (bi#57, recorded 2026-09-06 by handoff-139): removed the
// whole diff-base requirement block (baseIdx find + missing/malformed
// base errors), then ran the validator over a baseless copy of the valid
// diff fixture: without the block it exited 0 HANDOFF VALID (bad — the
// bi#91 guard gone, baseless diff accepted); with the block restored it
// exits 1 with `error\t8\tdiff requires "base: <40-hex-sha>"`, and all
// five fixtures return to their §7 outcomes. (A naive one-line revert of
// just the missing-base push crashes on bodyLines[-1] instead — the block
// is the load-bearing unit, not the line.) A validator that cannot go red
// on a baseless diff is camouflage, not coverage.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const REQUIRED_HEADERS = ["id", "from", "to", "priority", "type", "created_at"];
const HEADER_RE = /^([A-Za-z0-9_-]+): (.*)$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9#_.-]*$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9.:@/_-]*$/;
const PRIORITY_RE = /^[0-9]{2}$/;
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const BASE_RE = /^[0-9a-f]{40}$/;
// NN_<ts>_<seq>_from_<sender>.handoff — 00 sorts first, so 00 is highest
// priority and folds process in order.
const FILENAME_RE = /^([0-9]{2})_(\d{8}T\d{6})_([0-9]{3,})_from_([A-Za-z0-9][A-Za-z0-9.:@/_-]*)\.handoff$/;
const NOTE_MAX = 80;

export const HANDOFF_EXPECTED = [
	"id: <handoff-id>         (e.g. handoff-001)",
	"from: <owner>            (sender, e.g. hero)",
	"to: <owner>              (recipient, e.g. titan-1)",
	"priority: <NN>           (two digits, 00 highest, first folds first)",
	"type: <diff|note>",
	"created_at: <RFC3339-Z>  (e.g. 2026-09-06T02:00:00Z)",
	"[directed-by: <owner>    (notes only: who directed the note)]",
	"<blank line>",
	"diff body: base: <40-hex-sha> + scoped hunks (diff --git / --- / +++ / @@) + Evidence: <ref>",
	"note body: exactly one line, 80 chars max",
	"filename: NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.handoff (NN == priority, sender == from)",
];

/**
 * Validate handoff text. Pure: no fs, no clock.
 * @returns {{ ok, type: string|null, base: string|null, errors: {line:number,message:string}[], expected: string[] }}
 */
export function validateHandoff(text, filename, opts = {}) {
	const errors = [];
	const err = (line, message) => errors.push({ line, message });
	const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	// Drop one trailing newline so "single line" checks see content lines.
	if (lines.length && lines[lines.length - 1] === "") lines.pop();

	// Header block: consecutive `key: value` lines from line 1.
	const headers = new Map(); // key -> { value, line }
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") break;
		const m = HEADER_RE.exec(line);
		if (!m) {
			err(i + 1, `malformed header ${JSON.stringify(line)} (expected "key: value")`);
			continue;
		}
		if (headers.has(m[1])) err(i + 1, `duplicate header ${JSON.stringify(m[1])}`);
		else headers.set(m[1], { value: m[2], line: i + 1 });
	}
	for (const k of REQUIRED_HEADERS) {
		if (!headers.has(k)) err(0, `missing header "${k}:"`);
	}
	for (const [k, h] of headers) {
		if (!REQUIRED_HEADERS.includes(k) && k !== "directed-by") {
			err(h.line, `unknown header ${JSON.stringify(k)} (expected one of ${REQUIRED_HEADERS.join(", ")})`);
		}
	}

	const get = (k) => (headers.has(k) ? headers.get(k).value : null);
	const type = get("type");
	const typeOk = type === "diff" || type === "note";
	if (headers.has("type") && !typeOk) {
		err(headers.get("type").line, `bad type ${JSON.stringify(type)} (expected "diff" or "note")`);
	}
	if (headers.has("id") && !ID_RE.test(get("id"))) {
		err(headers.get("id").line, `bad id ${JSON.stringify(get("id"))} (letters/digits/#/_/./-)`);
	}
	for (const k of ["from", "to"]) {
		if (headers.has(k) && !OWNER_RE.test(get(k))) {
			err(headers.get(k).line, `bad ${k} ${JSON.stringify(get(k))} (letters/digits/.:@/_/-)`);
		}
	}
	const priorityOk = headers.has("priority") && PRIORITY_RE.test(get("priority"));
	if (headers.has("priority") && !priorityOk) {
		err(headers.get("priority").line, `bad priority ${JSON.stringify(get("priority"))} (expected two digits, e.g. 00)`);
	}
	if (headers.has("created_at")) {
		const v = get("created_at");
		if (!CREATED_AT_RE.test(v) || Number.isNaN(Date.parse(v))) {
			err(headers.get("created_at").line, `bad created_at ${JSON.stringify(v)} (expected RFC3339 UTC, e.g. 2026-09-06T02:00:00Z)`);
		}
	}
	if (headers.has("directed-by") && typeOk && type !== "note") {
		err(headers.get("directed-by").line, `"directed-by" only valid on type note (diff handoffs carry evidence, not direction)`);
	}
	if (type === "note" && !headers.has("directed-by")) {
		err(0, `note requires "directed-by: <owner>" (notes only when directed)`);
	}

	// Body: everything after the blank separator.
	let bodyText = "";
	let bodyStartLine = 0;
	if (i >= lines.length) {
		err(0, "missing blank line + body (headers must be followed by an empty line and a body)");
	} else {
		bodyText = lines.slice(i + 1).join("\n");
		bodyStartLine = i + 2; // 1-based line of first body line
		if (bodyText.trim() === "") err(bodyStartLine, "empty body");
	}

	let base = null;
	if (bodyText.trim() !== "") {
		if (type === "diff") {
			const bodyLines = bodyText.split("\n");
			const baseIdx = bodyLines.findIndex((l) => l.startsWith("base:"));
			if (baseIdx === -1) {
				err(bodyStartLine, 'diff requires "base: <40-hex-sha>" (the commit the hunks apply against — bi#91)');
			} else {
				const sha = bodyLines[baseIdx].slice("base:".length).trim();
				if (!BASE_RE.test(sha)) {
					err(bodyStartLine + baseIdx, `bad base ${JSON.stringify(sha)} (expected full 40-hex commit sha)`);
				} else {
					base = sha;
				}
			}
			if (!bodyLines.some((l) => /^(diff --git |--- |\+\+\+ |@@ )/.test(l))) {
				err(bodyStartLine, "diff requires scoped hunks (diff --git / --- / +++ / @@ lines)");
			}
			if (!bodyLines.some((l) => /^Evidence: \S/.test(l))) {
				err(bodyStartLine, 'diff requires test evidence ("Evidence: <drill|verdict|command>")');
			}
		} else if (type === "note") {
			const bodyLines = bodyText.split("\n");
			if (bodyLines.length !== 1) {
				err(bodyStartLine, `note body must be a single line (found ${bodyLines.length})`);
			} else if (bodyLines[0].length > NOTE_MAX) {
				err(bodyStartLine, `note line is ${bodyLines[0].length} chars (max ${NOTE_MAX})`);
			}
		}
	}

	// Filename: NN_<ts>_<seq>_from_<sender>.handoff, NN == priority, sender == from.
	const base_name = basename(filename);
	const fm = FILENAME_RE.exec(base_name);
	if (!fm) {
		err(0, `bad filename ${JSON.stringify(base_name)} (expected NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.handoff)`);
	} else {
		if (priorityOk && fm[1] !== get("priority")) {
			err(0, `filename priority ${fm[1]} != header priority ${get("priority")} (fold order would lie)`);
		}
		if (headers.has("from") && fm[4] !== get("from")) {
			err(0, `filename sender ${JSON.stringify(fm[4])} != header from ${JSON.stringify(get("from"))}`);
		}
	}

	// Merge-time base gate: the merger passes the commit the fold runs
	// against; a handoff written against another commit is rejected here
	// instead of mis-applying (bi#91).
	if (opts.base != null) {
		if (typeOk && type !== "diff") {
			err(0, "note carries no base commit (--base applies to diff handoffs only)");
		} else if (base != null && opts.base !== base) {
			err(0, `base mismatch: file base ${base} != merge base ${opts.base} (handoff written against a different commit; rebase the handoff or fold at its base)`);
		}
	}

	const ok = errors.length === 0;
	return { ok, file: filename, type: typeOk ? type : null, base, errors, expected: HANDOFF_EXPECTED };
}

/** Read + validate a file. Unreadable file is one line-0 error. */
export function validateHandoffFile(path, opts = {}) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		return { ok: false, file: path, type: null, base: null, errors: [{ line: 0, message: `unreadable: ${e.message.split("\n")[0]}` }], expected: HANDOFF_EXPECTED };
	}
	return validateHandoff(text, path, opts);
}

export function formatText(res) {
	const out = [];
	if (res.ok) {
		out.push(`HANDOFF VALID\t${res.file}`);
	} else {
		out.push(`HANDOFF INVALID ${res.file} (${res.errors.length} error${res.errors.length === 1 ? "" : "s"})`);
		for (const e of res.errors) out.push(`error\t${e.line}\t${e.message}`);
		out.push("expected:");
		for (const l of res.expected) out.push(`  ${l}`);
	}
	return out.join("\n");
}

const isMain = process.argv[1] != null && basename(process.argv[1]) === "handoff-validate.mjs";
if (isMain) {
	const args = process.argv.slice(2);
	const file = args.find((a) => !a.startsWith("--"));
	const bi = args.indexOf("--base");
	const base = bi !== -1 ? args[bi + 1] : undefined;
	const asJson = args.includes("--json");
	if (!file) {
		console.log('usage: handoff-validate.mjs <file.handoff> [--base <sha>] [--json]');
		process.exit(1);
	}
	if (bi !== -1 && (base == null || base.startsWith("--"))) {
		console.log("handoff-validate.mjs: --base needs <sha>");
		process.exit(1);
	}
	const res = validateHandoffFile(file, base == null ? {} : { base });
	if (asJson) console.log(JSON.stringify(res, null, 2));
	else console.log(formatText(res));
	process.exit(res.ok ? 0 : 1);
}
