// bais/scripts/pack-review.mjs — bi#140: batch-receive reviewer (scripts lane).
//
// A reviewer role consuming an equal-priority campaign pack as ONE unit —
// whole-pack diff review + whole-pack suite run + a SINGLE pack verdict —
// instead of folding per issue. The merger spends one reviewer over a full
// pack rather than N per-issue folds; the verdict feeds the campaign loop
// (bi#137: PASS releases the pack and authorizes refill, FAIL blocks it).
//
// Grounding (ground-first skill: observation precedes inference):
// - Consumes dispatch packs read-only: slot shape is the live
//   `dispatch --agents N --json` contract (observed 2026-09-06:
//   {slot, issue: {id, title}, open_downstream, files, files_state} plus
//   top-level {slots, leased, budget, unfilled, unparseable}). This file
//   never imports dispatch.mjs/briefs.mjs (read-only consumption = same
//   JSON shape, not code sharing) and never writes to the issues dir.
// - Reviewer-verdict shape anticipates bi#59 (fresh-context reviewer:
//   brief template, report format, revert-hunk red-check, /tmp-confirmed
//   handoff). bi#59 names no verdict JSON, so this shape commits to one:
//   a single ref naming every member, per-member findings, the red-check
//   note, and the handoff path — the bi#59 report format can adopt it
//   verbatim when the role lane lands.
//
// Verdict shape (anticipates bi#59):
//   { ref, pack, verdict: "PASS"|"FAIL", members: [ids...],
//     failed: [ids...], reasons: [...], releases: bool, report }
// - ref is the ONE verdict ref for the pack: `verdict-<pack>`.
// - members names EVERY member, PASS or FAIL (never a silent subset).
// - FAIL is loud: formatVerdict names each red item id + reason.
// - releases feeds bi#137: true (pack released, refill authorized) only
//   on PASS; false blocks refill while the pack is held.
//
// Review rules (whole-pack, deterministic, no LLM):
// - item: per-member check result ("pass" reds the pack otherwise).
// - diff: every member must carry a non-empty diff under review —
//   the load-bearing hunk (bi#57 red-check target below).
// - suite: the whole-pack suite run ("pass") — a green-items pack with
//   a red suite still FAILS as a unit.
//
// CLI/MERGER WIRING — explicitly OUT of this lane (needs bais/src/cli.ts
// + merger, both outside this footprint): `bais pack-review --pack <file>
// [--json]` calling reviewFile(); exit 0 PASS / 1 FAIL / 2 usage; the
// merger maps verdict.releases onto the bi#137 refill signal (released
// pack authorizes the next pack). Until then the operator runs:
// node bais/scripts/pack-review.mjs --pack <pack.json> [--json]
//
// Red-check 2026-09-06 (bi#57): with the diff-emptiness guard of
// reviewMember neutered (empty diff scored ok), §4's empty-diff pack
// failed LOUD as `FAIL: empty diff reds the pack naming the item`;
// restored, green.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Load-bearing hunk (bi#140/bi#57 red-check target): the diff-emptiness
// guard. Neutering `diff.trim() !== ""` to always-ok must trip §4 with
// "empty diff reds the pack naming the item".
export function reviewMember(m) {
	const id = String(m?.id ?? "(missing id)");
	const reasons = [];
	if (m?.item !== "pass") reasons.push(`item ${id} red (item=${JSON.stringify(m?.item ?? null)})`);
	if (typeof m?.diff !== "string" || m.diff.trim() === "") reasons.push(`item ${id} has no diff under review`);
	return { id, ok: reasons.length === 0, reasons };
}

export function reviewPack(pack) {
	const name = String(pack?.pack ?? "(missing pack)");
	const slots = Array.isArray(pack?.slots) ? pack.slots : [];
	const members = slots.map((s) => String(s?.id ?? "(missing id)"));
	const per = slots.map(reviewMember);
	const reasons = per.flatMap((r) => r.reasons);
	if (pack?.suite !== "pass") reasons.push(`whole-pack suite red (suite=${JSON.stringify(pack?.suite ?? null)})`);
	const verdict = reasons.length === 0 && slots.length > 0 ? "PASS" : "FAIL";
	if (slots.length === 0) reasons.push(`pack ${name} holds no members (nothing reviewed)`);
	const failed = per.filter((r) => !r.ok).map((r) => r.id);
	const ref = `verdict-${name}`;
	const lines = [
		`pack verdict ${ref}: ${verdict} ${name} [${members.join(" ")}]`,
		...per.map((r) => `  member ${r.id}: ${r.ok ? "ok" : "RED — " + r.reasons.join("; ")}`),
		`  suite: ${pack?.suite ?? null}`,
		`  releases: ${verdict === "PASS" ? "yes (bi#137 refill authorized)" : "no (pack held)"}`,
	];
	return { ref, pack: name, verdict, members, failed, reasons, releases: verdict === "PASS", report: lines.join("\n") };
}

