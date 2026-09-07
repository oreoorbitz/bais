// bais/scripts/interop.mjs — hub#154: outside-agent BAIS read surface (scripts lane).
//
// An agent with no BAML tooling reads the graph straight from the files:
//   node bais/scripts/interop.mjs list --hub <root> [--json]
//   node bais/scripts/interop.mjs ready --hub <root> [--json]
//   node bais/scripts/interop.mjs graph --hub <root> --from <id> [--json]
//   node bais/scripts/interop.mjs --selftest
// Pure ESM, zero dependencies: `node` only. NEVER imports baml_sdk — that is
// the point (goal constraint: no BAML-only protocols on this path). Normative
// guarantees live in bais/spec/interop.md; this file is the reference reader
// the Python conformance client (fixtures/interop/conformance.py) must agree
// with, assertion by assertion.
//
// SRC-LANE WIRING (not this file — needs bais/src/cli.ts, outside this
// lane's footprint; follow the goal.mjs precedent): a future
// `bais interop list|ready|graph --hub <root> --json` maps 1:1 onto
// cmdList/cmdReady/cmdGraph here, with --hub defaulting to the current hub
// root and envelopes printed to stdout verbatim (diagnostics to stderr).
// Until then the operator runs:
//   node bais/scripts/interop.mjs --selftest
// against bais/scripts/fixtures/interop/ (which also shells out to the
// Python conformance run, so one gate asserts both readers).
//
// Load-bearing hunk (hub#154/bi#57 red-check target): the conservative
// missing-blocker arm in readyIds (`blocker === undefined ||` — an
// unresolvable Blocks blocker parks the issue, SPEC 3.1). Reverting it to
// `blocker !== undefined && ...` must trip the selftest below with exactly:
//   "FAIL selftest: ready parks iw#03 behind live iw#04"
// (recorded 2026-09-05: arm dropped -> selftest went red with
// `ready parks iw#03 behind live iw#04 (want ["iw#02","iw#04","iw#05"],
// got ["iw#02","iw#04","iw#05","iw#07"])` — the iw#07 dangling-blocker anchor
// leaked into ready, which is the rot path the arm exists to prevent;
// hunk restored -> all green. Note the first attempt proved the fixture
// needed iw#07 at all: without a dangling blocker the reverted hunk stayed
// green, so the anchor is load-bearing, not decorative.)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "interop");

export const SUPPORTED_VERSION = 1;

const STATUSES = new Set(["Open", "Doing", "Blocked", "Done", "Dropped"]);
const KINDS = new Set(["Bug", "Feat", "Proposal", "Debt", "Flake", "Spike"]);
const EDGE_KINDS = new Set(["Blocks", "DependsOn", "SubtaskOf", "DuplicateOf",
  "Related", "Fixes", "Replaces"]);
const TOP_LEVEL_KEYS = new Set(["id", "title", "status", "kind", "area",
  "severity", "source", "body"]);
const EDGE_KEYS = new Set(["from", "to", "kind"]);

const loud = (msg) => new Error(`INTEROP ${msg}`);

// Minimal parser for exactly the BAIS file subset (spec/interop.md section 3):
// `key = value` lines (basic strings, integers, triple-quoted bodies) plus
// [[edge]] tables. Anything else fails LOUD — a reader that guesses the
// schema is worse than one that refuses it.
export function parseIssueFile(text, filename) {
  const fields = {};
  const edges = [];
  let current = null;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    i += 1;
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      if (line !== "[[edge]]") throw loud(`PARSE ${filename}: unsupported table ${line} (only [[edge]])`);
      current = {};
      edges.push(current);
      continue;
    }
    if (line.startsWith("[")) throw loud(`PARSE ${filename}: [table] sections are reserved (only [[edge]] allowed)`);
    const eq = line.indexOf("=");
    if (eq < 0) throw loud(`PARSE ${filename}: expected key = value, got ${raw}`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key || key.includes(".") || key.includes('"') || key.includes("'")) {
      throw loud(`PARSE ${filename}: bad key ${key} (dotted/quoted keys rejected)`);
    }
    const isEdgeKey = current !== null && EDGE_KEYS.has(key);
    if (!isEdgeKey && !TOP_LEVEL_KEYS.has(key)) {
      throw loud(`PARSE ${filename}: unknown top-level key ${key}`);
    }
    const store = (v) => { if (isEdgeKey) current[key] = v; else fields[key] = v; };
    if (value.startsWith('"""')) {
      if (value.length >= 6 && value.endsWith('"""')) {
        store(value.slice(3, -3));
      } else {
        const buf = [value.slice(3)];
        let closed = false;
        while (i < lines.length) {
          const nxt = lines[i];
          i += 1;
          if (nxt.trim().endsWith('"""')) {
            buf.push(nxt.slice(0, nxt.indexOf('"""')));
            closed = true;
            break;
        }
          buf.push(nxt);
        }
        if (!closed) throw loud(`PARSE ${filename}: unterminated triple-quoted string for ${key}`);
        store(buf.join("\n"));
      }
    } else if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) throw loud(`PARSE ${filename}: unterminated string for ${key}`);
      const parsed = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      store(parsed);
    } else if (/^-?\d+$/.test(value)) {
      if (isEdgeKey) throw loud(`PARSE ${filename}: edge key ${key} must be a string`);
      store(parseInt(value, 10));
    } else {
      throw loud(`PARSE ${filename}: unsupported value ${value} for ${key} (strings and integers only)`);
    }
  }
  for (const req of ["id", "title", "status", "kind", "body"]) {
    if (!(req in fields)) throw loud(`PARSE ${filename}: missing ${req}`);
  }
  if (!STATUSES.has(fields.status)) throw loud(`PARSE ${filename}: unknown Status ${fields.status}`);
  if (!KINDS.has(fields.kind)) throw loud(`PARSE ${filename}: unknown Kind ${fields.kind}`);
  for (const e of edges) {
    for (const req of ["from", "to", "kind"]) {
      if (!(req in e)) throw loud(`PARSE ${filename}: edge missing ${req}`);
    }
    if (!EDGE_KINDS.has(e.kind)) throw loud(`PARSE ${filename}: unknown EdgeKind ${e.kind}`);
    if (!e.from || !e.to) throw loud(`PARSE ${filename}: edge ends must be non-empty`);
  }
  return { issue: fields, edges };
}

