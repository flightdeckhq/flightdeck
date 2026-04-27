import { describe, it, expect } from "vitest";
import {
  eventBadgeConfig,
  EVENT_FILTER_PILLS,
  EVENT_TYPE_GROUPS,
  getBadge,
  getEventDetail,
  getSummaryRows,
  isEventVisible,
} from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

// Phase 5 — MCP event taxonomy + rendering contract pinned at the
// pure-function layer. The dashboard's E2E spec (T25) replays the
// frozen fixture against the live UI; this file pins the lib/events.ts
// transformations so a refactor that quietly drops a badge or renames
// a summary key fails before the E2E does.

function makeMCPEvent(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: "evt-1",
    session_id: "00000000-0000-0000-0000-000000000001",
    flavor: "phase5-fixture",
    event_type: "mcp_tool_call",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-04-27T10:00:00Z",
    ...overrides,
  } as AgentEvent;
}

describe("eventBadgeConfig — Phase 5 MCP entries", () => {
  const expected: Record<string, { cssVar: string; label: string; filled?: boolean }> = {
    mcp_tool_call: { cssVar: "var(--event-mcp-tool)", label: "MCP TOOL", filled: true },
    mcp_tool_list: { cssVar: "var(--event-mcp-tool)", label: "MCP TOOLS", filled: false },
    mcp_resource_read: {
      cssVar: "var(--event-mcp-resource)",
      label: "MCP RESOURCE",
      filled: true,
    },
    mcp_resource_list: {
      cssVar: "var(--event-mcp-resource)",
      label: "MCP RESOURCES",
      filled: false,
    },
    mcp_prompt_get: { cssVar: "var(--event-mcp-prompt)", label: "MCP PROMPT", filled: true },
    mcp_prompt_list: {
      cssVar: "var(--event-mcp-prompt)",
      label: "MCP PROMPTS",
      filled: false,
    },
  };

  for (const [eventType, want] of Object.entries(expected)) {
    it(`registers ${eventType} with the right colour, label, filled flag`, () => {
      const cfg = eventBadgeConfig[eventType];
      expect(cfg).toBeDefined();
      expect(cfg.cssVar).toBe(want.cssVar);
      expect(cfg.label).toBe(want.label);
      const filled = cfg.filled ?? true;
      expect(filled).toBe(want.filled);
    });
  }

  it("getBadge() returns the configured entry for each MCP type", () => {
    for (const eventType of Object.keys(expected)) {
      const badge = getBadge(eventType);
      expect(badge.label).toBe(expected[eventType].label);
    }
  });
});

describe("EVENT_TYPE_GROUPS — MCP filter group", () => {
  it("groups all six MCP event types under the MCP key", () => {
    const mcp = EVENT_TYPE_GROUPS.MCP;
    expect(mcp).toEqual([
      "mcp_tool_list",
      "mcp_tool_call",
      "mcp_resource_list",
      "mcp_resource_read",
      "mcp_prompt_list",
      "mcp_prompt_get",
    ]);
  });

  it("isEventVisible filters MCP events when the MCP pill is active", () => {
    expect(isEventVisible("mcp_tool_call", "MCP")).toBe(true);
    expect(isEventVisible("mcp_resource_read", "MCP")).toBe(true);
    expect(isEventVisible("post_call", "MCP")).toBe(false);
  });

  it("MCP pill appears in EVENT_FILTER_PILLS with the cyan-2 colour token", () => {
    const pill = EVENT_FILTER_PILLS.find((p) => p.label === "MCP");
    expect(pill).toBeDefined();
    expect(pill?.color).toBe("var(--event-mcp-tool)");
  });
});