// Single verdict line: PASS names every member; FAIL is loud — names the
// red item(s) AND every member (no silent subset either way).
export function formatVerdict(v) {
	const all = `[${v.members.join(" ")}]`;
	if (v.verdict === "PASS") return `pack-verdict ${v.ref}: PASS ${v.pack} ${all}`;
	return `pack-verdict ${v.ref}: FAIL ${v.pack} — red ${v.failed.length ? v.failed.join(", ") : "pack"}: ${v.reasons.join("; ")}; members ${all}`;
}

export function reviewFile(path) {
	const raw = readFileSync(resolve(path), "utf8");
	return reviewPack(JSON.parse(raw));
}

const optValue = (argv, name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest") || argv.length === 0) {
		let failures = 0;
		const check = (cond, msg) => {
			if (!cond) {
				failures++;
				console.error(`FAIL: ${msg}`);
			} else console.log(`ok: ${msg}`);
		};
		const fix = (n) => join(HERE, "fixtures", "pack-review", n);
		// 1. Green pack yields exactly one verdict ref, PASS, every member named.
		{
			const v = reviewFile(fix("green-pack.json"));
			check(v.verdict === "PASS", `green pack passes (${v.verdict})`);
			check(v.ref === "verdict-t-green", `one verdict ref (${v.ref})`);
			check(JSON.stringify(v.members) === '["t#01","t#02","t#03"]', `verdict names every member (${JSON.stringify(v.members)})`);
			check(v.releases === true, `PASS releases the pack for refill`);
			check(v.failed.length === 0 && v.reasons.length === 0, `no failures or reasons on green`);
		}
		// 2. One red item FAILS the whole pack, loud, naming the item.
		{
			const v = reviewFile(fix("red-item-pack.json"));
			const line = formatVerdict(v);
			check(v.verdict === "FAIL", `red-item pack fails (${v.verdict})`);
			check(JSON.stringify(v.failed) === '["t#02"]', `failed names the red item (${JSON.stringify(v.failed)})`);
			check(line.includes("t#02") && /FAIL/.test(line), `verdict line loud with item id (${JSON.stringify(line)})`);
			check(v.members.length === 3 && line.includes("t#01") && line.includes("t#03"), `FAIL verdict still names every member`);
			check(v.releases === false, `FAIL holds the pack (no refill)`);
		}
		// 3. Green items + red whole-pack suite FAILS as a unit, naming the suite.
		{
			const v = reviewFile(fix("red-suite-pack.json"));
			check(v.verdict === "FAIL" && v.failed.length === 0, `suite-red pack fails with no red item (${v.verdict})`);
			check(v.reasons.some((r) => r.includes("suite")), `reason names the suite (${JSON.stringify(v.reasons)})`);
		}
		// 4. A member with no diff under review reds the pack, naming the item.
		{
			const v = reviewPack({ pack: "t-nodiff", suite: "pass", slots: [{ id: "t#09", item: "pass", diff: "  \n" }] });
			check(v.verdict === "FAIL" && JSON.stringify(v.failed) === '["t#09"]', `empty diff reds the pack naming the item (${JSON.stringify(v.failed)})`);
		}
		// 5. Usage errors: missing file and malformed pack are refused, never green.
		{
			let refused = 0;
			try {
				reviewFile(fix("no-such-pack.json"));
			} catch {
				refused++;
			}
			const empty = reviewPack({ pack: "t-empty", suite: "pass", slots: [] });
			check(refused === 1, `missing pack file refused`);
			check(empty.verdict === "FAIL" && empty.reasons.some((r) => r.includes("no members")), `memberless pack fails, never silent-green`);
		}
		if (failures) {
			console.error(`${failures} failure(s)`);
			process.exit(1);
		}
		console.log("pack-review: all green");
	} else {
		const file = optValue(argv, "--pack");
		if (!file) {
			console.error("pack-review needs --pack <pack.json>");
			process.exit(2);
		}
		let v;
		try {
			v = reviewFile(file);
		} catch (e) {
			console.error(`pack-review refused: ${e.message}`);
			process.exit(2);
		}
		if (argv.includes("--json")) console.log(JSON.stringify(v, null, 2));
		else console.log(v.report + "\n" + formatVerdict(v));
		process.exit(v.verdict === "PASS" ? 0 : 1);
	}
}
