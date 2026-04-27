import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { EventNode } from "@/components/timeline/EventNode";

// Phase 5 — EventNode MCP icon rendering. One test per MCP event type
// asserts that the lucide icon class lands on the rendered <svg> AND
// that the colour CSS variable matches the event's badge family. The
// test pins both the visual signal (colour) and the iconography
// (glyph) so a refactor that swaps either silently fails here.

describe("EventNode — Phase 5 MCP icons + colours", () => {
  const baseProps = {
    x: 100,
    eventType: "mcp_tool_call" as const,
    sessionId: "test-sess-mcp",
    flavor: "phase5-fixture",
    occurredAt: "2026-04-27T10:00:00Z",
    onClick: vi.fn(),
  };

  function renderNode(props: Record<string, unknown> = {}) {
    return render(<EventNode {...baseProps} {...props} />);
  }

  const cases: Array<{
    eventType: string;
    cssVar: string;
    iconClass: string;
  }> = [
    { eventType: "mcp_tool_call", cssVar: "var(--event-mcp-tool)", iconClass: "lucide-wrench" },
    { eventType: "mcp_tool_list", cssVar: "var(--event-mcp-tool)", iconClass: "lucide-list-checks" },
    {
      eventType: "mcp_resource_read",
      cssVar: "var(--event-mcp-resource)",
      iconClass: "lucide-file-text",
    },
    {
      eventType: "mcp_resource_list",
      cssVar: "var(--event-mcp-resource)",
      iconClass: "lucide-folder",
    },
    {
      eventType: "mcp_prompt_get",
      cssVar: "var(--event-mcp-prompt)",
      iconClass: "lucide-message-square",
    },
    {
      eventType: "mcp_prompt_list",
      cssVar: "var(--event-mcp-prompt)",
      iconClass: "lucide-list",
    },
  ];

  for (const { eventType, cssVar, iconClass } of cases) {
    it(`${eventType}: colour ${cssVar} + glyph ${iconClass}`, () => {
      const { container } = renderNode({ eventType });
      const node = container.querySelector(
        "[style*='background']",
      ) as HTMLElement;
      expect(node).not.toBeNull();
      expect(node.style.backgroundColor).toBe(cssVar);
      // lucide-react renders icons as <svg class="lucide lucide-NAME ...">.
      // The class assertion is the iconography-stability pin.
      expect(container.querySelector(`svg.${iconClass}`)).not.toBeNull();
    });
  }

  it("mcp_tool_list icon does NOT collide with the LLM tool_call wrench", () => {
    // Phase 5 deliberately keeps the same Wrench icon for mcp_tool_call
    // (calls) and a different ListChecks for mcp_tool_list (discovery).
    // The colour variable distinguishes mcp_tool_call (cyan-2) from the
    // pre-Phase-5 tool_call (cyan-1). This test makes the distinction
    // explicit so a future refactor cannot collapse the two.
    const { container: callContainer } = renderNode({
      eventType: "mcp_tool_call",
    });
    const { container: llmCallContainer } = renderNode({
      eventType: "tool_call",
    });
    const callNode = callContainer.querySelector(
      "[style*='background']",
    ) as HTMLElement;
    const llmNode = llmCallContainer.querySelector(
      "[style*='background']",
    ) as HTMLElement;
    expect(callNode.style.backgroundColor).toBe("var(--event-mcp-tool)");
    expect(llmNode.style.backgroundColor).toBe("var(--event-tool)");
    // Both render Wrench but the colour distinguishes them.
    expect(callContainer.querySelector("svg.lucide-wrench")).not.toBeNull();
    expect(llmCallContainer.querySelector("svg.lucide-wrench")).not.toBeNull();
  });
});
