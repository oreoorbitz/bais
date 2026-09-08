// Tests for prompt_registry.baml (hub#210) — literal data only, no LLM calls.
// One test -> one policy hunk: the header comment in prompt_registry.baml
// records the bi#57 red-check against "embedded prompt text is rejected".

function reg_eval(id: string, status: Status) -> Issue {
    Issue {
        id: id,
        title: id,
        status: status,
        kind: Kind.Feat,
        area: null,
        severity: null,
        source: null,
        body: "",
    }
}

function reg_record(
    id: string,
    version: int,
    spec_ref: string,
    eval_issue: string?,
    evidence: string?,
) -> PromptRecord {
    PromptRecord {
        id: id,
        prompt: "turn-prompt",
        version: version,
        status: PromptStatus.Active,
        spec_ref: spec_ref,
        prompt_text: null,
        eval_issue: eval_issue,
        evidence: evidence,
        supersedes: null,
        timestamp: "2026-09-07T00:00:00Z",
    }
}

test "prompt registry: a passing eval-bound record is clean" {
    let issues = [reg_eval("hub#201", Status.Done)];
    let rec = reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    assert.equal(registry_problems([rec], issues), [])
}

test "prompt registry: embedded prompt text is rejected" {
    let issues = [reg_eval("hub#201", Status.Done)];
    let rec = reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    rec.prompt_text = "You are a helpful assistant...";
    let problems = record_problems(rec, issues);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].record, "turn-prompt@v1");
    assert.equal(problems[0].kind, PromptProblemKind.EmbeddedPromptText)
}

test "prompt registry: a change without an eval-run edge is rejected" {
    let rec = reg_record("turn-prompt@v2", 2, "bi/baml_src/turn.baml#TurnPrompt", null, "drill(baml-suites)");
    let problems = record_problems(rec, []);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].kind, PromptProblemKind.MissingEvalEdge)
}

test "prompt registry: dangling eval issue is rejected" {
    let rec = reg_record("turn-prompt@v2", 2, "bi/baml_src/turn.baml#TurnPrompt", "hub#999", "drill(baml-suites)");
    let problems = record_problems(rec, []);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].kind, PromptProblemKind.UnresolvedEvalIssue);
    assert.equal(problems[0].detail, "eval issue hub#999 does not resolve to a loaded issue")
}

test "prompt registry: an unfinished eval run does not justify a change" {
    let issues = [reg_eval("hub#201", Status.Doing)];
    let rec = reg_record("turn-prompt@v2", 2, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    let problems = record_problems(rec, issues);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].kind, PromptProblemKind.EvalNotPassing)
}

test "prompt registry: missing evidence cite is rejected" {
    let issues = [reg_eval("hub#201", Status.Done)];
    let rec = reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", null);
    let problems = record_problems(rec, issues);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].kind, PromptProblemKind.MissingEvidence)
}

test "prompt registry: spec ref must name a baml path" {
    let issues = [reg_eval("hub#201", Status.Done)];
    let rec = reg_record("turn-prompt@v1", 1, "docs/prompt.txt", "hub#201", "drill(baml-suites)");
    let problems = record_problems(rec, issues);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].kind, PromptProblemKind.SpecRefNotBaml)
}

test "prompt registry: duplicate version is rejected naming the first claimant" {
    let issues = [reg_eval("hub#201", Status.Done)];
    let a = reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    let b = reg_record("turn-prompt@v1-copy", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    let problems = duplicate_versions([a, b]);
    assert.equal(problems.length(), 1);
    assert.equal(problems[0].record, "turn-prompt@v1-copy");
    assert.equal(problems[0].kind, PromptProblemKind.DuplicateVersion);
    assert.equal(problems[0].detail, "turn-prompt version 1 also claimed by turn-prompt@v1")
}

test "prompt registry: warn phase advises without failing" {
    let bad = [reg_record("turn-prompt@v2", 2, "bi/baml_src/turn.baml#TurnPrompt", null, null)];
    let verdict = registry_verdict(bad, [], RolloutPhase.Warn);
    assert.equal(verdict.phase, RolloutPhase.Warn);
    assert.equal(verdict.problems.length(), 2);
    assert.equal(verdict.passed, true)
}

test "prompt registry: fail phase rejects behind the flag" {
    let issues = [reg_eval("hub#201", Status.Done)];
    let bad = [reg_record("turn-prompt@v2", 2, "bi/baml_src/turn.baml#TurnPrompt", null, null)];
    let bad_verdict = registry_verdict(bad, issues, RolloutPhase.Fail);
    assert.equal(bad_verdict.passed, false);
    let good = [
        reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)"),
    ];
    let good_verdict = registry_verdict(good, issues, RolloutPhase.Fail);
    assert.equal(good_verdict.passed, true);
    assert.equal(good_verdict.problems, [])
}

test "prompt registry: revert restores the older reference with evidence intact" {
    let v1 = reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    v1.status = PromptStatus.Superseded;
    let v2 = reg_record("turn-prompt@v2", 2, "bi/baml_src/turn.baml#TurnPromptV2", "hub#202", "drill(mirror-parity)");
    v2.supersedes = "turn-prompt@v1";
    let records = [v1, v2];
    let reverted = revert_to(records, "turn-prompt", 1, "2026-09-07T12:00:00Z");
    if let r: PromptRecord = reverted {
        // New append-only record at max+1...
        assert.equal(r.id, "turn-prompt@v3");
        assert.equal(r.version, 3);
        assert.equal(r.status, PromptStatus.Active);
        assert.equal(r.prompt_text, null);
        assert.equal(r.timestamp, "2026-09-07T12:00:00Z");
        // ...carrying the OLDER prompt reference with its evidence intact...
        assert.equal(r.spec_ref, "bi/baml_src/turn.baml#TurnPrompt");
        assert.equal(r.eval_issue, "hub#201");
        assert.equal(r.evidence, "drill(baml-suites)");
        // ...superseding the record being rolled back.
        assert.equal(r.supersedes, "turn-prompt@v2");
        // History is never rewritten.
        assert.equal(records.length(), 2);
        assert.equal(records[1].spec_ref, "bi/baml_src/turn.baml#TurnPromptV2")
    } else {
        assert.equal(reverted, "unreachable: revert target exists")
    }
}

test "prompt registry: revert to an unknown version yields null" {
    let v1 = reg_record("turn-prompt@v1", 1, "bi/baml_src/turn.baml#TurnPrompt", "hub#201", "drill(baml-suites)");
    assert.equal(revert_to([v1], "turn-prompt", 9, "2026-09-07T12:00:00Z"), null);
    assert.equal(revert_to([v1], "other-prompt", 1, "2026-09-07T12:00:00Z"), null)
}
