import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  FANOUT_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T134 — Hovering a run lights its connectors, and only its own.
//
// Connectors rest at 10% opacity. Hovering any mark of a run (an
// event circle or a run glyph), or keyboard-focusing its glyph, raises every
// connector that starts or ends on that run to 50%
// (`data-hover="true"`). The fan-out fixture makes the "only its own"
// half observable: the coordinator run owns three worker connectors,
// and each worker run owns one of them, on a row the three runs share.
//
// The worker runs start together, so their circles stack, and the
// overlay redraws every second as the window moves (a connector whose
// parent event just left the window drops out until the next pair
// forms). The spec therefore hovers a worker circle that is on top at
// its own centre and belongs to a run that has a connector, and every
// check polls for "exactly this run's connectors are lit, and it has
// at least one" in a single read.
//
// No fixed waits. Both theme projects run it unchanged (attributes
// only, no colours).

test.use({ viewport: { width: 1600, height: 1800 } });

type ConnectorState = {
  parent: string;
  child: string;
  hover: string;
};

async function connectorStates(page: Page): Promise<ConnectorState[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<SVGPathElement>(
        '[data-testid="sub-agent-connector-overlay"] path[data-parent-session-id]',
      ),
    ).map((p) => ({
      parent: p.getAttribute("data-parent-session-id") ?? "",
      child: p.getAttribute("data-child-session-id") ?? "",
      hover: p.getAttribute("data-hover") ?? "",
    })),
  );
}

const touches = (s: ConnectorState, runId: string) => s.parent === runId || s.child === runId;

/** Exactly the connectors touching ``runId`` are lit, and there is at
 *  least one; with ``null``, none is lit. */
async function litExactlyFor(page: Page, runId: string | null): Promise<boolean> {
  const states = await connectorStates(page);
  const exact = states.every((s) => (s.hover === "true") === (runId !== null && touches(s, runId)));
  return exact && (runId === null || states.some((s) => touches(s, runId)));
}

async function moveMouseOffTheSwimlane(page: Page): Promise<void> {
  // The page header carries no run marks.
  await page.mouse.move(5, 5);
}

/** Centre of the first circle in ``row`` that belongs to one of
 *  ``runs`` and is the topmost element at its own centre, so the
 *  pointer there hovers that circle's run. */
async function reachableCircleOf(
  row: Locator,
  runs: string[],
): Promise<{ x: number; y: number; run: string } | null> {
  return row.evaluate((rowEl, wanted) => {
    for (const c of Array.from(
      rowEl.querySelectorAll<HTMLElement>("[data-event-id][data-session-id]"),
    )) {
      const run = c.getAttribute("data-session-id") ?? "";
      if (!wanted.includes(run)) continue;
      const r = c.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === c || c.contains(hit))) return { x, y, run };
    }
    return null;
  }, runs);
}

test.describe("T134 — hovering a run lights its connectors", () => {
  test("parent run, child run, mouse-out and glyph focus each light exactly that run's connectors", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFleetReady(page);
    await page.getByRole("button", { name: "5m", exact: true }).click();
    const workerRow = await bringSwimlaneRowIntoView(page, FANOUT_FIXTURE.workerName);
    await expect(workerRow).toBeVisible();
    const coordinatorRow = page.locator(
      `[data-testid="swimlane-agent-row-${FANOUT_FIXTURE.coordinatorName}"]`,
    );
    await expect(coordinatorRow).toBeVisible();

    // The coordinator has one run; its circles carry that run's id.
    const coordinatorRunId = await coordinatorRow
      .locator("[data-session-id]")
      .first()
      .getAttribute("data-session-id");
    expect(coordinatorRunId).toBeTruthy();
    const coordinator = coordinatorRunId!;

    // Wait for the fan-out: at least two worker connectors drawn from
    // the coordinator's run (the keep-alive posts all three).
    await expect
      .poll(
        async () =>
          (await connectorStates(page)).filter((s) => s.parent === coordinator).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);
    await moveMouseOffTheSwimlane(page);
    await expect.poll(() => litExactlyFor(page, null)).toBe(true);

    // 1. Parent side: hovering one of the coordinator's circles lights
    //    every worker connector and nothing else.
    const parentTarget = await reachableCircleOf(coordinatorRow, [coordinator]);
    expect(parentTarget, "a coordinator circle the pointer can reach").not.toBeNull();
    await page.mouse.move(parentTarget!.x, parentTarget!.y);
    await expect.poll(() => litExactlyFor(page, coordinator)).toBe(true);

    // 2. Child side: hover a worker circle of a run that has a
    //    connector. Only that run's connector lights; the other worker
    //    runs on the same row stay dark.
    let childTarget: { x: number; y: number; run: string } | null = null;
    await expect
      .poll(
        async () => {
          const workerRuns = (await connectorStates(page))
            .filter((s) => s.parent === coordinator)
            .map((s) => s.child);
          childTarget = await reachableCircleOf(workerRow, workerRuns);
          return childTarget;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();
    const hoveredRun = childTarget!.run;
    expect(hoveredRun).not.toBe(coordinator);
    await page.mouse.move(childTarget!.x, childTarget!.y);
    await expect.poll(() => litExactlyFor(page, hoveredRun)).toBe(true);

    // 3. Mouse-out clears the highlight.
    await moveMouseOffTheSwimlane(page);
    await expect.poll(() => litExactlyFor(page, null)).toBe(true);

    // 4. Keyboard: focusing another worker run's start glyph lights
    //    that run's connector the way hovering does. Only keyboard
    //    (``:focus-visible``) focus counts, so the glyph is focused the
    //    way a Tab would focus it; a mouse click's focus would not.
    const otherWorker = (await connectorStates(page)).find(
      (s) => s.parent === coordinator && s.child !== hoveredRun,
    );
    expect(otherWorker, "a second worker run with a connector").toBeTruthy();
    const glyph = page.getByTestId(
      `swimlane-run-bracket-start-${otherWorker!.child.slice(0, 8)}`,
    );
    await glyph.evaluate((el) =>
      (el as HTMLElement).focus({ focusVisible: true } as FocusOptions),
    );
    await expect(glyph).toBeFocused();
    await expect.poll(() => litExactlyFor(page, otherWorker!.child)).toBe(true);
    await glyph.blur();
    await expect.poll(() => litExactlyFor(page, null)).toBe(true);
  });
});
