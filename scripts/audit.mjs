// bais/scripts/audit.mjs — bi#142 audit gate for load-bearing closes.
//
// Passing checks are not completeness. A red-check proves the net works;
// the audit proves the work is complete. First close attempt on a
// load-bearing node triggers AUDIT_REQUIRED: re-read the issue + handoff,
// trace every requirement and acceptance clause to evidence, examine
// boundaries and failure cases, fix and re-audit every finding.
//
// Load-bearing (read-only derivation): a node is load-bearing iff its
// blast radius has open_downstream >= LOAD_BEARING_THRESHOLD. The radii
// come from bais dist's blastRadii (SPEC §3.4, same precedes relation as
// the cycle detector) — consumed, never recomputed here, and never
// overridden: SPEC §3.4 fixes "no declared override field", so there is
// no marker to read, only edges to derive from. Status-blind like the
// source: a Done anchor with a live Open fan-out still reports it.
//
// State machine: required → in-audit → passed with ref.
//   openAudit(taskId, prior)  first close attempt creates the record
//                             (n = per-task count + 1; the count travels
//                             with the task id, never global)
//   beginAudit(rec)           required → in-audit
//   addFinding / resolveFinding  in-audit only; open findings block pass
//   addChallenge(rec, sender, text)  challenges keyed per sender — one
//                             sender's challenges never touch another's
//   setTrail(rec, links)      [{requirement, evidence}, ...]
//   passAudit(rec)            needs in-audit + zero open findings +
//                             a trail covering every Requirement: /
//                             Acceptance: clause; yields the ref the
//                             close must cite: audit(<task>#<n>)
//   reAudit(passedRec, reason) passed → a NEW in-audit record (n+1)
//                             carrying the post-pass finding
//
// Close-evidence (bi#83) interop: the audit ref rides on the issue as
//   Evidence: audit(<task>#<n>)
// alongside drill()/verdict() refs. Load-bearing Done without a
// resolvable audit ref fails loud (AUDIT_REQUIRED when bare,
// audit-ref-unresolvable when dangling); non-load-bearing and non-Done
// entries are unaffected.
//
// CHECK-GATE WIRING — SPEC, NOT IMPLEMENTATION (explicitly out of scope
// for bi#142; do not wire without a follow-up issue):
//   1. Teach bais/src/graph.ts parseCloseEvidence/closeEvidenceIn the
//      `audit` kind, resolving audit() refs against a passed-audit index
//      (same Missing/External shape as drill/verdict), OR
//   2. have `bais check` run auditCloseProblems() from this script over
//      the loaded set and merge its problems into the check report.
// Either way `bais move` semantics stay untouched (check failure, not a
// transition guard — same advisory-first posture as bi#83).
//
// Grounding: strong-solver skill (trust-execution-over-narration — "I
// verified it by reading" is prose, not a badge). Every claim below is
// executed by this script's own fixtures; the red-check is observed,
// not asserted.
//
// Red-check (bi#57, observed 2026-09-06): flip `>=` to `>` in
// isLoadBearing → `audit.threshold-boundary` + `audit.gate-threshold-bare`
// go red (2 FAIL, 26 pass, exit 1): the boundary anchor still reports
// open_downstream:1 but the gate returns `[]`, so the threshold bare
// close slips through silently — the right reason. Restored `>=`
// returns all 28 green. Re-record this observation on any hunk change.
//
// Usage: node bais/scripts/audit.mjs   (exit 1 on any FAIL)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { blastRadii } = await import(join(HERE, "..", "dist", "src", "graph.js"));
const { parseBaisFile } = await import(join(HERE, "..", "dist", "src", "toml.js"));

// Any live downstream work held => the close needs an audit. 1 is the
// graduate-of-bi#57 choice: a close that frees (or risks) someone else's
// work is never routine.
export const LOAD_BEARING_THRESHOLD = 1;

// Load-bearing hunk (bi#57 red-check target): the >= boundary. `>` must
// trip audit.threshold-boundary + audit.gate-threshold-bare.
export function isLoadBearing(radius, threshold = LOAD_BEARING_THRESHOLD) {
	return (radius?.open_downstream ?? 0) >= threshold;
}

export function auditRef(task, n) {
	return `audit(${task}#${n})`;
}

