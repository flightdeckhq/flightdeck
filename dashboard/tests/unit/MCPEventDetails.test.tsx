import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import {
  MCPEventDetails,
  isMCPEvent,
} from "@/components/session/MCPEventDetails";
import type { AgentEvent, EventContent, Session, SessionDetail } from "@/lib/types";
import * as api from "@/lib/api";

// MCPEventDetails component contract. Mirrors the frozen
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
  it("returns true for every MCP event type", () => {
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

/** A run's detail as GET /v1/sessions/:id serves it, with its capture posture. */
function runDetail(
  sessionId: string,
  capturePrompts: boolean | null,
  captureEnabled = false,
): SessionDetail {
  return {
    session: {
      session_id: sessionId,
      capture_prompts: capturePrompts,
      capture_enabled: captureEnabled,
    } as Session,
    events: [],
  };
}

/** The content endpoint's body for an MCP call stored with capture on. */
function storedContent(overrides: Partial<EventContent>): EventContent {
  return {
    event_id: "mcp-evt-1",
    session_id: "00000000-0000-0000-0000-000000000001",
    provider: "mcp",
    model: "filesystem",
    system_prompt: null,
    messages: [],
    tools: null,
    response: {},
    captured_at: "2026-11-05T00:00:00Z",
    ...overrides,
  };
}

describe("MCPEventDetails — capture OFF", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("mcp_tool_call expanded shows the capture-disabled notice", async () => {
    const sessionId = "00000000-0000-0000-0000-0000000000f1";
    const sessionSpy = vi
      .spyOn(api, "fetchSession")
      .mockResolvedValue(runDetail(sessionId, false));
    const event = makeMCPEvent({
      session_id: sessionId,
      event_type: "mcp_tool_call",
      tool_name: "echo",
      payload: {
        server_name: "demo",
        transport: "stdio",
        duration_ms: 42,
        // No arguments, no result -- capture_prompts=false on the wire.
      },
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      await findByTestId("mcp-event-detail-capture-disabled-mcp-evt-1"),
    ).toBeDefined();
    expect(sessionSpy).toHaveBeenCalledWith(sessionId, undefined);
    expect(queryByTestId("mcp-event-detail-arguments-mcp-evt-1")).toBeNull();
    expect(queryByTestId("mcp-event-detail-no-content-mcp-evt-1")).toBeNull();
  });

  it("stored content the endpoint no longer serves (404) shows the capture-disabled notice", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(null);
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      has_content: true,
      payload: { server_name: "demo", transport: "stdio" },
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      await findByTestId("mcp-event-detail-capture-disabled-mcp-evt-1"),
    ).toBeDefined();
    expect(queryByTestId("mcp-event-detail-arguments-mcp-evt-1")).toBeNull();
  });
});

describe("MCPEventDetails — arguments and result stored in event_content", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("mcp_tool_call reads tool_input / tool_output from the content endpoint", async () => {
    const contentSpy = vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      storedContent({
        tool_input: { path: "/etc/hosts" },
        tool_output: { content: [{ type: "text", text: "127.0.0.1 localhost" }] },
      }),
    );
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      tool_name: "read_file",
      has_content: true,
      payload: { server_name: "filesystem", transport: "stdio", duration_ms: 12 },
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    // Nothing is fetched until the accordion opens.
    expect(contentSpy).not.toHaveBeenCalled();
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(contentSpy).toHaveBeenCalledWith("mcp-evt-1");
    const args = await findByTestId("mcp-event-detail-arguments-mcp-evt-1");
    expect(args.textContent).toContain("/etc/hosts");
    expect(getByTestId("mcp-event-detail-result-mcp-evt-1").textContent).toContain(
      "127.0.0.1 localhost",
    );
    expect(queryByTestId("mcp-event-detail-capture-disabled-mcp-evt-1")).toBeNull();
  });

  it("mcp_prompt_get shows the stored rendered messages under Rendered", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      storedContent({
        tool_input: { name: "Ada" },
        tool_output: [{ role: "user", content: { type: "text", text: "Hello Ada" } }],
      }),
    );
    const event = makeMCPEvent({
      event_type: "mcp_prompt_get",
      has_content: true,
      payload: { server_name: "demo", transport: "stdio", prompt_name: "greet" },
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect((await findByTestId("mcp-event-detail-rendered-mcp-evt-1")).textContent).toContain(
      "Hello Ada",
    );
    expect(getByTestId("mcp-event-detail-arguments-mcp-evt-1").textContent).toContain("Ada");
    expect(queryByTestId("mcp-event-detail-result-mcp-evt-1")).toBeNull();
  });

  it("content stored before the tool columns reads input / response", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(
      storedContent({ input: { q: "legacy" }, response: { content: [{ type: "text", text: "old" }] } }),
    );
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      has_content: true,
      payload: { server_name: "demo", transport: "stdio" },
    });
    const { getByTestId, findByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect((await findByTestId("mcp-event-detail-arguments-mcp-evt-1")).textContent).toContain(
      "legacy",
    );
    expect(getByTestId("mcp-event-detail-result-mcp-evt-1").textContent).toContain("old");
  });

  it("a stored row with no arguments or result says the call recorded none", async () => {
    vi.spyOn(api, "fetchEventContent").mockResolvedValue(storedContent({}));
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      has_content: true,
      payload: { server_name: "demo", transport: "stdio" },
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(await findByTestId("mcp-event-detail-no-content-mcp-evt-1")).toBeDefined();
    expect(queryByTestId("mcp-event-detail-result-mcp-evt-1")).toBeNull();
  });

  it("inline arguments on an older row win over the content endpoint", () => {
    const contentSpy = vi.spyOn(api, "fetchEventContent");
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      has_content: true,
      payload: { server_name: "demo", transport: "stdio", arguments: { text: "inline" } },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(getByTestId("mcp-event-detail-arguments-mcp-evt-1").textContent).toContain("inline");
    expect(contentSpy).not.toHaveBeenCalled();
  });
});