describe("getEventDetail — MCP per-type detail strings", () => {
  it("mcp_tool_call surfaces server · tool · duration", () => {
    const detail = getEventDetail(
      makeMCPEvent({
        event_type: "mcp_tool_call",
        tool_name: "echo",
        payload: { server_name: "demo", duration_ms: 42 },
      }),
    );
    expect(detail).toBe("demo · echo · 42ms");
  });

  it("mcp_resource_read surfaces server · uri · bytes", () => {
    const detail = getEventDetail(
      makeMCPEvent({
        event_type: "mcp_resource_read",
        payload: {
          server_name: "demo",
          resource_uri: "mem://demo",
          content_bytes: 46,
        },
      }),
    );
    expect(detail).toBe("demo · mem://demo · 46 bytes");
  });

  it("mcp_prompt_get surfaces server · prompt · duration", () => {
    const detail = getEventDetail(
      makeMCPEvent({
        event_type: "mcp_prompt_get",
        payload: { server_name: "demo", prompt_name: "greet", duration_ms: 3 },
      }),
    );
    expect(detail).toBe("demo · greet · 3ms");
  });

  it("mcp_*_list surfaces server · count discovered", () => {
    const tools = getEventDetail(
      makeMCPEvent({
        event_type: "mcp_tool_list",
        payload: { server_name: "demo", count: 3 },
      }),
    );
    expect(tools).toBe("demo · 3 discovered");

    const resources = getEventDetail(
      makeMCPEvent({
        event_type: "mcp_resource_list",
        payload: { server_name: "demo", count: 1 },
      }),
    );
    expect(resources).toBe("demo · 1 discovered");

    const prompts = getEventDetail(
      makeMCPEvent({
        event_type: "mcp_prompt_list",
        payload: { server_name: "demo", count: 2 },
      }),
    );
    expect(prompts).toBe("demo · 2 discovered");
  });

  it("falls back to a static label when the payload is empty", () => {
    expect(
      getEventDetail(makeMCPEvent({ event_type: "mcp_tool_call" })),
    ).toBe("mcp tool call");
    expect(
      getEventDetail(makeMCPEvent({ event_type: "mcp_resource_read" })),
    ).toBe("mcp resource read");
  });
});

describe("getSummaryRows — MCP per-type rows", () => {
  it("mcp_tool_call rows include server, transport, tool, duration", () => {
    const rows = getSummaryRows(
      makeMCPEvent({
        event_type: "mcp_tool_call",
        tool_name: "echo",
        payload: { server_name: "demo", transport: "stdio", duration_ms: 42 },
      }),
    );
    const map = Object.fromEntries(rows);
    expect(map.Server).toBe("demo");
    expect(map.Transport).toBe("stdio");
    expect(map.Tool).toBe("echo");
    expect(map.Duration).toBe("42ms");
  });

  it("mcp_resource_read rows include URI, Size, MIME", () => {
    const rows = getSummaryRows(
      makeMCPEvent({
        event_type: "mcp_resource_read",
        payload: {
          server_name: "demo",
          transport: "stdio",
          resource_uri: "mem://demo",
          content_bytes: 46,
          mime_type: "text/plain",
        },
      }),
    );
    const map = Object.fromEntries(rows);
    expect(map.URI).toBe("mem://demo");
    expect(map.Size).toBe("46 bytes");
    expect(map.MIME).toBe("text/plain");
  });

  it("mcp_*_list rows include Count", () => {
    const rows = getSummaryRows(
      makeMCPEvent({
        event_type: "mcp_tool_list",
        payload: { server_name: "demo", transport: "stdio", count: 3 },
      }),
    );
    const map = Object.fromEntries(rows);
    expect(map.Count).toBe("3");
  });

  it("MCP error path adds an Error row regardless of capture state", () => {
    const rows = getSummaryRows(
      makeMCPEvent({
        event_type: "mcp_tool_call",
        tool_name: "broken",
        payload: {
          server_name: "demo",
          transport: "stdio",
          // Cast: payload.error is overloaded between the LLM error
          // payload and the MCP error payload at the type level.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          error: { error_type: "invalid_params", code: -32602, message: "x" } as any,
        },
      }),
    );
    const map = Object.fromEntries(rows);
    expect(map.Error).toBe("invalid_params");
  });
});
