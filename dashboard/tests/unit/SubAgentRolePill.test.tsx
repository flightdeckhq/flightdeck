import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SubAgentRolePill, SubAgentLostDot } from "@/components/facets/SubAgentRolePill";

describe("SubAgentRolePill (D126)", () => {
  it("renders the child glyph and role string for child topology", () => {
    const { getByTestId } = render(
      <SubAgentRolePill role="Researcher" topology="child" />,
    );
    const pill = getByTestId("sub-agent-role-pill");
    // The leftward-arrow glyph is the visual cue that the row is a
    // sub-agent spawned by a parent. Cementing the contract — flipping
    // the glyph to ⤴ would lie about the topology.
    expect(pill.textContent).toContain("↳");
    expect(pill.textContent).toContain("Researcher");
    expect(pill.dataset.topology).toBe("child");
  });

  it("renders the parent glyph for parent topology", () => {
    const { getByTestId } = render(
      <SubAgentRolePill role="" topology="parent" />,
    );
    const pill = getByTestId("sub-agent-role-pill");
    // ⤴ signals "this row spawns sub-agents". Empty role string
    // falls back to literal "parent" label so a parent agent (which
    // by design has no role of its own) still renders meaningfully.
    expect(pill.textContent).toContain("⤴");
    expect(pill.textContent).toContain("parent");
  });

  it("renders nothing for lone topology", () => {
    const { container } = render(
      <SubAgentRolePill role="x" topology="lone" />,
    );
    // Lone agents have no relationship to surface — rendering the
    // pill on a lone row would lie about topology.
    expect(container.firstChild).toBeNull();
  });

  it("respects custom testId", () => {
    const { getByTestId } = render(
      <SubAgentRolePill role="Writer" topology="child" testId="x" />,
    );
    expect(getByTestId("x")).toBeTruthy();
  });
});

describe("SubAgentLostDot (D126 § L8)", () => {
  it("renders with the lost-state colour", () => {
    const { getByTestId } = render(<SubAgentLostDot />);
    const dot = getByTestId("sub-agent-lost-dot");
    // The dot reads from --status-lost so both themes pick up the
    // theme-correct red. Asserting the inline style references the
    // CSS variable rather than a hardcoded hex catches an accidental
    // theme-bypass.
    expect(dot.style.color).toContain("--status-lost");
  });
});
