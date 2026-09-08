// Probe: lease-bound Doing (dead-agent reclamation). Plain node, tmp
// fixtures only, every instant injected via --now — the full claim /
// renew / reap cycle is a pure function of (files, now), so the same
// script run twice must print byte-identical output (determinism is
// asserted, not assumed). Epic/scope gate pins (epic policy): epic and
// unknown --as claims refuse with names; declared + child claims land;
// --scope-confirmed overrides.
// Red-check (bi#57) 2026-09-08: graph.ts isEpic/epicChildren blinded
// (SubtaskOf → SubtaskOf_) → FAIL claim.epic-refused (epic claim lands),
// FAIL claim.epic-unmoved, FAIL claim.epic-override (3 FAIL, 25 pass);
// restored cmp-identical → 28 green.
// Red-check target: leaseExpired's `<=`
// boundary — flipping it to `<` must trip claim.reap-boundary.
// Red-check observed 2026-09-05: `<` trips reap-boundary + cleared
// (2 FAIL, 17 pass); restored `<=` returns 19 green.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "cli.js");
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const run = (dir, args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const issue = (id, title, status, files = "") =>
	`id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "Feat"\nbody = """\nb${files ? `\nFiles: ${files}` : ""}\n"""\n`;
const mkfix = () => {
	const d = mkdtempSync(join(tmpdir(), "claim-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	return d;
};
const T0 = "2026-09-05T12:00:00Z";
const L1H = "2026-09-05T13:00:00Z";
const L2H = "2026-09-05T14:00:00Z";

function cycle() {
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "work", "Open", "work.ts"));
	const log = [];
	// Bare move to Doing is allowed (bi#49 contract) but anonymous:
	// no claim lines, instantly stale, reaped on sight.
	const bare = run(d, ["move", "t#01", "Doing"]);
	log.push(`bare:${bare.code}:${bare.out.trim()}`);
	const fb = readFileSync(join(is, "t#01.toml"), "utf8");
	log.push(`anon:${!/holder =/.test(fb)}:${!/lease =/.test(fb)}`);
	const ra = run(d, ["reap", "--now", T0]);
	log.push(`reapanon:${ra.code}:${ra.out.trim()}`);
	// Claim with fixed now: exact lease instant.
	const c = run(d, ["move", "t#01", "Doing", "--as", "agent-1", "--for", "1h", "--now", T0]);
	log.push(`claim:${c.code}:${c.out.trim()}`);
	const f1 = readFileSync(join(is, "t#01.toml"), "utf8");
	log.push(`file:${/^holder = "agent-1"$/m.test(f1)}:${/^lease = "2026-09-05T13:00:00Z"$/m.test(f1)}`);
	// Strangers cannot renew; the holder can.
	const s = run(d, ["renew", "t#01", "--as", "agent-2", "--for", "1h", "--now", T0]);
	log.push(`stranger:${s.code}:${s.out.trim()}`);
	const r = run(d, ["renew", "t#01", "--as", "agent-1", "--for", "2h", "--now", T0]);
	log.push(`renew:${r.code}:${r.out.trim()}`);
	// Live lease reaps nothing; past expiry reaps exactly once.
	const n1 = run(d, ["reap", "--now", "2026-09-05T12:30:00Z"]);
	log.push(`noreap:${n1.code}:${n1.out.trim()}`);
	const b = run(d, ["reap", "--now", L2H]);
	log.push(`boundary:${b.code}:${b.out.trim()}`);
	const f2 = readFileSync(join(is, "t#01.toml"), "utf8");
	log.push(`cleared:${/^status = "Open"$/m.test(f2)}:${!/holder =/.test(f2)}:${!/lease =/.test(f2)}`);
	const n2 = run(d, ["reap", "--now", L2H]);
	log.push(`idempotent:${n2.code}:${n2.out.trim()}`);
	return log.join("\n");
}

const once = cycle();
check("claim.bare-anonymous", once.includes("bare:0:moved\tt#01\tOpen\tDoing"), once);
check("claim.bare-no-lines", once.includes("anon:true:true"), once);
check("claim.bare-instantly-stale", once.includes("reapanon:0:reaped\tt#01\tunknown\tno-lease"), once);
check("claim.claim-exact", once.includes(`claim:0:moved\tt#01\tOpen\tDoing`), once);
check("claim.file-lines", once.includes("file:true:true"), once);
check("claim.stranger-refused", once.includes("stranger:1:bais renew: t#01 held by \"agent-1\", not \"agent-2\" (strangers cannot renew)"), once);
check("claim.renew-exact", once.includes(`renew:0:renewed\tt#01\tagent-1\t${L2H}`), once);
check("claim.live-reaps-nothing", once.includes("noreap:0:reaped\t0"), once);
check("claim.reap-boundary", once.includes(`boundary:0:reaped\tt#01\tagent-1\t${L2H}`), once);
check("claim.cleared", once.includes("cleared:true:true:true"), once);
check("claim.idempotent", once.includes("idempotent:0:reaped\t0"), once);
// Determinism: same files + same nows, twice, byte-identical.
check("claim.deterministic", cycle() === once);

// Legacy Doing with no claim is immediately stale; check is advisory.
{
	const d = mkfix();
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#09.toml"), issue("t#09", "legacy", "Doing"));
	const c = run(d, ["check"]);
	check("claim.legacy-stale", c.code === 0 && c.out.includes("stale-claim\tt#09\tunknown\tno-lease"), JSON.stringify(c));
	const rp = run(d, ["reap", "--now", T0]);
	check("claim.legacy-reaped", rp.code === 0 && rp.out.includes("reaped\tt#09\tunknown\tno-lease"), JSON.stringify(rp));
	check("claim.legacy-open", /^status = "Open"$/m.test(readFileSync(join(is, "t#09.toml"), "utf8")));
	// Leaving Doing clears the claim; non-Doing renew refuses.
	const d2 = mkfix();
	const is2 = join(d2, ".bais", "issues");
	writeFileSync(join(is2, "t#02.toml"), issue("t#02", "w", "Open", "w.ts"));
	run(d2, ["move", "t#02", "Doing", "--as", "a1", "--for", "1h", "--now", T0]);
	run(d2, ["move", "t#02", "Done"]);
	const f = readFileSync(join(is2, "t#02.toml"), "utf8");
	check("claim.move-clears", /^status = "Done"$/m.test(f) && !/holder =/.test(f) && !/lease =/.test(f), f);
	const rn = run(d2, ["renew", "t#02", "--as", "a1"]);
	check("claim.renew-nondoing", rn.code === 1 && rn.out.includes("not Doing (nothing to renew)"), JSON.stringify(rn));
	// list --claims appends; plain list shape unchanged.
	const l1 = run(d2, ["list"]);
	check("claim.list-shape", l1.out.trim() === "t#02\tDone\tFeat\tw\tbr=0", JSON.stringify(l1.out));
	run(d2, ["move", "t#02", "Doing", "--as", "a1", "--for", "1h", "--now", T0]);
	const l2 = run(d2, ["list", "--claims"]);
	check("claim.list-claims", l2.out.trim() === `t#02\tDoing\tFeat\tw\ta1\t${L1H}\tbr=0`, JSON.stringify(l2.out));
	// Bad durations and owners fail closed with names.
	const bd = run(d2, ["move", "t#02", "Doing", "--as", "a1", "--for", "soon"]);
	check("claim.bad-duration", bd.code === 1 && bd.out.includes('needs <n>s|m|h|d'), JSON.stringify(bd));
	const bh = run(d2, ["move", "t#02", "Doing", "--as", 'a"b']);
	check("claim.bad-holder", bh.code === 1 && bh.out.includes("not an owner id"), JSON.stringify(bh));
}

// Epic/scope gate (epic policy): holder-bound claims need a workable
// scope — epics and unknown footprints refuse with names, bare claims
// stay allowed, --scope-confirmed overrides for verification closes.
{
	const d3 = mkfix();
	const is3 = join(d3, ".bais", "issues");
	const edge = '[[edge]]\nfrom = "t#11"\nto = "t#10"\nkind = "SubtaskOf"\n';
	writeFileSync(join(is3, "t#10.toml"), issue("t#10", "epic", "Open", "coord.ts") + edge);
	writeFileSync(join(is3, "t#11.toml"), issue("t#11", "child", "Open", "child.ts"));
	writeFileSync(join(is3, "t#12.toml"), issue("t#12", "unknown", "Open"));
	writeFileSync(join(is3, "t#13.toml"), issue("t#13", "declared", "Open", "leaf.ts"));
	// Epic refusal names the subtasks even though Files: is declared.
	const ep = run(d3, ["move", "t#10", "Doing", "--as", "a1", "--for", "1h", "--now", T0]);
	check("claim.epic-refused", ep.code === 1 && ep.out.includes("is an epic (subtasks: t#11)"), JSON.stringify(ep));
	check("claim.epic-unmoved", /^status = "Open"$/m.test(readFileSync(join(is3, "t#10.toml"), "utf8")));
	// Unknown footprint refusal names the fix.
	const un = run(d3, ["move", "t#12", "Doing", "--as", "a1", "--for", "1h", "--now", T0]);
	check("claim.unknown-refused", un.code === 1 && un.out.includes("declares no footprint"), JSON.stringify(un));
	// Declared non-epic claims land as before.
	const ok = run(d3, ["move", "t#13", "Doing", "--as", "a1", "--for", "1h", "--now", T0]);
	check("claim.declared-lands", ok.code === 0 && ok.out.includes("moved\tt#13\tOpen\tDoing"), JSON.stringify(ok));
	// The child of an epic claims fine (the gate routes to children).
	const ch = run(d3, ["move", "t#11", "Doing", "--as", "a1", "--for", "1h", "--now", T0]);
	check("claim.child-lands", ch.code === 0 && ch.out.includes("moved\tt#11\tOpen\tDoing"), JSON.stringify(ch));
	// Operator override lands both, loudly.
	const oe = run(d3, ["move", "t#10", "Doing", "--as", "a1", "--for", "1h", "--now", T0, "--scope-confirmed"]);
	const oef = readFileSync(join(is3, "t#10.toml"), "utf8");
	check("claim.epic-override", oe.code === 0 && oe.out.includes("moved\tt#10\tOpen\tDoing") && /^holder = "a1"$/m.test(oef), JSON.stringify(oe));
	const ou = run(d3, ["move", "t#12", "Doing", "--as", "a1", "--for", "1h", "--now", T0, "--scope-confirmed"]);
	check("claim.unknown-override", ou.code === 0 && ou.out.includes("moved\tt#12\tOpen\tDoing"), JSON.stringify(ou));
}

if (fail) { console.log(`claim: ${fail} FAIL, ${pass} pass`); process.exit(1); }
console.log(`claim: all ${pass} green`);
