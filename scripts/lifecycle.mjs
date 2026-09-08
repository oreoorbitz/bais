// bais/scripts/lifecycle.mjs — bi#136: lifecycle binding (canonical).
//
// Clearing must be recoverable and bounded. Three bindings:
//
//   (1) goal clear is snapshot-first + explicit-confirm. `snapshotForClear`
//       builds the snapshot {kind:"goal-snapshot", statement, at, issues}
//       over the live goal.toml + issue id set; `verifySnapshotForClear`
//       refuses a clear unless the snapshot file exists, parses, carries
//       the CURRENT statement, and covers the CURRENT issue id set (a stale
//       snapshot — goal edited or issues added/removed since — is refused
//       with "snapshot stale", never silently honored). The --confirm flag
//       is the explicit human yes (same shape as goal commit's --approve).
//       Without snapshot-first + confirm, clear is refused, period.
//   (2) restructured-away nodes become Dropped with reason (or move to
//       .bais/archive/), never silent hard-delete. `retireBody` appends the
//       dated `Retired <date>: <reason>` line inside the body's closing
//       quotes; the CLI flips status to Dropped (or archives the file).
//   (3) archive budget: `archiveSize` reports exact bytes + file count;
//       `overCap` compares against the cap (config `archive_cap_bytes`,
//       `--cap` override). Over cap warns LOUD with exact bytes on both
//       --size and archive writes; --size exits nonzero (budget gate).
//       `bais delete` (CLI) removes the issue file fully + rebuilds the
//       projection — no more manual cache-folder hunting.
//
// All filesystem access is injected (sizes, file lists) or confined to the
// helpers' explicit dir arguments — the predicates stay deterministic and
// the --selftest runs fully in-process on fixture data (exact byte counts
// asserted literally).
//
//   (4) hub#195: the committed goal.toml is bound to the human-approved
//       sketch. `approvedSketchHash` hashes the approved sketch.toml text at
//       commit; `verifyApprovedSketch` refuses drift loud ("sketch stale" —
//       the (1) "snapshot stale" precedent): a post-approval edit to
//       nodes/edges is detected, never silently honored. `goalSnapshotId`
//       is the campaign-version id every committed e2e case file records;
//       `e2eSnapshotDrift` joins case-file snapshot ids against the live
//       goal_snapshot — cross-goal case reuse requires an explicit keep
//       decision (a rebind), never a silent carry-over.
//
// RED-CHECK (bi#57, bi#136): the load-bearing hunk is the snapshot-first
// refusal in verifySnapshotForClear (!snap -> {ok:false, ...}). Reverting
// it to always-ok must trip the selftest with exactly:
//   "FAIL selftest: clear without snapshot is refused"
// (verified 2026-09-06: refusal neutered -> that FAIL observed -> restored).
//
// RED-CHECK (bi#57, hub#195): the load-bearing hunk is the hash-mismatch
// refusal in verifyApprovedSketch (recorded !== actual -> {ok:false, ...}).
// Neutering it to always-ok must trip the selftest with exactly:
//   "FAIL selftest: tampered sketch.toml is refused loud against the approved-sketch hash"
// (verified 2026-09-08: refusal neutered -> that FAIL observed, exit 1 ->
// restored green).

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_KIND = "goal-snapshot";

// --- archive budget --------------------------------------------------------
// Sum exact bytes over regular files directly inside archiveDir (flat layout:
// `bais archive <id>` stores <id>.toml + moves nothing else there).
export function archiveSize(archiveDir) {
	let entries = [];
	try {
		entries = readdirSync(archiveDir).sort();
	} catch {
		return { bytes: 0, files: 0, entries: [] };
	}
	let bytes = 0;
	const kept = [];
	for (const n of entries) {
		try {
			const st = statSync(join(archiveDir, n));
			if (st.isFile()) { bytes += st.size; kept.push(n); }
		} catch { /* renamed mid-read: skip, never inflate */ }
	}
	return { bytes, files: kept.length, entries: kept };
}

export function overCap(bytes, capBytes) {
	return bytes > capBytes;
}

export function parseCapBytes(raw) {
	if (raw == null) return null;
	const m = /^(\d+)(b|k|m)?$/i.exec(String(raw).trim());
	if (!m) return null;
	const mult = (m[2] ?? "b").toLowerCase() === "k" ? 1024 : (m[2] ?? "b").toLowerCase() === "m" ? 1048576 : 1;
	return Number(m[1]) * mult;
}

export function sizeReport({ bytes, files }, capBytes) {
	const base = `archive\t${bytes}B\t${files} files`;
	if (capBytes != null && overCap(bytes, capBytes)) {
		return { text: base, warn: `warn\tarchive over cap: ${bytes} > ${capBytes} bytes`, over: true };
	}
	return { text: base, warn: null, over: false };
}

