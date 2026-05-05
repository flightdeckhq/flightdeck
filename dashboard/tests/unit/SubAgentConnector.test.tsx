import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  SubAgentConnector,
  anchorOnCircle,
  buildConnectorPath,
  pickSpawnEvent,
  type SubAgentConnectorSpec,
} from "@/components/timeline/SubAgentConnector";

// D126 § 4.3 — sub-agent connector overlay. Pure-math helpers
// drive the geometry; the React component renders a single SVG
// with one <path> per spec. Tests below exercise the math AND the
// rendering contract (testid + opacity + hover state) so a future
// regression in either layer surfaces with a focused failure.

describe("anchorOnCircle (D126 § 4.3 hemisphere lock)", () => {
  // Children rendered ABOVE the parent connect via the top of the
  // circle (negative y in screen coordinates); children BELOW
  // connect via the bottom. The natural direction projection
  // already lands the anchor on the correct hemisphere — this
  // test pins that behavior so a future refactor that changes the
  // sign convention surfaces here.
  it("anchors on top hemisphere when child is above the parent", () => {
    const { ax, ay } = anchorOnCircle(100, 100, 10, 100, 50);
    expect(ax).toBeCloseTo(100, 5);
    expect(ay).toBeCloseTo(90, 5);
  });

  it("anchors on bottom hemisphere when child is below the parent", () => {
    const { ax, ay } = anchorOnCircle(100, 100, 10, 100, 200);
    expect(ax).toBeCloseTo(100, 5);
    expect(ay).toBeCloseTo(110, 5);
  });

  it("anchors at 45° when child is diagonally below-right", () => {
    const { ax, ay } = anchorOnCircle(0, 0, 10, 50, 50);
    const expectedComponent = 10 / Math.SQRT2;
    expect(ax).toBeCloseTo(expectedComponent, 5);
    expect(ay).toBeCloseTo(expectedComponent, 5);
  });

  it("falls back gracefully when target is at the circle centre", () => {
    // Degenerate case: target sits at circle centre. The function
    // drops the anchor to the bottom of the circle so the path
    // stays renderable (no NaN). Brittle math here would explode
    // the SVG d= attribute and crash the chart — pin the safe
    // fallback explicitly.
    const { ax, ay } = anchorOnCircle(50, 50, 10, 50, 50);
    expect(ax).toBe(50);
    expect(ay).toBe(60);
  });
});

describe("buildConnectorPath", () => {
  it("emits an M anchor + Q control + child end-point", () => {
    const spec: SubAgentConnectorSpec = {
      id: "p1->c1",
      parentX: 100,
      parentY: 200,
      parentR: 10,
      childX: 300,
      childY: 250,
    };
    const d = buildConnectorPath(spec);
    // Quadratic Bezier shape: M ax ay Q cx cy x y
    expect(d).toMatch(/^M [\d.\-]+ [\d.\-]+ Q [\d.\-]+ [\d.\-]+ 300 250$/);
  });

  it("anchor sits on the parent's circumference (radius from centre)", () => {
    const spec: SubAgentConnectorSpec = {
      id: "p->c",
      parentX: 0,
      parentY: 0,
      parentR: 25,
      childX: 100,
      childY: 0,
    };
    const d = buildConnectorPath(spec);
    const m = d.match(/^M ([\d.\-]+) ([\d.\-]+) /);
    expect(m).not.toBeNull();
    const [ax, ay] = [parseFloat(m![1]), parseFloat(m![2])];
    const distFromCentre = Math.sqrt(ax * ax + ay * ay);
    expect(distFromCentre).toBeCloseTo(25, 4);
  });
});

describe("pickSpawnEvent", () => {
  // Time-proximity heuristic: parent's most recent event ≤ child's
  // first event time. Falls back to the parent's first event when
  // every parent event came AFTER the child (clock skew edge-case).
  it("picks the parent event closest in time before the child", () => {
    const events = [
      { occurred_at: "2026-05-03T10:00:00Z" },
      { occurred_at: "2026-05-03T10:05:00Z" },
      { occurred_at: "2026-05-03T10:10:00Z" },
    ];
    const child = { occurred_at: "2026-05-03T10:07:00Z" };
    const picked = pickSpawnEvent(events, child);
    expect(picked?.occurred_at).toBe("2026-05-03T10:05:00Z");
  });

  it("falls back to the first parent event when none precede the child", () => {
    const events = [
      { occurred_at: "2026-05-03T11:00:00Z" },
      { occurred_at: "2026-05-03T11:10:00Z" },
    ];
    const child = { occurred_at: "2026-05-03T10:00:00Z" };
    const picked = pickSpawnEvent(events, child);
    expect(picked?.occurred_at).toBe("2026-05-03T11:00:00Z");
  });

  it("returns null on an empty parent event list", () => {
    expect(pickSpawnEvent([], { occurred_at: "2026-05-03T10:00:00Z" })).toBeNull();
  });
});

