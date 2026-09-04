// bais/baml_src/messages.baml — typed inter-agent messages (bi#53).
//
// Agents handing work to each other in prose is how context rots:
// unparseable, unvalidatable, silently lossy. These three shapes are the
// BAML-owned contracts — CreateHandoff(raw) -> Handoff,
// ReportProgress(note) -> Progress, ReviewWork(diff) -> Verdict — validated
// by ctx.output_format, following the CreateIssue precedent in main.baml.
//
// Standing split: BAML owns the shapes + shaping functions below. Hosts
// transport them as plain data over existing channels — pub for ephemeral
// progress, log for durable handoffs and verdicts (bi#46) — as the `body`
// of a hub event (bi/src/notify.ts HubEvent: every body carries a `task`
// key so the subscriber's entity fallback routes it, and every hub `type`
// is a non-empty string so parseSseBlock admits it; unknown types render
// via the generic `hub <type> on <entity>` arm, which is the compat bar).
//
// Self-contained on purpose (`ns_*` no imports): the msg_* extractors mirror
// the reducer's body_* helpers, including the dual-path list rule from
// lease.baml — hosts JSON-encode lists at the boundary (the TS bridge never
// narrows a JS array inside map<string,unknown>), BAML-native callers pass
// real arrays. Malformed input parses to null: rejected, never defaulted
// (the checkpoint.baml rule — missing/empty/mistyped fields are evidence
// with a name, not a quiet accept).

enum Decision {
    Accept,
    Reject,
}

// A durable work transfer: what was done, what remains, what is unknown.
// Travels on the log (durable per bi#46), not pub.
class Handoff {
    task: string @description("entity under work: task:01J... or legacy bi#09 alias"),
    summary: string @description("one-paragraph state of the work"),
    done: string[] @description("completed items, explicit [] when none"),
    next: string[] @description("remaining items, explicit [] when none"),
    open_questions: string[] @description("unresolved questions for the receiver, explicit [] when none"),
}

// An ephemeral status pulse: where one task stands right now.
// Travels on pub (ephemeral per bi#46, like Heartbeat).
class Progress {
    task: string @description("entity reporting: task:01J... or legacy bi#09 alias"),
    note: string @description("one-line status"),
    percent: int? @description("0-100 when the task is measurable, null otherwise"),
}

// A durable review outcome over a diff. The decision vocabulary matches
// VerifyRecord's lowercase verdicts ("accept" | "reject") so a Verdict maps
// onto verification without translation.
class Verdict {
    subject: string @description("what was reviewed: submit id, entity, or diff ref"),
    decision: Decision,
    rationale: string @description("why: a verdict without a reason is unvalidatable prose"),
    findings: string[] @description("per-finding notes; [] when the rationale says it all"),
}

// Registry: every message kind has a wire name, so a prompt-facing
// rendering can show its source shape for audit. Takes the kind NAME as a
// plain string (same FFI reason as event_type_name: hosts cannot pass
// enums inbound, proposals/05).
function message_wire(t: string) -> string {
    match (t) {
        "Handoff" => "bais.message.handoff@1",
        "Progress" => "bais.message.progress@1",
        "Verdict" => "bais.message.verdict@1",
        _ => "unknown",
    }
}

// Durable vs ephemeral placement (bi#46): progress rides pub, handoffs and
// verdicts ride the log. Unknown kinds route nowhere.
function message_channel(t: string) -> string {
    match (t) {
        "Progress" => "pub",
        "Handoff" | "Verdict" => "log",
        _ => "unknown",
    }
}

// Hub `type` string for each kind (bi/src/notify.ts HubEvent.type):
// short names, always non-empty, carried in `type` next to the body.
function message_hub_type(t: string) -> string {
    match (t) {
        "Handoff" => "Handoff",
        "Progress" => "Progress",
        "Verdict" => "Verdict",
        _ => "unknown",
    }
}

// Lowercase wire spelling of a Decision NAME ("Accept" -> "accept"),
// matching the VerifyRecord verdict vocabulary in ns_event/verify.
function decision_wire(d: string) -> string {
    match (d) {
        "Accept" => "accept",
        "Reject" => "reject",
        _ => "unknown",
    }
}

