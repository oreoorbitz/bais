// bais/scripts/drill-intake.mjs — bi#148 findings-to-arms pipeline.
//
// Static evaluators decay: hacking skills generalize, so agents eventually
// find the property the drill doesn't check. This script closes the loop
// between an audit/review finding and a new red-check arm: the audit trail
// becomes the next drill.
//
// (1) FINDINGS INBOX. One file per finding under
//     bais/scripts/fixtures/drill-intake/<id>.finding.toml:
//
//       id = "phantom-tool-parity"        # unique finding id
//       title = "..."                     # one-line summary
//       source = "..."                    # audit/review ref + date, e.g.
//                                         # "review 2026-09-06: mcp-test pins ..."
//       property = "..."                  # the unchecked property (the arm's claim)
//       suite = "mcp-test"                # home suite stem: bais/scripts/<suite>.mjs
//       arm = "parity-no-phantoms"        # check label inside the suite
//       status = "candidate"              # candidate | open | graduated
//       fixture = "..."                   # fixture shape the arm runs on
//       exact_failure = "..."             # the exact failure the arm must print
//       redcheck = "..."                  # recorded red observation (graduated only)
//
//     status meanings:
//       candidate — arm sketch on file, not yet a confirmed evasion. Listed
//                   as todo, does NOT fail the gate.
//       open      — RECORDED evasion with no covering arm. Fails LOUD
//                   (exit 1) naming the gap. This is the bi#148 acceptance.
//       graduated — arm landed with its red-check proof. Verified here:
//                   arm marker + Red-check record present in the home suite,
//                   redcheck field non-empty, and the suite stem resolvable
//                   by Evidence: drill() via the hub#164 registry.
//
// (2) ARM-GRADUATION PROCEDURE (candidate → registered drill stem):
//     1. File the finding (status candidate): property, fixture shape,
//        exact-failure expectation.
//     2. Confirm the evasion (status open) or graduate directly: write the
//        arm in its home suite — NEW code only, never touch existing
//        passing arms.
//     3. Red-check proof (bi#57): break the seam the arm guards, observe
//        the EXACT failure, restore, re-run green. When src is frozen by
//        the brief, a scratch stub server presenting exactly the drifted
//        bytes is the sanctioned stand-in (record why). Quote the observed
//        output in the suite (Red-check record) and in the finding.
//     4. Mark graduated: check verifies the stem resolves via knownDrillNames
//        (hub#164), so `Evidence: drill(<suite>)` cites the new coverage.
//
// CHECK-GATE WIRING — SPEC, NOT IMPLEMENTATION (same posture as audit.mjs
// bi#142; do not wire without a follow-up issue): teaching `bais check` to
// run this inbox means graph.ts merging open-finding gaps into the check
// report. Until then `node bais/scripts/drill-intake.mjs` is the gate.
//
// Grounding: ground-first skill (enumerate before you theorize — "List
// before you claim", docs are hypotheses). The three tonight-candidates
// below were enumerated, not assumed: audit.mjs arms read (28 checks),
// bagl rank-contract read (mixed-vendor refusal ALREADY red-checked
// 2026-09-06 in bagl/src/corpus.ts — covered, no finding filed), MCP
// list/call surface read (tools/list advertises 6, only 2 ever invoked
// via tools/call in any suite — real gap, graduated as the worked example).
//
// Red-check record, intake self-proof (bi#57, observed live 2026-09-06):
// this script never trusts its own predicates — every main run executes
// intake.selftest-* arms on scratch tmpdir findings first: a scratch OPEN
// finding must fail with the exact GAP line, a scratch GRADUATED finding
// must close, and probeParity must name the stub's phantom. Flip any
// predicate (e.g. `status === "open"` to `=== "OPEN"`) and selftest goes
// red while the live gate stays silent-green — the wrong-reason tripwire.
// A passing gate that cannot go red is camouflage, not coverage.
//
// Usage: node bais/scripts/drill-intake.mjs   (exit 1 on any FAIL/GAP)
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url)); // bais/scripts
const FIX = join(HERE, "fixtures", "drill-intake");
const ROOT = join(HERE, "..", ".."); // repo root (root hub)
const LIVE_ISSUES = join(ROOT, ".bais", "issues");

const gmod = await import(pathToFileURL(join(HERE, "..", "dist", "src", "graph.js")).href);
const { knownDrillNames, scriptsDirFor } = gmod;

