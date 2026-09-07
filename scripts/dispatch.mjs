// bais/scripts/dispatch.mjs — bi#123: workload-aware swarm pack conformance.
//
// `bais dispatch --agents N` dry-runs the pure pack (BAML dispatch_pack,
// mirrored by both hosts): load-bearing first, live claims never assigned,
// declared footprints never shared between slots. Read-only except tmp
// fixtures; never writes to the real issues dir. Exits non-zero on any
// divergence. Red-check 2026-09-05: with the leased filter of dispatchPack
// disabled, the leased fixture below (Open + live envelope — readiness alone
// would pack it) failed LOUD as `leased skipped ["t#01","t#02","t#03"]`;
// restored, green. A Doing+leased fixture would NOT catch this (Doing is
// already unready), which is why the fixture claims an Open issue.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseFiles, warnPartial, warnReentry, buildPack, splitUnknownPack, warnUnknownWithheld, warnUnknownShared, buildCohorts, renderCohortBrief, warnCohortSplit, warnCohortExclude, assertBriefLines, parseAcceptance } from "./briefs.mjs";

const CLI = "/Users/adrian/code/orion/orion-learn-baml/bais/dist/src/cli.js";
let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const run = (dir, args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const issue = (id, title, status, edges = [], extra = "", files = "") => {
	const es = edges.map((e) => `[[edge]]\nfrom = "${e[0]}"\nto = "${e[1]}"\nkind = "${e[2]}"\n`).join("\n");
	return `id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "Feat"\nbody = """\nb${files ? `\nFiles: ${files}` : ""}\n"""\n${extra}${es}`;
};
const mkfix = (files) => {
	const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	for (const [name, content] of files) writeFileSync(join(is, name), content);
	return d;
};
const slotsOf = (out) => out.split("\n").filter((l) => l.startsWith("slot")).map((l) => l.split("\t")[1]);

// 1. Hub first, budget caps.
{
	const d = mkfix([
		["t#01.toml", issue("t#01", "hub", "Open", [], "", "t01.ts")],
		["t#02.toml", issue("t#02", "leaf a", "Open", [["t#02", "t#01", "DependsOn"]], "", "t02.ts")],
		["t#03.toml", issue("t#03", "leaf b", "Open", [["t#03", "t#01", "DependsOn"]], "", "t03.ts")],
		["t#04.toml", issue("t#04", "lone", "Open", [], "", "t04.ts")],
	]);
	const r = run(d, ["dispatch", "--agents", "2"]);
	check(r.code === 0 && JSON.stringify(slotsOf(r.out)) === '["t#01","t#02"]', `hub first, budget caps (${JSON.stringify(slotsOf(r.out))})`);
}

// 2. Live-claimed Doing is never assigned (and is named on stderr).
{
	const d = mkfix([
		["t#01.toml", issue("t#01", "hub", "Open", [], "", "t01.ts")],
		["t#02.toml", issue("t#02", "held", "Open", [], 'holder = "a1"\nlease = "2099-01-01T00:00:00Z"\n', "t02.ts")],
		["t#03.toml", issue("t#03", "lone", "Open", [], "", "t03.ts")],
	]);
	const r = run(d, ["dispatch", "--agents", "3"]);
	const slots = slotsOf(r.out);
	check(r.code === 0 && !slots.includes("t#02") && JSON.stringify(slots) === '["t#01","t#03"]', `leased skipped (${JSON.stringify(slots)})`);
	const j = JSON.parse(run(d, ["dispatch", "--agents", "3", "--json"]).out);
	check(Array.isArray(j.leased) && j.leased.includes("t#02"), `leased named in json (${JSON.stringify(j.leased)})`);
}

// 3. Declared footprints never share a file between slots.
{
	const body12 = 'body = """b\nFiles: a.ts\n"""';
	const body3 = 'body = """b\nFiles: b.ts\n"""';
	const d = mkfix([
		["t#01.toml", `id = "t#01"\ntitle = "hub"\nstatus = "Open"\nkind = "Feat"\n${body12}\n[[edge]]\nfrom = "t#02"\nto = "t#01"\nkind = "DependsOn"\n`],
		["t#02.toml", `id = "t#02"\ntitle = "same file"\nstatus = "Open"\nkind = "Feat"\n${body12}\n`],
		["t#03.toml", `id = "t#03"\ntitle = "clean"\nstatus = "Open"\nkind = "Feat"\n${body3}\n`],
	]);
	const r = run(d, ["dispatch", "--agents", "3"]);
	check(r.code === 0 && JSON.stringify(slotsOf(r.out)) === '["t#01","t#03"]', `conflict packs around (${JSON.stringify(slotsOf(r.out))})`);
	check(/t#03\tbr=0\tfiles: b\.ts/.test(r.out), `declared files shown (${JSON.stringify(r.out.split("\n").filter((l) => l.startsWith("slot1")))})`);
}

// 4. Usage errors.
{
	const d = mkfix([["t#01.toml", issue("t#01", "lone", "Open")]]);
	const r1 = run(d, ["dispatch"]);
	const r2 = run(d, ["dispatch", "--agents", "0"]);
	check(r1.code !== 0 && /--agents/.test(r1.out), `missing --agents rejected (${JSON.stringify(r1.out.trim())})`);
	check(r2.code !== 0 && /--agents/.test(r2.out), `zero budget rejected (${JSON.stringify(r2.out.trim())})`);
}

// 5. Tie-break is id ascending (lexicographic, same as BAML `<`).
{
	const d = mkfix([
		["t#09.toml", issue("t#09", "nine", "Open")],
		["t#02.toml", issue("t#02", "two", "Open")],
	]);
	const r = run(d, ["dispatch", "--agents", "1"]);
	check(r.code === 0 && JSON.stringify(slotsOf(r.out)) === '["t#02"]', `tie-breaks on id (${JSON.stringify(slotsOf(r.out))})`);
}

// 6. hub#160: live structural properties on the root hub .bais (migrated
// from bi/.bais 2026-09-06 — robust to backlog evolution; no pins here,
// cross-check §6 owns the pinned numbers) PLUS subdir execution: the raw
// CLI from bi/ and bais/ (no local .bais) falls through to the root hub —
// same issue-id sets as from the root cwd for list/ready/dispatch --json.
// bagl/ owns a nested hub (bagl/.bais, git-ignored): nearest-hub-wins keeps
// it on its own hub — green, but NOT the root set. (Resolving bagl/ at the
// root hub would fork it off its own hub; see bais/src/resolve.ts.)
//
// Fixtures (repo-layout mirror, fully isolated in tmp): hub + empty bi/,
// bais/, bagl/ subdirs — every subdir run is byte-identical to the root-cwd
// run. A nested-hub fixture pins nearest-wins: sub/ with its own .bais
// resolves sub, the hub root is unaffected.
{
	const d = "/Users/adrian/code/orion/orion-learn-baml";
	const r = run(d, ["dispatch", "--agents", "4", "--json"]);
	const j = JSON.parse(r.out);
	const readyIds = new Set(JSON.parse(run(d, ["ready", "--json"]).out).ready.map((f) => f.issue.id));
	const slotIds = j.slots.map((s) => s.issue.id);
	// hub#175: the live hub is mostly unknown-footprint, so the pack no
	// longer fills the budget — at most one unknown per pack, the rest
	// withheld LOUD (named in --json warnings). Structural, not counts.
	const liveUnknowns = j.slots.filter((s) => s.files_state !== "declared");
	const liveWithheld = j.withheld ?? [];
	const liveWarnings = j.warnings ?? [];
	check(r.code === 0 && liveUnknowns.length <= 1, `live pack holds at most one unknown (${liveUnknowns.length})`);
	check(liveWithheld.every((id) => !slotIds.includes(id) && readyIds.has(id)), `live withheld are unpacked ready issues (${JSON.stringify(liveWithheld)})`);
	check(liveWithheld.every((id) => liveWarnings.some((w) => w.includes(id))), `live withheld all named in warnings`);
	check(j.unfilled === 4 - j.slots.length, `live unfilled accounts the pack (${j.unfilled})`);
	check(slotIds.every((id) => readyIds.has(id)), `every slot is ready (${JSON.stringify(slotIds)})`);
	check(!slotIds.some((id) => (j.leased ?? []).includes(id)), `no leased slot (${JSON.stringify(j.leased ?? [])})`);
	const maxOpen = Math.max(...j.slots.map((s) => s.open_downstream));
	check(j.slots[0].open_downstream === maxOpen, `slot0 holds the max radius (${j.slots[0].issue.id}=${maxOpen})`);
	const seen = [];
	let overlap = null;
	for (const s of j.slots) {
		if (s.files_state !== "declared") continue;
		for (const f of s.files) {
			if (seen.includes(f)) overlap = `${f} in ${s.issue.id}`;
			seen.push(f);
		}
	}
	check(overlap === null, `declared footprints disjoint${overlap ? ` (${overlap})` : ""}`);
	// hub#160 live fallthrough: id-set equality with the root-cwd runs above.
	const idSet = (out, key) => JSON.parse(out)[key].map((f) => f.issue.id).sort();
	const wantList = JSON.stringify(idSet(run(d, ["list", "--json"]).out, "issues"));
	const wantReady = JSON.stringify([...readyIds].sort());
	const wantSlots = JSON.stringify([...slotIds].sort());
	for (const sub of ["bi", "bais"]) {
		const sd = join(d, sub);
		const l = run(sd, ["list", "--json"]);
		check(l.code === 0 && JSON.stringify(idSet(l.out, "issues")) === wantList, `list from ${sub}/ resolves root hub`);
		const rd = run(sd, ["ready", "--json"]);
		check(rd.code === 0 && JSON.stringify(idSet(rd.out, "ready")) === wantReady, `ready from ${sub}/ resolves root hub`);
		const p = run(sd, ["dispatch", "--agents", "4", "--json"]);
		check(p.code === 0 && JSON.stringify(JSON.parse(p.out).slots.map((s) => s.issue.id).sort()) === wantSlots, `dispatch from ${sub}/ resolves root hub`);
	}
	const b = run(join(d, "bagl"), ["list", "--json"]);
	const bIds = b.code === 0 ? idSet(b.out, "issues") : [];
	check(b.code === 0 && bIds.length > 0 && bIds.every((id) => id.startsWith("bagl#")), `bagl/ stays on its nested hub (${JSON.stringify(bIds.slice(0, 3))}…)`);
	// hub#160 fixtures: repo-layout mirror (hub + empty bi/bais/bagl subdirs).
	const f = mkfix([
		["t#01.toml", issue("t#01", "hub", "Open")],
		["t#02.toml", issue("t#02", "leaf", "Open", [["t#02", "t#01", "DependsOn"]])],
		["t#03.toml", issue("t#03", "lone", "Open")],
	]);
	for (const sub of ["bi", "bais", "bagl"]) mkdirSync(join(f, sub), { recursive: true });
	for (const sub of ["bi", "bais", "bagl"]) {
		const sd = join(f, sub);
		const rl = run(f, ["list", "--json"]);
		const sl = run(sd, ["list", "--json"]);
		check(sl.code === 0 && sl.out === rl.out, `${sub}/ fixture list byte-identical to hub root`);
		const rr = run(f, ["ready", "--json"]);
		const sr = run(sd, ["ready", "--json"]);
		check(sr.code === 0 && sr.out === rr.out, `${sub}/ fixture ready byte-identical to hub root`);
		const rp = run(f, ["dispatch", "--agents", "2", "--json"]);
		const sp = run(sd, ["dispatch", "--agents", "2", "--json"]);
		check(sp.code === 0 && sp.out === rp.out, `${sub}/ fixture dispatch byte-identical to hub root`);
	}
	// Red-check 2026-09-06: with the fallthrough forced off (`resolvedHub =
// null` in bais/src/cli.ts + rebuild), all 6 live bi//bais/ checks and all
// 9 fixture mirror checks failed LOUD (`FAIL: list from bi/ resolves root
// hub`, … — the subdir CLI exits 1 with `No .bais — run bais init`, and the
// `code === 0 &&` guards fail gracefully instead of crashing on the
// non-JSON output) while the bagl-nested and nested-hub checks stayed green
// (cwd-local hubs never needed the walk); 15 failure(s), no `all green`.
// Restored, green.
	// Nested-hub fixture pins nearest-wins.
	const sub2 = join(f, "sub");
	mkdirSync(join(sub2, ".bais", "issues"), { recursive: true });
	writeFileSync(join(sub2, ".bais", "config.toml"), 'project = "s"\n');
	writeFileSync(join(sub2, ".bais", "issues", "s#01.toml"), issue("s#01", "nested", "Open"));
	check(JSON.stringify(idSet(run(sub2, ["list", "--json"]).out, "issues")) === '["s#01"]', `nested hub wins from inside sub/`);
	check(!idSet(run(f, ["list", "--json"]).out, "issues").includes("s#01"), `hub root unaffected by nested hub`);
}

// 7. bi#125: briefs render per-slot spawn briefs (fixtures under
// scripts/fixtures/briefs-pack — declared t#01/t#03, unknown t#02).
// Red-check 2026-09-06: with the files_state branch of renderBrief
// forced to declared, the UNKNOWN assertion below failed LOUD as
// `unknown slot flagged UNKNOWN (brief names files it does not own)`;
// restored, green.
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const fix = join(HERE, "fixtures", "briefs-pack");
	const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
	const pack = buildPack(d, 3);
	check(pack.slots.length === 3, `briefs pack fills budget (${pack.slots.length}/3)`);
	const b0 = pack.slots[0].brief;
	check(b0.includes("alpha.ts") && b0.includes("/tmp/t01-deliver/"), `declared brief owns files + handoff path`);
	const b1 = pack.slots[1].brief;
	check(/UNKNOWN/.test(b1) && !/alpha\.ts|beta\.ts/.test(b1.split("File ownership")[1].split("Context policy")[0]), `unknown slot flagged UNKNOWN (${JSON.stringify(b1.split("\n").find((l) => l.includes("UNKNOWN")))})`);
	for (const s of pack.slots) {
		const paste = ["bais move", "File ownership", "Acceptance", "Context policy", "Trust scope", "Worktree", "PRE-FINISH DELIVERY"].every((h) => s.brief.includes(h));
		check(paste, `slot${s.slot} brief pastes into a spawn call`);
	}
	const empty = parseFiles("body text\nFiles:\nmore text");
	check(empty.declared === true && empty.files.length === 0, `bare Files: is declared touches-nothing`);
	const t3 = pack.slots[2].brief;
	check(t3.includes("beta.ts") && /fork candidates only/.test(t3), `declared brief keeps disjoint files + fork caveat`);
}

// 8. bi#126: partial packs warn loudly, exit stays 0 (via the briefs
// pack path — same spec the dispatch --json wiring must meet when the
// src lane lands it: stderr line + unfilled field; full packs quiet).
// NOTE for the src lane: the raw `dispatch` CLI does NOT yet emit this
// (needs bais/src/cli.ts + bi/src/cli.ts: `unfilled: budget -
// slots.length` in --json, warnPartial line on stderr when > 0).
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const fix = join(HERE, "fixtures", "briefs-pack");
	const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
	const runBriefs = (args) => {
		const r = spawnSync("node", [join(HERE, "briefs.mjs"), ...args], { cwd: d, encoding: "utf8", timeout: 60000 });
		return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
	};
	const p = runBriefs(["--agents", "5", "--dir", d, "--json"]);
	const j = JSON.parse(p.out);
	check(p.code === 0, `partial pack exits 0 (valid work)`);
	check(p.err.trim() === "[bais] budget 5, packed 3: 2 slots unfilled (only 3 ready+unleased+clash-free)", `partial pack warns loudly (${JSON.stringify(p.err.trim())})`);
	check(j.unfilled === 2, `--json carries unfilled (${j.unfilled})`);
	check(warnPartial(8, 5) === "[bais] budget 8, packed 5: 3 slots unfilled (only 5 ready+unleased+clash-free)", `issue example format exact`);
	check(warnPartial(3, 3) === null, `full pack has no warning`);
	const f = runBriefs(["--agents", "3", "--dir", d, "--json"]);
	check(f.code === 0 && f.err === "" && JSON.parse(f.out).unfilled === 0, `full pack stays quiet`);
}

