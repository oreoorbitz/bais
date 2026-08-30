// ns_toml — TOML v1.0.0 parser ported to BAML, scoped to BAIS.
// Source of truth: bais/toml/toml.md + toml.abnf (toml-lang/toml@master).
// Line-oriented, pure BAML (no LLM). Parses BAIS subset (bare keys,
// string/int/bool, comments, ws, multiline basic/literal, [[edge]]) and
// returns typed root.Issue / root.Edge. See bais/toml/BAIS.md.

class BaisFile {
    issue: root.Issue,
    edges: root.Edge[],
}

class ParseState {
    lines: string[],
    n: int,
    pos: int,
    id: string?,
    title: string?,
    status_s: string?,
    kind_s: string?,
    area: string?,
    severity_s: string?,
    source: string?,
    body: string?,
    edges: root.Edge[],
    cur_from: string?,
    cur_to: string?,
    cur_kind: string?,
    in_edge: bool,
}

function state_new(lines: string[]) -> ParseState {
    ParseState {
        lines: lines,
        n: lines.length(),
        pos: 0,
        id: null,
        title: null,
        status_s: null,
        kind_s: null,
        area: null,
        severity_s: null,
        source: null,
        body: null,
        edges: [],
        cur_from: null,
        cur_to: null,
        cur_kind: null,
        in_edge: false,
    }
}

function is_bare_key_char(c: string) -> bool {
    c.is_ascii_alphanumeric() || c == "-" || c == "_"
}

function strip_comment(line: string) -> string {
    let idx = line.index_of("#");
    if (idx == null) {
        line
    } else {
        line.slice(0, idx).trim_end()
    }
}

function parse_bool_raw(raw: string) -> bool? {
    let t = raw.trim();
    if (t == "true") {
        true
    } else if (t == "false") {
        false
    } else {
        null
    }
}

function parse_int_raw(raw: string) -> int? {
    let cleaned = raw.trim().replace_all("_", "");
    let v = baml.Int.parse(cleaned) catch (e) {
        baml.errors.ParseError => null
    };
    v
}

function hex_digit_val(c: string) -> int? {
    let cp = c.code_point_at(0) ?? -1;
    if (cp >= 48 && cp <= 57) {
        cp - 48
    } else if (cp >= 97 && cp <= 102) {
        cp - 87
    } else if (cp >= 65 && cp <= 70) {
        cp - 55
    } else {
        null
    }
}

function hex_to_int(hex: string) -> int throws baml.errors.ParseError {
    let v = 0;
    for (let ch in hex.chars()) {
        let d = hex_digit_val(ch);
        if (d == null) {
            throw baml.errors.ParseError { message: "bad hex digit " + ch }
        }
        v = v * 16 + d;
    }
    v
}

