// bais/scripts/inbox.mjs — agent inbox surface (bi#149).
//
// Spawn briefs require agents to re-read issue + inbox on start/resume
// (bi#144) and teardown requires the inbox drained-or-requeued (bi#141),
// but no inbox surface existed (found during bi#145). This module enforces
// the file spec in bais/spec/inbox.md: per-owner queue dirs under
// .bais/inbox/<owner>/, line-oriented messages (id/from/to/priority/
// created_at + body), bi#139 priority filenames with a .msg suffix,
// operator+lieutenant-only sends, live-claim-gated delivery with loud
// re-queue for dead owners, and read-and-acknowledge semantics.
// Pure ESM, zero dependencies: `node` only.
//
// Usage (run from bais/):
//   node scripts/inbox.mjs send --hub <root> --as <sender> [--lieutenant <o>...]
//     --to <owner> --priority <NN> --id <msg-id> --body <text> [--now <ts>]
//   node scripts/inbox.mjs read --hub <root> --as <owner|operator> --owner <o>
//   node scripts/inbox.mjs ack --hub <root> --as <owner|operator> --owner <o> <id>
//   node scripts/inbox.mjs validate <file.msg> [--json]
// Exit 0 on delivered / re-queued / listed / acked / valid; exit 1 on
// refused / no-such / invalid (all loud on stdout, repair guidance mirrors
// `bais check`: INBOX INVALID + error<TAB>line<TAB>message + expected:).
//
// Wiring spec (future `bais inbox ...` CLI, out of scope for bi#149):
// `bais inbox send|read|ack` map 1:1 onto the subcommands here with
// --hub defaulting to the hub root; `bais handoff --validate` stays
// handoff-only (§7 of the spec: it refuses .msg drops via its filename
// rule). Lieutenant membership (--lieutenant set) comes from the goal
// event logs (`lieutenant: <owner>` lines); until the CLI reads those,
// the caller passes the set explicitly.
//
// Red-check (bi#57, recorded 2026-09-06 by inbox-149): removed the
// liveness-gate hunk in send (`if (!isLive(...)) reroute` → always land),
// then ran the fixture gate over untouched fixtures: the dead-owner drop
// landed silently in the dead queue and check.mjs --all went red with
// `expected INBOX REQUEUED for <dead-owner>, got INBOX DELIVERED`
// (wrong outcome — the rot path the gate exists to prevent); with the
// hunk restored all 9 assertions return to their §8 outcomes. A gate that
// cannot go red on a dead-owner drop is camouflage, not coverage.

import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, basename } from "node:path";

const REQUIRED_HEADERS = ["id", "from", "to", "priority", "created_at"];
const HEADER_RE = /^([A-Za-z0-9_-]+): (.*)$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9#_.-]*$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9.:@/_-]*$/;
const PRIORITY_RE = /^[0-9]{2}$/;
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// NN_<ts>_<seq>_from_<sender>.msg — same priority convention as bi#139
// handoffs, .msg suffix so the surfaces never collide on suffix.
// NOTE: exactly one backslash before the dot (escaped dot).
const FILENAME_RE = /^([0-9]{2})_([0-9]{8}T[0-9]{6})_([0-9]{3,})_from_([A-Za-z0-9][A-Za-z0-9.:@/_-]*)[.]msg$/;
const BODY_MAX = 2000;

export const INBOX_EXPECTED = [
	"id: <msg-id>            (e.g. msg-001)",
	"from: <owner>           (sender: operator or a lieutenant, e.g. operator)",
	"to: <owner>             (recipient queue, e.g. titan-1)",
	"priority: <NN>          (two digits, 00 highest, first reads first)",
	"created_at: <RFC3339-Z> (e.g. 2026-09-06T02:00:00Z)",
	"<blank line>",
	"body: non-empty, 2000 chars max (operational content; code travels by handoff diff)",
	"filename: NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.msg (NN == priority, sender == from)",
];

/**
 * Validate inbox message text. Pure: no fs, no clock.
 * @returns {{ ok, errors: {line:number,message:string}[], expected: string[] }}
 */
