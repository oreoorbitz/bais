// BAIS tool specs — LLM-callable via BAIS, reusable by any consumer (bi, bagl).
// Mirrors bi's ToolSpec shape (plain-data, no ai.tools.Tool handle) so BAML
// validates the prompt and the host can list them. Consumers import via
// [dependencies] bais = { path = "../bais" } and re-export.

class ToolSpec {
    name: string,
    description: string,
    input_schema: map<string, unknown>,
}

function BaisListTool() -> ToolSpec {
    ToolSpec {
        name: "bais_list",
        description: "List BAIS issues from .bais/issues/*.toml (BAML-validated via bais parser). Returns {issues, unparseable}: files the parser rejected are reported in `unparseable`, never guessed at — treat a non-empty `unparseable` as a gap in the list, not as zero issues.",
        input_schema: {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "Filter by status (Open/Doing/Blocked/Done/Dropped) — optional",
                },
            },
            "additionalProperties": false,
        },
    }
}

function BaisReadyTool() -> ToolSpec {
    ToolSpec {
        name: "bais_ready",
        description: "List ready BAIS issues (Open where not blocked by Blocks edge via bais ready_issues).",
        input_schema: { "type": "object", "properties": {}, "additionalProperties": false },
    }
}

function BaisNewTool() -> ToolSpec {
    ToolSpec {
        name: "bais_new",
        description: "Create a new BAIS issue .bais/issues/<id>.toml (BAML-serialized via bais parser). Self-adjust: call when you discover a pattern (e.g. sub-agent timeout too short, reconcile conflicts, flaky tool) — title/body should capture repro + acceptance.",
        input_schema: {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Issue title" },
                "kind": {
                    "type": "string",
                    "description": "Kind: Bug/Feat/Proposal/Debt/Flake/Spike (default Feat)",
                },
                "area": {
                    "type": "string",
                    "description": "Area e.g. cli/bi, bridge/ffi, agent/reconcile (optional)",
                },
                "body": {
                    "type": "string",
                    "description": "Markdown body with repro + acceptance (optional)",
                },
                "status": {
                    "type": "string",
                    "description": "Status: Open/Doing/Blocked/Done/Dropped (default Open)",
                },
            },
            "required": ["title"],
            "additionalProperties": false,
        },
    }
}

function BaisMoveTool() -> ToolSpec {
    ToolSpec {
        name: "bais_move",
        description: "Move a BAIS issue to a new Status (re-serializes via bais BAML parser).",
        input_schema: {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Issue id e.g. bi#09" },
                "status": { "type": "string", "description": "New status: Open/Doing/Blocked/Done/Dropped" },
            },
            "required": ["id", "status"],
            "additionalProperties": false,
        },
    }
}

function BaisCheckTool() -> ToolSpec {
    ToolSpec {
        name: "bais_check",
        description: "Validate every .bais/issues/*.toml via bais BAML parser. Returns {ok, bad, dangling, cycles}: `bad` is per-file parse failures, `dangling` is edge ends naming an id that does not exist — status Missing (this project: a defect, it parks the target issue because an unresolvable blocker blocks) or External (another project's id, not resolvable from here) — `cycles` is ids in a Blocks/DependsOn dependency cycle (or downstream of one), which ready_issues reports only as silence.",
        input_schema: { "type": "object", "properties": {}, "additionalProperties": false },
    }
}

function BaisGraphTool() -> ToolSpec {
    ToolSpec {
        name: "bais_graph",
        description: "Graph traversal from a BAIS issue via Blocks/DependsOn/etc edges (BFS).",
        input_schema: {
            "type": "object",
            "properties": { "from": { "type": "string", "description": "Starting issue id e.g. bi#04" } },
            "required": ["from"],
            "additionalProperties": false,
        },
    }
}

function ReportSubagentTimeoutTool() -> ToolSpec {
    ToolSpec {
        name: "report_subagent_timeout",
        description: "Report sub-agent timeout pattern (directive, duration_ms, timeout_ms) → creates BAIS issue for self-adjust. Call when a sub-agent times out or you notice consistently short timeouts.",
        input_schema: {
            "type": "object",
            "properties": {
                "directive": { "type": "string", "description": "Sub-agent directive/task that timed out" },
                "duration_ms": { "type": "number", "description": "Actual duration before timeout" },
                "timeout_ms": { "type": "number", "description": "Configured timeout" },
                "area": {
                    "type": "string",
                    "description": "Area e.g. agent/subagent (default agent/subagent)",
                },
            },
            "required": ["directive", "duration_ms", "timeout_ms"],
            "additionalProperties": false,
        },
    }
}

function ReportReconcileConflictTool() -> ToolSpec {
    ToolSpec {
        name: "report_reconcile_conflict",
        description: "Report reconcile conflict pattern (conflict_count, files) → creates BAIS issue. Call when merging sub-agent results shows repeated conflicts.",
        input_schema: {
            "type": "object",
            "properties": {
                "conflict_count": { "type": "number", "description": "Number of conflicts" },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Files with conflicts",
                },
                "area": {
                    "type": "string",
                    "description": "Area e.g. agent/reconcile (default agent/reconcile)",
                },
            },
            "required": ["conflict_count"],
            "additionalProperties": false,
        },
    }
}

function ListBaisTools() -> ToolSpec[] {
    [
        BaisListTool(),
        BaisReadyTool(),
        BaisNewTool(),
        BaisMoveTool(),
        BaisCheckTool(),
        BaisGraphTool(),
        ReportSubagentTimeoutTool(),
        ReportReconcileConflictTool(),
    ]
}