function parse_decision(s: string) -> Decision? {
    if (s == "accept") {
        Decision.Accept
    } else if (s == "reject") {
        Decision.Reject
    } else {
        null
    }
}

// ── Body extractors (mirror the reducer's body_* helpers) ───────────────

function msg_string(body: map<string, unknown>, key: string) -> string? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let s: string = v {
        s
    } else {
        null
    }
}

function msg_int(body: map<string, unknown>, key: string) -> int? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let n: int = v {
        n
    } else {
        null
    }
}

// Dual-path lists (lease.baml rule): real arrays from BAML-native callers,
// JSON text from hosts crossing the TS bridge. Malformed JSON is missing.
function msg_string_list(body: map<string, unknown>, key: string) -> string[]? {
    let v = body.get(key);
    if (v == null) {
        null
    } else if let l: string[] = v {
        l
    } else if let s: string = v {
        baml.json.from_string<string[]>(s) catch_all (e) {
            _ => null
        }
    } else {
        null
    }
}

// ── Body constructors (BAML -> host transport, plain data) ──────────────
// Lists stay real arrays here; the host JSON-encodes at the boundary
// (hub encodeBodyArrays). Every body carries `task` for the subscriber's
// entity fallback and `shape` so the source shape survives transport.

function handoff_body(h: Handoff) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("task", h.task);
    let _ = b.set("summary", h.summary);
    let _ = b.set("done", h.done);
    let _ = b.set("next", h.next);
    let _ = b.set("open_questions", h.open_questions);
    let _ = b.set("shape", message_wire("Handoff"));
    b
}

function progress_body(p: Progress) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("task", p.task);
    let _ = b.set("note", p.note);
    if let pct: int = p.percent {
        let _ = b.set("percent", pct);
    }
    let _ = b.set("shape", message_wire("Progress"));
    b
}

function verdict_body(v: Verdict) -> map<string, unknown> {
    let b: map<string, unknown> = {};
    let _ = b.set("subject", v.subject);
    let _ = b.set("decision", decision_wire(v.decision.to_string()));
    let _ = b.set("rationale", v.rationale);
    let _ = b.set("findings", v.findings);
    let _ = b.set("shape", message_wire("Verdict"));
    b
}

// ── Body parsers (host transport -> BAML, strict) ───────────────────────
// Null means malformed: a missing/empty/mistyped required field, a corrupt
// list, an out-of-range percent, or an unknown decision string. The one
// deliberate default is Verdict.findings -> [] (a verdict may rest entirely
// on its rationale); everything else is required.

function parse_handoff(body: map<string, unknown>) -> Handoff? {
    if let task: string = msg_string(body, "task") {
        if let summary: string = msg_string(body, "summary") {
            if let done: string[] = msg_string_list(body, "done") {
                if let next: string[] = msg_string_list(body, "next") {
                    if let open: string[] = msg_string_list(body, "open_questions") {
                        if (task == "" || summary == "") {
                            null
                        } else {
                            Handoff {
                                task: task,
                                summary: summary,
                                done: done,
                                next: next,
                                open_questions: open,
                            }
                        }
                    } else {
                        null
                    }
                } else {
                    null
                }
            } else {
                null
            }
        } else {
            null
        }
    } else {
        null
    }
}

function parse_progress(body: map<string, unknown>) -> Progress? {
    if let task: string = msg_string(body, "task") {
        if let note: string = msg_string(body, "note") {
            if (task == "" || note == "") {
                null
            } else if (body.get("percent") != null && msg_int(body, "percent") == null) {
                // Percent present but not an int — mistyped, not absent.
                null
            } else if let pct: int = msg_int(body, "percent") {
                if (pct < 0 || pct > 100) {
                    null
                } else {
                    Progress { task: task, note: note, percent: pct }
                }
            } else {
                Progress { task: task, note: note, percent: null }
            }
        } else {
            null
        }
    } else {
        null
    }
}