export function validateInbox(text, filename) {
	const errors = [];
	const err = (line, message) => errors.push({ line, message });
	const base = basename(filename);
	if (base.endsWith(".handoff")) {
		err(0, `not an inbox file ${JSON.stringify(base)} (handoff drops validate with handoff-validate.mjs, not here)`);
		return { ok: false, file: filename, errors, expected: INBOX_EXPECTED };
	}
	const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (lines.length && lines[lines.length - 1] === "") lines.pop();

	const headers = new Map();
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
		if (!REQUIRED_HEADERS.includes(k)) {
			err(h.line, `unknown header ${JSON.stringify(k)} (expected one of ${REQUIRED_HEADERS.join(", ")})`);
		}
	}

	const get = (k) => (headers.has(k) ? headers.get(k).value : null);
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

	let bodyText = "";
	let bodyStartLine = 0;
	if (i >= lines.length) {
		err(0, "missing blank line + body (headers must be followed by an empty line and a body)");
	} else {
		bodyText = lines.slice(i + 1).join("\n");
		bodyStartLine = i + 2;
		if (bodyText.trim() === "") err(bodyStartLine, "empty body (inbox messages carry operational content)");
		else if (bodyText.length > BODY_MAX) {
			err(bodyStartLine, `body is ${bodyText.length} chars (max ${BODY_MAX}; code travels by handoff diff)`);
		}
	}

	const fm = FILENAME_RE.exec(base);
	if (!fm) {
		err(0, `bad filename ${JSON.stringify(base)} (expected NN_<YYYYMMDDTHHMMSS>_<seq>_from_<sender>.msg)`);
	} else {
		if (priorityOk && fm[1] !== get("priority")) {
			err(0, `filename priority ${fm[1]} != header priority ${get("priority")} (read order would lie)`);
		}
		if (headers.has("from") && fm[4] !== get("from")) {
			err(0, `filename sender ${JSON.stringify(fm[4])} != header from ${JSON.stringify(get("from"))}`);
		}
	}

	return { ok: errors.length === 0, file: filename, errors, expected: INBOX_EXPECTED };
}

/** Read + validate a file. Unreadable file is one line-0 error. */
export function validateInboxFile(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		return { ok: false, file: path, errors: [{ line: 0, message: `unreadable: ${e.message.split("\n")[0]}` }], expected: INBOX_EXPECTED };
	}
	return validateInbox(text, path);
}

export function formatText(res) {
	const out = [];
	if (res.ok) {
		out.push(`INBOX VALID\t${res.file}`);
	} else {
		out.push(`INBOX INVALID ${res.file} (${res.errors.length} error${res.errors.length === 1 ? "" : "s"})`);
		for (const e of res.errors) out.push(`error\t${e.line}\t${e.message}`);
		out.push("expected:");
		for (const l of res.expected) out.push(`  ${l}`);
	}
	return out.join("\n");
}

// --- Hub operations (fs + clock; pure validate above stays importable) ---

/** Top-level `key = "value"` TOML string fields. Enough for status/holder/lease. */
export function parseIssueFields(text) {
	const fields = {};
	for (const line of text.split("\n")) {
		const m = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line.trim());
		if (m) fields[m[1]] = m[2];
	}
	return fields;
}

/**
 * Liveness (spec section 4, same rule as the dispatcher's lease filter):
 * some issue with status Doing, holder == owner, parseable future lease.
 * Missing/unparseable/expired/anonymous/non-Doing all read as dead.
 */
export function isLive(hubRoot, owner, nowMs) {
	let files;
	try {
		files = readdirSync(join(hubRoot, ".bais", "issues"));
	} catch {
		return false;
	}
	for (const f of files) {
		if (!f.endsWith(".toml")) continue;
		let text;
		try {
			text = readFileSync(join(hubRoot, ".bais", "issues", f), "utf8");
		} catch {
			continue;
		}
		const { status, holder, lease } = parseIssueFields(text);
		if (status !== "Doing" || holder !== owner) continue;
		const exp = Date.parse(lease ?? "");
		if (Number.isFinite(exp) && exp > nowMs) return true;
	}
	return false;
}

export function inboxDir(hubRoot, owner) {
	return join(hubRoot, ".bais", "inbox", owner);
}

