import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, waitFor, act } from "@testing-library/react";
import { EventErrorIndicator, EventRow } from "@/components/session/EventRow";
import {
  getEventDetail,
  getSummaryRows,
  isErrorEvent,
  toolFailure,
} from "@/lib/events";
import type { AgentEvent, AgentSummaryResponse } from "@/lib/types";
import {
  __resetAgentSummaryCacheForTests,
  useAgentSummary,
} from "@/hooks/useAgentSummary";
import { useFleetStore } from "@/store/fleet";

// A failed tool call (the Claude Code plugin's PostToolUseFailure, or
// Claude Code's OpenTelemetry tool_result with success=false) is stored
// as a tool_call carrying an error object. These tests pin that every
// dashboard surface counting errors treats it as one: the shared
// isErrorEvent predicate, the drawer row's indicator, detail and
// expanded rows, and the agent summary's live errors patch.

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAgentSummary: vi.fn(
      async (agentId: string): Promise<AgentSummaryResponse> => ({
        agent_id: agentId,
        period: "7d",
        bucket: "day",
        totals: {
          tokens: 0,
          errors: 0,
          sessions: 1,
          cost_usd: 0,
          latency_p50_ms: 0,
          latency_p95_ms: 0,
          partial_estimate: false,
          models_unpriced: [],
          billing_modes: [],
        },
        series: [
          {
            ts: "2026-11-07T00:00:00Z",
            tokens: 0,
            errors: 0,
            sessions: 1,
            cost_usd: 0,
            latency_p95_ms: 0,
          },
        ],
      }),
    ),
  };
});

const FAILURE = {
  error_type: "other",
  error_class: "PluginToolError",
  message: "cat: missing.txt: No such file or directory",
  interrupted: false,
};

let nextId = 0;
function makeEvent(
  eventType: string,
  payload: Record<string, unknown> | undefined,
  extra: Partial<AgentEvent> = {},
): AgentEvent {
  nextId += 1;
  return {
    id: `evt-${nextId}`,
    session_id: "sess-1",
    flavor: "claude-code",
    event_type: eventType as AgentEvent["event_type"],
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: 12,
    tool_name: "Bash",
    has_content: false,
    payload: payload as AgentEvent["payload"],
    occurred_at: new Date().toISOString(),
    ...extra,
  };
}

const failedTool = () => makeEvent("tool_call", { error: { ...FAILURE } });
const okTool = () => makeEvent("tool_call", { tool_use_id: "toolu_1" });

describe("isErrorEvent / toolFailure", () => {
  it("counts an llm_error and a tool_call with an error object", () => {
    expect(isErrorEvent(makeEvent("llm_error", { error: { error_type: "rate_limit" } }))).toBe(true);
    expect(isErrorEvent(failedTool())).toBe(true);
    expect(toolFailure(failedTool())).toEqual(FAILURE);
  });

  it("does not count a successful tool_call, a string error or a payload-less row", () => {
    expect(isErrorEvent(okTool())).toBe(false);
    expect(isErrorEvent(makeEvent("tool_call", { error: "plain text" }))).toBe(false);
    expect(isErrorEvent(makeEvent("tool_call", undefined))).toBe(false);
    expect(toolFailure(okTool())).toBeNull();
  });

  it("leaves a failed MCP call to its own indicator", () => {
    const mcp = makeEvent("mcp_tool_call", {
      server_name: "github",
      error: { error_type: "invalid_params", error_class: "McpError" },
    });
    expect(isErrorEvent(mcp)).toBe(false);
    expect(toolFailure(mcp)).toBeNull();
  });

  it("does not count an error block on another event type", () => {
    expect(isErrorEvent(makeEvent("post_call", { error: { error_type: "other" } }))).toBe(false);
  });
});

