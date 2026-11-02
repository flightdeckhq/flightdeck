import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  SubAgentConnector,
  anchorOnCircle,
  buildConnectorPath,
  centreWithin,
  circleCentre,
  connectorTouchesRun,
  pickSpawnEvent,
  type SubAgentConnectorSpec,
} from "@/components/timeline/SubAgentConnector";

/** A full spec between parent run ``p`` and child run ``c``. */
function mkSpec(
  p: string,
  c: string,
  geometry: Partial<SubAgentConnectorSpec> = {},
): SubAgentConnectorSpec {
  return {
    id: `${p}->${c}`,
    parentSessionId: p,
    childSessionId: c,
    parentEventId: `${p}-spawn`,
    childEventId: `${c}-first`,
    parentX: 50,
    parentY: 50,
    parentR: 11,
    childX: 200,
    childY: 100,
    ...geometry,
  };
}

// Sub-agent connector overlay. Pure-math helpers
// drive the geometry; the React component renders a single SVG
// with one <path> per spec. Tests below exercise the math AND the
// rendering contract (testid + opacity + hover state) so a future
// regression in either layer surfaces with a focused failure.

describe("anchorOnCircle (hemisphere lock)", () => {
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
    const spec = mkSpec("p1", "c1", {
      parentX: 100,
      parentY: 200,
      parentR: 10,
      childX: 300,
      childY: 250,
    });
    const d = buildConnectorPath(spec);
    // Quadratic Bezier shape: M ax ay Q cx cy x y
    expect(d).toMatch(/^M [\d.\-]+ [\d.\-]+ Q [\d.\-]+ [\d.\-]+ 300 250$/);
  });

  it("anchor sits on the parent's circumference (radius from centre)", () => {
    const spec = mkSpec("p", "c", {
      parentX: 0,
      parentY: 0,
      parentR: 25,
      childX: 100,
      childY: 0,
    });
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
      mkSpec("p1", "c1"),
      mkSpec("p2", "c2", { parentX: 80, parentY: 60, childX: 250, childY: 150 }),
    ];
    const { getByTestId } = render(
      <SubAgentConnector connectors={specs} width={500} height={300} />,
    );
    expect(getByTestId("sub-agent-connector-p1->c1")).toBeTruthy();
    expect(getByTestId("sub-agent-connector-p2->c2")).toBeTruthy();
  });

  it("renders at 10% opacity at rest and 50% when hoveredId names one of its runs", () => {
    const spec = mkSpec("p1", "c1");
    const { rerender, getByTestId } = render(
      <SubAgentConnector connectors={[spec]} width={500} height={300} />,
    );
    const path = getByTestId("sub-agent-connector-p1->c1") as SVGPathElement;
    // The path's inline opacity reflects the active flag. The
    // value is 0.1 at rest; when hover fires (either internal
    // mouseEnter or an external hoveredId naming the parent or the
    // child run) it's 0.5.
    expect(path.getAttribute("opacity")).toBe("0.1");
    for (const runId of ["p1", "c1"]) {
      rerender(
        <SubAgentConnector
          connectors={[spec]}
          width={500}
          height={300}
          hoveredId={runId}
        />,
      );
      expect(path.getAttribute("opacity")).toBe("0.5");
    }
    // An unrelated run, or the connector's own id, leaves it at rest.
    for (const other of ["c2", "p1->c1", null]) {
      rerender(
        <SubAgentConnector
          connectors={[spec]}
          width={500}
          height={300}
          hoveredId={other}
        />,
      );
      expect(path.getAttribute("opacity")).toBe("0.1");
    }
  });

  it("data-hover attr toggles in lockstep with the opacity", () => {
    const spec = mkSpec("p1", "c1");
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
        hoveredId="c1"
      />,
    );
    expect(getByTestId("sub-agent-connector-p1->c1").getAttribute("data-hover"))
      .toBe("true");
  });

  it("a hovered parent run lights its whole fan-out; a hovered child run only its own link", () => {
    const fanout = [mkSpec("p", "w1"), mkSpec("p", "w2"), mkSpec("p", "w3"), mkSpec("q", "x")];
    const { rerender, getByTestId } = render(
      <SubAgentConnector connectors={fanout} width={500} height={300} hoveredId="p" />,
    );
    const hover = (id: string) =>
      getByTestId(`sub-agent-connector-${id}`).getAttribute("data-hover");
    expect([hover("p->w1"), hover("p->w2"), hover("p->w3"), hover("q->x")]).toEqual([
      "true",
      "true",
      "true",
      "false",
    ]);
    rerender(<SubAgentConnector connectors={fanout} width={500} height={300} hoveredId="w2" />);
    expect([hover("p->w1"), hover("p->w2"), hover("p->w3"), hover("q->x")]).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
  });

  it("exposes each end's run and event ids on the path", () => {
    const { getByTestId } = render(
      <SubAgentConnector connectors={[mkSpec("p1", "c1")]} width={500} height={300} />,
    );
    const path = getByTestId("sub-agent-connector-p1->c1");
    expect(path.getAttribute("data-parent-session-id")).toBe("p1");
    expect(path.getAttribute("data-child-session-id")).toBe("c1");
    expect(path.getAttribute("data-parent-event-id")).toBe("p1-spawn");
    expect(path.getAttribute("data-child-event-id")).toBe("c1-first");
  });
});

