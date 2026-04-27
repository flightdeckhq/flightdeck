import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import {
  MCPEventDetails,
  isMCPEvent,
} from "@/components/session/MCPEventDetails";
import type { AgentEvent } from "@/lib/types";

// Phase 5 — MCPEventDetails component contract. Mirrors the frozen
// dashboard fixture in dashboard/tests/e2e/fixtures/mcp-events.json
// shape-by-shape. The accordion is closed at first render; the
// per-event-type body lives inside the expanded panel.

function makeMCPEvent(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: "mcp-evt-1",
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

describe("isMCPEvent", () => {
  it("returns true for every Phase 5 MCP event type", () => {
    for (const t of [
      "mcp_tool_call",
      "mcp_tool_list",
      "mcp_resource_read",
      "mcp_resource_list",
      "mcp_prompt_get",
      "mcp_prompt_list",
    ]) {
      expect(isMCPEvent(t)).toBe(true);
    }
  });

  it("returns false for non-MCP events", () => {
    for (const t of ["post_call", "tool_call", "embeddings", "llm_error"]) {
      expect(isMCPEvent(t)).toBe(false);
    }
  });
});

describe("MCPEventDetails — accordion default-collapsed", () => {
  it("renders the toggle button + does NOT render details body until expanded", () => {
    const event = makeMCPEvent({
      payload: { server_name: "demo", transport: "stdio", duration_ms: 42 },
    });
    const { getByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    expect(getByTestId("mcp-event-details-toggle-mcp-evt-1")).toBeDefined();
    // Body assertions absent before expansion.
    expect(queryByTestId("mcp-event-detail-arguments-mcp-evt-1")).toBeNull();
  });

  it("returns null for non-MCP events even if event has a payload", () => {
    const event = makeMCPEvent({
      event_type: "post_call",
      payload: { server_name: "demo" },
    });
    const { container } = render(<MCPEventDetails event={event} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("MCPEventDetails — capture ON", () => {
  it("mcp_tool_call expanded shows arguments + result code blocks", () => {
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      tool_name: "echo",
      payload: {
        server_name: "demo",
        transport: "stdio",
        duration_ms: 42,
        arguments: { text: "fixture" },
        result: {
          content: [{ type: "text", text: "fixture" }],
          isError: false,
        },
      },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(getByTestId("mcp-event-detail-arguments-mcp-evt-1")).toBeDefined();
    expect(getByTestId("mcp-event-detail-result-mcp-evt-1")).toBeDefined();
    expect(
      getByTestId("mcp-event-detail-arguments-mcp-evt-1").textContent,
    ).toContain("fixture");
  });

  it("mcp_resource_read expanded shows the content body", () => {
    const event = makeMCPEvent({
      event_type: "mcp_resource_read",
      payload: {
        server_name: "demo",
        transport: "stdio",
        resource_uri: "mem://demo",
        content_bytes: 46,
        mime_type: "text/plain",
        content: {
          contents: [{ text: "hello", mimeType: "text/plain", uri: "mem://demo" }],
        },
      },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      getByTestId("mcp-event-detail-content-mcp-evt-1").textContent,
    ).toContain("hello");
  });

  it("mcp_prompt_get expanded shows arguments + rendered messages", () => {
    const event = makeMCPEvent({
      event_type: "mcp_prompt_get",
      payload: {
        server_name: "demo",
        transport: "stdio",
        prompt_name: "greet",
        arguments: { name: "Ada" },
        rendered: [
          { role: "user", content: "Please greet Ada." },
          { role: "assistant", content: "Hello, Ada!" },
        ],
      },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(getByTestId("mcp-event-detail-arguments-mcp-evt-1")).toBeDefined();
    const rendered = getByTestId("mcp-event-detail-rendered-mcp-evt-1");
    expect(rendered.textContent).toContain("Ada");
  });
});

describe("MCPEventDetails — capture OFF", () => {
  it("mcp_tool_call expanded shows the capture-disabled notice", () => {
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      tool_name: "echo",
      payload: {
        server_name: "demo",
        transport: "stdio",
        duration_ms: 42,
        // No arguments, no result -- capture_prompts=false on the wire.
      },
    });
    const { getByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      getByTestId("mcp-event-detail-capture-disabled-mcp-evt-1"),
    ).toBeDefined();
    expect(queryByTestId("mcp-event-detail-arguments-mcp-evt-1")).toBeNull();
  });
});

describe("MCPEventDetails — list events", () => {
  it("mcp_tool_list expanded shows the discovery notice with count", () => {
    const event = makeMCPEvent({
      event_type: "mcp_tool_list",
      payload: { server_name: "demo", transport: "stdio", count: 3 },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    const notice = getByTestId("mcp-event-detail-list-notice-mcp-evt-1");
    expect(notice.textContent).toContain("3");
    expect(notice.textContent?.toLowerCase()).toContain("item");
  });

  it("mcp_resource_list with count=0 still renders the notice", () => {
    const event = makeMCPEvent({
      event_type: "mcp_resource_list",
      payload: { server_name: "demo", transport: "stdio", count: 0 },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      getByTestId("mcp-event-detail-list-notice-mcp-evt-1"),
    ).toBeDefined();
  });
});

describe("MCPEventDetails — error path", () => {
  it("renders the structured error block regardless of capture state", () => {
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      tool_name: "broken",
      payload: {
        server_name: "demo",
        transport: "stdio",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: {
          error_type: "invalid_params",
          error_class: "McpError",
          message: "bad arg",
          code: -32602,
        } as any,
      },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      getByTestId("mcp-event-detail-error-type-mcp-evt-1").textContent,
    ).toBe("invalid_params");
    expect(
      getByTestId("mcp-event-detail-error-code-mcp-evt-1").textContent,
    ).toBe("-32602");
    expect(
      getByTestId("mcp-event-detail-error-class-mcp-evt-1").textContent,
    ).toBe("McpError");
  });
});