export function listMessages(hubRoot, owner) {
	const dir = inboxDir(hubRoot, owner);
	let files;
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".msg")).sort();
	} catch {
		return [];
	}
	return files.map((f) => join(dir, f));
}

/** Atomic publish: tmp + fsync + rename (spec section 1, same as handoff.md section 5). */
function publishAtomic(dir, name, text) {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `${name}.tmp.${process.pid}`);
	const fd = openSync(tmp, "w");
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, join(dir, name));
}

function parseOpts(argv) {
	const o = { lieutenant: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--hub") o.hub = argv[++i];
		else if (a === "--as") o.as = argv[++i];
		else if (a === "--to") o.to = argv[++i];
		else if (a === "--owner") o.owner = argv[++i];
		else if (a === "--priority") o.priority = argv[++i];
		else if (a === "--id") o.id = argv[++i];
		else if (a === "--body") o.body = argv[++i];
		else if (a === "--now") o.now = argv[++i];
		else if (a === "--lieutenant") o.lieutenant.push(argv[++i]);
		else if (a === "--json") o.json = true;
		else if (!a.startsWith("--") && o._pos === undefined) o._pos = a;
	}
	return o;
}

function nowMs(o) {
	if (o.now == null) return Date.now();
	const t = Date.parse(o.now);
	if (!Number.isFinite(t)) {
		console.log(`INBOX REFUSED bad --now ${JSON.stringify(o.now)} (expected RFC3339 UTC)`);
		process.exit(1);
	}
	return t;
}

function stampFor(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function cmdSend(o, hub) {
	const ms = nowMs(o);
	for (const k of ["as", "to", "priority", "id", "body"]) {
		if (o[k] == null) {
			console.log(`INBOX REFUSED missing --${k} (send needs --as --to --priority --id --body)`);
			process.exit(1);
		}
	}
	// Writer authorization (spec section 3): operator or a named
	// lieutenant. --as is the sender: filename + header attribution
	// depend on it, so it is not a separate flag.
	if (o.as !== "operator" && !o.lieutenant.includes(o.as)) {
		console.log(`INBOX REFUSED sender ${JSON.stringify(o.as)} (only operator or a lieutenant may send; pass --lieutenant <owner> for the sender's directories)`);
		process.exit(1);
	}
	const created = o.now ?? new Date(ms).toISOString().replace(/[.][0-9]+Z$/, "Z");
	const text = [`id: ${o.id}`, `from: ${o.as}`, `to: ${o.to}`, `priority: ${o.priority}`, `created_at: ${created}`, "", o.body].join("\n") + "\n";
	// Per-sender per-stamp sequence: bump past existing matches so two
	// sends in the same second never collide (spec section 1 filenames).
	const stamp = stampFor(ms);
	const prefix = `${o.priority}_${stamp}_`;
	const suffix = `_from_${o.as}.msg`;
	const taken = new Set();
	for (const dir of [inboxDir(hub, o.to), join(hub, ".bais", "inbox", "_requeue", o.to)]) {
		let files;
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) if (f.startsWith(prefix) && f.endsWith(suffix)) taken.add(f);
	}
	let n = 1;
	const seqOf = (k) => String(k).padStart(3, "0");
	while (taken.has(`${prefix}${seqOf(n)}${suffix}`)) n++;
	const name = `${prefix}${seqOf(n)}${suffix}`;
	const res = validateInbox(text, name);
	if (!res.ok) {
		res.file = name;
		console.log(formatText(res));
		process.exit(1);
	}
	// Liveness gate (spec section 5): dead owners reroute loud, never land silent.
	if (!isLive(hub, o.to, ms)) {
		const dir = join(hub, ".bais", "inbox", "_requeue", o.to);
		publishAtomic(dir, name, text);
		console.log(`INBOX REQUEUED ${join(".bais", "inbox", "_requeue", o.to, name)} (owner ${o.to} has no live claim; re-queued for operator triage)`);
		process.exit(0);
	}
	const dir = inboxDir(hub, o.to);
	publishAtomic(dir, name, text);
	console.log(`INBOX DELIVERED ${join(".bais", "inbox", o.to, name)}`);
}

