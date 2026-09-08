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
import { foundationRank, compareFoundation, foundationSeatingWarn } from "./goal.mjs";

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
		["t#01.toml", issue("t#01", "hub", "Open", [], "", "hub.ts")],
		["t#02.toml", issue("t#02", "leaf", "Open", [["t#02", "t#01", "DependsOn"]], "", "leaf.ts")],
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

// 15. hub#217: curriculum scheduling — dispatch consumes the measured-
// capability schedule (Learning-with-Challenges, arXiv:2601.22781). BAML
// owns the rule (bais/baml_src/curriculum.baml: tier_green /
// dispatchable_tiers / curriculum_schedule, pinned by literal-tally baml
// tests); the mirror below is the scripts-lane consumption, same lockstep
// pattern as dispatchPack. A fixture campaign over two measurement
// windows shows harder-tier issues HELD with a named reason while the
// frontier tier is red, and dispatched once the green threshold is met —
// including against the naive CLI pack, which seats the harder tier
// immediately.
// NOTE for the src lane: the raw `dispatch` CLI does NOT yet consume the
// schedule (needs bais/src/cli.ts + bi/src/bais.ts: read the BITS arm
// tallies, run curriculum_schedule over the ready set BEFORE
// dispatch_pack, carry `held: [{id, reason}]` in --json, and print one
// `[bais] curriculum hold: <id> — <reason>` line per held issue on
// stderr; exit stays 0 — held work is valid, never silent).
{
	// ── mirror of baml_src/curriculum.baml (hub#217) — keep in lockstep ──
	const observations = (t) => t.pass + t.fail;
	const passRatePct = (t) => (observations(t) === 0 ? 0 : Math.trunc((t.pass * 100) / observations(t)));
	// RED-CHECK TARGET: the green-threshold comparison (see the red-check
	// record at the bottom of this section).
	const tierGreen = (t, thresholdPct) => observations(t) > 0 && t.pass * 100 >= thresholdPct * observations(t);
	const tallyFor = (tier, tiers) => (tiers.find((t) => t.tier === tier) ?? {}).tally ?? null;
	const rateOf = (tier, tiers) => {
		const t = tallyFor(tier, tiers);
		return t ? passRatePct(t) : 0;
	};
	const dispatchableTiers = (tiers, thresholdPct) => {
		const out = [];
		let remaining = [...tiers];
		while (remaining.length > 0) {
			let best = remaining[0];
			for (const t of remaining) if (t.tier < best.tier) best = t;
			out.push(best.tier);
			if (!tierGreen(best.tally, thresholdPct)) break;
			remaining = remaining.filter((t) => t.tier !== best.tier);
		}
		return out;
	};
	const holdReason = (item, tiers, thresholdPct) => {
		if (tallyFor(item.tier, tiers) === null) return `tier ${item.tier} unmeasured — no tally record, fail-closed (declare measurements first)`;
		let frontier = null;
		for (const t of tiers) {
			if (t.tier <= item.tier && !tierGreen(t.tally, thresholdPct)) {
				if (frontier === null || t.tier < frontier.tier) frontier = t;
			}
		}
		if (frontier) return `tier ${item.tier} held: frontier tier ${frontier.tier} pass-rate ${passRatePct(frontier.tally)}% below ${thresholdPct}% threshold (${frontier.tally.pass}/${observations(frontier.tally)} arms passing)`;
		return `tier ${item.tier} held — outside the declared dispatch radius`;
	};
	const curriculumSchedule = (ready, tiers, thresholdPct) => {
		const allowed = dispatchableTiers(tiers, thresholdPct);
		const held = [];
		let pool = [];
		for (const r of ready) {
			if (allowed.includes(r.tier)) pool.push(r);
			else held.push({ id: r.id, reason: holdReason(r, tiers, thresholdPct) });
		}
		const dispatch = [];
		while (pool.length > 0) {
			let best = null;
			let bestRate = 0;
			for (const r of pool) {
				const rate = rateOf(r.tier, tiers);
				if (best === null || rate < bestRate
					|| (rate === bestRate && r.foundation_rank < best.foundation_rank)
					|| (rate === bestRate && r.foundation_rank === best.foundation_rank && r.id < best.id)) {
					best = r;
					bestRate = rate;
				}
			}
			dispatch.push(best.id);
			pool = pool.filter((r) => r.id !== best.id);
		}
		return { dispatch, held };
	};
	// Fixture campaign: one squad, three tiers of ready work, two
	// measurement windows.
	const ready = [
		{ id: "t#a", tier: 0, foundation_rank: 1 },
		{ id: "t#b", tier: 1, foundation_rank: 0 },
		{ id: "t#c", tier: 2, foundation_rank: 0 },
	];
	const w1 = [
		{ tier: 0, tally: { pass: 9, fail: 1, skip: 0 } }, // 90% green
		{ tier: 1, tally: { pass: 1, fail: 1, skip: 0 } }, // 50% red frontier
		{ tier: 2, tally: { pass: 4, fail: 0, skip: 0 } }, // 100% but gated behind tier 1
	];
	const s1 = curriculumSchedule(ready, w1, 80);
	check(JSON.stringify(s1.dispatch) === '["t#b","t#a"]', `campaign window 1: red frontier holds the radius (${JSON.stringify(s1.dispatch)})`);
	check(s1.held.length === 1 && s1.held[0].id === "t#c" && s1.held[0].reason === "tier 2 held: frontier tier 1 pass-rate 50% below 80% threshold (1/2 arms passing)", `campaign window 1: harder tier held with named reason (${JSON.stringify(s1.held[0]?.reason)})`);
	// Naive dispatch seats the harder tier immediately — the schedule is
	// what holds it back.
	const d = mkfix([
		["t#a.toml", issue("t#a", "easy", "Open", [], "", "ta.ts")],
		["t#b.toml", issue("t#b", "frontier", "Open", [], "", "tb.ts")],
		["t#c.toml", issue("t#c", "hard", "Open", [], "", "tc.ts")],
	]);
	const naive = JSON.parse(run(d, ["dispatch", "--agents", "3", "--json"]).out);
	check(JSON.stringify(naive.slots.map((s) => s.issue.id)) === '["t#a","t#b","t#c"]', `naive pack seats the harder tier (${JSON.stringify(naive.slots.map((s) => s.issue.id))})`);
	const governed = naive.slots.map((s) => s.issue.id).filter((id) => !s1.held.some((h) => h.id === id));
	check(JSON.stringify(governed) === '["t#a","t#b"]', `governed pack holds the harder tier (${JSON.stringify(governed)})`);
	// Window 2: the frontier tier is mastered to exactly the threshold —
	// the radius expands and the harder tier dispatches.
	const w2 = [
		{ tier: 0, tally: { pass: 9, fail: 1, skip: 0 } },
		{ tier: 1, tally: { pass: 4, fail: 1, skip: 0 } }, // exactly 80% — green
		{ tier: 2, tally: { pass: 4, fail: 0, skip: 0 } },
	];
	const s2 = curriculumSchedule(ready, w2, 80);
	check(JSON.stringify(s2.dispatch) === '["t#b","t#a","t#c"]', `campaign window 2: harder tier dispatches once the frontier is green (${JSON.stringify(s2.dispatch)})`);
	check(s2.held.length === 0, `campaign window 2: nothing held`);
	check(JSON.stringify(curriculumSchedule(ready, w2, 80)) === JSON.stringify(s2), `schedule is deterministic on identical inputs`);
	// Fail-closed: an unmeasured tier never dispatches blind (bi#55).
	const s3 = curriculumSchedule([{ id: "t#m", tier: 5, foundation_rank: 0 }], w2, 80);
	check(s3.dispatch.length === 0 && s3.held.length === 1 && s3.held[0].reason.includes("unmeasured"), `unmeasured tier held fail-closed (${JSON.stringify(s3.held[0]?.reason)})`);
	// Red-check 2026-09-07 (bi#57): with the mirror's green-threshold
	// comparison flipped `>=` -> `>` in tierGreen above, the suite failed
	// LOUD with 2 failure(s) FOR THE RIGHT REASON —
	//   FAIL: campaign window 2: harder tier dispatches once the frontier
	//   is green (["t#b","t#a"]) and FAIL: campaign window 2: nothing held
	// — the exactly-80% frontier went red and t#c was held behind it
	// (windows 1/naive checks stayed green: 50% is red under either
	// comparison, so only the boundary discriminates). Restored, green.
	// A threshold comparison that cannot go red at the boundary is
	// camouflage, not coverage.
}

