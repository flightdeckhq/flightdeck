import { describe, it, expect } from "vitest";
import { EVENT_TYPE_GROUPS, getBadge, getEventDetail, getSummaryRows } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

// session_signal rendering at the pure-function layer: the feed line
// names the signal, the summary rows list its metadata.

function signal(name: string | undefined, data?: Record<string, string | number | boolean | null>): AgentEvent {
  return {
    id: "evt-1",
    session_id: "00000000-0000-0000-0000-000000000001",
    flavor: "claude-code",
    event_type: "session_signal",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-10-30T10:00:00Z",
    payload: { signal: name, signal_data: data },
  } as AgentEvent;
}

describe("session_signal", () => {
  it("has its own badge and sits in the Run filter group", () => {
    expect(getBadge("session_signal").label).toBe("SIGNAL");
    expect(EVENT_TYPE_GROUPS.Run).toContain("session_signal");
  });

  it("names each known signal in the feed line", () => {
    expect(getEventDetail(signal("context_compaction_started", { trigger: "manual" }))).toBe(
      "compaction started · manual",
    );
    expect(getEventDetail(signal("context_compacted", { trigger: "auto" }))).toBe("context compacted · auto");
    expect(getEventDetail(signal("context_compacted"))).toBe("context compacted");
    expect(
      getEventDetail(
        signal("model_switched", { from_model: "claude-sonnet-5", to_model: "claude-opus-5", source: "command" }),
      ),
    ).toBe("model claude-sonnet-5 → claude-opus-5 · command");
  });

  it("shows an unknown signal by name and survives a missing one", () => {
    expect(getEventDetail(signal("worktree_created"))).toBe("worktree created");
    expect(getEventDetail(signal(undefined))).toBe("session signal");
  });

  it("lists the metadata with labels and formats", () => {
    const rows = getSummaryRows(
      signal("model_switched", {
        from_model: "claude-sonnet-5",
        to_model: "claude-opus-5",
        requested_model: null,
        source: "auto",
        context_tokens: 182340,
        prompt_cache_warm: true,
        cache_ttl: "5m",
        estimated_cache_write_usd: 1.1396,
        pricing: "catalog",
        brand_new_key: "x",
      }),
    );
    expect(rows).toEqual([
      ["Signal", "model switched"],
      ["From model", "claude-sonnet-5"],
      ["To model", "claude-opus-5"],
      ["Requested", "—"],
      ["Source", "auto"],
      ["Context tokens", (182340).toLocaleString()],
      ["Prompt cache warm", "yes"],
      ["Cache TTL", "5m"],
      ["Est. cache write", "$1.1396"],
      ["Pricing", "catalog"],
      ["brand_new_key", "x"],
    ]);
  });

  it("names notifications and permission signals in the feed line", () => {
    expect(getEventDetail(signal("notification", { notification_type: "idle_prompt" }))).toBe(
      "notification · idle prompt",
    );
    expect(getEventDetail(signal("permission_requested", { tool_name: "Bash", command: "rm -rf node_modules" }))).toBe(
      "permission requested · Bash",
    );
    expect(
      getEventDetail(
        signal("permission_denied", { tool_name: "Bash", reason: "[Irreversible Local Destruction]" }),
      ),
    ).toBe("permission denied · Bash · [Irreversible Local Destruction]");
  });

  it("names commands, tasks, directory and settings changes in the feed line", () => {
    expect(getEventDetail(signal("command_expanded", { expansion_type: "slash_command", command_name: "review" }))).toBe(
      "command · /review",
    );
    expect(getEventDetail(signal("command_expanded", { expansion_type: "slash_command", command_name: "/review" }))).toBe(
      "command · /review",
    );
    expect(
      getEventDetail(signal("command_expanded", { expansion_type: "mcp_prompt", command_name: "mcp__docs__summarise" })),
    ).toBe("MCP prompt · /mcp__docs__summarise");
    expect(getEventDetail(signal("command_expanded"))).toBe("command");
    expect(getEventDetail(signal("task_created", { task_id: "3" }))).toBe("task created");
    expect(getEventDetail(signal("task_completed", { task_id: "3", teammate_name: "tester" }))).toBe(
      "task completed · tester",
    );
    expect(getEventDetail(signal("teammate_idle", { teammate_name: "reviewer" }))).toBe("teammate idle · reviewer");
    expect(getEventDetail(signal("teammate_idle"))).toBe("teammate idle");
    expect(getEventDetail(signal("cwd_changed", { old_cwd: "/repo", new_cwd: "/repo/api" }))).toBe("cwd → /repo/api");
    expect(getEventDetail(signal("cwd_changed"))).toBe("cwd changed");
    expect(getEventDetail(signal("config_changed", { source: "project_settings" }))).toBe(
      "settings changed · project settings",
    );
    expect(getEventDetail(signal("config_changed"))).toBe("settings changed");
  });

  it("names an MCP server's request for input and the user's response", () => {
    expect(getEventDetail(signal("elicitation_requested", { mcp_server: "asker", mode: "form" }))).toBe(
      "MCP input requested · asker",
    );
    expect(getEventDetail(signal("elicitation_responded", { mcp_server: "asker", action: "accept" }))).toBe(
      "MCP input submitted · asker",
    );
    expect(getEventDetail(signal("elicitation_responded", { mcp_server: "asker", action: "decline" }))).toBe(
      "MCP input declined · asker",
    );
    expect(getEventDetail(signal("elicitation_responded", { action: "cancel" }))).toBe("MCP input cancelled");
    expect(getEventDetail(signal("elicitation_responded", { action: "other" }))).toBe("MCP input answered");
    expect(
      getSummaryRows(signal("elicitation_responded", { mcp_server: "asker", mode: "url", elicitation_id: "el-1", action: "accept" })),
    ).toEqual([
      ["Signal", "elicitation responded"],
      ["MCP server", "asker"],
      ["Mode", "url"],
      ["Elicitation id", "el-1"],
      ["Response", "accept"],
    ]);
  });

  it("labels the command, task and directory metadata", () => {
    expect(
      getSummaryRows(signal("command_expanded", { expansion_type: "slash_command", command_name: "review", command_source: "plugin" })),
    ).toEqual([
      ["Signal", "command expanded"],
      ["Expansion", "slash_command"],
      ["Command name", "review"],
      ["Command source", "plugin"],
    ]);
    expect(getSummaryRows(signal("task_created", { task_id: "3", teammate_name: "tester" }))).toEqual([
      ["Signal", "task created"],
      ["Task id", "3"],
      ["Teammate", "tester"],
    ]);
    expect(getSummaryRows(signal("cwd_changed", { old_cwd: "/repo", new_cwd: "/repo/api" }))).toEqual([
      ["Signal", "cwd changed"],
      ["From directory", "/repo"],
      ["To directory", "/repo/api"],
    ]);
  });

  it("labels the permission metadata", () => {
    expect(
      getSummaryRows(
        signal("permission_denied", {
          tool_name: "mcp__github__create_issue",
          mcp_server: "github",
          tool_use_id: "toolu_1",
          reason: "[Data Exfiltration]",
          command: "x",
        }),
      ),
    ).toEqual([
      ["Signal", "permission denied"],
      ["Tool", "mcp__github__create_issue"],
      ["MCP server", "github"],
      ["Tool use id", "toolu_1"],
      ["Reason", "[Data Exfiltration]"],
      ["Command", "x"],
    ]);
  });
});
