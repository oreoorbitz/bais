// curriculum.baml — hub#217: curriculum scheduling (Learning-with-
// Challenges, arXiv:2601.22781): match dispatch difficulty to MEASURED
// capability. Pure scheduling policy over plain data — the host measures
// arm pass-rates (BITS SuiteTally, bits/baml_src/main.baml) and readiness
// (ready_issues, main.baml); this file owns the rule:
//
//   1. Tiers are difficulty levels (int, lower = easier; BITS T0..T3 /
//      tiers.json "t0".."t2" map 0..n). A tier is GREEN when its measured
//      pass-rate meets the threshold:
//      pass*100 >= threshold_pct*(pass+fail), with at least one observation
//      — skips never count, and an unmeasured tier is never green
//      (fail-closed with a named reason, bi#55).
//   2. The dispatch radius covers tiers from the easiest up to AND
//      INCLUDING the first non-green tier: the frontier tier is where
//      capability is being built, so its work dispatches, while harder
//      tiers are HELD with a named reason until the frontier goes green.
//      The radius expands only when the current tier is green.
//   3. Within the radius, ready issues order by their tier's measured
//      pass-rate ASCENDING (weakest tier first — the capability frontier
//      gets the agents), tie-break foundation_rank (hub#186: baselines
//      before enhancements), then id ascending (full determinism, same as
//      dispatch_pack).
//
// SuiteTally is redeclared here as plain data: bits/ is a separate BAML
// project and BAML has no cross-project imports, so the shape mirrors
// bits' SuiteTally field-for-field and hosts pass tallies straight
// through. Composes with hub#186: foundation_rank rides ReadyItem as
// precomputed plain data (the same clocks/policy split as dispatch_pack —
// the host owns graph walks and measurement, BAML owns the rule).

class SuiteTally {
    pass: int,
    fail: int,
    skip: int,
}

class TierTally {
    tier: int @description("difficulty level, lower = easier (BITS T0..T3 -> 0..3)"),
    tally: SuiteTally,
}

class ReadyItem {
    id: string,
    tier: int,
    foundation_rank: int @description("hub#186: 0 = baseline or precedes-ancestor, 1 = enhancement"),
}

class HeldItem {
    id: string,
    reason: string,
}

class CurriculumSchedule {
    dispatch: string[],
    held: HeldItem[],
}

// Skips are not observations — a skipped arm measured nothing.
function observations(t: SuiteTally) -> int {
    t.pass + t.fail
}

// Truncating int percent (int/int truncates); 0 when unmeasured. Only used
// for ordering and reason strings — the green comparison below cross-
// multiplies so the threshold itself never loses precision to truncation.
function pass_rate_pct(t: SuiteTally) -> int {
    if (observations(t) == 0) {
        0
    } else {
        t.pass * 100 / observations(t)
    }
}

// THE green-threshold comparison (red-check target, bi#57 — see header of
// curriculum_test.baml). Cross-multiplied integer form of
// pass/(pass+fail) >= threshold_pct/100; unmeasured is never green.
function tier_green(t: SuiteTally, threshold_pct: int) -> bool {
    observations(t) > 0 && t.pass * 100 >= threshold_pct * observations(t)
}

function tally_for(tier: int, tiers: TierTally[]) -> SuiteTally? {
    for (let t in tiers) {
        if (t.tier == tier) {
            return t.tally;
        }
    }
    null
}

function rate_of(tier: int, tiers: TierTally[]) -> int {
    if let t: SuiteTally = tally_for(tier, tiers) {
        pass_rate_pct(t)
    } else {
        0
    }
}

// Dispatchable tier levels, easiest first, up to AND INCLUDING the first
// non-green tier. The radius expands past a tier only when that tier is
// green; a green tier behind a red frontier does NOT dispatch (difficulty
// unlocks in order, never by skipping ahead).
function dispatchable_tiers(tiers: TierTally[], threshold_pct: int) -> int[] {
    let out: int[] = [];
    let remaining = tiers;
    while (remaining.length() > 0) {
        let best: TierTally? = null;
        for (let t in remaining) {
            if let b: TierTally = best {
                if (t.tier < b.tier) {
                    best = t;
                }
            } else {
                best = t;
            }
        }
        if let b: TierTally = best {
            out.push(b.tier);
            if (!tier_green(b.tally, threshold_pct)) {
                break;
            }
            let bt = b.tier;
            remaining
                = remaining.filter((t) -> {
                    t.tier != bt
                });
        }
    }
    out
}

// Every hold names its reason (bi#55 — no fail-closed without one):
// unmeasured tiers say so, gated tiers name the red frontier tier and its
// measured rate.
function hold_reason(item: ReadyItem, tiers: TierTally[], threshold_pct: int) -> string {
    if (tally_for(item.tier, tiers) == null) {
        return `tier ${item.tier} unmeasured — no tally record, fail-closed (declare measurements first)`;
    }
    let frontier: TierTally? = null;
    for (let t in tiers) {
        if (t.tier <= item.tier && !tier_green(t.tally, threshold_pct)) {
            if let f: TierTally = frontier {
                if (t.tier < f.tier) {
                    frontier = t;
                }
            } else {
                frontier = t;
            }
        }
    }
    if let f: TierTally = frontier {
        `tier ${item.tier} held: frontier tier ${f.tier} pass-rate ${pass_rate_pct(f.tally)}% below ${threshold_pct}% threshold (${f.tally.pass}/${observations(f.tally)} arms passing)`
    } else {
        `tier ${item.tier} held — outside the declared dispatch radius`
    }
}

// The scheduling rule itself. Pure: same inputs, same schedule, always.
function curriculum_schedule(
    ready: ReadyItem[],
    tiers: TierTally[],
    threshold_pct: int,
) -> CurriculumSchedule {
    let allowed = dispatchable_tiers(tiers, threshold_pct);
    let pool: ReadyItem[] = [];
    let held: HeldItem[] = [];
    for (let r in ready) {
        if (allowed.includes(r.tier)) {
            pool.push(r);
        } else {
            held.push(HeldItem { id: r.id, reason: hold_reason(r, tiers, threshold_pct) });
        }
    }
    // Greedy best-first (dispatch_pack idiom): weakest measured pass-rate
    // first, foundation_rank fallback on ties, id ascending after that.
    let dispatch: string[] = [];
    while (pool.length() > 0) {
        let best: ReadyItem? = null;
        let best_rate = 0;
        for (let r in pool) {
            let rate = rate_of(r.tier, tiers);
            if let b: ReadyItem = best {
                if (
                    rate < best_rate
                        || (rate == best_rate && r.foundation_rank < b.foundation_rank)
                        || (
                            rate == best_rate
                                && r.foundation_rank == b.foundation_rank
                                && r.id < b.id
                        )
                ) {
                    best = r;
                    best_rate = rate;
                }
            } else {
                best = r;
                best_rate = rate;
            }
        }
        if let b: ReadyItem = best {
            dispatch.push(b.id);
            let bid = b.id;
            pool
                = pool.filter((r) -> {
                    r.id != bid
                });
        }
    }
    CurriculumSchedule { dispatch: dispatch, held: held }
}