describe("MCPEventDetails — capture on, nothing captured", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("a capture-on run's call without a body says so instead of claiming capture is off", async () => {
    const sessionId = "00000000-0000-0000-0000-0000000000f2";
    vi.spyOn(api, "fetchSession").mockResolvedValue(runDetail(sessionId, true));
    const event = makeMCPEvent({
      session_id: sessionId,
      event_type: "mcp_tool_call",
      payload: { server_name: "demo", transport: "stdio" },
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    const notice = await findByTestId("mcp-event-detail-no-content-mcp-evt-1");
    expect(notice.textContent).toContain("no request or response body was recorded");
    expect(queryByTestId("mcp-event-detail-capture-disabled-mcp-evt-1")).toBeNull();
  });

  it("a run that predates the stored posture but stored content counts as capture on", async () => {
    const sessionId = "00000000-0000-0000-0000-0000000000f3";
    vi.spyOn(api, "fetchSession").mockResolvedValue(runDetail(sessionId, null, true));
    const event = makeMCPEvent({
      session_id: sessionId,
      event_type: "mcp_resource_read",
      payload: { server_name: "demo", transport: "stdio", resource_uri: "mem://x" },
    });
    const { getByTestId, findByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(await findByTestId("mcp-event-detail-no-content-mcp-evt-1")).toBeDefined();
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

// ---------------------------------------------------------------------
// Content-overflow handling (truncation markers + Load full)
// ---------------------------------------------------------------------

describe("MCPEventDetails — truncation markers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("mcp_tool_call: truncated arguments shows Load full button + size", () => {
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      tool_name: "ingest",
      payload: {
        server_name: "demo",
        transport: "stdio",
        // Inline marker — full content lives in event_content.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: { _truncated: true, size: 9216 } as any,
        result: { isError: false, content: [] },
      },
    });
    const { getByTestId, queryByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    const placeholder = getByTestId(
      "mcp-event-detail-arguments-mcp-evt-1-truncated",
    );
    expect(placeholder.textContent).toContain("Load full response");
    expect(placeholder.textContent).toContain("9.0 KB");
    // Result stayed inline — its CodeBlock pre is rendered.
    expect(getByTestId("mcp-event-detail-result-mcp-evt-1")).toBeDefined();
    // Capped notice is NOT shown (this is regular truncation).
    expect(
      queryByTestId("mcp-event-detail-arguments-mcp-evt-1-capped"),
    ).toBeNull();
  });

  it("mcp_tool_call: capped marker (>2 MiB) shows no Load button", () => {
    const event = makeMCPEvent({
      event_type: "mcp_tool_call",
      tool_name: "log_dump",
      payload: {
        server_name: "demo",
        transport: "stdio",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result: { _truncated: true, _capped: true, size: 5_242_880 } as any,
      },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    const capped = getByTestId(
      "mcp-event-detail-result-mcp-evt-1-capped",
    );
    expect(capped.textContent).toContain("Content too large to capture");
    expect(capped.textContent).toContain("5.00 MB");
  });

  it("mcp_resource_read: has_content=true with no inline content shows Load full", () => {
    const event = makeMCPEvent({
      event_type: "mcp_resource_read",
      has_content: true,
      payload: {
        server_name: "demo",
        transport: "stdio",
        resource_uri: "mem://big-log",
        content_bytes: 20480,
        mime_type: "text/plain",
        // No inline ``content`` — body overflowed to event_content.
      },
    });
    const { getByTestId } = render(<MCPEventDetails event={event} />);
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    expect(
      getByTestId("mcp-event-detail-content-mcp-evt-1-truncated"),
    ).toBeDefined();
  });

  it("Load full button fetches /v1/events/:id/content and renders the response", async () => {
    const fetchSpy = vi
      .spyOn(api, "fetchEventContent")
      .mockResolvedValue({
        event_id: "mcp-evt-1",
        session_id: "00000000-0000-0000-0000-000000000001",
        provider: "mcp",
        model: "demo",
        system_prompt: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [] as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: null as any,
        response: {
          contents: [{ text: "loaded-from-event-content", uri: "mem://demo" }],
        },
        input: null,
        captured_at: "2026-04-27T00:00:00Z",
      } satisfies EventContent);
    const event = makeMCPEvent({
      event_type: "mcp_resource_read",
      has_content: true,
      payload: {
        server_name: "demo",
        transport: "stdio",
        resource_uri: "mem://big-log",
        content_bytes: 20480,
        mime_type: "text/plain",
      },
    });
    const { getByTestId, findByTestId } = render(
      <MCPEventDetails event={event} />,
    );
    fireEvent.click(getByTestId("mcp-event-details-toggle-mcp-evt-1"));
    const placeholder = getByTestId(
      "mcp-event-detail-content-mcp-evt-1-truncated",
    );
    fireEvent.click(placeholder.querySelector("button")!);
    expect(fetchSpy).toHaveBeenCalledWith("mcp-evt-1");
    // The placeholder is replaced by the loaded CodeBlock.
    const loaded = await findByTestId("mcp-event-detail-content-mcp-evt-1");
    await waitFor(() => {
      expect(loaded.textContent).toContain("loaded-from-event-content");
    });
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
