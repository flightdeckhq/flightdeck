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

  // B-5b: every MCP event renders as a HEXAGON shape (not a circle
  // with a ring). The shape itself is the family identifier; the
  // pre-B-5b mauve box-shadow ring around a circle was insufficient
  // for at-a-glance discrimination on dark backgrounds at swimlane
  // density. This describe block pins:
  //   1. data-mcp-family marker present + data-event-shape="hexagon"
  //   2. clip-path: polygon(...) on the inline style
  //   3. NO ``rounded-full`` className (would clip into rounded
  //      hexagon apexes)
  //   4. NO box-shadow (ring dropped — shape is the signal)
  describe("B-5b — MCP family hexagon shape", () => {
    for (const eventType of [
      "mcp_tool_call",
      "mcp_tool_list",
      "mcp_resource_read",
      "mcp_resource_list",
      "mcp_prompt_get",
      "mcp_prompt_list",
    ] as const) {
      it(`${eventType}: renders as a hexagon (clip-path polygon, data-event-shape=hexagon)`, () => {
        const { container } = renderNode({ eventType });
        const node = container.querySelector(
          "[style*='background']",
        ) as HTMLElement;
        expect(node.getAttribute("data-mcp-family")).toBe("true");
        expect(node.getAttribute("data-event-shape")).toBe("hexagon");
        // The clip-path produces the hexagon — assert it's a six-
        // vertex polygon. jsdom doesn't compute the path; we read
        // the inline style.
        expect(node.style.clipPath).toContain("polygon(");
        // Six (x y) vertex pairs separated by commas.
        const vertexCount = (node.style.clipPath.match(/,/g) ?? []).length + 1;
        expect(vertexCount).toBe(6);
        // The ``rounded-full`` className would round the hex apexes
        // into a sausage shape — the component must opt out for MCP.
        expect(node.className).not.toContain("rounded-full");
        // Box-shadow ring is dropped for B-5b; the shape carries
        // the family signal, no ring needed.
        expect(node.style.boxShadow).toBe("");
        // Border is dropped on MCP because clip-path would slice
        // the white border into jagged fragments at the apexes.
        // jsdom collapses ``border: none`` so neither the shorthand
        // getter nor the raw style attribute exposes it — instead
        // assert that the non-MCP 1.5px white border did NOT leak
        // onto the MCP hexagon path. This is a regression guard
        // against a future refactor that accidentally inherits the
        // circle's chrome border.
        const rawStyle = node.getAttribute("style") ?? "";
        expect(rawStyle).not.toContain("1.5px solid");
      });
    }

    it("non-MCP events stay CIRCLES — regression guard", () => {
      const { container } = renderNode({ eventType: "tool_call" });
      const node = container.querySelector(
        "[style*='background']",
      ) as HTMLElement;
      expect(node.getAttribute("data-mcp-family")).toBeNull();
      expect(node.getAttribute("data-event-shape")).toBe("circle");
      // Non-MCP retains the ``rounded-full`` Tailwind class.
      expect(node.className).toContain("rounded-full");
      // No clip-path on non-MCP events.
      expect(node.style.clipPath).toBe("");
      // The 1.5px translucent-white inner border is preserved on
      // non-MCP circles (chrome separation against adjacent
      // circles).
      expect(node.style.border).toContain("1.5px");
    });

    it("attachment override still works on session_start (regression for non-MCP shape)", () => {
      const { container } = renderNode({
        eventType: "session_start",
        isAttachment: true,
      });
      const node = container.querySelector(
        "[style*='background']",
      ) as HTMLElement;
      // Attachment paints the warning amber, still circle-shaped.
      expect(node.style.backgroundColor).toBe("var(--warning)");
      expect(node.getAttribute("data-event-shape")).toBe("circle");
      expect(node.className).toContain("rounded-full");
    });

    it("directive_result error override still works (regression for non-MCP shape)", () => {
      const { container } = renderNode({
        eventType: "directive_result",
        directiveStatus: "error",
      });
      const node = container.querySelector(
        "[style*='background']",
      ) as HTMLElement;
      expect(node.style.backgroundColor).toBe("var(--event-block)");
      expect(node.getAttribute("data-event-shape")).toBe("circle");
    });
  });
});