function unescape_basic_string(inner: string) -> string throws baml.errors.ParseError {
    let out = "";
    let i = 0;
    let n = inner.length();
    while (i < n) {
        let ch = inner.slice(i, i + 1);
        if (ch == "\\") {
            if (i + 1 >= n) {
                throw baml.errors.ParseError { message: "trailing \\ in string" }
            }
            let esc = inner.slice(i + 1, i + 2);
            if (esc == "\"") {
                out = out + "\"";
                i = i + 2;
            } else if (esc == "\\") {
                out = out + "\\";
                i = i + 2;
            } else if (esc == "b") {
                out
                    = out
                        + string.from_code_points([8]) catch (e) {
                            baml.errors.InvalidArgument => {
                                throw baml.errors.ParseError { message: "bad \\b" }
                            }
                        };
                i = i + 2;
            } else if (esc == "t") {
                out = out + "\t";
                i = i + 2;
            } else if (esc == "n") {
                out = out + "\n";
                i = i + 2;
            } else if (esc == "f") {
                out
                    = out
                        + string.from_code_points([12]) catch (e) {
                            baml.errors.InvalidArgument => {
                                throw baml.errors.ParseError { message: "bad \\f" }
                            }
                        };
                i = i + 2;
            } else if (esc == "r") {
                out = out + "\r";
                i = i + 2;
            } else if (esc == "e") {
                out
                    = out
                        + string.from_code_points([27]) catch (e) {
                            baml.errors.InvalidArgument => {
                                throw baml.errors.ParseError { message: "bad \\e" }
                            }
                        };
                i = i + 2;
            } else if (esc == "x") {
                if (i + 3 >= n) {
                    throw baml.errors.ParseError { message: "short \\x escape" }
                }
                let hex = inner.slice(i + 2, i + 4);
                let v = hex_to_int(hex);
                out
                    = out
                        + string.from_code_points([v]) catch (e) {
                            baml.errors.InvalidArgument => {
                                throw baml.errors.ParseError { message: "bad \\x" }
                            }
                        };
                i = i + 4;
            } else if (esc == "u") {
                if (i + 5 >= n) {
                    throw baml.errors.ParseError { message: "short \\u escape" }
                }
                let hex = inner.slice(i + 2, i + 6);
                let v = hex_to_int(hex);
                out
                    = out
                        + string.from_code_points([v]) catch (e) {
                            baml.errors.InvalidArgument => {
                                throw baml.errors.ParseError { message: "bad \\u" }
                            }
                        };
                i = i + 6;
            } else if (esc == "U") {
                if (i + 9 >= n) {
                    throw baml.errors.ParseError { message: "short \\U escape" }
                }
                let hex = inner.slice(i + 2, i + 10);
                let v = hex_to_int(hex);
                out
                    = out
                        + string.from_code_points([v]) catch (e) {
                            baml.errors.InvalidArgument => {
                                throw baml.errors.ParseError { message: "bad \\U" }
                            }
                        };
                i = i + 10;
            } else if (esc == "\n") {
                i = i + 2;
                while (i < n) {
                    let c = inner.slice(i, i + 1);
                    if (c == " " || c == "\t" || c == "\n" || c == "\r") {
                        i = i + 1;
                    } else {
                        break;
                    }
                }
            } else {
                throw baml.errors.ParseError { message: "unknown escape \\" + esc }
            }
        } else {
            out = out + ch;
            i = i + 1;
        }
    }
    out
}

function parse_basic_string(raw: string) -> string throws baml.errors.ParseError {
    if (!raw.starts_with("\"") || !raw.ends_with("\"") || raw.length() < 2) {
        throw baml.errors.ParseError { message: "bad basic string " + raw }
    }
    let inner = raw.slice(1, raw.length() - 1);
    unescape_basic_string(inner)
}

function parse_literal_string(raw: string) -> string throws baml.errors.ParseError {
    if (!raw.starts_with("'") || !raw.ends_with("'") || raw.length() < 2) {
        throw baml.errors.ParseError { message: "bad literal string " + raw }
    }
    raw.slice(1, raw.length() - 1)
}

function parse_ml_basic_string_content(buf: string) -> string throws baml.errors.ParseError {
    unescape_basic_string(buf)
}

function strip_value_comment(raw: string) -> string {
    let t = raw.trim();
    if (t.starts_with("\"")) {
        let i = 1;
        while (i < t.length()) {
            let c = t.slice(i, i + 1);
            if (c == "\\") {
                i = i + 2;
                continue;
            }
            if (c == "\"") {
                let rest = t.slice(i + 1, t.length()).trim();
                if (rest.starts_with("#")) {
                    return t.slice(0, i + 1);
                } else {
                    return t;
                }
            }
            i = i + 1;
        }
        t
    } else if (t.starts_with("'")) {
        let i = 1;
        while (i < t.length()) {
            let c = t.slice(i, i + 1);
            if (c == "'") {
                let rest = t.slice(i + 1, t.length()).trim();
                if (rest.starts_with("#")) {
                    return t.slice(0, i + 1);
                } else {
                    return t;
                }
            }
            i = i + 1;
        }
        t
    } else {
        let idx = t.index_of("#");
        if (idx == null) {
            t
        } else {
            t.slice(0, idx).trim()
        }
    }
}

function parse_value_string(raw: string) -> string throws baml.errors.ParseError {
    let t = raw.trim();
    if (t.starts_with("\"")) {
        parse_basic_string(t)
    } else if (t.starts_with("'")) {
        parse_literal_string(t)
    } else {
        throw baml.errors.ParseError { message: "not a string: " + t }
    }
}

function parse_status(s: string) -> root.Status throws baml.errors.ParseError {
    if (s == "Open") {
        root.Status.Open
    } else if (s == "Doing") {
        root.Status.Doing
    } else if (s == "Blocked") {
        root.Status.Blocked
    } else if (s == "Done") {
        root.Status.Done
    } else if (s == "Dropped") {
        root.Status.Dropped
    } else {
        throw baml.errors.ParseError { message: "unknown Status " + s }
    }
}

