// Probe bi#45: ready --wait blocks, wakes on store touch, timeout exits 0 empty.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = "/Users/adrian/code/orion/orion-learn-baml/bais/dist/src/cli.js";
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const issue = (id, title, status, edges = []) => {
	const es = edges.map((e) => `[[edge]]\nfrom = "${e[0]}"\nto = "${e[1]}"\nkind = "${e[2]}"\n`).join("\n");
	return `id = "${id}"\ntitle = "${title}"\nstatus = "${status}"\nkind = "Feat"\nbody = "b"\n\n${es}`;
};
const mkfix = (withStore) => {
	const d = mkdtempSync(join(tmpdir(), "probe45-"));
	mkdirSync(join(d, ".bais", "issues"), { recursive: true });
	writeFileSync(join(d, ".bais", "config.toml"), 'project = "t"\n');
	const is = join(d, ".bais", "issues");
	writeFileSync(join(is, "t#01.toml"), issue("t#01", "blocker", "Doing"));
	writeFileSync(join(is, "t#02.toml"), issue("t#02", "downstream work", "Open", [["t#01", "t#02", "Blocks"]]));
	if (withStore) execFileSync("node", [CLI, "ingest"], { cwd: d, timeout: 60000 });
	return d;
};
const waitForExit = (child) => new Promise((res) => {
	let out = "";
	child.stdout.on("data", (c) => { out += c; });
	child.stderr.on("data", (c) => { out += c; });
	child.on("close", (code) => res({ code, out }));
});
const alive = (child) => child.exitCode === null && child.signalCode === null;
const freeBlocker = (d) => execFileSync("node", [CLI, "move", "t#01", "Done"], { cwd: d, timeout: 60000, encoding: "utf8" });

// --- store path: waiter sleeps, wakes exactly once with fresh set ---
{
	const d = mkfix(true);
	const child = spawn("node", [CLI, "ready", "--wait", "--timeout", "20"], { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
	const done = waitForExit(child);
	await new Promise((r) => setTimeout(r, 1500));
	check("45.store.sleeps", alive(child), `exited early code=${child.exitCode}`);
	freeBlocker(d); // admit: TaskTransition equivalent — frees t#02, touches store
	const t0 = Date.now();
	const res = await done;
	const dt = Date.now() - t0;
	check("45.store.wakes-exit0", res.code === 0, JSON.stringify(res));
	check("45.store.wakes-fast", dt < 5000, `${dt}ms`);
	check("45.store.fresh-set", res.out === "t#02\tdownstream work\n", JSON.stringify(res.out));
}
// --- scan path: waiter sleeps, wakes on file touch ---
{
	const d = mkfix(false);
	const child = spawn("node", [CLI, "ready", "--wait", "--timeout", "20"], { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
	const done = waitForExit(child);
	await new Promise((r) => setTimeout(r, 1500));
	check("45.scan.sleeps", alive(child), `exited early code=${child.exitCode}`);
	freeBlocker(d);
	const res = await done;
	check("45.scan.wakes-exit0", res.code === 0, JSON.stringify(res));
	check("45.scan.fresh-set", res.out === "t#02\tdownstream work\n", JSON.stringify(res.out));
}
// --- timeout exits 0 empty (text + json) ---
{
	const d = mkfix(true);
	const t0 = Date.now();
	const child = spawn("node", [CLI, "ready", "--wait", "--timeout", "1"], { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
	const res = await waitForExit(child);
	const dt = Date.now() - t0;
	check("45.timeout.exit0", res.code === 0, JSON.stringify(res));
	check("45.timeout.empty-text", res.out === "(no ready issues)\n", JSON.stringify(res.out));
	check("45.timeout.timing", dt >= 900 && dt < 8000, `${dt}ms`);
}
{
	const d = mkfix(false);
	const child = spawn("node", [CLI, "ready", "--wait", "--timeout", "1", "--json"], { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
	const res = await waitForExit(child);
	const j = JSON.parse(res.out);
	check("45.timeout.json", res.code === 0 && Array.isArray(j.ready) && j.ready.length === 0, res.out);
}
// --- non-empty ready returns immediately (no wait) ---
{
	const d = mkfix(false);
	execFileSync("node", [CLI, "move", "t#01", "Done"], { cwd: d, timeout: 60000 });
	const t0 = Date.now();
	const child = spawn("node", [CLI, "ready", "--wait", "--timeout", "20"], { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
	const res = await waitForExit(child);
	const dt = Date.now() - t0;
	check("45.immediate.fresh", res.code === 0 && res.out === "t#02\tdownstream work\n", JSON.stringify(res.out));
	check("45.immediate.no-sleep", dt < 3000, `${dt}ms`);
}
// --- bad timeout rejected ---
{
	const d = mkfix(false);
	const child = spawn("node", [CLI, "ready", "--wait", "--timeout", "abc"], { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
	const res = await waitForExit(child);
	check("45.bad-timeout.exit1", res.code === 1, JSON.stringify(res));
}
console.log(`\nprobe45: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