// One `Evidence: audit(task#n)` ref per matching body line (same shape as
// bi#83's drill/verdict lines: case-sensitive kind, trailing `#` comment
// stripped). Task ids contain `#` themselves (t#a1), so the split is on
// the LAST `#`: `audit(t#a1#1)` → {task: "t#a1", n: 1}.
export function parseAuditRefs(body) {
	const out = [];
	for (const line of (body ?? "").split("\n")) {
		const m = /^\s*Evidence\s*:\s*audit\s*\(\s*([^)]*?)\s*\)\s*(?:#.*)?$/.exec(line);
		if (!m) continue;
		const inner = m[1].trim();
		const hash = inner.lastIndexOf("#");
		if (hash === -1) continue;
		const task = inner.slice(0, hash).trim();
		const n = Number(inner.slice(hash + 1).trim());
		if (task !== "" && Number.isInteger(n) && n > 0) out.push({ task, n, raw: `audit(${inner})` });
	}
	return out;
}

// The clauses an audit must discharge: `Requirement:` / `Acceptance:`
// body lines on the issue under audit.
export function parseRequirements(body) {
	const out = [];
	for (const line of (body ?? "").split("\n")) {
		const m = /^\s*(Requirement|Acceptance)\s*:\s*(.+?)\s*$/.exec(line);
		if (m) out.push({ kind: m[1], text: m[2].trim() });
	}
	return out;
}

// Trail links not naming a live clause, and live clauses with no link.
export function trailUncovered(requirements, links) {
	const wanted = new Set(requirements.map((r) => r.text));
	const linked = new Set((links ?? []).map((l) => l.requirement));
	return {
		unlinked: requirements.filter((r) => !linked.has(r.text)).map((r) => r.text),
		stray: (links ?? []).filter((l) => !wanted.has(l.requirement)).map((l) => l.requirement),
	};
}

const fail = (msg) => { throw new Error(msg); };

// First close attempt on a load-bearing node opens the record. The count
// travels with the task id: n = 1 + prior audits for THIS task.
export function openAudit(taskId, prior = []) {
	const n = prior.filter((a) => a.task === taskId).length + 1;
	return { task: taskId, n, state: "required", findings: [], challenges: {}, trail: [] };
}

export function beginAudit(rec) {
	if (rec.state !== "required") fail(`audit-not-required (state=${rec.state})`);
	rec.state = "in-audit";
	return rec;
}

export function addFinding(rec, text) {
	if (rec.state !== "in-audit") fail(`audit-not-in-audit (state=${rec.state})`);
	rec.findings.push({ text, resolved: false });
	return rec;
}

export function resolveFinding(rec, idx) {
	if (rec.state !== "in-audit") fail(`audit-not-in-audit (state=${rec.state})`);
	if (!rec.findings[idx]) fail(`audit-no-such-finding (${idx})`);
	rec.findings[idx].resolved = true;
	return rec;
}

// Challenges are isolated per sender: keyed by sender id, append-only per
// sender, never merged across senders. Advisory to the pass verdict —
export function addChallenge(rec, sender, text) {
	if (sender === undefined || sender === null || String(sender).trim() === "") fail("audit-challenge-needs-sender");
	(rec.challenges[sender] ??= []).push(text);
	return rec;
}

export function setTrail(rec, links) {
	rec.trail = links ?? [];
	return rec;
}

// Pass needs in-audit + every finding resolved + a trail covering every
// live Requirement:/Acceptance: clause of the issue under audit.
export function passAudit(rec, requirements = []) {
	if (rec.state !== "in-audit") fail(`audit-not-in-audit (state=${rec.state})`);
	const open = rec.findings.filter((f) => !f.resolved);
	if (open.length > 0) fail(`audit-findings-open (${open.length}: ${open.map((f) => f.text).join("; ")})`);
	const { unlinked, stray } = trailUncovered(requirements, rec.trail);
	if (unlinked.length > 0) fail(`audit-trail-incomplete (unlinked: ${unlinked.join("; ")})`);
	if (stray.length > 0) fail(`audit-trail-stray (stray: ${stray.join("; ")})`);
	if (rec.trail.length === 0) fail("audit-trail-empty");
	rec.state = "passed";
	rec.ref = auditRef(rec.task, rec.n);
	return rec.ref;
}

// A post-pass finding re-opens the work as a NEW audit (n+1) carrying the
// finding — the count keeps travelling with the task id, never reused.
export function reAudit(passedRec, reason) {
	if (passedRec.state !== "passed") fail(`audit-not-passed (state=${passedRec.state})`);
	const rec = { task: passedRec.task, n: passedRec.n + 1, state: "in-audit", findings: [], challenges: {}, trail: [] };
	if (reason) rec.findings.push({ text: reason, resolved: false });
	return rec;
}

