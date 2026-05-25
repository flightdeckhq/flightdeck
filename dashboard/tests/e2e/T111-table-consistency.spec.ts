/**
 * T111 — D163 table-consistency canary.
 *
 * The Agents table and the Events table run through the shared
 * primitive at ``dashboard/src/components/ui/table.tsx``. This
 * spec asserts that both surfaces ship the canonical header /
 * row class signature so a future drift (per-page inline styles
 * sneaking back in, or a refactor that bypasses the primitive)
 * surfaces immediately.
 *
 * Under both Playwright theme projects per Rule 40c.3 — the
 * class signature must be present in both themes; the values
 * themselves are theme-agnostic Tailwind utility classes.
 */
import { test, expect, Page } from "@playwright/test";

// Canonical class fragments from the primitive (see
// dashboard/src/components/ui/table.tsx::TableHead /
// TableCell / TableRow). The class STRING includes these
// substrings on every header cell / interactive body row
// when the surface uses the primitive.
const HEADER_CLASS_FRAGMENTS = [
  "text-[11px]",
  "font-semibold",
  "uppercase",
  "tracking-[0.06em]",
  "text-text-secondary",
  "px-3",
  "py-2",
];

const INTERACTIVE_ROW_CLASS_FRAGMENTS = [
  "border-b",
  "border-border-subtle",
  "cursor-pointer",
  "hover:bg-surface-hover",
];

async function expectHeaderSignature(page: Page, tableSelector: string) {
  const firstTh = page.locator(`${tableSelector} thead th`).first();
  await expect(firstTh).toBeVisible();
  const cls = (await firstTh.getAttribute("class")) ?? "";
  for (const fragment of HEADER_CLASS_FRAGMENTS) {
    expect(
      cls.includes(fragment),
      `expected ${tableSelector} header to carry "${fragment}" — got: ${cls}`,
    ).toBe(true);
  }
}

async function expectInteractiveRowSignature(
  page: Page,
  rowSelector: string,
) {
  const row = page.locator(rowSelector).first();
  await expect(row).toBeVisible();
  const cls = (await row.getAttribute("class")) ?? "";
  for (const fragment of INTERACTIVE_ROW_CLASS_FRAGMENTS) {
    expect(
      cls.includes(fragment),
      `expected ${rowSelector} to carry "${fragment}" — got: ${cls}`,
    ).toBe(true);
  }
}

test.describe("T111 — Agents + Events tables share the primitive signature", () => {
  test("the Agents table header carries the canonical class signature", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    await expectHeaderSignature(page, '[data-testid="agent-table"]');
  });

  test("the Events table header carries the canonical class signature", async ({
    page,
  }) => {
    await page.goto("/events");
    await expect(page.getByTestId("events-table")).toBeVisible();
    await expectHeaderSignature(page, '[data-testid="events-table"]');
  });

  test("an Agents body row carries the interactive-row signature (border + hover + cursor)", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agent-table")).toBeVisible();
    // Wait until at least one row mounts (the seeded fixture
    // includes multiple agents). Selecting the first agent-row-*
    // testid via a CSS attribute selector.
    await page.waitForSelector('[data-testid^="agent-row-"]');
    await expectInteractiveRowSignature(
      page,
      '[data-testid^="agent-row-"]',
    );
  });

  test("an Events body row carries the interactive-row signature (border + hover + cursor)", async ({
    page,
  }) => {
    await page.goto("/events");
    await expect(page.getByTestId("events-table")).toBeVisible();
    await page.waitForSelector('[data-testid="events-row"]');
    await expectInteractiveRowSignature(
      page,
      '[data-testid="events-row"]',
    );
  });
});