// 9. bi#129: one outstanding pack per dispatcher turn (scripts lane).
// pack → claim a slot → re-dispatch warns LOUD naming the held slot;
// after release the re-dispatch runs quiet. Exit stays 0 throughout
// (held slots are valid in-flight work, never silent).
// NOTE for the src lane: the raw `dispatch` CLI does NOT yet emit this
// (needs bais/src/cli.ts + bi/src/cli.ts: warnReentry(leased) line on
// stderr when leased is non-empty; --json already carries leased).
// Red-check 2026-09-06: with warnReentry neutered to always-null, the
// held-slot assertion below failed LOUD as `re-dispatch warns naming
// the held slot (null)`; restored, green. A guard that cannot go
// red on a held slot is camouflage, not coverage.
{
	check(warnReentry(["t#02"]) === "[bais] reentry: 1 held slot still claimed (t#02); next pack after the merger confirms the fold", `reentry format exact`);
	check(warnReentry(["t#01", "t#03"]) === "[bais] reentry: 2 held slots still claimed (t#01, t#03); next pack after the merger confirms the fold", `reentry plural format exact`);
	check(warnReentry([]) === null && warnReentry() === null, `no held slots stays quiet`);
	const d = mkfix([
		["t#01.toml", issue("t#01", "hub", "Open")],
		["t#02.toml", issue("t#02", "leaf", "Open", [["t#02", "t#01", "DependsOn"]])],
	]);
	const first = buildPack(d, 2);
	check(warnReentry(first.leased) === null, `first dispatch runs quiet`);
	const claim = run(d, ["move", "t#01", "Doing", "--as", "demo-129", "--for", "2h"]);
	check(claim.code === 0, `slot claim lands in fixture hub (${JSON.stringify(claim.out.trim().split("\n")[0])})`);
	const held = buildPack(d, 2);
	const w = warnReentry(held.leased);
	check(w !== null && w.includes("t#01"), `re-dispatch warns naming the held slot (${JSON.stringify(w)})`);
	const release = run(d, ["move", "t#01", "Open"]);
	check(release.code === 0, `slot release lands (${JSON.stringify(release.out.trim().split("\n")[0])})`);
	const after = buildPack(d, 2);
	check(warnReentry(after.leased) === null, `dispatch runs quiet after release`);
}

