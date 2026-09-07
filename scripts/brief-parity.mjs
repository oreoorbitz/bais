// bais/scripts/brief-parity.mjs — hub#163: single-source brief gate.
//
// renderBrief exists ONCE (bais/scripts/briefs.mjs, canonical); both CLIs
// (bais/src/cli.ts, bi/src/cli.ts) import it instead of mirroring it. This
// script proves all three served surfaces render byte-identical briefs on
// fixtures: a drifted surface fails loud naming the first divergent line.
//
// Fixtures: scripts/fixtures/briefs-pack (copied read-only into a tmpdir hub
// — declared t#01/t#03, unknown t#02), the same pack dispatch.mjs §§7–8 use.
// Cwd discipline: every surface runs with cwd=<resolved tmpdir> and briefs.mjs
// gets --dir <same resolved path>, so the `run from <dir>` / Trust-scope
// lines agree (an unresolved /tmp-vs-/private/tmp symlink reads as drift).
//
// Direct assertions (single-source proof): renderBrief's bi#134 style
// branches are called straight from the canonical module — override renders
// `Style override:`, absent renders the inherits line. The CLIs cannot
// produce a styled brief while ns_toml rejects top-level `style` keys
// (probed 2026-09-06: "unknown top-level key style"), so parity runs on
// loadable (unstyled) fixtures and the override branch is pinned here.
//
// Test-only flag (red-check + fixtures, never used by a committed hook):
//   --briefs-mjs PATH  use a scratch briefs.mjs copy for surface 1 + the
//                      direct assertions instead of the real one.
//
// Red-check record (hub#163/bi#57, all observed live 2026-09-06):
//   $ cp bais/scripts/briefs.mjs bais/scripts/briefs-redcheck-scratch.mjs
//     (+ one-line mutate: inherits Style line -> "Style: MUTATED."; rm after)
//   $ node bais/scripts/brief-parity.mjs --briefs-mjs bais/scripts/briefs-redcheck-scratch.mjs
//     => FAIL: bais CLI brief slot0 diverges at line 17: canonical
//        "Style: MUTATED." vs bais CLI "Style: inherits goal style (...)."
//     => FAIL: bi CLI brief slot0 diverges at line 17 (same naming)
//     => FAIL: absent style renders the inherits line
//     => brief-parity: 3 failure(s), exit 1
//   $ rm <scratch>; node bais/scripts/brief-parity.mjs
//     => brief-parity: all green, exit 0
//   (The red run also caught a real harness bug first try: a relative
//   --briefs-mjs resolved against the tmpdir cwd as "cannot find module"
//   instead of drift — fixed to resolve against the operator cwd; re-ran
//   red to confirm the line-naming path.)
// A passing gate that cannot go red is camouflage, not coverage — the three
// FAIL lines above are the proof this one can.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // bais/scripts
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
	if (i < 0) return undefined;
	if (args[i].includes("=")) return args[i].slice(name.length + 1);
	return args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : "";
};
// Resolve to absolute: surface 1 runs with cwd=<tmpdir>, so a relative
// override would resolve against the tmpdir (red-check caught this — a
// relative --briefs-mjs failed as "cannot find module" instead of drift).
// A relative override resolves against the operator's cwd, like any CLI path.
const briefsMjsRaw = flag("--briefs-mjs") || join(HERE, "briefs.mjs");
const briefsMjs = briefsMjsRaw.startsWith("/") ? briefsMjsRaw : resolve(process.cwd(), briefsMjsRaw);
const baisCli = join(HERE, "..", "dist", "src", "cli.js");
const biCli = join(HERE, "..", "..", "bi", "dist", "src", "cli.js");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Tmpdir hub from the shared briefs-pack fixtures (read-only reuse).
const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-brief-parity-")));
const is = join(d, ".bais", "issues");
mkdirSync(is, { recursive: true });
writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
for (const f of readdirSync(join(HERE, "fixtures", "briefs-pack"))) {
	copyFileSync(join(HERE, "fixtures", "briefs-pack", f), join(is, f));
}

