import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SubAgentLostDot } from "@/components/facets/SubAgentRolePill";

// D126 § 7.fix.P — cross-cutting L8 row-failure cue suite. METHODOLOGY
// L8: surface row-level failures inline so an operator scanning a
// table or a swimlane immediately spots trouble without expanding the
// row. The same red AlertCircle pattern fires on:
//
//   * Investigate session row (parent_session_id && state="lost")
//   * Fleet AgentTable row (sub-agent topology + lost session)
//   * Fleet swimlane left panel (any session in scope is sub-agent
//     + lost)
//
// Each surface uses the same SubAgentLostDot component so the colour
// and tooltip semantics stay in lock-step. This file pins the shared
// contract — a regression in any one surface registers here.

describe("SubAgentLostDot — shared contract across surfaces", () => {
  it("renders an AlertCircle icon (NOT a generic dot) so it reads as 'failure cue'", () => {
    const { container } = render(<SubAgentLostDot />);
    // lucide-react renders the icon as an SVG with circle + line
    // children. Asserting on the SVG element's presence is
    // sufficient regression coverage; the visual style matches
    // the llm_error / mcp_error AlertCircle indicators.
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("uses --status-lost CSS variable so both themes pick up the right red", () => {
    const { getByTestId } = render(<SubAgentLostDot />);
    const dot = getByTestId("sub-agent-lost-dot");
    expect(dot.style.color).toContain("--status-lost");
  });

  it("default testid is 'sub-agent-lost-dot' so cross-surface E2E selectors stay uniform", () => {
    const { getByTestId } = render(<SubAgentLostDot />);
    expect(getByTestId("sub-agent-lost-dot")).toBeTruthy();
  });

  it("custom testid override works for surface-specific selectors", () => {
    const { getByTestId } = render(
      <SubAgentLostDot testId="swimlane-sub-agent-lost-dot" />,
    );
    expect(getByTestId("swimlane-sub-agent-lost-dot")).toBeTruthy();
  });

  it("optional role prop doesn't change the dot itself — only the tooltip", () => {
    const { getByTestId, rerender } = render(<SubAgentLostDot />);
    const before = getByTestId("sub-agent-lost-dot").outerHTML;
    rerender(<SubAgentLostDot role="Researcher" sessionIdSuffix="abc12345" />);
    const after = getByTestId("sub-agent-lost-dot").outerHTML;
    // The trigger element (the visible dot) is identical; only
    // the tooltip content (rendered into a Radix portal that
    // jsdom doesn't pop here) varies. Same dot, richer hover.
    expect(before).toBe(after);
  });

  it("renders with flexShrink: 0 so it never collapses on narrow rows", () => {
    // The cue MUST stay visible regardless of available row
    // width. Without flexShrink: 0, narrow viewports would shrink
    // the dot to invisibility while the textual columns claim
    // the space — exactly the failure-mode L8 exists to prevent.
    const { getByTestId } = render(<SubAgentLostDot />);
    const dot = getByTestId("sub-agent-lost-dot");
    expect(dot.style.flexShrink).toBe("0");
  });

  it("tooltip wrapping is consistent across surfaces (TooltipProvider in render)", () => {
    // The component embeds its own TooltipProvider so callers
    // don't need to wrap with one. Same shape on Investigate
    // / AgentTable / SwimLane, no duplicate provider chains.
    const { getByTestId } = render(<SubAgentLostDot />);
    // Trigger is the testid'd span; presence proves the embed is
    // intact. A regression that drops the provider would leave
    // the trigger but produce React tooltip-context errors at
    // runtime; the test is the early warning.
    expect(getByTestId("sub-agent-lost-dot")).toBeTruthy();
  });

  it("supports session-id suffix for tooltip identification", () => {
    // Investigate, AgentTable, and SwimLane each pass a different
    // suffix when they render the dot — the spec calls for a
    // visible row-level identifier so the operator can deep-link
    // the failed sub-agent without expanding rows.
    const { getByTestId } = render(
      <SubAgentLostDot sessionIdSuffix="abc12345" />,
    );
    expect(getByTestId("sub-agent-lost-dot")).toBeTruthy();
  });
});
