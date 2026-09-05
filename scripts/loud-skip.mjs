// bais/scripts/loud-skip.mjs — bi#81 loud-skip helper for T2 offline runs.
// A skip is a named SKIP line, never a silent pass. The skip path performs
// zero assertions and the T2 runner exits zero.
export function loudSkip(name, reason) {
  console.log(`SKIP [t2] ${name}: ${reason}`);
}