describe("tool_call row text", () => {
  it("marks a failed tool call in the detail line", () => {
    expect(getEventDetail(failedTool())).toBe("Bash · failed");
    expect(getEventDetail(okTool())).toBe("Bash");
  });

  it("lists the error in the expanded rows", () => {
    expect(getSummaryRows(failedTool())).toEqual([
      ["Tool", "Bash"],
      ["Error type", "other"],
      ["Error class", "PluginToolError"],
      ["Error", FAILURE.message],
      ["Interrupted", "no"],
    ]);
    expect(getSummaryRows(okTool())).toEqual([["Tool", "Bash"]]);
  });

  it("shows a redacted message as stored", () => {
    const ev = makeEvent("tool_call", {
      error: { error_type: "other", error_class: "ClaudeCodeToolError", message: "<redacted>" },
    });
    expect(getSummaryRows(ev)).toContainEqual(["Error", "<redacted>"]);
  });
});

describe("EventErrorIndicator", () => {
  it("decorates a failed tool_call row", () => {
    const ev = failedTool();
    const { getByTestId } = render(<EventErrorIndicator event={ev} />);
    const el = getByTestId(`tool-error-indicator-${ev.id}`);
    expect(el.getAttribute("aria-label")).toBe(`Tool call failed: ${FAILURE.message}`);
  });

  it("falls back to the error class when the message is empty", () => {
    const ev = makeEvent("tool_call", { error: { error_type: "other", error_class: "PluginToolError" } });
    const { getByTestId } = render(<EventErrorIndicator event={ev} />);
    expect(getByTestId(`tool-error-indicator-${ev.id}`).getAttribute("aria-label")).toBe(
      "Tool call failed: PluginToolError",
    );
  });

  it("renders nothing on a successful tool_call or a string error", () => {
    expect(render(<EventErrorIndicator event={okTool()} />).container.innerHTML).toBe("");
    expect(
      render(<EventErrorIndicator event={makeEvent("tool_call", { error: "x" })} />).container
        .innerHTML,
    ).toBe("");
  });

  it("keeps the MCP indicator for a failed MCP call", () => {
    const ev = makeEvent("mcp_tool_call", {
      server_name: "github",
      error: { error_type: "invalid_params", error_class: "McpError", message: "bad args" },
    });
    const { getByTestId, queryByTestId } = render(<EventErrorIndicator event={ev} />);
    expect(getByTestId(`mcp-error-indicator-${ev.id}`).getAttribute("aria-label")).toBe(
      "MCP call failed: bad args",
    );
    expect(queryByTestId(`tool-error-indicator-${ev.id}`)).toBeNull();
  });

  it("is rendered inside the drawer's EventRow", () => {
    const ev = failedTool();
    const { getByTestId } = render(
      <EventRow event={ev} isExpanded={false} onToggleExpand={() => {}} />,
    );
    expect(getByTestId(`tool-error-indicator-${ev.id}`)).toBeTruthy();
  });
});

describe("agent summary live patch", () => {
  beforeEach(() => {
    __resetAgentSummaryCacheForTests();
  });

  it("counts a failed tool_call in errors without adding tokens", async () => {
    const agentId = "agent-tool-failure";
    const { result } = renderHook(() =>
      useAgentSummary(agentId, { period: "7d", bucket: "day" }),
    );
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    const push = (event: AgentEvent) =>
      act(() => {
        useFleetStore.setState({ lastEvent: event, lastEventAgentId: agentId });
      });

    push(okTool());
    expect(result.current.summary!.totals.errors).toBe(0);

    push(makeEvent("tool_call", { error: { ...FAILURE } }, { tokens_total: 50 }));
    expect(result.current.summary!.totals.errors).toBe(1);
    expect(result.current.summary!.series[0]!.errors).toBe(1);
    expect(result.current.summary!.totals.tokens).toBe(0);

    push(makeEvent("llm_error", { error: { error_type: "rate_limit" } }));
    expect(result.current.summary!.totals.errors).toBe(2);

    push(
      makeEvent("mcp_tool_call", {
        server_name: "github",
        error: { error_type: "invalid_params" },
      }),
    );
    expect(result.current.summary!.totals.errors).toBe(2);
  });
});