function parse_verdict(body: map<string, unknown>) -> Verdict? {
    if let subject: string = msg_string(body, "subject") {
        if let raw: string = msg_string(body, "decision") {
            if let rationale: string = msg_string(body, "rationale") {
                if let d: Decision = parse_decision(raw) {
                    if (subject == "" || rationale == "") {
                        null
                    } else {
                        Verdict {
                            subject: subject,
                            decision: d,
                            rationale: rationale,
                            findings: msg_string_list(body, "findings") ?? [],
                        }
                    }
                } else {
                    null
                }
            } else {
                null
            }
        } else {
            null
        }
    } else {
        null
    }
}

// ── Prompt-facing renderings ────────────────────────────────────────────
// Every rendering leads with its source shape (wire name) for audit: a
// shaped line in prompt context always says which contract produced it.

function render_handoff(h: Handoff) -> string {
    `[${message_wire("Handoff")} task:${h.task}] ${h.summary} | done: ${h.done.join("; ")} | next: ${h.next.join("; ")} | open: ${h.open_questions.join("; ")}`
}

function render_progress(p: Progress) -> string {
    if let pct: int = p.percent {
        `[${message_wire("Progress")} task:${p.task} ${pct.to_string()}%] ${p.note}`
    } else {
        `[${message_wire("Progress")} task:${p.task}] ${p.note}`
    }
}

function render_verdict(v: Verdict) -> string {
    `[${message_wire("Verdict")} subject:${v.subject} decision:${decision_wire(v.decision.to_string())}] ${v.rationale} | findings: ${v.findings.join("; ")}`
}

// ── Shaping LLM functions (CreateIssue precedent) ───────────────────────
// Return type IS the schema; `${ctx.output_format}` carries it to the
// model. Hosts never parse prose out of these — the SDK returns typed
// values or the call fails.

function CreateHandoff(raw: string) -> Handoff {
    client: "openai/gpt-4o-mini"
    prompt: `
        Shape the raw work report below into a Handoff (${message_wire("Handoff")}).
        task names the entity under work; summary is one paragraph; done/next/open_questions
        are explicit lists (empty when none — never omit a field).

        ${ctx.output_format}

        Raw:
        ${raw}
    `
}

function ReportProgress(note: string) -> Progress {
    client: "openai/gpt-4o-mini"
    prompt: `
        Shape the raw status note below into a Progress (${message_wire("Progress")}).
        task names the reporting entity; note is one line; percent is 0-100 only
        when the task is measurable, otherwise leave it null.

        ${ctx.output_format}

        Note:
        ${note}
    `
}

function ReviewWork(diff: string) -> Verdict {
    client: "openai/gpt-4o-mini"
    prompt: `
        Review the diff below into a Verdict (${message_wire("Verdict")}).
        subject names what was reviewed; decision is accept or reject;
        rationale is required — a verdict without a reason is rejected;
        findings lists per-finding notes ([] when the rationale says it all).

        ${ctx.output_format}

        Diff:
        ${diff}
    `
}

// ── Tests (literal shapes, no LLM) ──────────────────────────────────────

test "message wire names are pinned" {
    assert.equal(message_wire("Handoff"), "bais.message.handoff@1");
    assert.equal(message_wire("Progress"), "bais.message.progress@1");
    assert.equal(message_wire("Verdict"), "bais.message.verdict@1");
    assert.equal(message_wire("Prose"), "unknown")
}

test "progress rides pub, handoffs and verdicts ride the log" {
    assert.equal(message_channel("Progress"), "pub");
    assert.equal(message_channel("Handoff"), "log");
    assert.equal(message_channel("Verdict"), "log");
    assert.equal(message_channel("Prose"), "unknown")
}

test "hub types are admittable and bodies carry the task key" {
    assert.equal(message_hub_type("Handoff"), "Handoff");
    assert.equal(message_hub_type("Progress"), "Progress");
    assert.equal(message_hub_type("Verdict"), "Verdict");
    // parseSseBlock admits any non-empty type; the subscriber routes on
    // entity with a body.task fallback — every body must carry it.
    let h = Handoff { task: "bi#09", summary: "s", done: ["a"], next: ["b"], open_questions: [] };
    assert.equal(handoff_body(h).get("task"), "bi#09");
    let p = Progress { task: "bi#09", note: "n", percent: null };
    assert.equal(progress_body(p).get("task"), "bi#09");
    let v = Verdict { subject: "bi#09", decision: Decision.Accept, rationale: "r", findings: [] };
    assert.equal(verdict_body(v).get("subject"), "bi#09")
}