// --- goal snapshot / clear -------------------------------------------------
export function snapshotForClear({ statement, issueIds, at = new Date().toISOString() }) {
	return { kind: SNAPSHOT_KIND, statement, at, issues: [...issueIds].sort() };
}

export function verifySnapshotForClear(snap, { statement, issueIds }) {
	if (snap == null || typeof snap !== "object") {
		return { ok: false, error: "clear refused: snapshot-first — run `bais goal snapshot --out <file>` then retry with --snapshot <file>" };
	}
	if (snap.kind !== SNAPSHOT_KIND) {
		return { ok: false, error: `clear refused: not a goal snapshot (kind=${JSON.stringify(snap.kind ?? null)})` };
	}
	if (snap.statement !== statement) {
		return { ok: false, error: "clear refused: snapshot stale — goal statement changed since snapshot, re-run `bais goal snapshot`" };
	}
	const live = new Set(issueIds);
	const snapSet = new Set(Array.isArray(snap.issues) ? snap.issues : []);
	const sameSize = live.size === snapSet.size;
	const sameMembers = sameSize && [...live].every((id) => snapSet.has(id));
	if (!sameMembers) {
		return { ok: false, error: "clear refused: snapshot stale — issue set changed since snapshot, re-run `bais goal snapshot`" };
	}
	return { ok: true, error: null };
}

// --- approved-sketch hash binding (hub#195) ---------------------------------
// The approved PLAN (nodes + edges, persisted as .bais/sketch.toml) is the
// governed artifact, not just the interview data. commit() records
// approved_sketch_hash + goal_snapshot in goal.toml; drift between the
// recorded hash and the committed sketch file flags loud in `bais check`.
// Content-address idiom: sha256 over the exact sketch.toml bytes written
// (the surfaceAnchor/eventId precedent). Pure — both sides arrive as text.
export function approvedSketchHash(sketchTomlText) {
	return `sha256:${createHash("sha256").update(String(sketchTomlText ?? ""), "utf8").digest("hex")}`;
}

// Campaign-version id: kind-prefixed short content hash of the approved
// sketch. E2e case files record it (`// goal snapshot: <id>`) as the
// campaign version they were authored under.
export function goalSnapshotId(sketchTomlText) {
	const h = createHash("sha256").update(String(sketchTomlText ?? ""), "utf8").digest("hex");
	return `${SNAPSHOT_KIND}-${h.slice(0, 12)}`;
}

// Drift check (the "snapshot stale" precedent, loud never silent):
// goal.toml's recorded approved_sketch_hash must re-derive from the
// committed sketch.toml. A goal.toml WITHOUT the hash is grandfathered
// (pre-195 campaigns carry none); a recorded hash against a missing or
// edited sketch.toml is drift. Returns { ok, drift, grandfathered, error }.
export function verifyApprovedSketch({ goalTomlText, sketchTomlText }) {
	const m = String(goalTomlText ?? "").match(/^approved_sketch_hash *= *("(?:[^"\\]|\\.)*")/m);
	if (!m) return { ok: true, drift: false, grandfathered: true, error: null };
	let recorded = "";
	try {
		recorded = JSON.parse(m[1]);
	} catch {
		return { ok: false, drift: true, grandfathered: false, error: "goal sketch stale: approved_sketch_hash in goal.toml does not parse — re-approve via `bais goal sketch` + `bais goal commit --approve` (hub#195)" };
	}
	const actual = approvedSketchHash(sketchTomlText);
	// hub#195 red-check target (see header): this mismatch refusal is the
	// binding. Neutering it lets a tampered sketch.toml pass silently.
	if (recorded !== actual) {
		return {
			ok: false,
			drift: true,
			grandfathered: false,
			error: `goal sketch stale — approved_sketch_hash ${recorded || "(unparseable)"} in goal.toml no longer matches .bais/sketch.toml (${actual}): the sketch was edited after approval; re-approve via \`bais goal sketch\` + \`bais goal commit --approve\` (hub#195)`,
		};
	}
	return { ok: true, drift: false, grandfathered: false, error: null };
}

// Cross-goal case-reuse join: every e2e case file embedding a
// `// goal snapshot: <id>` header must match the live goal_snapshot. A case
// authored under a retired campaign version keeps its old id until an
// explicit keep decision rebinds it (rebindE2eSnapshot, goal.mjs) — silent
// carry-over flags here. goalSnapshot "" (pre-195 goal.toml) and cases
// without the header (pre-195 scaffolds) are grandfathered: vacuous/skipped.
export const GOAL_SNAPSHOT_HEADER = /^\/\/ goal snapshot: (\S+)/m;
export function e2eSnapshotDrift({ goalSnapshot, cases }) {
	if (!goalSnapshot) return [];
	const rows = [];
	for (const c of cases ?? []) {
		const m = GOAL_SNAPSHOT_HEADER.exec(String(c?.text ?? ""));
		if (!m) continue;
		if (m[1] !== goalSnapshot) {
			rows.push({
				file: c.file,
				case_snapshot: m[1],
				goal_snapshot: goalSnapshot,
				reason: `case authored under ${m[1]} but the live campaign is ${goalSnapshot} — cross-goal reuse needs an explicit keep decision (rebind) or a reasoned retire (hub#195)`,
			});
		}
	}
	return rows;
}

