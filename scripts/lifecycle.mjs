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
// RED-CHECK (bi#57, bi#136): the load-bearing hunk is the snapshot-first
// refusal in verifySnapshotForClear (!snap -> {ok:false, ...}). Reverting
// it to always-ok must trip the selftest with exactly:
//   "FAIL selftest: clear without snapshot is refused"
// (verified 2026-09-06: refusal neutered -> that FAIL observed -> restored).

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

	console.log(failures === 0 ? "lifecycle selftest: all green" : `${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}