// ---- probeParity: the shared list/call parity probe ----
// listed: [{name} | "name", ...] from tools/list.
// callOne: (name) -> {ok:true} | {ok:false, code, message} (sync or async).
// Returns the phantoms: listed tools the server cannot dispatch.
// Pure: no I/O, so the live arm and the stub red-demo run the same code.
export async function probeParity(listed, callOne) {
	const phantoms = [];
	for (const t of listed ?? []) {
		const name = typeof t === "string" ? t : t.name;
		const r = await callOne(name);
		if (!r || r.ok !== true) {
			phantoms.push({ name, code: r?.code ?? null, message: r?.message ?? "no-result" });
		}
	}
	return phantoms;
}

// ---- minimal finding-file parser (flat k = "v" | """multiline""") ----
function unquote(s, file, line) {
	if (!s.startsWith('"')) throw new Error(`intake-parse ${file}:${line}: value must be quoted`);
	let out = "";
	for (let i = 1; i < s.length; i++) {
		const c = s[i];
		if (c === '"') return out;
		if (c === "\\" && i + 1 < s.length) {
			const n = s[++i];
			out += n === "n" ? "\n" : n === "t" ? "\t" : n;
		} else out += c;
	}
	throw new Error(`intake-parse ${file}:${line}: unterminated string`);
}