// --- retire -----------------------------------------------------------------
// Append the dated retire line before the body's closing """. The snippet
// form covers a bare `body = """..."""` value; the file form inserts before
// the body's closing quotes mid-file ([[edge]] blocks after the body are
// preserved). The line lands inside the quotes so the strict TOML parser
// still accepts the file (verified by re-parse in the CLI).
export function retireBody(text, reason, date = new Date().toISOString().slice(0, 10)) {
	const line = `Retired ${date}: ${reason}`;
	if (text.endsWith('"""')) {
		return text.slice(0, -3).replace(/\s+$/, "\n") + line + '\n"""';
	}
	return `${text.replace(/\s+$/, "")}\n${line}\n`;
}

// File form: insert the Retired line before the closing quotes of the body
// block. Returns the edited text, or null when no closable body block exists
// (caller refuses rather than writing an unparseable file).
export function retireBodyInFile(text, reason, date = new Date().toISOString().slice(0, 10)) {
	const lines = String(text ?? "").split("\n");
	const start = lines.findIndex((l) => /^\s*body\s*=\s*"""\s*$/.test(l));
	if (start === -1) return null;
	const close = lines.findIndex((l, i) => i > start && /^\s*"""\s*$/.test(l));
	if (close === -1) return null;
	const out = [...lines];
	out.splice(close, 0, `Retired ${date}: ${reason}`);
	return out.join("\n");
}