const run = (cmd, argv) => {
	const r = spawnSync(cmd, argv, { cwd: d, encoding: "utf8", timeout: 60000 });
	return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const briefsOf = (label, res, agents) => {
	let j = null;
	try {
		j = JSON.parse(res.out);
	} catch {
		check(false, `${label} --agents ${agents} --json parses (exit ${res.code}, stderr ${JSON.stringify(res.err.slice(0, 200))})`);
		return null;
	}
	check(res.code === 0, `${label} --agents ${agents} exits 0`);
	return j;
};

// Surface 1: canonical module as a binary. 2: bais CLI. 3: bi CLI.
const full = [
	["briefs.mjs", run("node", [briefsMjs, "--agents", "3", "--dir", d, "--json"])],
	["bais CLI", run("node", [baisCli, "dispatch", "--agents", "3", "--briefs", "--json"])],
	["bi CLI", run("node", [biCli, "bais", "dispatch", "--agents", "3", "--briefs", "--json"])],
];
const packs = full.map(([label, res]) => [label, briefsOf(label, res, 3)]);
if (packs.every(([, j]) => j && Array.isArray(j.slots))) {
	const byLabel = new Map(packs.map(([label, j]) => [label, j.slots.map((s) => s.brief)]));
	check(byLabel.get("briefs.mjs").length === 3, `full pack renders 3 briefs`);
	for (const other of ["bais CLI", "bi CLI"]) {
		const a = byLabel.get("briefs.mjs");
		const b = byLabel.get(other);
		if (a.length !== b.length) {
			check(false, `${other} packs ${b.length} briefs, canonical packs ${a.length}`);
			continue;
		}
		let diverged = -1;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) { diverged = i; break; }
		}
		if (diverged === -1) {
			check(true, `${other} renders byte-identical briefs (${a.length}/${a.length})`);
		} else {
			const al = a[diverged].split("\n");
			const bl = b[diverged].split("\n");
			let line = 0;
			while (line < al.length && line < bl.length && al[line] === bl[line]) line++;
			check(false, `${other} brief slot${diverged} diverges at line ${line}: canonical ${JSON.stringify(al[line])} vs ${other} ${JSON.stringify(bl[line])}`);
		}
	}
}

// Partial pack (--agents 5): unfilled agrees everywhere, briefs still match.
const part = [
	["briefs.mjs", run("node", [briefsMjs, "--agents", "5", "--dir", d, "--json"])],
	["bais CLI", run("node", [baisCli, "dispatch", "--agents", "5", "--briefs", "--json"])],
	["bi CLI", run("node", [biCli, "bais", "dispatch", "--agents", "5", "--briefs", "--json"])],
];
const parts = part.map(([label, res]) => [label, briefsOf(label, res, 5)]);
if (parts.every(([, j]) => j)) {
	for (const [label, j] of parts) check(j.unfilled === 2, `${label} partial pack carries unfilled=2 (got ${j.unfilled})`);
}

// Direct: the canonical module's bi#134 style branches + warnPartial shape.
const { renderBrief, warnPartial } = await import(pathToFileURL(briefsMjs).href);
const styled = renderBrief({ slot: 0, id: "t#99", title: "styled", body: "Acceptance: holds.", files: [], files_state: "unknown", dir: d, style: "corporate-oop" });
check(styled.includes("Style override: corporate-oop") && styled.includes(".bais/styles/corporate-oop.toml"), `override branch renders the bi#134 style line`);
const plain = renderBrief({ slot: 0, id: "t#99", title: "plain", body: "Acceptance: holds.", files: [], files_state: "unknown", dir: d });
check(plain.includes("Style: inherits goal style"), `absent style renders the inherits line`);
check(warnPartial(8, 5) === "[bais] budget 8, packed 5: 3 slots unfilled (only 5 ready+unleased+clash-free)", `warnPartial exact shape`);
check(warnPartial(3, 3) === null, `warnPartial quiet on full packs`);

if (failures) {
	console.error(`brief-parity: ${failures} failure(s) — land render changes in bais/scripts/briefs.mjs; the CLIs import it`);
	process.exit(1);
}
console.log("brief-parity: all green (3 surfaces byte-identical, style branches pinned)");