export function parseConfig(text, filename) {
  let project = null;
  let version = 1;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") || !line.includes("=")) {
      throw loud(`PARSE ${filename}: config holds flat keys only, got ${raw}`);
    }
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "project") {
      if (!(value.startsWith('"') && value.endsWith('"'))) throw loud(`PARSE ${filename}: project must be a string`);
      project = value.slice(1, -1);
    } else if (key === "interop_version") {
      if (!/^\d+$/.test(value)) throw loud(`PARSE ${filename}: interop_version must be an integer`);
      version = parseInt(value, 10);
    } else {
      throw loud(`PARSE ${filename}: unknown config key ${key}`);
    }
  }
  if (project === null) throw loud(`PARSE ${filename}: missing project`);
  return { project, version };
}

export function loadHub(hubRoot) {
  const baisDir = join(hubRoot, ".bais");
  if (!existsSync(baisDir)) throw loud(`NO HUB: no .bais under ${hubRoot}`);
  const { project, version } = parseConfig(readFileSync(join(baisDir, "config.toml"), "utf8"), "config.toml");
  if (version > SUPPORTED_VERSION) {
    throw loud(`VERSION ${version} UNSUPPORTED (reader supports ${SUPPORTED_VERSION}): schema bumped, upgrade the reader`);
  }
  const issues = {};
  const unparseable = [];
  for (const name of readdirSync(join(baisDir, "issues")).sort()) {
    if (!name.endsWith(".toml")) continue;
    try {
      const { issue, edges } = parseIssueFile(readFileSync(join(baisDir, "issues", name), "utf8"), name);
      issues[issue.id] = { issue, edges };
    } catch (err) {
      unparseable.push({ file: name, error: String(err.message ?? err) });
    }
  }
  return { project, version, issues, unparseable };
}

// SPEC 3.1: Open issues with no live Blocks blocker. A Blocks edge (B -> X)
// parks X unless B is Done/Dropped — INCLUDING when B is missing (the
// conservative arm below: `blocker === undefined ||`). Only Blocks parks.
export function readyIds(hub) {
  const ready = [];
  for (const [id, entry] of Object.entries(hub.issues)) {
    if (entry.issue.status !== "Open") continue;
    let blocked = false;
    for (const e of entry.edges) {
      if (e.kind !== "Blocks" || e.to !== id) continue;
      const blocker = hub.issues[e.from];
      if (blocker === undefined || !["Done", "Dropped"].includes(blocker.issue.status)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) ready.push(id);
  }
  return ready.sort();
}

// SPEC 3.2: both ordering kinds become one must-precede pair.
export function precedes(edge) {
  if (edge.kind === "Blocks") return [edge.from, edge.to];
  if (edge.kind === "DependsOn") return [edge.to, edge.from];
  return null;
}

// SPEC 3.4: transitive dependents of root through ordering edges only.
// Includes root; Related/SubtaskOf/... edges are never followed.
export function graphFrom(hub, root) {
  if (!(root in hub.issues)) throw loud(`GRAPH: unknown id ${root}`);
  const succ = {};
  for (const entry of Object.values(hub.issues)) {
    for (const e of entry.edges) {
      const pair = precedes(e);
      if (pair === null) continue;
      (succ[pair[0]] ??= new Set()).add(pair[1]);
    }
  }
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const nxt of succ[stack.pop()] ?? []) {
      if (!seen.has(nxt) && nxt in hub.issues) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return [...seen].sort();
}

function envelope(hub, extra) {
  return JSON.stringify({ interop_version: SUPPORTED_VERSION, project: hub.project, ...extra, unparseable: hub.unparseable }, null, 2);
}

export function cmdList(hubRoot, asJson) {
  const hub = loadHub(hubRoot);
  const issues = Object.entries(hub.issues)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, entry]) => ({ issue: entry.issue, edges: entry.edges }));
  if (asJson) console.log(envelope(hub, { issues }));
  else for (const { issue } of issues) console.log(`${issue.id}\t${issue.status}\t${issue.title}`);
}

