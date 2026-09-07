// bais/scripts/fixtures/forwarding/check.mjs — chain forwarding +
// terminal broadcast checker + fixture runner (bi#143).
//
// Enforces bais/spec/forwarding.md over line-oriented event logs: one
// chain, declared branches with file footprints, direct-forward only
// over disjoint unambiguous hops (each hop carries a handoff diff),
// footprint collision or ambiguity routed via the operator WITH a
// reason, and a terminal broadcast to the merger (= Done) closing the
// chain. The forward rides the handoff/inbox surfaces — this checker
// references handoff ids but never validates handoff files (that is
// handoff-validate.mjs's job).
//
// Usage (run from bais/):
//   node scripts/fixtures/forwarding/check.mjs <file.events>  # exit 0 OK, 1 refused/incomplete
//   node scripts/fixtures/forwarding/check.mjs --all          # all fixtures, exit 0 iff each behaves
// Pure ESM, zero dependencies: `node` only.
//
// Red-check (bi#57, recorded 2026-09-06 by fwd-143): removed the
// collision refusal hunk (`collides(...)` branch in the forward case),
// then ran --all over the untouched fixtures: direct-despite-collision
// proceeded past line 6 and the run went red with `expected REFUSED
// "collision" @ line 6, got OK` (wrong outcome — the silent-collision
// path the gate exists to prevent); with the hunk restored all 6
// fixtures return to their §7 outcomes. A gate that cannot go red on
// a direct-over-collision hop is camouflage, not coverage.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const KV_RE = /^([A-Za-z0-9_-]+):\s?(.*)$/;

function parseArgs(argv) {
	const [a, b] = argv;
	if (a === undefined || a === "" || a === "--all") return { file: null, all: true };
	return { file: a, all: false, _extra: b };
}

/**
 * Check one event-log text. Pure: no fs, no clock.
 * @returns {{ verdict: "OK"|"REFUSED"|"INCOMPLETE", line: number|null, errors: string[] }}
 */
export function checkForwarding(text) {
	const errors = [];
	let refused = null; // { line, message } — first structural violation wins
	const refuse = (line, message) => {
		if (!refused) refused = { line, message };
	};
	const rawLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();

	const kv = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((p) => {
		const i = p.indexOf("=");
		return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)];
	}));
	// reason= may carry spaces: capture everything up to handoff= (or end).
	const reasonOf = (s) => {
		const m = /reason=(.*?)(?:\s+handoff=|$)/.exec(s);
		return m ? m[1].trim() || null : null;
	};
	const collides = (a, b) => a.files.some((f) => b.files.includes(f));

	let chain = null;
	let chainLine = 0;
	const branches = new Map(); // name -> { owner, files, line }
	const forwardedFrom = new Set();
	let lastTo = null; // previous forward's to (or "?" when ambiguous)
	let lastToLine = 0;
	let sawBroadcast = false;
	let closed = false;

	rawLines.forEach((line, idx) => {
		const n = idx + 1;
		const t = line.trim();
		if (t === "" || t.startsWith("#")) return;
		const m = KV_RE.exec(t);
		if (!m) {
			refuse(n, `malformed record ${JSON.stringify(t)} (expected "kind: rest")`);
			return;
		}
		const [, kind, rest] = m;
		switch (kind) {
			case "chain": {
				if (chain) refuse(n, `second chain claim ${JSON.stringify(rest)} (one chain per log)`);
				else if (chainLine !== 0) refuse(n, "chain record must be first (branch declared before chain)");
				else if (!rest) refuse(n, "empty chain id");
				else { chain = rest; chainLine = n; }
				break;
			}
			case "branch": {
				if (!chain) refuse(n, "branch before chain");
				else {
					const first = rest.split(/\s+/)[0] ?? "";
					const { owner, files } = kv(rest);
					if (!first) refuse(n, "empty branch name");
					else if (branches.has(first)) refuse(n, `second declaration of branch ${JSON.stringify(first)} (unique names)`);
					else if (!owner) refuse(n, `branch ${JSON.stringify(first)} missing owner=`);
					else if (files === undefined || files === null) refuse(n, `branch ${JSON.stringify(first)} missing files= footprint (empty value means footprint-free)`);
					else branches.set(first, { owner, files: files.split(",").map((f) => f.trim()).filter(Boolean), line: n });
				}
				break;
			}
			case "forward": {
				if (closed) refuse(n, "forward after terminal broadcast (chain is closed)");
				else if (!chain) refuse(n, "forward before chain");
				else {
					const from = rest.split(/\s+/)[0] ?? "";
					const { to, via, handoff } = kv(rest);
					const reason = reasonOf(rest);
					if (!from) refuse(n, "empty forward source");
					else if (!branches.has(from)) refuse(n, `forward from undeclared branch ${JSON.stringify(from)}`);
					else if (!to) refuse(n, `forward from ${JSON.stringify(from)} missing to=`);
					else if (to !== "?" && !branches.has(to)) refuse(n, `forward to undeclared branch ${JSON.stringify(to)} (spell ambiguity as to=?)`);
					else if (via !== "direct" && via !== "operator") refuse(n, `forward from ${JSON.stringify(from)} missing via=direct|operator`);
					else if (!handoff) refuse(n, `forward from ${JSON.stringify(from)} missing handoff= (every hop carries a handoff diff)`);
					else if (forwardedFrom.has(from)) refuse(n, `branch ${JSON.stringify(from)} already forwarded (one forward per branch)`);
					else if (lastTo !== null && lastTo !== "?" && from !== lastTo) refuse(n, `forward from ${JSON.stringify(from)} does not continue the chain (expected from ${JSON.stringify(lastTo)})`);
					else if (via === "direct" && to === "?") refuse(n, "ambiguous target to=? cannot direct-forward (route via operator)");
					else if (via === "direct" && collides(branches.get(from), branches.get(to))) {
						const shared = branches.get(from).files.find((f) => branches.get(to).files.includes(f));
						refuse(n, `footprint collision on ${JSON.stringify(shared)}: direct-forward refused (route via operator with reason=)`);
					} else if (via === "operator" && !reason) refuse(n, `via=operator hop from ${JSON.stringify(from)} missing reason= (operator stays conflict resolver)`);
					else {
						forwardedFrom.add(from);
						lastTo = to;
						lastToLine = n;
					}
				}
				break;
			}
			case "broadcast": {
				if (sawBroadcast) refuse(n, "second broadcast (the terminal broadcast closes the chain exactly once)");
				else {
					const { to, chain: c, result, ref } = kv(rest);
					if (to !== "merger") refuse(n, `broadcast to ${JSON.stringify(to)} (terminal broadcast goes to=merger)`);
					else if (c !== chain) refuse(n, `broadcast chain ${JSON.stringify(c)} != ${JSON.stringify(chain)}`);
					else if (result !== "done") refuse(n, `broadcast result is ${JSON.stringify(result)} (expected "done" — the = Done transition)`);
					else if (!ref) refuse(n, "broadcast missing ref= closing handoff to the merger");
					else { sawBroadcast = true; closed = true; }
				}
				break;
			}
			default:
				refuse(n, `unknown record kind ${JSON.stringify(kind)} (chain/branch/forward/broadcast only)`);
		}
	});

	if (refused) return { verdict: "REFUSED", line: refused.line, errors: [`${refused.message}`] };
	if (!chain) errors.push("no chain declared");
	if (!sawBroadcast) errors.push("chain never closed (no terminal broadcast)");
	else if (lastTo === "?") errors.push(`chain ends ambiguous (last hop to=? @ line ${lastToLine})`);
	else if (lastTo !== null) {
		for (const name of branches.keys()) {
			if (name !== lastTo && !forwardedFrom.has(name)) errors.push(`branch ${JSON.stringify(name)} never forwarded`);
		}
	}
	if (errors.length) return { verdict: "INCOMPLETE", line: null, errors };
	return { verdict: "OK", line: null, errors: [] };
}

