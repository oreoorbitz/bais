// bais/scripts/clock.mjs — injectable drill wall-clock (bi#82).
//
// Drills mix fixed timestamps with live `new Date()` / `Date.now()`
// (fixture defaults, the clock-skew future bound, freeze/expiry windows).
// Every live read is a rot vector: boundaries drift as the calendar
// advances and a slow runner can flake a timing edge nobody can reproduce.
//
// Scripts take `--now <ISO-8601|epoch-ms>` (or env BAIS_NOW) fixing the
// in-process wall clock for BOTH fixture timestamps and gate evaluations:
//   - fixtures: use clock.nowISO() instead of `new Date().toISOString()`.
//   - gates: installClock() pins global Date.now AND no-arg `new Date()`,
//     so dist hub gates (checkClock future bound, freeze windows, evidence
//     stamps) see the pinned time without rebuilding dist.
// Live mode (--now absent): passthrough, zero behavior change.
//
// Fully in-process, no sockets. Safe to import from any drill script.

const RealDate = Date;

const parseNow = (v) => {
	const s = String(v).trim();
	if (/^-?\d+$/.test(s)) {
		const ms = Number(s);
		if (!Number.isFinite(ms)) throw new Error(`bad --now: ${v}`);
		return ms;
	}
	const ms = RealDate.parse(s);
	if (Number.isNaN(ms)) throw new Error(`bad --now (need ISO-8601 or epoch-ms): ${v}`);
	return ms;
};

// Resolve a pinned epoch-ms from argv/env. CLI flag wins over env.
// Accepts `--now <v>` and `--now=<v>`. Returns number|null (null = live).
export const resolvePinnedMs = (argv = process.argv, env = process.env) => {
	let flag = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--now" && i + 1 < argv.length) { flag = argv[i + 1]; i++; }
		else if (a.startsWith("--now=")) flag = a.slice("--now=".length);
	}
	const raw = flag ?? env?.BAIS_NOW ?? null;
	if (raw === null || raw === undefined || String(raw).trim() === "") return null;
	return parseNow(raw);
};

export const createClock = (pinnedMs) => {
	const fixed = pinnedMs !== null && pinnedMs !== undefined;
	return {
		fixed,
		pinnedMs: fixed ? pinnedMs : null,
		nowMs: () => (fixed ? pinnedMs : RealDate.now()),
		nowISO: () => new RealDate(fixed ? pinnedMs : RealDate.now()).toISOString(),
		// Absolute ISO for a millisecond epoch (boundary probes).
		isoAt: (ms) => new RealDate(ms).toISOString(),
	};
};

// Pin the in-process wall clock. Patches globalThis.Date so BOTH
// Date.now() and no-arg new Date() return the pinned time; explicit-arg
// constructions (new Date(ms), Date.parse) pass through untouched.
// Returns a restore function. No-op (noop restore) when not fixed.
export const installClock = (clock) => {
	if (!clock.fixed) return () => {};
	const fixedMs = clock.pinnedMs;
	class PinnedDate extends RealDate {
		constructor(...args) {
			super(...(args.length === 0 ? [fixedMs] : args));
		}
		static now() {
			return fixedMs;
		}
	}
	globalThis.Date = PinnedDate;
	return () => {
		if (globalThis.Date === PinnedDate) globalThis.Date = RealDate;
	};
};

// Convenience: resolve + create + install from argv/env in one call.
// Returns { clock, restore }.
export const clockFromArgv = (argv = process.argv, env = process.env) => {
	const clock = createClock(resolvePinnedMs(argv, env));
	return { clock, restore: installClock(clock) };
};
