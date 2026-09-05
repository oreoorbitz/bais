// bais/scripts/test-t2.mjs — bi#81 T2 runner. T2 = live-key / external,
// never in default gates. Offline (no BAIS_T2_LIVE=1 + BAIS_LIVE_KEY) every
// member skips LOUDLY: one named SKIP line per test, zero assertions,
// exit zero. Run: node scripts/test-t2.mjs (offline, plain node).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loudSkip } from "./loud-skip.mjs";

const BAIS = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(BAIS, "tiers.json"), "utf8"));
const members = manifest.t2_placeholders ?? [];

const live = process.env.BAIS_T2_LIVE === "1" && !!process.env.BAIS_LIVE_KEY;
let checks = 0; // assertions executed on this run (must stay 0 offline)

if (!live) {
  const why = !process.env.BAIS_LIVE_KEY
    ? "offline (no BAIS_LIVE_KEY) — asserts nothing"
    : "offline (BAIS_T2_LIVE!=1) — asserts nothing";
  for (const m of members) loudSkip(m.name, why);
  console.log(`t2: ${members.length} skipped, ${checks} asserted — exit 0`);
  process.exit(0);
}

// Live path: no silent pass either — members run here once they exist.
console.log(`t2: live mode, ${members.length} member(s) configured, ${checks} asserted so far`);
process.exit(0);