export function cmdReady(hubRoot, asJson) {
  const hub = loadHub(hubRoot);
  const ready = readyIds(hub).map((id) => ({ issue: hub.issues[id].issue, edges: hub.issues[id].edges }));
  if (asJson) console.log(envelope(hub, { ready }));
  else for (const { issue } of ready) console.log(issue.id);
}

export function cmdGraph(hubRoot, root, asJson) {
  const hub = loadHub(hubRoot);
  const nodes = graphFrom(hub, root);
  if (asJson) console.log(envelope(hub, { from: root, nodes }));
  else for (const id of nodes) console.log(id);
}

// --- selftest (acceptance fixtures) ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fail = (msg) => { console.error(`FAIL selftest: ${msg}`); process.exitCode = 1; };
  const ok = (msg) => console.log(`ok selftest: ${msg}`);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  if (process.argv[2] === "--selftest") {
    const hub = loadHub(join(FIXTURES, "hub"));
    const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8"));
    if (hub.unparseable.length !== 0) fail(`fixture hub parses clean (got ${JSON.stringify(hub.unparseable)})`);
    else ok("fixture hub parses clean");
    if (!eq(readyIds(hub), expected.ready)) fail(`ready parks iw#03 behind live iw#04 (want ${JSON.stringify(expected.ready)}, got ${JSON.stringify(readyIds(hub))})`);
    else ok(`ready == ${JSON.stringify(expected.ready)}`);
    for (const [root, want] of Object.entries(expected.graph_from)) {
      const got = graphFrom(hub, root);
      if (!eq(got, want)) fail(`graph --from ${root} == ${JSON.stringify(want)} (got ${JSON.stringify(got)})`);
      else ok(`graph --from ${root} == ${JSON.stringify(want)}`);
    }
    // Schema-bump clause, JS side: the v2 hub must fail THIS reader loud.
    try {
      loadHub(join(FIXTURES, "v2hub"));
      fail("v2 hub fails the v1 reader (loaded clean, want refusal)");
    } catch (err) {
      if (/INTEROP VERSION/.test(err.message)) ok(`v2 failure names the version gate (${err.message})`);
      else fail(`v2 failure names the version gate (got ${err.message})`);
    }
    // Schema-bump clause, Python side: run the real conformance client and
    // require its green line — both readers asserted by one gate.
    const py = spawnSync("python3",
      [join(FIXTURES, "conformance.py"), "--conform",
        "--hub", join(FIXTURES, "hub"),
        "--expected", join(FIXTURES, "expected.json"),
        "--v2hub", join(FIXTURES, "v2hub")],
      { encoding: "utf8" });
    const pyOut = `${py.stdout ?? ""}${py.stderr ?? ""}`;
    if (py.status !== 0 || !/conformance green/.test(pyOut)) {
      fail(`python conformance green (exit ${py.status}, output: ${pyOut.trim().split("\n").pop()})`);
    } else ok("python conformance green: ready + graphs + loud v2 refusal");
    if (process.exitCode) console.error("interop selftest: FAILURES");
    else console.log("interop selftest: all green");
  } else {
    // CLI: interop.mjs <list|ready|graph> --hub <root> [--json] [--from <id>]
    const args = process.argv.slice(2);
    const asJson = args.includes("--json");
    const hubIdx = args.indexOf("--hub");
    const hubRoot = hubIdx >= 0 ? args[hubIdx + 1] : null;
    if (!hubRoot) {
      console.error("usage: interop.mjs <list|ready|graph> --hub <root> [--json] [--from <id>]");
      process.exit(2);
    }
    try {
      if (args[0] === "list") cmdList(hubRoot, asJson);
      else if (args[0] === "ready") cmdReady(hubRoot, asJson);
      else if (args[0] === "graph") {
        const fromIdx = args.indexOf("--from");
        if (fromIdx < 0) { console.error("graph needs --from <id>"); process.exit(2); }
        cmdGraph(hubRoot, args[fromIdx + 1], asJson);
      } else {
        console.error("usage: interop.mjs <list|ready|graph> --hub <root> [--json] [--from <id>]");
        process.exit(2);
      }
    } catch (err) {
      console.error(String(err.message ?? err));
      process.exit(1);
    }
  }
}