// The gate: Done + load-bearing needs >= 1 cited audit ref resolving to a
// passed audit. Bare closes fail AUDIT_REQUIRED; dangling refs fail
// audit-ref-unresolvable. Everything else is unaffected (ok: true).
// passedByRef maps "audit(task#n)" → audit record with state "passed".
export function auditCloseProblems(entries, radiiById, passedByRef = new Map()) {
	const out = [];
	for (const e of entries) {
		if (e.status !== "Done") continue;
		if (!isLoadBearing(radiiById.get(e.id))) continue;
		const refs = parseAuditRefs(e.body);
		if (refs.length === 0) {
			out.push({ id: e.id, reason: "AUDIT_REQUIRED", ref: null, kind: null, status: "Missing" });
			continue;
		}
		for (const r of refs) {
			const rec = passedByRef.get(`audit(${r.task}#${r.n})`);
			if (!rec || rec.state !== "passed") {
				out.push({ id: e.id, reason: "audit-ref-unresolvable", ref: r.raw, kind: "audit", status: "Missing" });
			}
		}
	}
	return out;
}

// ---- Fixture runner (executed acceptance for bi#142) ----
let pass = 0, failCount = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { failCount++; console.log(`FAIL ${name} ${extra}`); }
};
const throws = (fn, needle) => {
	try { fn(); } catch (e) { return String(e?.message ?? e).includes(needle); }
	return false;
};

const FIX = join(HERE, "fixtures", "audit");
const loadToml = async (path) => parseBaisFile(readFileSync(path, "utf8"));

// Graph fixtures → radii through the real derivation (read-only: this
// script never recomputes blast radius, it consumes blastRadii).
const graphFiles = readdirSync(join(FIX, "graph")).filter((f) => f.endsWith(".toml")).sort();
const graph = [];
for (const f of graphFiles) graph.push(await loadToml(join(FIX, "graph", f)));
const radiiById = new Map(blastRadii(graph).map((r) => [r.id, r]));

// Derivation shape: anchor 2, boundary anchor exactly 1, leaves 0.
check("audit.radii-anchor", radiiById.get("t#a1")?.open_downstream === 2, JSON.stringify(radiiById.get("t#a1")));
check("audit.radii-boundary", radiiById.get("t#a5")?.open_downstream === 1, JSON.stringify(radiiById.get("t#a5")));
check("audit.radii-leaves",
	["t#a2", "t#a3", "t#a4", "t#a6"].every((id) => radiiById.get(id)?.open_downstream === 0),
	JSON.stringify([...radiiById]));

// Threshold boundary: open == 1 is load-bearing under >=, and only there.
check("audit.threshold-boundary",
	isLoadBearing(radiiById.get("t#a5")) === true && isLoadBearing(radiiById.get("t#a4")) === false,
	`a5=${JSON.stringify(radiiById.get("t#a5"))} a4=${JSON.stringify(radiiById.get("t#a4"))}`);
check("audit.threshold-anchor", isLoadBearing(radiiById.get("t#a1")) === true);

// State machine: required → in-audit → passed with ref.
{
	const a = openAudit("t#a1");
	check("audit.open-required", a.state === "required" && a.n === 1, JSON.stringify(a));
	check("audit.begin-negative", throws(() => passAudit(structuredClone(a)), "audit-not-in-audit"));
	beginAudit(a);
	check("audit.begin", a.state === "in-audit");
	check("audit.begin-twice", throws(() => beginAudit(a), "audit-not-required"));
	addFinding(a, "trail skips Acceptance clause");
	check("audit.finding-blocks-pass",
		throws(() => passAudit(structuredClone({ ...a, state: "in-audit" })), "audit-findings-open") ||
		throws(() => passAudit(a), "audit-findings-open"));
	resolveFinding(a, 0);
	check("audit.resolve", a.findings[0].resolved === true);
	check("audit.resolve-unknown", throws(() => resolveFinding(a, 7), "audit-no-such-finding"));
	// Trail must name every Requirement:/Acceptance: link; stray links fail too.
	const anchor = graph.find((f) => f.issue.id === "t#a1");
	const reqs = parseRequirements(anchor.issue.body);
	check("audit.reqs-parsed", reqs.length === 4, JSON.stringify(reqs));
	const trail = JSON.parse(readFileSync(join(FIX, "trails", "t#a1-1.json"), "utf8"));
	check("audit.trail-covers",
		trailUncovered(reqs, trail.links).unlinked.length === 0 &&
		trailUncovered(reqs, trail.links).stray.length === 0,
		JSON.stringify(trailUncovered(reqs, trail.links)));
	setTrail(a, trail.links);
	const ref = passAudit(a, reqs);
	check("audit.pass-ref", ref === "audit(t#a1#1)" && a.state === "passed", ref);
	check("audit.pass-empty-trail", (() => {
		const b = beginAudit(openAudit("t#zz"));
		return throws(() => passAudit(b, []), "audit-trail-empty");
	})());
	// Count travels with the task id: second audit for t#a1 is #2, while a
	// fresh task still starts at #1.
	const a2 = openAudit("t#a1", [a]);
	const b1 = openAudit("t#a2", [a]);
	check("audit.count-travels", a2.n === 2 && b1.n === 1, `a2.n=${a2.n} b1.n=${b1.n}`);
	// Challenges isolated per sender.
	addChallenge(a2, "alice", "did you re-read the handoff?");
	addChallenge(a2, "bob", "boundary a5 needs eyes");
	addChallenge(a2, "alice", "second point, same sender");
	check("audit.challenges-isolated",
		a2.challenges["alice"].length === 2 && a2.challenges["bob"].length === 1 &&
		!a2.challenges["bob"].some((c) => c.includes("handoff")),
		JSON.stringify(a2.challenges));
	check("audit.challenge-needs-sender", throws(() => addChallenge(openAudit("t#q"), "  ", "x"), "audit-challenge-needs-sender"));
	// Post-pass finding → NEW in-audit record, count keeps travelling.
	const r = reAudit(a, "late finding: failure case unexamined");
	check("audit.reaudit", r.state === "in-audit" && r.n === 2 && r.findings.length === 1 && !r.findings[0].resolved,
		JSON.stringify(r));
	check("audit.reaudit-negative", throws(() => reAudit(openAudit("t#q"), "x"), "audit-not-passed"));
}