function checkFile(path) {
	return checkForwarding(readFileSync(path, "utf8"));
}

const EXPECT = [
	{ file: "clean-chain.events", verdict: "OK" },
	{ file: "collision-via-operator.events", verdict: "OK" },
	{ file: "ambiguous-next-via-operator.events", verdict: "OK" },
	{ file: "terminal-broadcast.events", verdict: "OK" },
	{ file: "direct-despite-collision.events", verdict: "REFUSED", line: 6, match: "collision" },
	{ file: "missing-broadcast.events", verdict: "INCOMPLETE", match: "never closed" },
];

function runAll() {
	let pass = 0;
	for (const e of EXPECT) {
		const r = checkFile(join(HERE, e.file));
		const okVerdict = r.verdict === e.verdict;
		const okLine = e.line === undefined || r.line === e.line;
		const okMatch = e.match === undefined || r.errors.some((x) => x.includes(e.match));
		if (okVerdict && okLine && okMatch) {
			console.log(`PASS\t${e.file}\t${r.verdict}`);
			pass++;
		} else {
			console.log(`FAIL\t${e.file}\texpected ${e.verdict}${e.line ? ` @ line ${e.line}` : ""} ${e.match ? JSON.stringify(e.match) : ""}, got ${r.verdict}${r.line ? ` @ line ${r.line}` : ""} [${r.errors.join("; ")}]`);
		}
	}
	const total = EXPECT.length;
	console.log(`${pass}/${total} forwarding fixtures behave as specified`);
	return pass === total ? 0 : 1;
}

const { file, all } = parseArgs(process.argv.slice(2));
if (all) {
	process.exit(runAll());
} else {
	const r = checkFile(file);
	if (r.verdict === "OK") console.log(`FORWARD OK\t${file}`);
	else {
		console.log(`FORWARD ${r.verdict}\t${file}`);
		for (const e of r.errors) console.log(`error\t${r.line ?? "-"}\t${e}`);
	}
	process.exit(r.verdict === "OK" ? 0 : 1);
}