function parse_kind(s: string) -> root.Kind throws baml.errors.ParseError {
    if (s == "Bug") {
        root.Kind.Bug
    } else if (s == "Feat") {
        root.Kind.Feat
    } else if (s == "Proposal") {
        root.Kind.Proposal
    } else if (s == "Debt") {
        root.Kind.Debt
    } else if (s == "Flake") {
        root.Kind.Flake
    } else if (s == "Spike") {
        root.Kind.Spike
    } else {
        throw baml.errors.ParseError { message: "unknown Kind " + s }
    }
}

function parse_edge_kind(s: string) -> root.EdgeKind throws baml.errors.ParseError {
    if (s == "Blocks") {
        root.EdgeKind.Blocks
    } else if (s == "DependsOn") {
        root.EdgeKind.DependsOn
    } else if (s == "SubtaskOf") {
        root.EdgeKind.SubtaskOf
    } else if (s == "DuplicateOf") {
        root.EdgeKind.DuplicateOf
    } else if (s == "Related") {
        root.EdgeKind.Related
    } else if (s == "Fixes") {
        root.EdgeKind.Fixes
    } else if (s == "Replaces") {
        root.EdgeKind.Replaces
    } else {
        throw baml.errors.ParseError { message: "unknown EdgeKind " + s }
    }
}

function flush_edge(st: ParseState) -> void throws baml.errors.ParseError {
    if (!st.in_edge) {
        return;
    }
    if (st.cur_from == null || st.cur_to == null || st.cur_kind == null) {
        throw baml.errors.ParseError { message: "incomplete [[edge]]" }
    }
    let cur_kind: string = st.cur_kind ?? "";
    let k = parse_edge_kind(cur_kind);
    let cf: string = st.cur_from ?? "";
    let ct: string = st.cur_to ?? "";
    st.edges.push(root.Edge { from: cf, to: ct, kind: k });
    st.cur_from = null;
    st.cur_to = null;
    st.cur_kind = null;
}

function set_top_level(
    st: ParseState,
    key: string,
    raw_val: string,
) -> void throws baml.errors.ParseError {
    let v = raw_val.trim();
    if (key == "id") {
        st.id = parse_value_string(v);
    } else if (key == "title") {
        st.title = parse_value_string(v);
    } else if (key == "status") {
        st.status_s = parse_value_string(v);
    } else if (key == "kind") {
        st.kind_s = parse_value_string(v);
    } else if (key == "area") {
        st.area = parse_value_string(v);
    } else if (key == "severity") {
        if (v.starts_with("\"") || v.starts_with("'")) {
            st.severity_s = parse_value_string(v);
        } else {
            st.severity_s = v;
        }
    } else if (key == "source") {
        st.source = parse_value_string(v);
    } else if (key == "body") {
        st.body = parse_value_string(v);
    } else {
        throw baml.errors.ParseError { message: "unknown top-level key " + key }
    }
}

function set_edge_field(
    st: ParseState,
    key: string,
    raw_val: string,
) -> void throws baml.errors.ParseError {
    let v = parse_value_string(raw_val.trim());
    if (key == "from") {
        st.cur_from = v;
    } else if (key == "to") {
        st.cur_to = v;
    } else if (key == "kind") {
        st.cur_kind = v;
    } else {
        throw baml.errors.ParseError { message: "unknown edge key " + key }
    }
}

function escape_basic_string(s: string) -> string {
    s.replace_all("\\", "\\\\")
        .replace_all("\"", "\\\"")
        .replace_all("\n", "\\n")
        .replace_all("\r", "\\r")
        .replace_all("\t", "\\t")
}