/** Headers of one .msg file (header block only; body read separately). */
function parseMsgHeaders(path) {
	const text = readFileSync(path, "utf8");
	const fields = {};
	for (const line of text.split("\n")) {
		const m = /^([A-Za-z0-9_-]+): (.*)$/.exec(line);
		if (!m) break;
		fields[m[1]] = m[2];
	}
	return fields;
}

function bodyOf(path) {
	const text = readFileSync(path, "utf8");
	const parts = text.split("\n");
	const idx = parts.findIndex((l) => l.trim() === "");
	return parts.slice(idx + 1).join("\n").replace(/\n$/, "");
}

function cmdRead(o, hub) {
	for (const k of ["as", "owner"]) {
		if (o[k] == null) {
			console.log(`INBOX REFUSED missing --${k} (read needs --as --owner)`);
			process.exit(1);
		}
	}
	if (o.as !== o.owner && o.as !== "operator") {
		console.log(`INBOX REFUSED reader ${JSON.stringify(o.as)} (only ${o.owner} or operator may read this queue)`);
		process.exit(1);
	}
	const files = listMessages(hub, o.owner);
	if (!files.length) console.log(`INBOX EMPTY ${o.owner}`);
	for (const f of files) {
		const res = validateInboxFile(f);
		if (!res.ok) {
			console.log(formatText({ ...res, file: f }));
			process.exit(1);
		}
		const { id, from, priority, created_at } = parseMsgHeaders(f);
		console.log(`INBOX MESSAGE ${id} from=${from} priority=${priority} created_at=${created_at}`);
		console.log(bodyOf(f));
	}
}

function cmdAck(o, hub) {
	for (const k of ["as", "owner"]) {
		if (o[k] == null) {
			console.log(`INBOX REFUSED missing --${k} (ack needs --as --owner <id>)`);
			process.exit(1);
		}
	}
	const id = o._pos;
	if (id == null) {
		console.log("INBOX REFUSED missing <id> (usage: ack --as <o> --owner <o> <id>)");
		process.exit(1);
	}
	if (o.as !== o.owner && o.as !== "operator") {
		console.log(`INBOX REFUSED acker ${JSON.stringify(o.as)} (only ${o.owner} or operator may ack this queue)`);
		process.exit(1);
	}
	if (o.owner === "_requeue" || o.owner.startsWith("_requeue/")) {
		console.log("INBOX REFUSED _requeue is drained by operator triage, not direct ack (ack the rerouted owner queue via the operator path)");
		process.exit(1);
	}
	const dirs = [inboxDir(hub, o.owner)];
	if (o.as === "operator") dirs.push(join(hub, ".bais", "inbox", "_requeue", o.owner));
	for (const dir of dirs) {
		let files;
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".msg"));
		} catch {
			continue;
		}
		for (const f of files) {
			if (parseMsgHeaders(join(dir, f)).id !== id) continue;
			if (dir.includes("_requeue") && o.as !== "operator") {
				console.log(`INBOX REFUSED ${id} is rerouted mail (only operator may ack _requeue)`);
				process.exit(1);
			}
			unlinkSync(join(dir, f));
			console.log(`INBOX ACKED ${id}`);
			return;
		}
	}
	console.log(`INBOX NO SUCH MESSAGE ${id} (queue ${o.owner} holds no such id)`);
	process.exit(1);
}

const isMain = process.argv[1] != null && basename(process.argv[1]) === "inbox.mjs";
if (isMain) {
	const [sub, ...rest] = process.argv.slice(2);
	const o = parseOpts(rest);
	const hub = o.hub ?? process.cwd();
	if (sub === "send") cmdSend(o, hub);
	else if (sub === "read") cmdRead(o, hub);
	else if (sub === "ack") cmdAck(o, hub);
	else if (sub === "validate") {
		const file = o._pos;
		if (!file) {
			console.log("usage: inbox.mjs validate <file.msg> [--json]");
			process.exit(1);
		}
		const res = validateInboxFile(file);
		if (o.json) console.log(JSON.stringify(res, null, 2));
		else console.log(formatText(res));
		process.exit(res.ok ? 0 : 1);
	} else {
		console.log("usage: inbox.mjs <send|read|ack|validate> [options]");
		process.exit(1);
	}
}