// 10. hub#162: three same-surface issues cohort to ONE sequential slot
// under the footprint cap (fixtures/cohort/trio — pairwise shared
// Files: + shared area + small; union 3 files <= 5 cap). Each member
// keeps its own acceptance bullets and passes assertBriefLines, so
// every step is independently closable (own red-check per bi#57).
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const fix = join(HERE, "fixtures", "cohort", "trio");
	const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
	const { cohorts, excluded, uncohorted, warnings, byId } = buildCohorts(d);
	check(cohorts.length === 1 && JSON.stringify(cohorts[0].members) === '["c#01","c#02","c#03"]', `trio cohorts to one slot (${JSON.stringify(cohorts.map((c) => c.members))})`);
	check(cohorts[0].files.length <= 5, `cohort union within the 5-file cap (${cohorts[0].files.length}: ${cohorts[0].files.join(",")})`);
	check(excluded.length === 0 && uncohorted.length === 0 && warnings.length === 0, `trio has no exclusions, remainders, or splits`);
	check(cohorts[0].affinity >= 3 && cohorts[0].reasons.length >= 2, `affinity shows its work (${cohorts[0].affinity}: ${cohorts[0].reasons.join("; ")})`);
	for (const id of cohorts[0].members) {
		const bullets = parseAcceptance(byId.get(id).body).filter((b) => !b.startsWith("(no Acceptance:"));
		check(bullets.length > 0, `${id} independently closable with own acceptance (${JSON.stringify(bullets[0])})`);
	}
	const brief = renderCohortBrief(cohorts[0], byId, d);
	check(/SEQUENTIALLY/.test(brief) && /ONE agent/.test(brief) && /withholds them from parallel packs/.test(brief), `cohort brief binds one agent, sequential, partitioned from swipe`);
	for (const id of cohorts[0].members) {
		const step = brief.split(`--- step`)[cohorts[0].members.indexOf(id) + 1];
		let linesOk = true;
		try { assertBriefLines(step); } catch { linesOk = false; }
		check(linesOk, `${id} step keeps all six required spawn-brief lines`);
	}
}