test "decision wire matches the VerifyRecord vocabulary" {
    assert.equal(decision_wire("Accept"), "accept");
    assert.equal(decision_wire("Reject"), "reject");
    assert.equal(decision_wire("Maybe"), "unknown");
    // Strict lowercase on parse: "Accept" is a host bug, not a verdict.
    assert.equal(parse_decision("accept"), Decision.Accept);
    assert.equal(parse_decision("reject"), Decision.Reject);
    assert.equal(parse_decision("Accept"), null);
    assert.equal(parse_decision("maybe"), null)
}

test "handoff survives a host round-trip with zero munging" {
    let h = Handoff {
        task: "bi#09",
        summary: "fencing done, docs remain",
        done: ["fencing echo", "admitted flag"],
        next: ["docs", "probe"],
        open_questions: ["who verifies?"],
    };
    // No string ops between produce and parse: the map crosses as data.
    if let back: Handoff = parse_handoff(handoff_body(h)) {
        assert.equal(back.task, h.task);
        assert.equal(back.summary, h.summary);
        assert.equal(back.done.join(","), h.done.join(","));
        assert.equal(back.next.join(","), h.next.join(","));
        assert.equal(back.open_questions.join(","), h.open_questions.join(","));
        assert.equal(back.done.length(), 2)
    } else {
        assert.equal(true, false)
    }
}

test "handoff parses the host JSON-encoded list shape" {
    let b: map<string, unknown> = {};
    let _ = b.set("task", "bi#09");
    let _ = b.set("summary", "s");
    let _ = b.set("done", "[\"a\",\"b\"]");
    let _ = b.set("next", "[]");
    let _ = b.set("open_questions", "[\"q\"]");
    if let h: Handoff = parse_handoff(b) {
        assert.equal(h.done.length(), 2);
        assert.equal(h.done.join(","), "a,b");
        assert.equal(h.next.length(), 0);
        assert.equal(h.open_questions.length(), 1)
    } else {
        assert.equal(true, false)
    }
}

test "malformed handoffs are rejected, never defaulted" {
    // Empty task.
    let empty_task: map<string, unknown> = {};
    let _ = empty_task.set("task", "");
    let _ = empty_task.set("summary", "s");
    let _ = empty_task.set("done", ["a"]);
    let _ = empty_task.set("next", []);
    let _ = empty_task.set("open_questions", []);
    assert.equal(parse_handoff(empty_task), null);
    // Missing summary key entirely.
    let no_summary: map<string, unknown> = {};
    let _ = no_summary.set("task", "bi#09");
    let _ = no_summary.set("done", ["a"]);
    let _ = no_summary.set("next", []);
    let _ = no_summary.set("open_questions", []);
    assert.equal(parse_handoff(no_summary), null);
    // Corrupt list JSON counts as missing.
    let bad_list: map<string, unknown> = {};
    let _ = bad_list.set("task", "bi#09");
    let _ = bad_list.set("summary", "s");
    let _ = bad_list.set("done", "[not json");
    let _ = bad_list.set("next", []);
    let _ = bad_list.set("open_questions", []);
    assert.equal(parse_handoff(bad_list), null);
    // Wrong-typed task (an int, not prose we could squint at).
    let int_task: map<string, unknown> = {};
    let _ = int_task.set("task", 42);
    let _ = int_task.set("summary", "s");
    let _ = int_task.set("done", []);
    let _ = int_task.set("next", []);
    let _ = int_task.set("open_questions", []);
    assert.equal(parse_handoff(int_task), null)
}