describe("circleCentre", () => {
  it("maps a circle's viewport rect into the overlay's coordinates", () => {
    // Container (the overlay's origin) at (100, 40); a 22 px circle
    // whose box starts at (311, 152) has its centre at (222, 123).
    expect(
      circleCentre({ left: 311, top: 152, width: 22, height: 22 }, { left: 100, top: 40 }),
    ).toEqual({ x: 222, y: 123 });
  });

  it("keeps the centre of a hover-scaled circle", () => {
    // A 1.25x hover grows the 22 px box to 27.5 px about its centre.
    const resting = circleCentre(
      { left: 311, top: 152, width: 22, height: 22 },
      { left: 0, top: 0 },
    );
    const scaled = circleCentre(
      { left: 311 - 2.75, top: 152 - 2.75, width: 27.5, height: 27.5 },
      { left: 0, top: 0 },
    );
    expect(scaled.x).toBeCloseTo(resting.x, 10);
    expect(scaled.y).toBeCloseTo(resting.y, 10);
  });
});

describe("centreWithin", () => {
  // The row's timeline panel spans x 100..1000. A circle near "now" is
  // clipped by the panel with its centre past the right edge; the
  // overlay must not draw a connector to it.
  const panel = { left: 100, top: 0, right: 1000, bottom: 48 };

  it("is true for a circle whose centre is inside the panel", () => {
    expect(centreWithin({ left: 500, top: 13, width: 22, height: 22 }, panel)).toBe(true);
    // Overlapping the edge, but the centre (996) is still inside.
    expect(centreWithin({ left: 985, top: 13, width: 22, height: 22 }, panel)).toBe(true);
  });

  it("is false once the centre passes the panel's edge", () => {
    expect(centreWithin({ left: 995, top: 13, width: 22, height: 22 }, panel)).toBe(false);
    expect(centreWithin({ left: 80, top: 13, width: 22, height: 22 }, panel)).toBe(false);
    expect(centreWithin({ left: 500, top: 40, width: 22, height: 22 }, panel)).toBe(false);
  });
});

describe("connectorTouchesRun", () => {
  it("is true only for a run at either end", () => {
    const spec = mkSpec("p", "c");
    expect(connectorTouchesRun(spec, "p")).toBe(true);
    expect(connectorTouchesRun(spec, "c")).toBe(true);
    expect(connectorTouchesRun(spec, "x")).toBe(false);
    expect(connectorTouchesRun(spec, null)).toBe(false);
    expect(connectorTouchesRun(spec, undefined)).toBe(false);
    expect(connectorTouchesRun(spec, "")).toBe(false);
  });
});
