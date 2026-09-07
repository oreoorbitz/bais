#!/usr/bin/env python3
"""BAIS interop conformance client (hub#154) — Python stdlib ONLY.

An outside agent (no BAML, no Node, no third-party packages) reads a BAIS
graph straight from the files and self-tests against expected.json:

    python3 conformance.py --hub hub --expected ../expected.json
    python3 conformance.py ready --hub hub
    python3 conformance.py graph --hub hub --from iw#01 [--json]

Works on Python >= 3.8: the stdlib has no TOML parser before 3.11, so this
file ships its own micro-parser for exactly the BAIS subset (bais/spec/
interop.md section 3): "key = value" lines with basic strings, integers,
triple-quoted bodies, and [[edge]] array-of-tables. Anything outside the
subset is rejected LOUD (non-zero exit + INTEROP ... message), never
misread — a reader that guesses is worse than one that refuses.

Schema versioning: SUPPORTED_VERSION = 1. The hub's .bais/config.toml may
carry `interop_version` (absent means 1). A hub declaring a newer version
fails loud: `INTEROP VERSION <n> UNSUPPORTED (reader supports 1)`. The
v2hub fixture asserts this path.
"""

import json
import os
import subprocess
import sys

SUPPORTED_VERSION = 1

STATUSES = ("Open", "Doing", "Blocked", "Done", "Dropped")
KINDS = ("Bug", "Feat", "Proposal", "Debt", "Flake", "Spike")
EDGE_KINDS = ("Blocks", "DependsOn", "SubtaskOf", "DuplicateOf",
              "Related", "Fixes", "Replaces")
# Only these carry ordering semantics (SPEC 3.2); the rest never do.
ORDERING_KINDS = ("Blocks", "DependsOn")
TOP_LEVEL_KEYS = ("id", "title", "status", "kind", "area",
                  "severity", "source", "body")


class InteropError(Exception):
    """Loud, machine-greppable failure: every message starts with INTEROP."""


def fail(msg):
    raise InteropError("INTEROP " + msg)


def parse_issue_file(text, filename):
    """Parse one .bais/issues/<id>.toml under the BAIS subset.

    Returns (fields dict, edges list). Raises InteropError on anything the
    subset cannot represent exactly — including [table] sections, dotted
    keys, and unknown top-level keys (SPEC 2 strictness, mirrored here).
    """
    fields = {}
    edges = []
    current = None  # active [[edge]] table, if any
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        i += 1
        if not line or line.startswith("#"):
            continue
        if line.startswith("[["):
            if line != "[[edge]]":
                fail("PARSE %s: unsupported table %r (only [[edge]])"
                     % (filename, line))
            current = {}
            edges.append(current)
            continue
        if line.startswith("["):
            fail("PARSE %s: [table] sections are reserved "
                 "(only [[edge]] allowed)" % filename)
        if "=" not in line:
            fail("PARSE %s: expected key = value, got %r" % (filename, raw))
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not key or "." in key or '"' in key or "'" in key:
            fail("PARSE %s: bad key %r (dotted/quoted keys rejected)"
                 % (filename, key))
        if current is not None and key in ("from", "to", "kind"):
            pass  # edge key, validated below
        elif key not in TOP_LEVEL_KEYS:
            fail("PARSE %s: unknown top-level key %r" % (filename, key))
        if value.startswith('"""'):
            # Triple-quoted body: same-line close or multi-line span.
            if len(value) >= 6 and value.endswith('"""'):
                parsed = value[3:-3]
            else:
                buf = [value[3:]]
                closed = False
                while i < len(lines):
                    nxt = lines[i]
                    i += 1
                    if nxt.strip().endswith('"""'):
                        idx = nxt.find('"""')
                        buf.append(nxt[:idx])
                        closed = True
                        break
                    buf.append(nxt)
                if not closed:
                    fail("PARSE %s: unterminated triple-quoted string for %r"
                         % (filename, key))
                parsed = "\n".join(buf)
            target = current if current is not None and key in (
                "from", "to", "kind") else fields
            target[key] = parsed
        elif value.startswith('"'):
            if len(value) < 2 or not value.endswith('"'):
                fail("PARSE %s: unterminated string for %r" % (filename, key))
            parsed = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            if current is not None and key in ("from", "to", "kind"):
                current[key] = parsed
            else:
                fields[key] = parsed
        elif value.lstrip("-").isdigit():
            if current is not None and key in ("from", "to", "kind"):
                fail("PARSE %s: edge key %r must be a string" % (filename, key))
            fields[key] = int(value)
        else:
            fail("PARSE %s: unsupported value %r for %r "
                 "(strings and integers only)" % (filename, value, key))
    # --- strict validation (mirrors SPEC 2, fails loud, never defaults) ---
    for req in ("id", "title", "status", "kind", "body"):
        if req not in fields:
            fail("PARSE %s: missing %s" % (filename, req))
    if fields["status"] not in STATUSES:
        fail("PARSE %s: unknown Status %r" % (filename, fields["status"]))
    if fields["kind"] not in KINDS:
        fail("PARSE %s: unknown Kind %r" % (filename, fields["kind"]))
    for e in edges:
        for req in ("from", "to", "kind"):
            if req not in e:
                fail("PARSE %s: edge missing %s" % (filename, req))
        if e["kind"] not in EDGE_KINDS:
            fail("PARSE %s: unknown EdgeKind %r" % (filename, e["kind"]))
        if not e["from"] or not e["to"]:
            fail("PARSE %s: edge ends must be non-empty" % filename)
    return fields, edges