test "progress round-trips, percent optional but bounded" {
    let p = Progress { task: "bi#09", note: "halfway", percent: 50 };
    if let back: Progress = parse_progress(progress_body(p)) {
        assert.equal(back.task, "bi#09");
        assert.equal(back.note, "halfway");
        assert.equal(back.percent, 50)
    } else {
        assert.equal(true, false)
    }
    let unmeasured = Progress { task: "bi#09", note: "blocked", percent: null };
    if let back: Progress = parse_progress(progress_body(unmeasured)) {
        assert.equal(back.percent, null)
    } else {
        assert.equal(true, false)
    }
    let over: map<string, unknown> = {};
    let _ = over.set("task", "bi#09");
    let _ = over.set("note", "n");
    let _ = over.set("percent", 101);
    assert.equal(parse_progress(over), null);
    let under: map<string, unknown> = {};
    let _ = under.set("task", "bi#09");
    let _ = under.set("note", "n");
    let _ = under.set("percent", -1);
    assert.equal(parse_progress(under), null);
    // Mistyped percent is malformed, not absent.
    let words: map<string, unknown> = {};
    let _ = words.set("task", "bi#09");
    let _ = words.set("note", "n");
    let _ = words.set("percent", "lots");
    assert.equal(parse_progress(words), null);
    let silent: map<string, unknown> = {};
    let _ = silent.set("task", "bi#09");
    let _ = silent.set("note", "");
    assert.equal(parse_progress(silent), null)
}

test "verdict round-trips and rejects unknown decisions" {
    let v = Verdict {
        subject: "submit:e1",
        decision: Decision.Reject,
        rationale: "no evidence attached",
        findings: ["empty evidence list"],
    };
    if let back: Verdict = parse_verdict(verdict_body(v)) {
        assert.equal(back.subject, "submit:e1");
        assert.equal(back.decision, Decision.Reject);
        assert.equal(back.rationale, "no evidence attached");
        assert.equal(back.findings.length(), 1)
    } else {
        assert.equal(true, false)
    }
    // Stored lowercase on the wire, matching VerifyRecord bodies.
    assert.equal(verdict_body(v).get("decision"), "reject");
    let maybe: map<string, unknown> = {};
    let _ = maybe.set("subject", "submit:e1");
    let _ = maybe.set("decision", "maybe");
    let _ = maybe.set("rationale", "r");
    let _ = maybe.set("findings", []);
    assert.equal(parse_verdict(maybe), null);
    // A verdict without a reason is unvalidatable prose.
    let silent: map<string, unknown> = {};
    let _ = silent.set("subject", "submit:e1");
    let _ = silent.set("decision", "accept");
    let _ = silent.set("rationale", "");
    let _ = silent.set("findings", []);
    assert.equal(parse_verdict(silent), null);
    // Findings alone are optional: the rationale can say it all.
    let bare: map<string, unknown> = {};
    let _ = bare.set("subject", "submit:e1");
    let _ = bare.set("decision", "accept");
    let _ = bare.set("rationale", "ci green, evidence linked");
    if let back: Verdict = parse_verdict(bare) {
        assert.equal(back.findings.length(), 0)
    } else {
        assert.equal(true, false)
    }
}

test "every rendering shows its source shape" {
    let h = Handoff { task: "bi#09", summary: "s", done: ["a"], next: ["b"], open_questions: [] };
    assert.is_true(render_handoff(h).index_of("bais.message.handoff@1") != null);
    assert.is_true(render_handoff(h).index_of("bi#09") != null);
    let p = Progress { task: "bi#09", note: "halfway", percent: 50 };
    assert.is_true(render_progress(p).index_of("bais.message.progress@1") != null);
    assert.is_true(render_progress(p).index_of("50%") != null);
    let unmeasured = Progress { task: "bi#09", note: "blocked", percent: null };
    assert.is_true(render_progress(unmeasured).index_of("bais.message.progress@1") != null);
    let v = Verdict {
        subject: "submit:e1",
        decision: Decision.Reject,
        rationale: "no evidence",
        findings: [],
    };
    assert.is_true(render_verdict(v).index_of("bais.message.verdict@1") != null);
    assert.is_true(render_verdict(v).index_of("reject") != null)
}