// 16. hub#219 item 1 (hub#186): foundation-first dispatch seating, wired.
// goal.mjs owns the pure derivation (foundationRank/compareFoundation/
// foundationSeatingWarn, imported above); bais/src/cli.ts dispatch
// re-seats the packed slots foundation-rank-first (rank 0 = the declared
// baseline + its precedes-ancestors, the same precedesAncestors set the
// layer-drift audit walks), then blast descending, then lexical id;
// --json carries foundation: 0|1 per slot; every enhancement seated
// while the baseline is unlanded prints the warn-first seating line
// VERBATIM on stderr (and in the --json warnings array). The declared
// baseline is the hub#219 item 6 activation: .bais/sketch.toml
// [[node]] id = "baseline" with issue = "<id>" — without that key the
// pack is byte-identical to the legacy radius-first order (the named
// off state, never an invented baseline).
//
// Fixture graph (radii in parens): t#00 core (1) <-DependsOn- t#01
// baseline (0); t#02 enhancement (1) <-DependsOn- t#03 leaf (0). Naive
// radius-first packs [t#00, t#02, t#01, t#03] — the enhancement t#02
// out-seats the baseline on blast radius. Foundation seating ranks
// {t#00, t#01} first: [t#00, t#01, t#02, t#03].
//
// Red-check 2026-09-08 (bi#57): with rankOf's membership neutered in
// bais/src/cli.ts (`foundationSet.has(id) ? 0 : 1` -> `false ? 0 : 1` —
// src lane, rebuild required), the suite failed LOUD with 3 failure(s)
// FOR THE RIGHT REASON —
//   FAIL: fixture baseline seats before the higher-blast enhancement
//     (["t#00","t#02","t#01","t#03"] — the naive order returned: t#02
//     (br 1) out-seated the baseline t#01 (br 0), the exact
//     issue-number-becomes-priority bug hub#186 killed)
//   FAIL: fixture --json carries foundation ranks ([1,1,1,1])
//   FAIL: landed baseline seats quiet (ranks [1,1,1] vs [0,1,1] — the
//     foundation ancestor t#00 lost its tier)
// while the mirror pins and the undeclared-baseline fixture stayed green
// (all-rank-1 reseats radius-first, byte-equal to naive — that fixture
// discriminates the off state, not the rank rule). Restored, green. A
// seating sort that cannot go red on an out-seated baseline is
// camouflage, not coverage.
{
	// Mirror pins (lockstep with goal.mjs's own selftest): the comparator
	// is the primary sort key, blast desc second, lexical id third.
	const preEdges = [
		{ from: "core", to: "baseline", kind: "precedes" },
		{ from: "tooling", to: "core", kind: "precedes" },
	];
	check(
		foundationRank("baseline", "baseline", preEdges) === 0 &&
			foundationRank("core", "baseline", preEdges) === 0 &&
			foundationRank("tooling", "baseline", preEdges) === 0 &&
			foundationRank("enh", "baseline", preEdges) === 1,
		`mirror: foundationRank 0 for baseline + precedes-ancestors, 1 otherwise`,
	);
	const pack16 = [
		{ id: "enh", blast: 9 },
		{ id: "baseline", blast: 1 },
		{ id: "core", blast: 0 },
		{ id: "enh-a", blast: 9 },
	];
	pack16.sort((a, b) => compareFoundation(a.id, b.id, "baseline", preEdges) || b.blast - a.blast || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	check(
		JSON.stringify(pack16.map((s) => s.id)) === '["baseline","core","enh","enh-a"]',
		`mirror: foundation sort — rank, then blast desc, then id (${JSON.stringify(pack16.map((s) => s.id))})`,
	);
	check(
		foundationSeatingWarn("t#02", "t#01") === "[bais] enhancement t#02 seated before baseline t#01 landed",
		`mirror: seating warn string pinned`,
	);
	// CLI fixture: declared baseline via sketch.toml issue= key.
	const sketchOn = `# .bais/sketch.toml — approved goal sketch (hub#184). Nodes + edges; e2e scaffolds live in .bais/e2e/.
[[node]]
id = "baseline"
title = "walking skeleton"
issue = "t#01"
radius = []

[[node]]
id = "c1"
title = "enhancement layer"
radius = []
`;
	const sketchOff = sketchOn.replace('issue = "t#01"\n', "");
	const files16 = [
		["t#00.toml", issue("t#00", "core", "Open", [], "", "core.ts")],
		["t#01.toml", issue("t#01", "baseline", "Open", [["t#01", "t#00", "DependsOn"]], "", "base.ts")],
		["t#02.toml", issue("t#02", "enhancement", "Open", [], "", "enh.ts")],
		["t#03.toml", issue("t#03", "leaf", "Open", [["t#03", "t#02", "DependsOn"]], "", "leaf.ts")],
	];
	const runH16 = (dir, args) => {
		const r = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
	};
	const dOn = mkfix(files16);
	writeFileSync(join(dOn, ".bais", "sketch.toml"), sketchOn);
	const jOn = JSON.parse(run(dOn, ["dispatch", "--agents", "4", "--json"]).out);
	const seatedIds = jOn.slots.map((s) => s.issue.id);
	check(
		JSON.stringify(seatedIds) === '["t#00","t#01","t#02","t#03"]',
		`fixture baseline seats before the higher-blast enhancement (${JSON.stringify(seatedIds)})`,
	);
	check(
		JSON.stringify(jOn.slots.map((s) => s.foundation)) === "[0,0,1,1]",
		`fixture --json carries foundation ranks (${JSON.stringify(jOn.slots.map((s) => s.foundation))})`,
	);
	const wantWarns = [foundationSeatingWarn("t#02", "t#01"), foundationSeatingWarn("t#03", "t#01")];
	check(
		wantWarns.every((w) => jOn.warnings.includes(w)),
		`fixture --json warnings carry the seating lines verbatim (${JSON.stringify(jOn.warnings)})`,
	);
	const hOn = runH16(dOn, ["dispatch", "--agents", "4"]);
	check(
		hOn.code === 0 && wantWarns.every((w) => hOn.err.split("\n").includes(w)),
		`fixture human mode prints the seating lines verbatim on stderr`,
	);
	// The baseline landed (Done): enhancements seat silent (nothing warns
	// about building on a landed foundation).
	run(dOn, ["move", "t#01", "Doing", "--as", "demo-219", "--for", "2h"]);
	const dLanded = mkfix(files16.map(([n, c]) => [n, n === "t#01.toml" ? c.replace('status = "Open"', 'status = "Done"') : c]));
	writeFileSync(join(dLanded, ".bais", "sketch.toml"), sketchOn);
	const jLanded = JSON.parse(run(dLanded, ["dispatch", "--agents", "4", "--json"]).out);
	check(
		jLanded.warnings.length === 0 && JSON.stringify(jLanded.slots.map((s) => s.foundation)) === "[0,1,1]",
		`landed baseline seats quiet (${JSON.stringify(jLanded.slots.map((s) => s.issue.id))})`,
	);
	// Undeclared baseline (no issue= key): the named off state — naive
	// radius-first order, no foundation key, no seating warns.
	const dOff = mkfix(files16);
	writeFileSync(join(dOff, ".bais", "sketch.toml"), sketchOff);
	const jOff = JSON.parse(run(dOff, ["dispatch", "--agents", "4", "--json"]).out);
	check(
		JSON.stringify(jOff.slots.map((s) => s.issue.id)) === '["t#00","t#02","t#01","t#03"]' &&
			jOff.slots.every((s) => s.foundation === undefined) &&
			jOff.warnings.length === 0,
		`fixture undeclared baseline stays byte-legacy (${JSON.stringify(jOff.slots.map((s) => s.issue.id))})`,
	);
}

// 17. hub#223: epics leave the ready set and dispatch withholds them with
// a named reason (BAML-first: is_epic consults in ready_issues +
// dispatch_epic_withheld/epic_hold_reason in bais/baml_src/main.baml;
// host mirror: readyIssues/dispatchPack/epicWithheldIn/warnEpicWithheld in
// bais/src/graph.ts). An epic in a work queue is a mistargeted agent — the
// Doing-claim gate caught it late (at claim time) instead of never offering
// it. Fixtures use the live derived-epic ids (bi#189 + children bi#192,
// bi#193) so the shape matches the real board, plus a bi#26-style second
// epic for the plural lane.
//
// Red-check 2026-09-08 (bi#57, observed live): with the host exclusion
// neutered (the `&& !isEpic(f.issue.id, edges)` conjunct of readyIssues in
// bais/src/graph.ts dropped + rebuild), the suite failed LOUD with 7
// failure(s) FOR THE RIGHT REASON —
//   FAIL: epic leaves the pack, leaves seat (["bi#189","bi#192","bi#193","bi#99"])
//   FAIL: epic holds no slot
//   FAIL: withheld epic counts unfilled (0)
//   FAIL: epic leaves ready, children stay (["bi#189","bi#192","bi#193","bi#99"])
//   FAIL: pure readyIssues drops the epic (["bi#189","bi#192","bi#193","bi#99"])
//   FAIL: pure dispatchPack seats leaves only (["bi#189","bi#192","bi#193","bi#99"])
//   FAIL: live pack never seats an Open epic (["bi#26","bi#119","bi#189","bi#192"])
// — the epic seats slot0 everywhere (bi#26 holds the live slot0 again, the
// hub#223 bug reproduced). Restored cmp-identical, rebuilt, green. The
// BAML-side twin: neutering `&& !is_epic(issue, edges)` in ready_issues
// fails exactly the 3 hub#223 baml tests (`ready excludes epics but keeps
// their children`: left = 3, right = 2, and the two dispatch twins off by
// one) — restored cmp-identical. An epic exclusion that cannot go red on a
// seated epic is camouflage, not coverage.
//
// FOLLOW-UPS (out of lane, recorded in hub#223 handoff): the bi host mirror
// (bi/src/bais.ts filterReadyIssues/dispatchPack) still seats epics; the
// store projection (bais/src/store.ts storeReady) still lists them, so
// cross-check §3 goes red on Open epics until that lane lands; the raw
// dispatch --json/--human CLI names no epic warning line (cli.ts untouched
// — warnEpicWithheld waits for its call site).
{
	const graph = await import("../dist/src/graph.js");
	const epicFix = [
		["bi#189.toml", issue("bi#189", "epic", "Open", [], "", "epic.ts")],
		["bi#192.toml", issue("bi#192", "child one", "Open", [["bi#192", "bi#189", "SubtaskOf"]], "", "c192.ts")],
		["bi#193.toml", issue("bi#193", "child two", "Open", [["bi#193", "bi#189", "SubtaskOf"]], "", "c193.ts")],
		["bi#99.toml", issue("bi#99", "lone", "Open", [], "", "lone.ts")],
	];
	const dE = mkfix(epicFix);
	const runH17 = (dir, args) => {
		const r = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
		return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
	};
	const jE = JSON.parse(run(dE, ["dispatch", "--agents", "4", "--json"]).out);
	const slotIds = jE.slots.map((s) => s.issue.id);
	check(jE.slots.length === 3 && JSON.stringify(slotIds) === '["bi#192","bi#193","bi#99"]', `epic leaves the pack, leaves seat (${JSON.stringify(slotIds)})`);
	check(!slotIds.includes("bi#189"), `epic holds no slot`);
	check(jE.unfilled === 1, `withheld epic counts unfilled (${jE.unfilled})`);
	const hE = runH17(dE, ["dispatch", "--agents", "4"]);
	check(hE.code === 0, `epic pack human mode exits 0 (valid work)`);
	const rE = JSON.parse(run(dE, ["ready", "--json"]).out).ready.map((f) => f.issue.id);
	check(!rE.includes("bi#189") && rE.includes("bi#192") && rE.includes("bi#193"), `epic leaves ready, children stay (${JSON.stringify(rE)})`);
	// Pure-mirror pins against dist (same lockstep as mirror-parity.mjs).
	// Bodies carry Files: lines (declared footprints): bare bodies read as
	// unknown and the hub#175 lane would keep only the first — that lane is
	// §13/§14 territory, not this section's.
	const F = (id, status, edges = [], file = `${id.replace("#", "")}.ts`) => ({ issue: { id, title: id, status, kind: "Feat", area: null, severity: null, source: null, body: `work\nFiles: ${file}\n` }, edges: edges.map((e) => ({ from: e[0], to: e[1], kind: e[2] })), holder: null, lease: null });
	const sub = [["bi#192", "bi#189", "SubtaskOf"], ["bi#193", "bi#189", "SubtaskOf"]];
	const pureAll = [F("bi#189", "Open"), F("bi#192", "Open", [sub[0]]), F("bi#193", "Open", [sub[1]]), F("bi#99", "Open")];
	const pureFp = new Map(pureAll.map((f) => [f.issue.id, graph.parseFileClaims(f.issue.body)]));
	check(graph.isEpic("bi#189", pureAll.flatMap((f) => f.edges)) === true && graph.isEpic("bi#192", pureAll.flatMap((f) => f.edges)) === false, `pure isEpic derives the epic, not the child`);
	check(JSON.stringify(graph.readyIssues(pureAll).map((f) => f.issue.id)) === '["bi#192","bi#193","bi#99"]', `pure readyIssues drops the epic (${JSON.stringify(graph.readyIssues(pureAll).map((f) => f.issue.id))})`);
	check(JSON.stringify(graph.dispatchPack(pureAll, [], pureFp, 4).map((s) => s.issue_id)) === '["bi#192","bi#193","bi#99"]', `pure dispatchPack seats leaves only (${JSON.stringify(graph.dispatchPack(pureAll, [], pureFp, 4).map((s) => s.issue_id))})`);
	const held = graph.epicWithheldIn(pureAll, []);
	check(held.length === 1 && held[0].issue_id === "bi#189" && held[0].reason === "epic" && JSON.stringify(held[0].children) === '["bi#192","bi#193"]', `pure withheld names the epic, its children, its reason (${JSON.stringify(held)})`);
	check(graph.warnEpicWithheld(["bi#189"]) === "[bais] epic withheld from swipe pack: bi#189 (coordinates subtasks from outside the pack — claim a child instead per hub#223)", `epic warn format exact`);
	check(graph.warnEpicWithheld(["bi#189", "bi#26"]) === "[bais] epics withheld from swipe pack: bi#189, bi#26 (coordinates subtasks from outside the pack — claim a child instead per hub#223)", `epic warn plural format exact`);
	// Blocked/leased epics are out for those reasons, never double-counted.
	const mixed = [
		F("bi#189", "Open"),
		F("bi#192", "Open", [sub[0]]),
		F("bi#26", "Open", [["bi#01", "bi#26", "Blocks"], ["bi#27", "bi#26", "SubtaskOf"]]),
		F("bi#01", "Open"),
	];
	check(JSON.stringify(graph.epicWithheldIn(mixed, []).map((h) => h.issue_id)) === '["bi#189"]', `blocked epic not double-counted as withheld`);
	check(JSON.stringify(graph.epicWithheldIn(mixed, ["bi#189"]).map((h) => h.issue_id)) === '[]', `leased epic not double-counted as withheld`);
	// Live hub structural (no pins — robust to backlog evolution): no slot
	// seats an Open epic. bi#26 + bi#189 are Open epics today; if either
	// closes the check still holds (a Done issue never dispatches).
	const live = JSON.parse(run("/Users/adrian/code/orion/orion-learn-baml", ["dispatch", "--agents", "4", "--json"]).out);
	const liveSlots = live.slots.map((s) => s.issue.id);
	check(!liveSlots.includes("bi#26") && !liveSlots.includes("bi#189"), `live pack never seats an Open epic (${JSON.stringify(liveSlots)})`);
}

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("dispatch: all green");
