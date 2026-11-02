import { test, expect } from "@playwright/test";
import {
  CONNECTOR_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T133 — A sub-agent connector ends on the circles it joins.
//
// The overlay used to compute its endpoints from the time scale and
// the row's centre, which put every end 19 px left of its circle (the
// panel's inset) and about 11 px below it (the circles sat high).
// Timeline.tsx now measures the rendered circles: the path starts on
// the rim of the parent's spawn-event circle and ends at the centre of
// the child's first in-window circle, both found by `data-event-id`.
//
// The check covers every connector the 5m window draws: the
// connector-parent pair, the fan-out coordinator's three worker
// connectors, and any other canonical pair in view. Geometry only, so
// both theme projects run it unchanged.

test.use({ viewport: { width: 1600, height: 1800 } });

// A path endpoint is a float the overlay computed from the same
// rects this spec reads, so anything past sub-pixel rounding is a
// real miss. The old geometry missed by 19 px and 11 px.
const ENDPOINT_TOLERANCE_PX = 1.5;

test.describe("T133 — sub-agent connector ends on the circles it joins", () => {
  test("every connector starts on its parent circle's rim and ends on its child circle's centre", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    await page.getByRole("button", { name: "5m", exact: true }).click();
    // Children sit right under their parent, so bringing the child
    // into view mounts both rows of the pair.
    await bringSwimlaneRowIntoView(page, CONNECTOR_FIXTURE.childName);

    const paths = page.locator(
      '[data-testid="sub-agent-connector-overlay"] path[data-parent-event-id]',
    );
    await expect
      .poll(() => paths.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // One evaluate, so the path geometry and the circle rects come
    // from the same rendered frame (the scale steps once a second).
    const report = await page.evaluate(() => {
      const svg = document.querySelector(
        '[data-testid="sub-agent-connector-overlay"]',
      ) as SVGSVGElement;
      const origin = svg.getBoundingClientRect();
      const circleIn = (eventId: string | null) =>
        eventId
          ? document.querySelector<HTMLElement>(
              `[data-testid^="swimlane-agent-row-"] [data-event-id="${CSS.escape(eventId)}"]`,
            )
          : null;
      const centre = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.left - origin.left + r.width / 2,
          y: r.top - origin.top + r.height / 2,
        };
      };
      return Array.from(svg.querySelectorAll("path[data-parent-event-id]")).map(
        (path) => {
          const nums = (path.getAttribute("d") ?? "")
            .replace(/[MQ]/g, " ")
            .trim()
            .split(/\s+/)
            .map(Number);
          const [sx, sy, , , ex, ey] = nums;
          const parent = circleIn(path.getAttribute("data-parent-event-id"));
          const child = circleIn(path.getAttribute("data-child-event-id"));
          if (!parent || !child) {
            return { id: path.getAttribute("data-testid"), missing: true };
          }
          const pc = centre(parent);
          const cc = centre(child);
          const radius = parent.offsetWidth / 2;
          return {
            id: path.getAttribute("data-testid"),
            missing: false,
            startOffRim: Math.abs(Math.hypot(sx! - pc.x, sy! - pc.y) - radius),
            endOffCentre: Math.hypot(ex! - cc.x, ey! - cc.y),
          };
        },
      );
    });

    expect(report.length).toBeGreaterThanOrEqual(1);
    for (const r of report) {
      expect(r.missing, `${r.id}: a joined circle is not mounted`).toBe(false);
      expect(r.startOffRim!, `${r.id}: start is off the parent circle's rim`).toBeLessThanOrEqual(
        ENDPOINT_TOLERANCE_PX,
      );
      expect(r.endOffCentre!, `${r.id}: end is off the child circle's centre`).toBeLessThanOrEqual(
        ENDPOINT_TOLERANCE_PX,
      );
    }
  });
});
