// bais/baml_src/tools.baml — MCP tool surface (fusion v1, Phase 5,
// step 17). BAML owns the plain-data spec (name/description/input_schema)
// so agent frameworks see a validated surface; the TS host (`bais mcp`)
// owns the stdio JSON-RPC loop and executes against the projection.
// Shape mirrors bi's tools.baml ToolSpec.
class ToolSpec {
    name: string,
    description: string,
    input_schema: map<string, unknown>,
}

function empty_schema() -> map<string, unknown> {
    let props: map<string, unknown> = {};
    let s: map<string, unknown> = {};
    let _ = s.set("type", "object");
    let _ = s.set("properties", props);
    let _ = s.set("additionalProperties", false);
    s
}

function mcp_tools() -> ToolSpec[] {
    let graph_props: map<string, unknown> = {};
    let from_spec: map<string, unknown> = {};
    let _ = from_spec.set("type", "string");
    let _ = from_spec.set("description", "Issue id to traverse from");
    let _ = graph_props.set("from", from_spec);
    let graph_schema: map<string, unknown> = {};
    let _ = graph_schema.set("type", "object");
    let _ = graph_schema.set("properties", graph_props);
    let graph_required: string[] = [];
    let _ = graph_required.push("from");
    let _ = graph_schema.set("required", graph_required);
    let _ = graph_schema.set("additionalProperties", false);

    let sample_props: map<string, unknown> = {};
    let n_spec: map<string, unknown> = {};
    let _ = n_spec.set("type", "number");
    let _ = n_spec.set("description", "How many Done issues to return");
    let _ = sample_props.set("n", n_spec);
    let seed_spec: map<string, unknown> = {};
    let _ = seed_spec.set("type", "number");
    let _ = seed_spec.set("description", "Sampling seed (deterministic)");
    let _ = sample_props.set("seed", seed_spec);
    let sample_schema: map<string, unknown> = {};
    let _ = sample_schema.set("type", "object");
    let _ = sample_schema.set("properties", sample_props);
    let sample_required: string[] = [];
    let _ = sample_required.push("n");
    let _ = sample_schema.set("required", sample_required);
    let _ = sample_schema.set("additionalProperties", false);

    let tools: ToolSpec[] = [];
    let _ = tools.push(
        ToolSpec {
            name: "bais_list",
            description: "List issues with status/kind/title. Reads the BAIS projection.",
            input_schema: empty_schema(),
        },
    );
    let _ = tools.push(
        ToolSpec {
            name: "bais_ready",
            description: "Agent-dispatch query: Open issues with no active lease and no unfinished blockers.",
            input_schema: empty_schema(),
        },
    );
    let _ = tools.push(
        ToolSpec {
            name: "bais_graph",
            description: "Traverse dependency edges from an issue id.",
            input_schema: graph_schema,
        },
    );
    let _ = tools.push(
        ToolSpec {
            name: "bais_check",
            description: "Validate issue files: parse errors, dangling refs, cycles.",
            input_schema: empty_schema(),
        },
    );
    let _ = tools.push(
        ToolSpec {
            name: "bais_oversight",
            description: "Human-oversight exception feeds: conflicts, budget overruns, unverified submits, stalled leases, caps over budget.",
            input_schema: empty_schema(),
        },
    );
    let _ = tools.push(
        ToolSpec {
            name: "bais_sample",
            description: "Deterministic sample of Done work for human review.",
            input_schema: sample_schema,
        },
    );
    tools
}

test "mcp tools are unique, described, and schema-shaped" {
    let tools = mcp_tools();
    assert.equal(tools.length(), 6);
    let names: string[] = [];
    for (let t in tools) {
        assert.equal((t.description.length() > 20), true);
        assert.equal(t.input_schema.get("type"), "object");
        names.push(t.name);
    }
    assert.equal(names.includes("bais_list"), true);
    assert.equal(names.includes("bais_ready"), true);
    assert.equal(names.includes("bais_graph"), true);
    assert.equal(names.includes("bais_check"), true);
    assert.equal(names.includes("bais_oversight"), true);
    assert.equal(names.includes("bais_sample"), true);
}

test "graph requires from, sample requires n" {
    let tools = mcp_tools();
    let graphs = tools.filter((t) -> {
        t.name == "bais_graph"
    });
    assert.equal(graphs.length(), 1);
    if let greq: string[] = graphs[0].input_schema.get("required") {
        assert.equal(greq.includes("from"), true);
    } else {
        assert.equal(true, false);
    }
    let samples = tools.filter((t) -> {
        t.name == "bais_sample"
    });
    assert.equal(samples.length(), 1);
    if let sreq: string[] = samples[0].input_schema.get("required") {
        assert.equal(sreq.includes("n"), true);
    } else {
        assert.equal(true, false);
    }
}