// 11. hub#162: an oversized affinity group splits LOUD under the cap
// (fixtures/cohort/oversized — six slices sharing mesh.ts + area: one
// affinity group, union 13 files). Three sequential cohorts of two,
// each union exactly at the 5-file cap; the split warning is exact on
// stderr and exit stays 0 (valid work, never silent).
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const fix = join(HERE, "fixtures", "cohort", "oversized");
	const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
	const { cohorts, excluded, warnings } = buildCohorts(d);
	check(cohorts.length === 3 && cohorts.every((c) => c.members.length === 2), `oversized splits into 3 cohorts of 2 (${JSON.stringify(cohorts.map((c) => c.members))})`);
	check(cohorts.every((c) => c.files.length <= 5), `every split cohort within the cap (${cohorts.map((c) => c.files.length).join(",")})`);
	check(excluded.length === 0, `split excludes nothing (cap remainder re-cohorts or stands named)`);
	check(warnings.length === 1, `one loud split warning (${JSON.stringify(warnings)})`);
	check(warnings[0] === "[bais] cohort split: o#01,o#02,o#03,o#04,o#05,o#06 share affinity but exceed the 5-file cap — 3 sequential cohorts (o#01+o#02 | o#03+o#04 | o#05+o#06)", `split format exact`);
	check(warnCohortSplit(["o#01", "o#02"], [["o#01"], ["o#02"]]) === "[bais] cohort split: o#01,o#02 share affinity but exceed the 5-file cap — 2 sequential cohorts (o#01 | o#02)", `split helper format exact`);
	const r = spawnSync("node", [join(HERE, "briefs.mjs"), "--cohorts", "--dir", d, "--json"], { encoding: "utf8", timeout: 60000 });
	check(r.status === 0, `cohort CLI exits 0 on a split (valid work)`);
	// bi#55: the cohorts probe dir is storeless, so the briefs child's
	// in-process `list` names the scan fallback on stderr ahead of the
	// split warning — both lines, in order (same fd, sequential writes).
	check((r.stderr ?? "").trim() === `[bais] no store.db — directory scan (run \`bais ingest\` for indexed reads)\n${warnings[0]}`, `split warns loudly on stderr`);
	check(JSON.parse(r.stdout).warnings.length === 1, `--json carries the split warning`);
}