function serialize_bais_file(f: BaisFile) -> string {
    let out = "";
    out = out + "id = \"" + escape_basic_string(f.issue.id) + "\"\n";
    out = out + "title = \"" + escape_basic_string(f.issue.title) + "\"\n";
    out = out + "status = \"" + f.issue.status.to_string() + "\"\n";
    out = out + "kind = \"" + f.issue.kind.to_string() + "\"\n";
    if (f.issue.area != null) {
        let a: string = f.issue.area ?? "";
        out = out + "area = \"" + escape_basic_string(a) + "\"\n";
    }
    if (f.issue.severity != null) {
        out = out + "severity = " + f.issue.severity.to_string() + "\n";
    }
    if (f.issue.source != null) {
        let s: string = f.issue.source ?? "";
        out = out + "source = \"" + escape_basic_string(s) + "\"\n";
    }
    let body = f.issue.body;
    if (body.includes("\"\"\"")) {
        out = out + "body = '''\n" + body + "'''\n";
    } else {
        out = out + "body = \"\"\"\n" + body + "\"\"\"\n";
    }
    for (let e in f.edges) {
        out = out + "\n[[edge]]\n";
        out = out + "from = \"" + escape_basic_string(e.from) + "\"\n";
        out = out + "to = \"" + escape_basic_string(e.to) + "\"\n";
        out = out + "kind = \"" + e.kind.to_string() + "\"\n";
    }
    out
}