export function parseFinding(text, file = "<finding>") {
	const f = {};
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (/^\s*(#|$)/.test(raw)) continue;
		const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(raw);
		if (!m) throw new Error(`intake-parse ${file}:${i + 1}: bad line ${JSON.stringify(raw)}`);
		const [, key, rest] = m;
		if (rest.trimStart().startsWith('"""')) {
			// collect until closing """
			const parts = [];
			const first = rest.trimStart().slice(3);
			if (first.includes('"""')) {
				parts.push(first.slice(0, first.indexOf('"""')));
			} else {
				parts.push(first);
				for (;;) {
					i++;
					if (i >= lines.length) throw new Error(`intake-parse ${file}: unterminated """ for ${key}`);
					const l = lines[i];
					const ci = l.indexOf('"""');
					if (ci === -1) parts.push(l);
					else { parts.push(l.slice(0, ci)); break; }
				}
			}
			f[key] = parts.join("\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		} else {
			f[key] = unquote(rest.trim(), file, i + 1);
		}
	}
	for (const k of ["id", "title", "source", "property", "suite", "arm", "status", "fixture", "exact_failure"]) {
		if (typeof f[k] !== "string" || f[k] === "") throw new Error(`intake-parse ${file}: missing ${k}`);
	}
	if (!["candidate", "open", "graduated"].includes(f.status)) throw new Error(`intake-parse ${file}: bad status ${JSON.stringify(f.status)}`);
	return f;
}

// ---- finding evaluation (pure; ctx injects the world for selftest) ----
// ctx: { readSuite(suite) -> string|null, drillNames: string[] }
export function evaluateFinding(f, ctx) {
	if (f.status === "candidate") {
		return { ok: true, line: `todo [${f.id}]: ${f.title} → arm sketch (${f.suite}#${f.arm})` };
	}
	if (f.status === "open") {
		return {
			ok: false,
			line: `GAP [${f.id}]: recorded evasion with no covering arm — ${f.property} (source: ${f.source}; expected failure once armed: ${f.exact_failure})`,
		};
	}
	// graduated: every graduation step must still hold.
	const src = ctx.readSuite(f.suite);
	if (src === null) return { ok: false, line: `FAIL [${f.id}]: home suite ${f.suite}.mjs missing` };
	if (!src.includes(f.arm)) return { ok: false, line: `FAIL [${f.id}]: arm ${f.arm} not found in ${f.suite}.mjs` };
	if (!src.includes("Red-check")) return { ok: false, line: `FAIL [${f.id}]: no Red-check record in ${f.suite}.mjs (bi#57 — unverified green is camouflage)` };
	if (typeof f.redcheck !== "string" || f.redcheck === "") return { ok: false, line: `FAIL [${f.id}]: finding graduates without a recorded red-check observation` };
	if (!ctx.drillNames.includes(f.suite)) {
		return { ok: false, line: `FAIL [${f.id}]: drill(${f.suite}) unresolvable via the hub registry (knownDrillNames)` };
	}
	return { ok: true, line: `ok [${f.id}]: arm ${f.suite}#${f.arm} present, red-checked, drill(${f.suite}) resolves` };
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
	let pass = 0, failCount = 0;
	const check = (name, cond, extra = "") => {
		if (cond) { pass++; console.log(`PASS ${name}`); }
		else { failCount++; console.log(`FAIL ${name} ${extra}`); }
	};

	// ---- selftest: the intake proves its own predicates (bi#57) ----
	{
		// s1: a scratch OPEN finding fails with the exact GAP line.
		const open = {
			id: "s-open", title: "t", source: "s", property: "P", suite: "s-suite",
			arm: "s-arm", status: "open", fixture: "F", exact_failure: "E",
		};
		const r1 = evaluateFinding(open, { readSuite: () => null, drillNames: [] });
		check("intake.selftest-open-loud",
			r1.ok === false && r1.line === "GAP [s-open]: recorded evasion with no covering arm — P (source: s; expected failure once armed: E)",
			JSON.stringify(r1));

		// s2: a scratch GRADUATED finding closes iff arm + record + stem hold.
		const d = mkdtempSync(join(tmpdir(), "drill-intake-self-"));
		const sdir = join(d, "scripts");
		mkdirSync(sdir, { recursive: true });
		writeFileSync(join(sdir, "s-suite.mjs"), "// Red-check record: stub\n// arm s-arm\n");
		const grad = { ...open, status: "graduated", redcheck: "observed stub red" };
		const ctx = {
			readSuite: (s) => { try { return readFileSync(join(sdir, `${s}.mjs`), "utf8"); } catch { return null; } },
			drillNames: knownDrillNames(sdir),
		};
		const r2 = evaluateFinding(grad, ctx);
		check("intake.selftest-graduated-closes", r2.ok === true, JSON.stringify(r2));
		check("intake.selftest-stem-resolves", ctx.drillNames.includes("s-suite"), JSON.stringify(ctx.drillNames));
		// s2b: each missing piece re-opens loudly, naming the piece.
		const noArm = evaluateFinding({ ...grad, arm: "missing-arm" }, ctx);
		check("intake.selftest-missing-arm",
			noArm.ok === false && noArm.line.includes("arm missing-arm not found"), JSON.stringify(noArm));
		const noRec = evaluateFinding(grad, { ...ctx, readSuite: () => "// arm s-arm\nno record here\n" });
		check("intake.selftest-missing-record",
			noRec.ok === false && noRec.line.includes("no Red-check record"), JSON.stringify(noRec));
		const noStem = evaluateFinding({ ...grad, suite: "ghost-suite" }, ctx);
		check("intake.selftest-missing-stem",
			noStem.ok === false && (noStem.line.includes("home suite ghost-suite.mjs missing") || noStem.line.includes("unresolvable")), JSON.stringify(noStem));

		// s3: probeParity names the stub's phantom exactly, quiet when complete.
		const listed = ["bais_list", "bais_graph"];
		const stubCall = async (n) => n === "bais_graph"
			? { ok: false, code: -32602, message: "unknown tool: bais_graph" }
			: { ok: true };
		const ph = await probeParity(listed, stubCall);
		check("intake.selftest-probe-red",
			ph.length === 1 && ph[0].name === "bais_graph" && ph[0].code === -32602 && ph[0].message === "unknown tool: bais_graph",
			JSON.stringify(ph));
		const clean = await probeParity(listed, async () => ({ ok: true }));
		check("intake.selftest-probe-green", clean.length === 0, JSON.stringify(clean));

		// s4: candidates list quiet.
		const r4 = evaluateFinding({ ...open, status: "candidate" }, ctx);
		check("intake.selftest-candidate-quiet", r4.ok === true && r4.line.startsWith("todo [s-open]"), JSON.stringify(r4));
	}

	// ---- live check over the findings inbox ----
	const liveNames = knownDrillNames(scriptsDirFor(LIVE_ISSUES));
	const liveCtx = {
		readSuite: (s) => { try { return readFileSync(join(HERE, `${s}.mjs`), "utf8"); } catch { return null; } },
		drillNames: liveNames,
	};
	let gaps = 0;
	for (const f of readdirSync(FIX).filter((x) => x.endsWith(".finding.toml")).sort()) {
		let parsed;
		try {
			parsed = parseFinding(readFileSync(join(FIX, f), "utf8"), f);
		} catch (e) {
			failCount++;
			console.log(`FAIL intake.parse-${f} ${String(e?.message ?? e)}`);
			continue;
		}
		const r = evaluateFinding(parsed, liveCtx);
		if (r.ok) { pass++; console.log(r.line); }
		else { failCount++; gaps++; console.log(r.line); }
	}

	if (failCount) { console.log(`drill-intake: ${failCount} FAIL, ${pass} pass — recorded evasion without a covering arm is a loud gap`); process.exit(1); }
	console.log(`drill-intake: all ${pass} green (inbox checked, no open evasions)`);
}