// 12. hub#162: a DependsOn-blocked member excludes WITH REASON —
// cohesion never overrides blockers (fixtures/cohort/blocked: b#03
// shares the face.ts surface but waits on Open b#04; b#04 stands alone
// elsewhere). b#01+b#02 still cohort; the exclusion names the edge.
//
// Red-check 2026-09-06 (bi#57): with the DependsOn guard of
// cohortCandidates neutered (`const dep = undefined` in briefs.mjs —
// scripts lane, no rebuild), the suite failed LOUD with 4 failure(s)
// FOR THE RIGHT REASON: `unblocked pair still cohorts
// ([["b#01","b#02","b#03"]])` (b#03 cohorted despite waiting on b#04),
// `blocked member excluded with reason (undefined)`, `blocked member
// in no cohort`, `exclusion warns loudly on stderr`. Restored, green.
// A blocker guard that cannot go red on an ordered member is
// camouflage, not coverage.
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const fix = join(HERE, "fixtures", "cohort", "blocked");
	const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
	const is = join(d, ".bais", "issues");
	mkdirSync(is, { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
	const { cohorts, excluded, uncohorted, warnings } = buildCohorts(d);
	check(cohorts.length === 1 && JSON.stringify(cohorts[0].members) === '["b#01","b#02"]', `unblocked pair still cohorts (${JSON.stringify(cohorts.map((c) => c.members))})`);
	const b3 = excluded.find((e) => e.id === "b#03");
	check(b3 !== undefined && /b#04/.test(b3.reason) && /DependsOn/.test(b3.reason) && /cohesion never overrides blockers/.test(b3.reason), `blocked member excluded with reason (${JSON.stringify(b3?.reason)})`);
	check(!cohorts.some((c) => c.members.includes("b#03")), `blocked member in no cohort`);
	check(uncohorted.some((u) => u.id === "b#04"), `dependency stands alone, named (${JSON.stringify(uncohorted)})`);
	check(warnings.length === 0, `no cap split on the blocked set`);
	check(warnCohortExclude("b#03", "r") === "[bais] cohort exclude b#03: r", `exclusion format exact`);
	const r = spawnSync("node", [join(HERE, "briefs.mjs"), "--cohorts", "--dir", d, "--json"], { encoding: "utf8", timeout: 60000 });
	check(r.status === 0, `cohort CLI exits 0 on an exclusion (valid work)`);
	const loud = b3 !== undefined && (r.stderr ?? "").split("\n").some((l) => l === warnCohortExclude(b3.id, b3.reason));
	check(loud, `exclusion warns loudly on stderr`);
}

// 13. hub#175: unknown footprints (no Files: line) are mutually exclusive
// in swipe packs — empty file lists never collide vacuously. The exclusion
// now lives in the src lane (dispatchPack in bais/src/graph.ts +
// bi/src/bais.ts, the CLI's own greedy pack): the raw `dispatch --json`
// keeps the first unknown in slot order and carries withheld+warnings
// (pinned §14 below). buildPack's splitUnknownPack stays as defense in
// depth — a no-op second filter over the pre-filtered CLI slots — so the
// buildPack-level withheld/warnings below read EMPTY while the CLI-level
// fields (§14) carry them. Fixtures under fixtures/packer. Ground-first
// (hub#159): slot files_state here is the CLI's observed dispatch --json
// output, never assumed from the body.
//
// Red-check 2026-09-06 (bi#57, scripts lane): with the splitUnknownPack
// filter neutered to keep-all, the suite failed LOUD with 9 failure(s) FOR
// THE RIGHT REASON — `first unknown keeps the slot (["u#01","u#02"])`
// (the hub#175 bug reproduced), plus the withheld/unfilled/renumber/--json/
// stderr lines going quiet. Restored, green. LAYERING NOTE: once the src
// lane landed, that neuter goes quiet through buildPack (the CLI pre-
// withholds, so the scripts filter never sees two unknowns) — the load-
// bearing hunk moved to src-lane dispatchPack, whose red-check is recorded
// in §14. A mutual-exclusion filter that cannot go red on a second unknown
// is camouflage, not coverage.
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const copyFix = (name) => {
		const fix = join(HERE, "fixtures", "packer", name);
		const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
		const is = join(d, ".bais", "issues");
		mkdirSync(is, { recursive: true });
		writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
		for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
		return d;
	};
	// A: two unknowns never share a swipe pack. The CLI pre-withholds u#02
	// (src lane), so buildPack sees one slot and stays quiet here — the
	// withheld id + loud warning live in the CLI --json (§14 pins them).
	const dA = copyFix("two-unknown");
	const packA = buildPack(dA, 2);
	check(packA.slots.length === 1 && packA.slots[0].issue.id === "u#01", `first unknown keeps the slot (${JSON.stringify(packA.slots.map((s) => s.issue.id))})`);
	check(JSON.stringify(packA.withheld) === '[]', `buildPack-level withheld empty (CLI pre-withheld; §14 pins CLI-level)`);
	check(packA.warnings.length === 0, `buildPack-level quiet (CLI warned; §14 pins CLI-level)`);
	check(packA.unfilled === 1, `withheld slot counts unfilled (${packA.unfilled})`);
	check(warnUnknownWithheld(["u#02"]) === "[bais] unknown footprint withheld from swipe pack: u#02 (no Files: line proves no clash-freedom — at most one unknown per pack; declare Files: first per bi#125)", `withheld format exact`);
	check(warnUnknownWithheld(["u#02", "u#03"]) === "[bais] unknown footprints withheld from swipe pack: u#02, u#03 (no Files: line proves no clash-freedom — at most one unknown per pack; declare Files: first per bi#125)", `withheld plural format exact`);
	// B: declared+unknown pair warns naming the unknown issue.
	const dB = copyFix("declared-unknown");
	const packB = buildPack(dB, 2);
	check(packB.slots.length === 2 && packB.withheld.length === 0, `declared+unknown still packs (${JSON.stringify(packB.slots.map((s) => s.issue.id))})`);
	check(packB.warnings.length === 1 && packB.warnings[0].includes("u#01") && packB.warnings[0].includes("d#01"), `declared+unknown warns naming the unknown (${JSON.stringify(packB.warnings)})`);
	check(warnUnknownShared("u#01", ["d#01"]) === "[bais] unknown footprint u#01 shares a swipe pack with declared d#01 (no Files: — confirm scope with the operator before writing)", `shared format exact`);
	// C: compound — declared + two unknowns: one kept (renumbered dense),
	// one withheld, both warnings present.
	const dC = mkfix([
		["d#01.toml", `id = "d#01"\ntitle = "declared"\nstatus = "Open"\nkind = "Feat"\nbody = """\nDeclared.\nAcceptance: d holds.\nFiles: alpha.ts\n"""\n`],
		["u#01.toml", `id = "u#01"\ntitle = "unknown one"\nstatus = "Open"\nkind = "Feat"\nbody = """\nUndeclared.\nAcceptance: one holds.\n"""\n`],
		["u#02.toml", `id = "u#02"\ntitle = "unknown two"\nstatus = "Open"\nkind = "Feat"\nbody = """\nUndeclared.\nAcceptance: two holds.\n"""\n`],
	]);
	const packC = buildPack(dC, 3);
	check(JSON.stringify(packC.slots.map((s) => s.issue.id)) === '["d#01","u#01"]', `compound keeps declared + first unknown (${JSON.stringify(packC.slots.map((s) => s.issue.id))})`);
	check(JSON.stringify(packC.slots.map((s) => s.slot)) === '[0,1]', `kept slots renumbered dense (${JSON.stringify(packC.slots.map((s) => s.slot))})`);
	check(JSON.stringify(packC.withheld) === '[]' && packC.warnings.length === 1 && packC.warnings[0].includes("u#01"), `compound quiet-withheld + shared warn only (CLI owns withheld; §14)`);
	// D: --json exits 0 (valid work); a lone unknown stays quiet (its brief
	// already flags UNKNOWN). The loud withheld/shared lines moved to the
	// CLI level with the exclusion (§14) — briefs-level fields read empty.
	const rj = spawnSync("node", [join(HERE, "briefs.mjs"), "--agents", "2", "--dir", dA, "--json"], { encoding: "utf8", timeout: 60000 });
	check(rj.status === 0, `unknown pack --json exits 0 (valid work)`);
	const jj = JSON.parse(rj.stdout);
	check(JSON.stringify(jj.withheld) === '[]' && jj.warnings.length === 0, `briefs-level quiet (CLI-level carries withheld+warnings; §14)`);
	const rh = spawnSync("node", [join(HERE, "briefs.mjs"), "--agents", "2", "--dir", dA], { encoding: "utf8", timeout: 60000 });
	check(rh.status === 0, `briefs human mode exits 0`);
	const lone = buildPack(dA, 1);
	check(lone.slots.length === 1 && lone.warnings.length === 0 && lone.withheld.length === 0, `lone unknown packs quiet (brief flags UNKNOWN)`);
	// E: declared-empty (bare Files:) is a real touches-nothing claim and
	// still packs freely — only unknowns are mutually exclusive.
	const pure = splitUnknownPack([{ issue: { id: "e#01" }, files_state: "declared" }, { issue: { id: "e#02" }, files_state: "declared" }]);
	check(pure.kept.length === 2 && pure.warnings.length === 0, `declared-empty packs freely`);
}

// 14. hub#175 src lane: the raw dispatch CLI enforces unknown mutual
// exclusion itself (dispatchPack in bais/src/graph.ts + bi/src/bais.ts
// mirrors splitUnknownPack, so the scripts post-filter stays a no-op over
// these slots). Reuses the §13 packer fixtures: live `dispatch --json`
// must no longer pack unknowns as disjoint — withheld/with warnings named
// in --json, loud on stderr in human mode. Exit stays 0 throughout.
//
// Red-check 2026-09-06 (bi#57): with the src-lane filter neutered to
// keep-all (`if (false) continue` in bais/src/graph.ts + rebuild), the
// suite failed LOUD with 9 failure(s) FOR THE RIGHT REASON — `live pack
// holds at most one unknown (4)` on the live hub plus `live pack keeps
// first unknown (["u#01","u#02"])` (the hub#175 bug reproduced: two
// unknowns sharing one swipe pack) with the withheld/warn lines going
// quiet. Restored, green. An exclusion that cannot go red on a second
// unknown is camouflage, not coverage.
{
	const HERE = dirname(fileURLToPath(import.meta.url));
	const copyFix = (name) => {
		const fix = join(HERE, "fixtures", "packer", name);
		const d = mkdtempSync(join(tmpdir(), "probe-dispatch-"));
		const is = join(d, ".bais", "issues");
		mkdirSync(is, { recursive: true });
		writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
		for (const f of readdirSync(fix)) writeFileSync(join(is, f), readFileSync(join(fix, f), "utf8"));
		return d;
	};
	// run() returns stdout only on success — human-mode warnings go to
	// stderr, so capture it separately here (same spawnSync shape as §8).
	const runH = (dir, args) => {
		const r = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
	};
	// A: two unknowns never share a live pack.
	const dA = copyFix("two-unknown");
	const jA = JSON.parse(run(dA, ["dispatch", "--agents", "2", "--json"]).out);
	check(jA.slots.length === 1 && jA.slots[0].issue.id === "u#01", `live pack keeps first unknown (${JSON.stringify(jA.slots.map((s) => s.issue.id))})`);
	check(JSON.stringify(jA.withheld) === '["u#02"]', `live --json names the withheld unknown (${JSON.stringify(jA.withheld)})`);
	check(jA.unfilled === 1 && jA.warnings.length === 1 && jA.warnings[0].includes("u#02"), `live --json warns + counts unfilled (${JSON.stringify(jA.warnings)})`);
	const hA = runH(dA, ["dispatch", "--agents", "2"]);
	check(hA.code === 0 && hA.err.includes("u#02") && hA.err.includes("withheld"), `live human mode warns loudly naming u#02`);
	// B: declared+unknown pair packs with a warning naming the unknown.
	const dB = copyFix("declared-unknown");
	const jB = JSON.parse(run(dB, ["dispatch", "--agents", "2", "--json"]).out);
	check(jB.slots.length === 2 && JSON.stringify(jB.withheld ?? []) === '[]', `live declared+unknown still packs (${JSON.stringify(jB.slots.map((s) => s.issue.id))})`);
	check(jB.warnings.length === 1 && jB.warnings[0].includes("u#01") && jB.warnings[0].includes("d#01"), `live declared+unknown warns naming the unknown (${JSON.stringify(jB.warnings)})`);
	const hB = runH(dB, ["dispatch", "--agents", "2"]);
	check(hB.code === 0 && hB.err.includes("u#01") && hB.err.includes("d#01"), `live human mode names unknown + declared partner`);
}

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("dispatch: all green");