function parse_bais_file(text: string) -> BaisFile throws baml.errors.ParseError {
    let lines = text.lines();
    let st = state_new(lines);
    let i = 0;
    while (i < st.n) {
        let raw_line = st.lines[i];
        let trimmed = raw_line.trim();
        if (trimmed.length() == 0 || trimmed.starts_with("#")) {
            i = i + 1;
            continue;
        }
        let no_comment = strip_comment(trimmed).trim();
        if (no_comment.length() == 0) {
            i = i + 1;
            continue;
        }
        if (no_comment == "[[edge]]") {
            flush_edge(st);
            st.in_edge = true;
            i = i + 1;
            continue;
        }
        if (no_comment.starts_with("[") && no_comment.ends_with("]")) {
            flush_edge(st);
            st.in_edge = false;
            throw baml.errors.ParseError { message: "unexpected table " + no_comment + " in issue file" }
        }
        let eq = raw_line.index_of("=");
        if (eq == null) {
            throw baml.errors.ParseError { message: "no = on line " + (i + 1).to_string() + ": " + raw_line }
        }
        let key_part = raw_line.slice(0, eq).trim();
        let key = key_part;
        for (let ch in key.chars()) {
            if (!is_bare_key_char(ch)) {
                throw baml.errors.ParseError { message: "bad key " + key }
            }
        }
        let val_part = raw_line.slice(eq + 1, raw_line.length());
        let val_trim = val_part.trim();
        if (val_trim.starts_with("\"\"\"")) {
            let after_open = val_trim.slice(3, val_trim.length());
            let close = after_open.index_of("\"\"\"");
            if (close != null) {
                let inner = after_open.slice(0, close);
                let buf = inner;
                if (buf.starts_with("\r\n")) {
                    buf = buf.slice(2, buf.length());
                } else if (buf.starts_with("\n")) {
                    buf = buf.slice(1, buf.length());
                }
                let parsed = parse_ml_basic_string_content(buf);
                if (st.in_edge) {
                    set_edge_field(st, key, "\"" + escape_basic_string(parsed) + "\"");
                } else {
                    if (key == "body") {
                        st.body = parsed;
                    } else {
                        set_top_level(st, key, "\"" + escape_basic_string(parsed) + "\"");
                    }
                }
                i = i + 1;
                continue;
            } else {
                let buf = after_open;
                if (buf.starts_with("\r\n")) {
                    buf = buf.slice(2, buf.length());
                } else if (buf.starts_with("\n")) {
                    buf = buf.slice(1, buf.length());
                }
                let j = i + 1;
                let found = false;
                let acc = buf;
                while (j < st.n) {
                    let l = st.lines[j];
                    let c = l.index_of("\"\"\"");
                    if (c != null) {
                        acc
                            = if (acc.length() == 0) {
                                l.slice(0, c)
                            } else {
                                acc + "\n" + l.slice(0, c)
                            };
                        found = true;
                        break;
                    } else {
                        acc
                            = if (acc.length() == 0) {
                                l
                            } else {
                                acc + "\n" + l
                            };
                        j = j + 1;
                    }
                }
                if (!found) {
                    throw baml.errors.ParseError { message: "unterminated \"\"\" for " + key }
                }
                let parsed = parse_ml_basic_string_content(acc);
                if (st.in_edge) {
                    set_edge_field(st, key, "\"" + escape_basic_string(parsed) + "\"");
                } else {
                    if (key == "body") {
                        st.body = parsed;
                    } else {
                        set_top_level(st, key, "\"" + escape_basic_string(parsed) + "\"");
                    }
                }
                i = j + 1;
                continue;
            }
        } else if (val_trim.starts_with("'''")) {
            let after_open = val_trim.slice(3, val_trim.length());
            let close = after_open.index_of("'''");
            if (close != null) {
                let inner = after_open.slice(0, close);
                let buf = inner;
                if (buf.starts_with("\r\n")) {
                    buf = buf.slice(2, buf.length());
                } else if (buf.starts_with("\n")) {
                    buf = buf.slice(1, buf.length());
                }
                if (st.in_edge) {
                    set_edge_field(st, key, "'" + buf + "'");
                } else {
                    if (key == "body") {
                        st.body = buf;
                    } else {
                        set_top_level(st, key, "'" + buf + "'");
                    }
                }
                i = i + 1;
                continue;
            } else {
                let buf = after_open;
                if (buf.starts_with("\r\n")) {
                    buf = buf.slice(2, buf.length());
                } else if (buf.starts_with("\n")) {
                    buf = buf.slice(1, buf.length());
                }
                let j = i + 1;
                let found = false;
                let acc = buf;
                while (j < st.n) {
                    let l = st.lines[j];
                    let c = l.index_of("'''");
                    if (c != null) {
                        acc
                            = if (acc.length() == 0) {
                                l.slice(0, c)
                            } else {
                                acc + "\n" + l.slice(0, c)
                            };
                        found = true;
                        break;
                    } else {
                        acc
                            = if (acc.length() == 0) {
                                l
                            } else {
                                acc + "\n" + l
                            };
                        j = j + 1;
                    }
                }
                if (!found) {
                    throw baml.errors.ParseError { message: "unterminated ''' for " + key }
                }
                if (st.in_edge) {
                    set_edge_field(st, key, "'" + acc + "'");
                } else {
                    if (key == "body") {
                        st.body = acc;
                    } else {
                        set_top_level(st, key, "'" + acc + "'");
                    }
                }
                i = j + 1;
                continue;
            }
        }
        let val_for_parse = strip_value_comment(val_trim);
        if (st.in_edge) {
            set_edge_field(st, key, val_for_parse);
        } else {
            if (key == "body") {
                st.body = parse_value_string(val_for_parse);
            } else {
                set_top_level(st, key, val_for_parse);
            }
        }
        i = i + 1;
    }
    flush_edge(st);
    if (st.id == null) {
        throw baml.errors.ParseError { message: "missing id" }
    }
    if (st.title == null) {
        throw baml.errors.ParseError { message: "missing title" }
    }
    if (st.status_s == null) {
        throw baml.errors.ParseError { message: "missing status" }
    }
    if (st.kind_s == null) {
        throw baml.errors.ParseError { message: "missing kind" }
    }
    if (st.body == null) {
        throw baml.errors.ParseError { message: "missing body" }
    }
    let ss: string = st.status_s ?? "";
    let status = parse_status(ss);
    let ks: string = st.kind_s ?? "";
    let kind = parse_kind(ks);
    let sev: int? = null;
    if (st.severity_s != null) {
        let sev_raw: string = st.severity_s ?? "";
        let s_trim = sev_raw.trim();
        let s_clean = if (s_trim.starts_with("\"") || s_trim.starts_with("'")) {
            s_trim.slice(1, s_trim.length() - 1)
        } else {
            s_trim
        };
        sev = parse_int_raw(s_clean);
        if (sev == null) {
            let sev_msg: string = st.severity_s ?? "";
            throw baml.errors.ParseError { message: "bad severity " + sev_msg }
        }
    }
    let iid: string = st.id ?? "";
    let ttl: string = st.title ?? "";
    let bdy: string = st.body ?? "";
    let issue = root.Issue {
        id: iid,
        title: ttl,
        status: status,
        kind: kind,
        area: st.area,
        severity: sev,
        source: st.source,
        body: bdy,
    };
    BaisFile { issue: issue, edges: st.edges }
}

function parse_bais_issue(text: string) -> root.Issue throws baml.errors.ParseError {
    parse_bais_file(text).issue
}

