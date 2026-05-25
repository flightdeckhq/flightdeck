/**
 * T111 — D163 table-consistency canary.
 *
 * The Agents table and the Events table run through the shared
 * primitive at ``dashboard/src/components/ui/table.tsx``. This
 * spec asserts that both surfaces ship the canonical header /
 * row class signature so a future drift (per-page inline styles
 * sneaking back in, or a refactor that bypasses the primitive)
 * surfaces immediately. Also locks the TopologyCell rounded-pill
 * class signature on /agents so the D163 pill restyle stays
 * structurally identifiable.
 *
 * Under both Playwright theme projects per Rule 40c.3 — the
 * class signature must be present in both themes; the values
 * themselves are theme-agnostic Tailwind utility classes.
 *
 * Class-membership checks use ``classList.contains`` rather than
 * raw class-string ``.includes`` so a future caller passing an
 * overriding ``className`` that happens to share a substring
 * can't pass silently.
 */
import { test, expect, Locator } from "@playwright/test";

// Canonical class fragments from the primitive (see
// dashboard/src/components/ui/table.tsx::TableHead /
// TableCell / TableRow). Every header cell / interactive body
// row on a primitive-backed table carries these tokens.
const HEADER_CLASSES = [
  "text-[11px]",
  "font-semibold",
  "uppercase",
  "tracking-[0.06em]",
  "text-text-secondary",
  "px-3",
  "py-2",
];

const INTERACTIVE_ROW_CLASSES = [
  "border-b",
  "border-border-subtle",
  "cursor-pointer",
  "hover:bg-surface-hover",
];

// TopologyCell pill base — every variant (lone / child / parent)
// carries this class signature regardless of accent vs muted
// tint. The colour treatment is in inline ``style`` (driven by
// theme variables); the class signature is structural.
const PILL_CLASSES = [
  "inline-flex",
  "items-center",
  "rounded-full",
  "px-2",
  "py-0.5",
  "font-mono",
  "text-[11px]",
  "whitespace-nowrap",
];

async function expectClasses(locator: Locator, classes: string[]) {
  // ``classList.contains`` reflects DOM truth and is order-
  // independent — string includes() against the raw class
  // attribute can pass on incidental substring matches.
  for (const cls of classes) {
    expect(
      await locator.evaluate(
        (el, cls) => el.classList.contains(cls),
        cls,
      ),
      `expected classList to contain "${cls}"`,
    ).toBe(true);
  }
}

test.describe("T111 — Agents + Events tables share the primitive signature", () => {
  test("the Agents table header carries the canonical class signature", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    const firstTh = page.locator('[data-testid="agent-table"] thead th').first();
    await expect(firstTh).toBeVisible();
    await expectClasses(firstTh, HEADER_CLASSES);
  });

  test("the Events table header carries the canonical class signature", async ({
    page,
  }) => {
    await page.goto("/events");
    await expect(page.getByTestId("events-table")).toBeVisible();
    const firstTh = page.locator('[data-testid="events-table"] thead th').first();
    await expect(firstTh).toBeVisible();
    await expectClasses(firstTh, HEADER_CLASSES);
  });

  test("an Agents body row carries the interactive-row signature (border + hover + cursor)", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    const row = page.locator('[data-testid^="agent-row-"]').first();
    await expect(row).toBeVisible();
    await expectClasses(row, INTERACTIVE_ROW_CLASSES);
  });

  test("an Events body row carries the interactive-row signature (border + hover + cursor)", async ({
    page,
  }) => {
    await page.goto("/events");
    await expect(page.getByTestId("events-table")).toBeVisible();
    const row = page.locator('[data-testid="events-row"]').first();
    await expect(row).toBeVisible();
    await expectClasses(row, INTERACTIVE_ROW_CLASSES);
  });

  test("the topology column pill on /agents carries the D163 rounded-pill class signature", async ({
    page,
  }) => {
    // The TopologyCell restyle (D163 step) replaced inline-style
    // text with a tinted rounded pill across all three modes
    // (lone / child / parent). Any of the three pills is
    // sufficient — they share the same PILL_CLASSES base.
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    const pill = page
      .locator('[data-testid^="agent-table-topology-pill-"]')
      .first();
    await expect(pill).toBeVisible();
    await expectClasses(pill, PILL_CLASSES);
  });
});
