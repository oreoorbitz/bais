// bais/scripts/hash-evidence.mjs — hash-vs-evidence audit conformance
// (hub#224). Every commit hash cited in an Evidence: line must resolve
// in a known clone (root/bi/bais/bits/bagl); failures name the repos
// tried (the assumption-echo). Warn by default, fatal under
// --audit-strict.
//
// The fixture hub lives under the repo root (removed afterwards): the
// audit resolves siblings beside the hub, so a /tmp hub would leave
// every hash unresolvable. The valid-hash pin injects the live root
// HEAD so it resolves in any clone state.
//
// Red-check (bi#57) 2026-09-08: extraction floor blinded (7,40 →
// 41,64) → 5 FAIL (bare/scope/sha64 extraction, bogus loudness,
// strict exit); restored cmp-identical → all green.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "bais", "dist", "src", "cli.js");
const { evidenceHashes } = await import(join(ROOT, "bais", "dist", "src", "graph.js"));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`ok: ${name}`); }
	else { fail++; console.log(`FAIL: ${name} ${extra}`); }
};
const run = (dir, args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};

// Pure extraction pins (no git): scope, floors, caps, Evidence-only.
{
	check("bare hash extracts unscoped", JSON.stringify(evidenceHashes("Evidence: drill(x) # fold c2a6837")) === JSON.stringify([{ hash: "c2a6837", repo: null }]));
	check("repo scope extracts", JSON.stringify(evidenceHashes("Evidence: drill(x) # fold bi@c2a6837")) === JSON.stringify([{ hash: "c2a6837", repo: "bi" }]));
	check("body prose never counts", evidenceHashes("body mentions c2a6837 in passing").length === 0);
	check("short hex never counts", evidenceHashes("Evidence: drill(x) # beef it").length === 0);
	const sha64 = "a".repeat(64);
	check("sha256 content-hash never counts", evidenceHashes(`Evidence: drill(x) # anchor ${sha64}`).length === 0);
	check("non-evidence lines never count", evidenceHashes("Files: c2a6837.ts").length === 0);
}

// CLI audit pins on a fixture hub beside the real siblings.
const d = mkdtempSync(join(ROOT, ".tmp-hash-evidence-"));
try {
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	const head = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
	// verdict(t#02) keeps close-evidence satisfied with no scripts lane
	// (tmp hubs resolve no drill stems); the hash under test rides the # comment.
	const issue = (id, ev) => `id = "${id}"\ntitle = "t"\nstatus = "Done"\nkind = "Feat"\nbody = """\nb\nEvidence: verdict(t#02) # ${ev}\n"""\n`;
	writeFileSync(join(d, ".bais", "issues", "t#01.toml"), issue("t#01", "fold deadbee0"));
	writeFileSync(join(d, ".bais", "issues", "t#02.toml"), issue("t#02", `fold ${head}`));
	const args = ["check", "--hash-root", ROOT];
	const r = run(d, args);
	check("bogus hash is loud with tried-list", r.out.includes("audit\tt#01\thash-vs-evidence\tdeadbee0 resolves nowhere (tried: root, bi, bais, bits, bagl)"), JSON.stringify(r.out.split("\n").filter((l) => l.includes("hash-vs-evidence"))));
	check("valid HEAD hash stays silent", !r.out.split("\n").some((l) => l.startsWith("audit\tt#02")), JSON.stringify(r.out.split("\n").filter((l) => l.startsWith("audit"))));
	check("default check stays green", r.code === 0, `code=${r.code}`);
	const strict = run(d, ["check", "--audit-strict", "--hash-root", ROOT]);
	check("strict exits 1 on unresolvable hash", strict.code === 1 && strict.out.includes("hash-vs-evidence"), `code=${strict.code}`);
} finally {
	rmSync(d, { recursive: true, force: true });
}

if (fail) { console.log(`hash-evidence: ${fail} FAIL, ${pass} pass`); process.exit(1); }
console.log("hash-evidence: all green");
