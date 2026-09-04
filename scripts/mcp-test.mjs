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
// bi#58: every conjunct is now equality — server name + protocol version
// (not truthy `result`), oversight completeness + lc type (not truthy
// `as_of`), exact tool count, exact sample total, exact JSON-RPC code.
const ok = byId[1]?.result?.serverInfo?.name === "bais" && byId[1]?.result?.protocolVersion === "2024-11-05"
	&& byId[2]?.result?.tools?.length === 6 && over.completeness === "complete" && typeof over.as_of?.lc === "number"
	&& samp.total === 1 && byId[5]?.error?.code === -32602;
console.log(ok ? "MCP: all green" : "MCP: FAILURES");
process.exit(ok ? 0 : 1);
