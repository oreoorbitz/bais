// bais/scripts/tiers.mjs — bi#81 BITS tier runner with time budgets.
// Usage: node scripts/tiers.mjs t0 t1   (npm test)
//        node scripts/tiers.mjs t0       (npm run test:t0)
//        node scripts/tiers.mjs t1       (npm run test:t1)
//        node scripts/tiers.mjs selftest (offline gate check, no children)
// Runs the tiers.json members for the requested tiers in manifest order
// (== the legacy npm-test chain order), times each script, prints a
// per-script + per-tier budget report. Over-budget = FAIL, not drift: a
// script exceeding its budget_s (or killed at its timeout) fails the run,
// and a fully-run tier exceeding its tier budget fails the run.
// Exits non-zero on any script failure or over-budget verdict.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BAIS = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(BAIS, "tiers.json"), "utf8"));

// Load-bearing hunk (bi#81 red-check target): the over-budget verdict.
// Reverting this to always-ok must trip `selftest` with
// "expected over-budget verdict".
export function judgeElapsed(elapsedMs, budgetS) {
  return elapsedMs > budgetS * 1000 ? "over-budget" : "ok";
}

const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;

if (process.argv[2] === "selftest") {
  let failures = 0;
  const check = (cond, msg) => {
    if (!cond) { failures++; console.error(`FAIL selftest: ${msg}`); }
    else console.log(`ok selftest: ${msg}`);
  };
  // The gate fires: 5s elapsed against a 1s budget is over-budget.
  check(judgeElapsed(5000, 1) === "over-budget",
    "expected over-budget verdict for 5000ms > 1s budget, got " + judgeElapsed(5000, 1));
  // The gate is quiet under budget (boundary: exactly at budget is ok).
  check(judgeElapsed(1000, 1) === "ok", "1000ms against 1s budget is ok");
  check(judgeElapsed(0, 1) === "ok", "0ms against 1s budget is ok");
  // Manifest covers the current chain exactly once, in legacy order
  // (contract-test is bi#84-new, pinned here like the rest).
  const legacy = ["lease-race", "sync-test", "mcp-test", "reducer-determinism",
    "cross-check", "ingest-durability", "move-unblocked", "ready-wait",
    "content-ids", "contract-test", "fault-drills"];
  const names = manifest.scripts.map((s) => s.name);
  check(JSON.stringify(names) === JSON.stringify(legacy),
    `manifest preserves the legacy chain order (${names.join(",")})`);
  check(new Set(names).size === names.length, "each script mapped exactly once");
  check(names.every((n) => ["t0", "t1"].includes(manifest.scripts.find((s) => s.name === n).tier)),
    "every npm-test script is T0 or T1 (T2 never in default gates)");
  for (const s of manifest.scripts) {
    check(typeof s.budget_s === "number" && s.budget_s > 0, `${s.name} has a positive budget (${s.budget_s})`);
  }
  console.log(failures === 0 ? "tiers selftest: all green" : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

const want = new Set(process.argv.slice(2));
if (want.size === 0 || [...want].some((t) => !["t0", "t1"].includes(t))) {
  console.error("usage: node scripts/tiers.mjs t0 t1 | t0 | t1 | selftest");
  process.exit(2);
}

const selected = manifest.scripts.filter((s) => want.has(s.tier));
let failed = 0;
const totals = {};
for (const s of selected) {
  const t0 = Date.now();
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
    cwd: BAIS, stdio: "inherit", timeout: s.budget_s * 1000,
  });
  const elapsed = Date.now() - t0;
  totals[s.tier] = (totals[s.tier] ?? 0) + elapsed;
  const verdict = r.error?.code === "ETIMEDOUT" ? "over-budget" : judgeElapsed(elapsed, s.budget_s);
  const pass = r.status === 0 && verdict === "ok";
  if (!pass) failed++;
  const why = r.error?.code === "ETIMEDOUT" ? " (timeout kill)"
    : verdict === "over-budget" ? " (OVER BUDGET)"
    : r.status !== 0 ? ` (exit ${r.status})` : "";
  console.log(`[tier ${s.tier}] ${s.name} ..... ${fmtS(elapsed)} / ${s.budget_s}s ${pass ? "ok" : "FAIL" + why}`);
}

// Per-tier budget report; a tier budget is enforced iff all its scripts ran.
for (const t of want) {
  const members = manifest.scripts.filter((s) => s.tier === t);
  const ran = selected.filter((s) => s.tier === t).length;
  const total = totals[t] ?? 0;
  const budget = manifest.tiers[t].budget_s;
  if (ran === members.length) {
    const verdict = judgeElapsed(total, budget);
    if (verdict !== "ok") {
      failed++;
      console.log(`[tier ${t}] total ..... ${fmtS(total)} / ${budget}s FAIL (OVER BUDGET)`);
    } else {
      console.log(`[tier ${t}] total ..... ${fmtS(total)} / ${budget}s ok — within budget`);
    }
  }
}

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log(`tiers [${[...want].join("+")}]: all green`);
