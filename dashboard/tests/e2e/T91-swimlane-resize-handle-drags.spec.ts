import { test, expect, type Locator } from "@playwright/test";
import { waitForFleetReady } from "./_fixtures";

// T91 — left-panel resize handle drag + persistence. The pre-Fix-1
// handle clamped at LEFT_PANEL_MAX_WIDTH=500 so an operator
// starting from a stored 500px could not drag any wider — the
// drag silently no-op'd. Fix 1 raises the cap to 640 and widens
// the hit area from 6→10px; this spec locks both in:
//
//   1. Drag the handle ~200px to the right from the default
//      460px starting width. New width MUST land above 500
//      (proves the old upper clamp is gone) and at or below 640
//      (proves the new cap holds).
//   2. The post-drag width is persisted to localStorage under
//      the canonical key.
//   3. After page reload, the column re-mounts at the persisted
//      width, not the default — the lazy useState initialiser
//      and the persist round-trip both work end-to-end.
//
// Viewport: wider than Playwright's default 1280 px so the
// timeline canvas (`leftPanelWidth + timelineWidth + sidebar`)
// fits without engaging Fleet's horizontal scroll (T24's regime).
// At narrow widths Fleet defaults scrollLeft to "now", which
// scrolls the resize handle off-screen to the left — boundingBox
// still reports a position but `page.mouse.move` to that
// off-screen coordinate fails to land on the handle. A wide
// viewport keeps the handle in view; a separate spec
// (T24) covers the narrow-viewport scroll contract.
const VIEWPORT_WIDE = { width: 1800, height: 900 };

// Dispatch a synthetic PointerEvent drag (pointerdown on the
// handle → pointermove on document → pointerup on document) at
// page coordinates. We dispatch directly via JS rather than
// page.mouse.move/down/up because Playwright's CDP-driven mouse
// path proved unreliable for this particular handle: the handler
// binds ``pointermove`` listeners to ``document`` on
// ``pointerdown``, and CDP's mouse-to-pointer-event synthesis was
// not delivering the ``pointermove`` events to the document-level
// listener in this layout — the in-page PointerEvent dispatch
// hits the listener every time. This is functionally equivalent
// from the handler's perspective (same React-synthetic
// pointerdown, same native document pointermove + pointerup) and
// matches the resilience pattern QA notes call out for swimlane
// E2E.
async function dragHandle(
  handle: Locator,
  deltaX: number,
): Promise<void> {
  await handle.evaluate((el, dx) => {
    const rect = el.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 1,
    } as const;
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...opts,
        clientX: startX,
        clientY: startY,
        button: 0,
        buttons: 1,
      }),
    );
    // Two intermediate moves so React's reducer commits at least
    // once before the final position — mirrors a real-world drag
    // with multiple frame-level moves.
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        ...opts,
        clientX: startX + dx / 2,
        clientY: startY,
        button: -1,
        buttons: 1,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        ...opts,
        clientX: startX + dx,
        clientY: startY,
        button: -1,
        buttons: 1,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        ...opts,
        clientX: startX + dx,
        clientY: startY,
        button: 0,
        buttons: 0,
      }),
    );
  }, deltaX);
}

test.describe("T91 — Swimlane left-panel resize handle drags + persists", () => {
  test("dragging the handle past 500 widens the column and persists across reload", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT_WIDE);
    await page.goto("/");
    await waitForFleetReady(page);

    // Clear AFTER initial mount via page.evaluate (not
    // addInitScript) so the reload mid-test reads the
    // drag-persisted value rather than re-firing the clear.
    // addInitScript fires on every navigation including reloads,
    // which would wipe what the drag just wrote. Pattern matches
    // T23's investigate-sidebar-resizable spec.
    await page.evaluate(() =>
      localStorage.removeItem("flightdeck-left-panel-width"),
    );
    await page.reload();
    await waitForFleetReady(page);

    const handle = page.locator('[data-testid="left-panel-resize-handle"]');
    await expect(handle).toBeVisible();
    await handle.scrollIntoViewIfNeeded();

    const handleBoxBefore = await handle.boundingBox();
    expect(handleBoxBefore).not.toBeNull();

    // Drag 200 px to the right. From the 460 default that targets
    // 660 → clamped to MAX 640. The assertion below tolerates the
    // clamp by only requiring strictly greater than the old 500 cap.
    await dragHandle(handle, 200);

    // Sanity check first: did the drag move the rendered handle?
    // If this fails, the drag never engaged.
    await expect
      .poll(async () => (await handle.boundingBox())?.x ?? handleBoxBefore!.x, {
        message:
          "expected the resize handle to move right after the drag — pointerdown likely missed the hit area",
        timeout: 5_000,
      })
      .toBeGreaterThan(handleBoxBefore!.x + 30);

    // Poll the persisted value: the handler writes through to
    // localStorage on every move so the post-up read should be
    // immediate, but polling rides the React render tick.
    await expect
      .poll(
        async () =>
          parseInt(
            (await page.evaluate(() =>
              localStorage.getItem("flightdeck-left-panel-width"),
            )) ?? "0",
            10,
          ),
        {
          message:
            "expected the persisted column width to exceed the old 500-px cap after a rightward drag",
          timeout: 5_000,
        },
      )
      .toBeGreaterThan(500);

    const persistedRaw = await page.evaluate(() =>
      localStorage.getItem("flightdeck-left-panel-width"),
    );
    expect(persistedRaw).not.toBeNull();
    const persisted = parseInt(persistedRaw!, 10);
    // Upper bound proves the new 640 clamp engages — without it a
    // far drag could keep going past 640 indefinitely.
    expect(persisted).toBeLessThanOrEqual(640);

    // Reload — the column must re-mount at the persisted width,
    // not at the default. Read the rendered handle's left edge
    // after reload and compare to the persisted value.
    await page.reload();
    await waitForFleetReady(page);

    const reloadedHandle = page.locator(
      '[data-testid="left-panel-resize-handle"]',
    );
    await expect(reloadedHandle).toBeVisible();
    const reloadedLeft = await reloadedHandle.evaluate(
      (el) => parseFloat((el as HTMLElement).style.left) || 0,
    );
    // The handle renders at ``left: leftPanelWidth - 5``; allow a
    // 2 px slack to absorb sub-pixel rounding on high-DPI displays.
    expect(Math.abs(reloadedLeft - (persisted - 5))).toBeLessThanOrEqual(2);
  });

  test("dragging far to the left clamps to LEFT_PANEL_MIN_WIDTH (200)", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT_WIDE);
    await page.goto("/");
    await waitForFleetReady(page);
    await page.evaluate(() =>
      localStorage.removeItem("flightdeck-left-panel-width"),
    );
    await page.reload();
    await waitForFleetReady(page);

    const handle = page.locator('[data-testid="left-panel-resize-handle"]');
    await expect(handle).toBeVisible();
    await handle.scrollIntoViewIfNeeded();

    // Far-left drag — way below the 200 px floor.
    await dragHandle(handle, -800);

    await expect
      .poll(
        async () =>
          parseInt(
            (await page.evaluate(() =>
              localStorage.getItem("flightdeck-left-panel-width"),
            )) ?? "0",
            10,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(200);
    const persistedRaw = await page.evaluate(() =>
      localStorage.getItem("flightdeck-left-panel-width"),
    );
    const persisted = parseInt(persistedRaw!, 10);
    // Clamp lands at exactly 200 (LEFT_PANEL_MIN_WIDTH); the
    // 2-px tolerance absorbs sub-pixel rounding.
    expect(persisted).toBeLessThanOrEqual(202);
  });
});
