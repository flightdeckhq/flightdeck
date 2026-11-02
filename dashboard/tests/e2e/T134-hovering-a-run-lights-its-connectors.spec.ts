import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  FANOUT_FIXTURE,
  bringSwimlaneRowIntoView,
  waitForFleetReady,
} from "./_fixtures";

// T134 — Hovering a run lights its connectors, and only its own.
//
// Connectors rest at 10% opacity. Hovering any mark of a run (an
// event circle or a run glyph), or focusing its glyph, raises every
// connector that starts or ends on that run to 50%
// (`data-hover="true"`). The fan-out fixture makes the "only its own"
// half observable: the coordinator run owns three worker connectors,
// and each worker run owns one of them, on a row the three runs share.
//
// No fixed waits: every check polls the overlay's attributes. Both
// theme projects run it unchanged (attributes only, no colours).

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

/** For each connector: does its lit state match "touches the run"? */
function litExactlyFor(states: ConnectorState[], runId: string | null): boolean {
  return states.every(
    (s) => (s.hover === "true") === (runId !== null && (s.parent === runId || s.child === runId)),
  );
}

async function moveMouseOffTheSwimlane(page: Page): Promise<void> {
  // The page header carries no run marks.
  await page.mouse.move(5, 5);
}

/** Move the pointer to a circle's centre and return the id of the run
 *  whose mark is under it (the topmost element there, which on a
 *  stack of same-time circles may belong to a sibling run). */
async function pointAtCircle(page: Page, circle: Locator): Promise<string | null> {
  const box = await circle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  return page.evaluate(
    ({ px, py }) =>
      document
        .elementFromPoint(px, py)
        ?.closest("[data-session-id]")
        ?.getAttribute("data-session-id") ?? null,
    { px: x, py: y },
  );
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

    // Wait for the fan-out: at least two worker connectors drawn from
    // the coordinator's run (the keep-alive posts all three).
    await expect
      .poll(
        async () =>
          (await connectorStates(page)).filter((s) => s.parent === coordinatorRunId)
            .length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);
    await moveMouseOffTheSwimlane(page);
    await expect.poll(async () => litExactlyFor(await connectorStates(page), null)).toBe(true);

    const fanoutPath = page
      .locator(
        `[data-testid="sub-agent-connector-overlay"] path[data-parent-session-id="${coordinatorRunId}"]`,
      )
      .first();

    // 1. Parent side: hovering the coordinator's spawn circle lights
    //    every worker connector and nothing else. The pointer goes to
    //    the circle's centre; whichever of the run's circles is on top
    //    there, the run under the pointer is the coordinator's.
    const spawnEventId = await fanoutPath.getAttribute("data-parent-event-id");
    const parentRun = await pointAtCircle(
      page,
      coordinatorRow.locator(`[data-event-id="${spawnEventId}"]`),
    );
    expect(parentRun).toBe(coordinatorRunId);
    await expect
      .poll(async () => litExactlyFor(await connectorStates(page), coordinatorRunId))
      .toBe(true);

    // 2. Child side: hover the worker circle a fan-out connector ends
    //    on. The three worker runs start together, so their circles
    //    can stack; the run under the pointer is the one that lights.
    const childEventId = await fanoutPath.getAttribute("data-child-event-id");
    const hoveredRun = await pointAtCircle(
      page,
      workerRow.locator(`[data-event-id="${childEventId}"]`),
    );
    expect(hoveredRun).toBeTruthy();
    expect(hoveredRun).not.toBe(coordinatorRunId);
    await expect
      .poll(async () => litExactlyFor(await connectorStates(page), hoveredRun))
      .toBe(true);
    // Exactly one connector belongs to that worker run, and the other
    // worker runs' connectors stay dark.
    const afterChildHover = await connectorStates(page);
    expect(afterChildHover.filter((s) => s.hover === "true")).toHaveLength(1);

    // 3. Mouse-out clears the highlight.
    await moveMouseOffTheSwimlane(page);
    await expect.poll(async () => litExactlyFor(await connectorStates(page), null)).toBe(true);

    // 4. Keyboard: focusing a worker run's start glyph lights that
    //    run's connector the way hovering does.
    const otherWorker = afterChildHover.find(
      (s) => s.parent === coordinatorRunId && s.child !== hoveredRun,
    );
    expect(otherWorker).toBeTruthy();
    const glyph = page.getByTestId(
      `swimlane-run-bracket-start-${otherWorker!.child.slice(0, 8)}`,
    );
    await glyph.focus();
    await expect
      .poll(async () => litExactlyFor(await connectorStates(page), otherWorker!.child))
      .toBe(true);
    await glyph.blur();
    await expect.poll(async () => litExactlyFor(await connectorStates(page), null)).toBe(true);
  });
});
