// bais/scripts/mcp-test.mjs — Phase 5 step 17: MCP stdio handshake,
// tool list from BAML specs, calls, and error shape. stdio pipes (no
// localhost IPC), so this runs sandboxed where sync-test cannot.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const BAIS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "bais-mcp-"));
mkdirSync(join(root, ".bais", "issues"), { recursive: true });
writeFileSync(join(root, ".bais", "issues", "t1.toml"), `id = "t1"\ntitle = "alpha"\nstatus = "Done"\nkind = "Feat"\nbody = "x"\n`);

const frame = (o) => {
	const b = Buffer.from(JSON.stringify(o), "utf8");
	return `Content-Length: ${b.length}\r\n\r\n${b.toString("utf8")}`;
};
const input =
	frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) +
	frame({ jsonrpc: "2.0", method: "notifications/initialized" }) +
	frame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
	frame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bais_oversight", arguments: {} } }) +
	frame({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bais_sample", arguments: { n: 5 } } }) +
	frame({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });

const needIngest = spawnSync("node", [`${BAIS}/dist/src/cli.js`, "ingest"], { cwd: root, encoding: "utf8" });
if (needIngest.status !== 0) throw new Error("ingest failed: " + needIngest.stderr);
const r = spawnSync("node", [`${BAIS}/dist/src/cli.js`, "mcp"], { cwd: root, input, encoding: "utf8", timeout: 60000 });
if (r.error) throw r.error;
const out = r.stdout ?? "";
const msgs = [];
const re = /Content-Length: (\d+)\r\n\r\n/g;
let m;
while ((m = re.exec(out)) !== null) {
	const len = Number(m[1]);
	const start = m.index + m[0].length;
	msgs.push(JSON.parse(out.slice(start, start + len)));
}
const byId = Object.fromEntries(msgs.filter((x) => x.id !== undefined).map((x) => [x.id, x]));
console.log("init:", byId[1]?.result?.serverInfo?.name, byId[1]?.result?.protocolVersion);
console.log("tools:", (byId[2]?.result?.tools ?? []).map((t) => t.name).join(","));
const over = JSON.parse(byId[3]?.result?.content?.[0]?.text ?? "{}");
console.log("oversight keys:", Object.keys(over).join(","));
const samp = JSON.parse(byId[4]?.result?.content?.[0]?.text ?? "{}");
console.log("sample:", samp.total, samp.sample?.map((t) => t.entity).join(","));
console.log("bad tool error:", byId[5]?.error?.code, byId[5]?.error?.message);
// parity-no-phantoms — bi#148 graduated arm (finding phantom-tool-parity).
// Property: every tools/list-advertised tool dispatches via tools/call with
// valid args. Until this arm, the suite pinned tools.length === 6 and the
// unknown-tool error but never invoked bais_list/bais_ready/bais_graph/
// bais_check — deleting one switch case (or renaming a BAML spec) shipped a
// phantom (listed-but-uncallable) while the gate stayed green. Now each
// listed name is called through the shared probeParity helper (imported from
// drill-intake.mjs — the same function the red-demo drives). Reverse half
// (callable-but-unlisted) rides on the exact-set pin below + the BAML spec
// test asserting exactly these 6 names.
//
// Red-check record (bi#148/bi#57, observed live 2026-09-06): src is frozen
// by the brief, so the seam was broken with a scratch stub server
// (/tmp/drill148-stub-server.mjs — tools/list advertises all 6, tools/call
// bais_graph answers -32602 "unknown tool: bais_graph", exactly the bytes a
// drifted host would present). Driving probeParity against it returned
// [{name:"bais_graph", code:-32602, message:"unknown tool: bais_graph"}] —
// the exact line `PHANTOM bais_graph (code -32602): unknown tool:
// bais_graph`. Live server after: 6/6 dispatch, arm green.
// A passing gate that cannot go red is camouflage, not coverage.
{
	const { probeParity } = await import("./drill-intake.mjs");
	const proot = mkdtempSync(join(tmpdir(), "bais-mcp-parity-"));
	mkdirSync(join(proot, ".bais", "issues"), { recursive: true });
	writeFileSync(join(proot, ".bais", "issues", "t1.toml"), `id = "t1"\ntitle = "alpha"\nstatus = "Done"\nkind = "Feat"\nbody = "x"\n`);
	const needParity = spawnSync("node", [`${BAIS}/dist/src/cli.js`, "ingest"], { cwd: proot, encoding: "utf8" });
	if (needParity.status !== 0) throw new Error("parity ingest failed: " + needParity.stderr);
	const NAMES = ["bais_list", "bais_ready", "bais_graph", "bais_check", "bais_oversight", "bais_sample"];
	const ARGS = { bais_graph: { from: "t1" }, bais_sample: { n: 1 } };
	let pin = frame({ jsonrpc: "2.0", id: 101, method: "initialize", params: {} })
		+ frame({ jsonrpc: "2.0", method: "notifications/initialized" })
		+ frame({ jsonrpc: "2.0", id: 102, method: "tools/list", params: {} });
	NAMES.forEach((n, k) => {
		pin += frame({ jsonrpc: "2.0", id: 110 + k, method: "tools/call", params: { name: n, arguments: ARGS[n] ?? {} } });
	});
	const pr = spawnSync("node", [`${BAIS}/dist/src/cli.js`, "mcp"], { cwd: proot, input: pin, encoding: "utf8", timeout: 60000 });
	if (pr.error) throw pr.error;
	const pmsgs = [];
	const pre = /Content-Length: (\d+)\r\n\r\n/g;
	let pm;
	while ((pm = pre.exec(pr.stdout ?? "")) !== null) {
		const len = Number(pm[1]);
		const start = pm.index + pm[0].length;
		pmsgs.push(JSON.parse((pr.stdout ?? "").slice(start, start + len)));
	}
	const pbyId = Object.fromEntries(pmsgs.filter((x) => x.id !== undefined).map((x) => [x.id, x]));
	const listed = (pbyId[102]?.result?.tools ?? []).map((t) => t.name);
	const callOne = (name) => {
		const msg = pbyId[110 + NAMES.indexOf(name)];
		if (!msg) return { ok: false, code: null, message: "no-response" };
		if (msg.error) return { ok: false, code: msg.error.code, message: msg.error.message };
		return { ok: true };
	};
	const phantoms = await probeParity(listed, callOne);
	const listedOk = JSON.stringify([...listed].sort()) === JSON.stringify([...NAMES].sort());
	if (!listedOk || phantoms.length > 0) {
		for (const p of phantoms) console.log(`PHANTOM ${p.name} (code ${p.code}): ${p.message}`);
		console.log(`parity-no-phantoms: FAIL (listed [${listed.join(",")}], ${phantoms.length} phantom(s))`);
		process.exit(1);
	}
	console.log("parity: no phantoms (6/6 listed tools dispatch)");
}
// bi#58: every conjunct is now equality — server name + protocol version
// (not truthy `result`), oversight completeness + lc type (not truthy
// `as_of`), exact tool count, exact sample total, exact JSON-RPC code.
const ok = byId[1]?.result?.serverInfo?.name === "bais" && byId[1]?.result?.protocolVersion === "2024-11-05"
	&& byId[2]?.result?.tools?.length === 6 && over.completeness === "complete" && typeof over.as_of?.lc === "number"
	&& samp.total === 1 && byId[5]?.error?.code === -32602;
console.log(ok ? "MCP: all green" : "MCP: FAILURES");
process.exit(ok ? 0 : 1);