// Gate over the committed close fixtures.
{
	const close = async (name) => {
		const f = await loadToml(join(FIX, "closes", name));
		return { id: f.issue.id, status: f.issue.status, body: f.issue.body };
	};
	const bare = await close("a1-bare.toml");
	const badref = await close("a1-badref.toml");
	const clean = await close("a1-clean.toml");
	const a5bare = await close("a5-bare.toml");
	const a4bare = await close("a4-bare.toml");
	// Passed-audit index: only t#a1#1 passed (mirrors trails/t#a1-1.json).
	const passedByRef = new Map([["audit(t#a1#1)", { task: "t#a1", n: 1, state: "passed" }]]);

	// First close attempt on a load-bearing node, no ref → AUDIT_REQUIRED, loud.
	const pBare = auditCloseProblems([bare], radiiById, passedByRef);
	check("audit.gate-load-bearing-bare",
		pBare.length === 1 && pBare[0].reason === "AUDIT_REQUIRED" && pBare[0].id === "t#a1",
		JSON.stringify(pBare));
	// Dangling ref → the right reason, not the bare reason.
	const pBad = auditCloseProblems([badref], radiiById, passedByRef);
	check("audit.gate-bad-ref",
		pBad.length === 1 && pBad[0].reason === "audit-ref-unresolvable" && pBad[0].ref === "audit(t#a1#9)",
		JSON.stringify(pBad));
	// Resolvable ref → quiet.
	check("audit.gate-clean",
		auditCloseProblems([clean], radiiById, passedByRef).length === 0);
	// Threshold boundary bare close → still AUDIT_REQUIRED (red-check tripwire).
	const pA5 = auditCloseProblems([a5bare], radiiById, passedByRef);
	check("audit.gate-threshold-bare",
		pA5.length === 1 && pA5[0].reason === "AUDIT_REQUIRED" && pA5[0].id === "t#a5",
		JSON.stringify(pA5));
	// Non-load-bearing closes unaffected — even prose-only.
	check("audit.gate-leaf-unaffected",
		auditCloseProblems([a4bare], radiiById, passedByRef).length === 0);
	// Non-Done entries unaffected — an Open anchor with no refs is quiet.
	check("audit.gate-open-unaffected",
		auditCloseProblems([{ id: "t#a1", status: "Open", body: "no refs" }], radiiById, passedByRef).length === 0);
	// Ref parsing: task ids contain `#`; split is on the last one, and
	// trailing comments are stripped like bi#83 lines.
	const refs = parseAuditRefs("Evidence: audit(t#a1#1)  # audited\nprose\nEvidence: audit(t#a5#12)");
	check("audit.ref-parse",
		refs.length === 2 && refs[0].task === "t#a1" && refs[0].n === 1 && refs[1].task === "t#a5" && refs[1].n === 12,
		JSON.stringify(refs));
}

if (failCount) { console.log(`audit: ${failCount} FAIL, ${pass} pass`); process.exit(1); }
console.log(`audit: all ${pass} green`);