// --- --selftest --------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("lifecycle.mjs") && process.argv.includes("--selftest")) {
	let failures = 0;
	const check = (cond, msg) => {
		if (!cond) { failures++; console.error(`FAIL selftest: ${msg}`); }
		else console.log(`ok selftest: ${msg}`);
	};

	// (1) clear without snapshot is refused.
	const live = { statement: " Ship it ", issueIds: ["bi#1", "bi#2"] };
	let r = verifySnapshotForClear(null, live);
	check(!r.ok && /snapshot-first/.test(r.error), `clear without snapshot is refused, got ${JSON.stringify(r)}`);
	r = verifySnapshotForClear({ kind: "nope" }, live);
	check(!r.ok && /not a goal snapshot/.test(r.error), `clear with wrong-kind file is refused, got ${JSON.stringify(r)}`);
	// Stale statement.
	const snap = snapshotForClear({ statement: live.statement, issueIds: live.issueIds, at: "2026-09-06T19:00:00Z" });
	check(snap.kind === SNAPSHOT_KIND && JSON.stringify(snap.issues) === JSON.stringify(["bi#1", "bi#2"]), `snapshot pins statement + sorted ids, got ${JSON.stringify(snap)}`);
	r = verifySnapshotForClear(snap, { statement: "Changed", issueIds: live.issueIds });
	check(!r.ok && /statement changed/.test(r.error), `clear with edited goal is refused as stale, got ${JSON.stringify(r)}`);
	// Stale issue set (added + removed).
	r = verifySnapshotForClear(snap, { statement: live.statement, issueIds: ["bi#1", "bi#2", "bi#3"] });
	check(!r.ok && /issue set changed/.test(r.error), `clear with added issue is refused as stale, got ${JSON.stringify(r)}`);
	r = verifySnapshotForClear(snap, { statement: live.statement, issueIds: ["bi#1"] });
	check(!r.ok && /issue set changed/.test(r.error), `clear with removed issue is refused as stale, got ${JSON.stringify(r)}`);
	// Fresh snapshot verifies.
	r = verifySnapshotForClear(snap, live);
	check(r.ok, `clear with fresh snapshot verifies, got ${JSON.stringify(r)}`);

	// (2) retire body edit keeps the closing quotes and names the reason.
	const body = 'body = """\nSome work.\n"""';
	const retired = retireBody(body, "superseded by bi#9", "2026-09-06");
	check(retired === 'body = """\nSome work.\nRetired 2026-09-06: superseded by bi#9\n"""', `retire appends dated reason inside quotes, got ${JSON.stringify(retired)}`);
	// File form: edges after the body survive; missing body refuses (null).
	const withEdges = 'id = "bi#1"\nbody = """\nWork.\n"""\n\n[[edge]]\nfrom = "bi#1"\nto = "bi#2"\nkind = "DependsOn"\n';
	const retiredFile = retireBodyInFile(withEdges, "superseded by bi#9", "2026-09-06");
	check(retiredFile === 'id = "bi#1"\nbody = """\nWork.\nRetired 2026-09-06: superseded by bi#9\n"""\n\n[[edge]]\nfrom = "bi#1"\nto = "bi#2"\nkind = "DependsOn"\n', `retire file form preserves edges, got ${JSON.stringify(retiredFile)}`);
	check(retireBodyInFile('id = "bi#1"\ntitle = "no body"\n', "r") === null, "retire file form returns null with no body block");

	// (3) archive budget: exact bytes, over-cap warns with exact bytes.
	check(parseCapBytes("10") === 10 && parseCapBytes("1k") === 1024 && parseCapBytes("2M") === 2097152 && parseCapBytes("bogus") === null, "cap parser handles plain/k/M and rejects garbage");
	const under = sizeReport({ bytes: 30, files: 2 }, 1024);
	check(under.text === "archive\t30B\t2 files" && under.warn === null && !under.over, `under-cap reports exact bytes quietly, got ${JSON.stringify(under)}`);
	const over = sizeReport({ bytes: 30, files: 2 }, 29);
	check(over.text === "archive\t30B\t2 files" && over.warn === "warn\tarchive over cap: 30 > 29 bytes" && over.over, `over-cap warns with exact bytes, got ${JSON.stringify(over)}`);
	const nocap = sizeReport({ bytes: 30, files: 2 }, null);
	check(nocap.warn === null && !nocap.over, "no cap configured means no warn");

	// (4) hub#195: approved-sketch hash binding + campaign snapshot ids.
	const sk195 = '[[node]]\nid = "hero"\ntitle = "t"\nradius = ["."]\n';
	const snapId195 = goalSnapshotId(sk195);
	check(
		snapId195.startsWith(`${SNAPSHOT_KIND}-`) && snapId195.length === SNAPSHOT_KIND.length + 1 + 12,
		`snapshot id is the kind-prefixed 12-hex content id (got ${snapId195})`,
	);
	check(
		goalSnapshotId(sk195) === snapId195 && goalSnapshotId(`${sk195}\n`) !== snapId195,
		"snapshot id is content-derived (deterministic, drift-sensitive)",
	);
	const goal195 = `[goal]\nstatement = "x"\ngoal_snapshot = "${snapId195}"\napproved_sketch_hash = "${approvedSketchHash(sk195)}"\n`;
	let v195 = verifyApprovedSketch({ goalTomlText: goal195, sketchTomlText: sk195 });
	check(v195.ok && !v195.drift && !v195.grandfathered, `committed goal.toml + sketch.toml verify against the approved-sketch hash, got ${JSON.stringify(v195)}`);
	v195 = verifyApprovedSketch({ goalTomlText: goal195, sketchTomlText: `${sk195}\n[[node]]\nid = "sneaky"\ntitle = "post-approval edit"\nradius = []\n` });
	check(
		!v195.ok && v195.drift && /sketch stale/.test(v195.error),
		`tampered sketch.toml is refused loud against the approved-sketch hash, got ${JSON.stringify(v195)}`,
	);
	v195 = verifyApprovedSketch({ goalTomlText: goal195, sketchTomlText: "" });
	check(!v195.ok && v195.drift, "a missing sketch.toml against a recorded hash is drift, never silent");
	v195 = verifyApprovedSketch({ goalTomlText: '[goal]\nstatement = "legacy"\n', sketchTomlText: "anything" });
	check(v195.ok && v195.grandfathered, "pre-195 goal.toml without the hash is grandfathered");
	// Cross-goal case reuse: a case still carrying the retired campaign's
	// snapshot id flags; a rebound case (explicit keep decision) is clean.
	const drift195 = e2eSnapshotDrift({
		goalSnapshot: "goal-snapshot-aaaaaaaabbbb",
		cases: [
			{ file: "kept.mjs", text: `// goal snapshot: ${snapId195} rest` },
			{ file: "rebound.mjs", text: "// goal snapshot: goal-snapshot-aaaaaaaabbbb rest" },
			{ file: "legacy.mjs", text: "// no snapshot header" },
		],
	});
	check(
		drift195.length === 1 && drift195[0].file === "kept.mjs" && drift195[0].case_snapshot === snapId195,
		`case under a retired snapshot id flags; rebound + headerless cases pass (got ${JSON.stringify(drift195)})`,
	);
	check(
		e2eSnapshotDrift({ goalSnapshot: "", cases: [{ file: "x.mjs", text: `// goal snapshot: ${snapId195}` }] }).length === 0,
		"goal.toml without goal_snapshot is grandfathered (vacuous join)",
	);

	console.log(failures === 0 ? "lifecycle selftest: all green" : `${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}