def parse_config(text, filename):
    """Read project + interop_version from .bais/config.toml (flat keys)."""
    project = None
    version = 1
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") or "=" not in line:
            fail("PARSE %s: config holds flat keys only, got %r"
                 % (filename, raw))
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if key == "project":
            if not (value.startswith('"') and value.endswith('"')):
                fail("PARSE %s: project must be a string" % filename)
            project = value[1:-1]
        elif key == "interop_version":
            if not value.isdigit():
                fail("PARSE %s: interop_version must be an integer" % filename)
            version = int(value)
        else:
            fail("PARSE %s: unknown config key %r" % (filename, key))
    if project is None:
        fail("PARSE %s: missing project" % filename)
    return project, version


def load_hub(hub_root):
    """Load every issue file under <hub>/.bais/issues/ (+ version gate)."""
    bais_dir = os.path.join(hub_root, ".bais")
    if not os.path.isdir(bais_dir):
        fail("NO HUB: no .bais under %r" % hub_root)
    with open(os.path.join(bais_dir, "config.toml"), encoding="utf-8") as fh:
        project, version = parse_config(fh.read(), "config.toml")
    if version > SUPPORTED_VERSION:
        fail("VERSION %d UNSUPPORTED (reader supports %d): "
             "schema bumped, upgrade the reader" % (version, SUPPORTED_VERSION))
    issues = {}
    unparseable = []
    issues_dir = os.path.join(bais_dir, "issues")
    for name in sorted(os.listdir(issues_dir)):
        if not name.endswith(".toml"):
            continue
        path = os.path.join(issues_dir, name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        try:
            fields, edges = parse_issue_file(text, name)
        except InteropError as exc:
            unparseable.append({"file": name, "error": str(exc)})
            continue
        issues[fields["id"]] = {"issue": fields, "edges": edges}
    return {"project": project, "version": version,
            "issues": issues, "unparseable": unparseable}


def ready_ids(hub):
    """SPEC 3.1: Open issues with no live Blocks blocker.

    X is blocked iff some Blocks edge (B -> X) exists with B neither
    Done/Dropped NOR missing. Only Blocks parks; everything else is
    informational. Load-bearing: the `B not in issues` arm is the
    conservative-missing-blocker rule — dropping it below must trip the
    conformance gate (see module docstring of interop.mjs, red-check).
    """
    issues = hub["issues"]
    ready = []
    for ident, entry in issues.items():
        if entry["issue"]["status"] != "Open":
            continue
        blocked = False
        for e in entry["edges"]:
            if e["kind"] != "Blocks" or e["to"] != ident:
                continue
            blocker = issues.get(e["from"])
            if blocker is None or blocker["issue"]["status"] not in (
                    "Done", "Dropped"):
                blocked = True
                break
        if not blocked:
            ready.append(ident)
    return sorted(ready)


def precedes(edge):
    """SPEC 3.2: normalize both ordering kinds to one must-precede pair."""
    if edge["kind"] == "Blocks":
        return (edge["from"], edge["to"])
    if edge["kind"] == "DependsOn":
        return (edge["to"], edge["from"])
    return None


def graph_from(hub, root):
    """Transitive dependents of root through ordering edges (SPEC 3.4).

    Includes root itself; Related/SubtaskOf/... edges are never followed.
    """
    issues = hub["issues"]
    if root not in issues:
        fail("GRAPH: unknown id %r" % root)
    succ = {}
    for ident, entry in issues.items():
        for e in entry["edges"]:
            pair = precedes(e)
            if pair is None:
                continue
            succ.setdefault(pair[0], set()).add(pair[1])
    seen = {root}
    stack = [root]
    while stack:
        node = stack.pop()
        for nxt in succ.get(node, ()):
            if nxt not in seen and nxt in issues:
                seen.add(nxt)
                stack.append(nxt)
    return sorted(seen)


def cmd_ready(hub_root, as_json):
    hub = load_hub(hub_root)
    ids = ready_ids(hub)
    if as_json:
        print(json.dumps({"interop_version": SUPPORTED_VERSION,
                           "project": hub["project"], "ready": ids,
                           "unparseable": hub["unparseable"]},
                          indent=2, sort_keys=True))
    else:
        for ident in ids:
            print(ident)
    return 0


def cmd_graph(hub_root, root, as_json):
    hub = load_hub(hub_root)
    nodes = graph_from(hub, root)
    if as_json:
        print(json.dumps({"interop_version": SUPPORTED_VERSION,
                           "project": hub["project"], "from": root,
                           "nodes": nodes,
                           "unparseable": hub["unparseable"]},
                          indent=2, sort_keys=True))
    else:
        for ident in nodes:
            print(ident)
    return 0


def cmd_conform(hub_root, expected_path, v2hub_root):
    """Acceptance gate (both clauses, fixture-asserted):

    1. ready + transitive graphs match expected.json from files alone.
    2. the v2 hub fails this same reader LOUD (exit != 0, INTEROP VERSION).
    """
    failures = []

    def check(cond, msg):
        if cond:
            print("ok conform: %s" % msg)
        else:
            failures.append(msg)
            print("FAIL conform: %s" % msg)

    hub = load_hub(hub_root)
    check(not hub["unparseable"],
          "fixture hub parses clean (got %r)" % (hub["unparseable"],))
    with open(expected_path, encoding="utf-8") as fh:
        expected = json.load(fh)
    check(ready_ids(hub) == expected["ready"],
          "ready == %r (got %r)" % (expected["ready"], ready_ids(hub)))
    for root, want in sorted(expected["graph_from"].items()):
        got = graph_from(hub, root)
        check(got == want,
              "graph --from %s == %r (got %r)" % (root, want, got))
    # Clause 2: old reader must fail LOUD on the bumped schema — run this
    # same file as a subprocess against v2hub so the gate observes the real
    # exit code and the real stderr, not an in-process exception.
    here = os.path.abspath(__file__)
    proc = subprocess.run(
        [sys.executable, here, "ready", "--hub", v2hub_root],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out = proc.stdout + proc.stderr
    check(proc.returncode != 0,
          "v2 hub fails the v1 reader (exit %d, want non-zero)"
          % proc.returncode)
    check("INTEROP VERSION" in out,
          "v2 failure names the version gate (got %r)" % out.strip()[-120:])
    if failures:
        print("%d conformance failure(s)" % len(failures))
        return 1
    print("conformance green: ready + %d graph(s) + loud v2 refusal"
          % len(expected["graph_from"]))
    return 0


def main(argv):
    args = list(argv)
    as_json = "--json" in args
    args = [a for a in args if a != "--json"]
    hub = None
    if "--hub" in args:
        i = args.index("--hub")
        hub = args[i + 1]
        del args[i:i + 2]
    if not args or args[0] not in ("ready", "graph", "--conform"):
        sys.stderr.write(
            "usage: conformance.py [--json] --hub <root> ready|graph\n"
            "       conformance.py --hub <root> graph --from <id> [--json]\n"
            "       conformance.py --conform --hub <root> "
            "--expected <json> --v2hub <root>\n")
        return 2
    try:
        if args[0] == "ready":
            return cmd_ready(hub, as_json)
        if args[0] == "graph":
            if "--from" not in args:
                sys.stderr.write("graph needs --from <id>\n")
                return 2
            return cmd_graph(hub, args[args.index("--from") + 1], as_json)
        expected = args[args.index("--expected") + 1]
        v2hub = args[args.index("--v2hub") + 1]
        return cmd_conform(hub, expected, v2hub)
    except InteropError as exc:
        sys.stderr.write("%s\n" % exc)
        return 1
    except (IOError, OSError) as exc:
        sys.stderr.write("INTEROP IO: %s\n" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