function roundtrip_issue(
    issue: root.Issue,
    edges: root.Edge[],
) -> BaisFile throws baml.errors.ParseError {
    let f = BaisFile { issue: issue, edges: edges };
    let s = serialize_bais_file(f);
    parse_bais_file(s)
}

test "parse minimal issue" {
    let toml = "id = \"bi#09\"\ntitle = \"media union\"\nstatus = \"Open\"\nkind = \"Proposal\"\nbody = \"hello\"\n";
    let f = parse_bais_file(toml);
    assert.equal(f.issue.id, "bi#09");
    assert.equal(f.issue.title, "media union");
    assert.equal(f.issue.status, root.Status.Open);
    assert.equal(f.issue.kind, root.Kind.Proposal);
    assert.equal(f.issue.body, "hello");
    assert.equal(f.edges.length(), 0);
}

test "parse with area severity source and comment" {
    let toml = "# BAIS issue\nid = \"bi#09\" # id\ntitle = \"t\"\nstatus = \"Doing\"\nkind = \"Bug\"\narea = \"ai/media\"\nseverity = 3\nsource = \"baml.errors.ParseError\"\nbody = \"repro\"\n";
    let f = parse_bais_file(toml);
    assert.equal(f.issue.area, "ai/media");
    assert.equal(f.issue.severity, 3);
    assert.equal(f.issue.source, "baml.errors.ParseError");
}

test "parse multiline body basic" {
    let toml = "id = \"x#01\"\ntitle = \"t\"\nstatus = \"Open\"\nkind = \"Feat\"\nbody = \"\"\"\nline1\nline2\n\"\"\"\n";
    let f = parse_bais_file(toml);
    assert.equal(f.issue.body, "line1\nline2\n");
}

test "parse multiline body literal" {
    let toml = "id = \"x#02\"\ntitle = \"t\"\nstatus = \"Open\"\nkind = \"Feat\"\nbody = '''\nraw \\n not escaped\n'''\n";
    let f = parse_bais_file(toml);
    assert.contains(f.issue.body, "\\n");
}

test "parse edges array of tables" {
    let toml = "id = \"a#01\"\ntitle = \"a\"\nstatus = \"Open\"\nkind = \"Bug\"\nbody = \"b\"\n\n[[edge]]\nfrom = \"a#01\"\nto = \"a#02\"\nkind = \"Blocks\"\n\n[[edge]]\nfrom = \"a#03\"\nto = \"a#01\"\nkind = \"Related\"\n";
    let f = parse_bais_file(toml);
    assert.equal(f.edges.length(), 2);
    assert.equal(f.edges[0].kind, root.EdgeKind.Blocks);
    assert.equal(f.edges[1].from, "a#03");
}

test "parse escapes in basic string" {
    let toml = "id = \"x#03\"\ntitle = \"a \\\"quoted\\\" and \\n newline\"\nstatus = \"Open\"\nkind = \"Bug\"\nbody = \"b\"\n";
    let f = parse_bais_file(toml);
    assert.contains(f.issue.title, "\"quoted\"");
    assert.contains(f.issue.title, "\n");
}

test "roundtrip serialize parse" {
    let issue = root.Issue {
        id: "bi#99",
        title: "roundtrip",
        status: root.Status.Blocked,
        kind: root.Kind.Spike,
        area: "bridge/ffi",
        severity: 2,
        source: null,
        body: "hello\nworld",
    };
    let edges = [root.Edge { from: "bi#99", to: "bi#01", kind: root.EdgeKind.DependsOn }];
    let f2 = roundtrip_issue(issue, edges);
    assert.equal(f2.issue.id, "bi#99");
    assert.equal(f2.edges.length(), 1);
    assert.equal(f2.issue.body, "hello\nworld");
}

test "reject unknown key strict" {
    let toml = "id = \"x#04\"\ntitle = \"t\"\nstatus = \"Open\"\nkind = \"Bug\"\nunknown = \"x\"\nbody = \"b\"\n";
    let threw = false;
    let _ = parse_bais_file(toml) catch (e) {
        baml.errors.ParseError => {
            threw = true;
            BaisFile {
                issue: root.Issue {
                    id: "",
                    title: "",
                    status: root.Status.Open,
                    kind: root.Kind.Bug,
                    area: null,
                    severity: null,
                    source: null,
                    body: "",
                },
                edges: [],
            }
        }
    };
    assert.is_true(threw);
}