describe("SubAgentConnector component", () => {
  // Covers the rendering contract T34 asserts on:
  //   * Renders no overlay when there are zero connectors (no
  //     overdraw on root-only fleet snapshots).
  //   * Stamps a stable per-connector testid so E2E selectors can
  //     pin the exact line being tested.
  //   * 10% opacity at rest, 50% on hover (design § 4.3 lock).

  it("renders an empty overlay (no path children) when connectors[] is empty", () => {
    // The overlay SVG mounts regardless so the testid is a
    // stable signal that the Timeline composed in connector-
    // aware mode; PATHS render conditionally — the design § 4.3
    // "no overdraw" lock applies to path count, not to the
    // empty-overlay element which has no visual footprint.
    const { getByTestId, queryAllByTestId } = render(
      <SubAgentConnector connectors={[]} width={500} height={300} />,
    );
    const overlay = getByTestId("sub-agent-connector-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute("data-connector-count")).toBe("0");
    // Exclude the overlay testid itself; the path testids embed
    // the connector id which contains an arrow ``->``. The regex
    // matches "sub-agent-connector-X" where X starts with non-
    // overlay content (anything other than the literal "overlay").
    expect(queryAllByTestId(/^sub-agent-connector-(?!overlay$)/)).toHaveLength(0);
  });

  it("returns null when width or height is zero (pre-measure render)", () => {
    const { container } = render(
      <SubAgentConnector connectors={[]} width={0} height={0} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("stamps a sub-agent-connector-<id> testid per spec", () => {
    const specs: SubAgentConnectorSpec[] = [
      { id: "p1->c1", parentX: 50, parentY: 50, parentR: 11, childX: 200, childY: 100 },
      { id: "p2->c2", parentX: 80, parentY: 60, parentR: 11, childX: 250, childY: 150 },
    ];
    const { getByTestId } = render(
      <SubAgentConnector connectors={specs} width={500} height={300} />,
    );
    expect(getByTestId("sub-agent-connector-p1->c1")).toBeTruthy();
    expect(getByTestId("sub-agent-connector-p2->c2")).toBeTruthy();
  });

  it("renders at 10% opacity at rest and 50% when hoveredId matches", () => {
    const spec: SubAgentConnectorSpec = {
      id: "p1->c1",
      parentX: 50,
      parentY: 50,
      parentR: 11,
      childX: 200,
      childY: 100,
    };
    const { rerender, getByTestId } = render(
      <SubAgentConnector connectors={[spec]} width={500} height={300} />,
    );
    const path = getByTestId("sub-agent-connector-p1->c1") as SVGPathElement;
    // The path's inline opacity reflects the active flag. The
    // value is 0.1 at rest; when hover fires (either internal
    // mouseEnter or external hoveredId match) it's 0.5.
    expect(path.getAttribute("opacity")).toBe("0.1");
    rerender(
      <SubAgentConnector
        connectors={[spec]}
        width={500}
        height={300}
        hoveredId="p1->c1"
      />,
    );
    expect(path.getAttribute("opacity")).toBe("0.5");
  });

  it("data-hover attr toggles in lockstep with the opacity", () => {
    const spec: SubAgentConnectorSpec = {
      id: "p1->c1",
      parentX: 50,
      parentY: 50,
      parentR: 11,
      childX: 200,
      childY: 100,
    };
    const { rerender, getByTestId } = render(
      <SubAgentConnector connectors={[spec]} width={500} height={300} />,
    );
    expect(getByTestId("sub-agent-connector-p1->c1").getAttribute("data-hover"))
      .toBe("false");
    rerender(
      <SubAgentConnector
        connectors={[spec]}
        width={500}
        height={300}
        hoveredId="p1->c1"
      />,
    );
    expect(getByTestId("sub-agent-connector-p1->c1").getAttribute("data-hover"))
      .toBe("true");
  });
});
