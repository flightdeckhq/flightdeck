import { test, expect } from "@playwright/test";

/**
 * T116 — every Fleet sidebar agent row keeps its name visible and its
 * label inside its own box.
 *
 * Guarded regression: a coding-agent row carries the Claude Code logo,
 * the CODING AGENT and CLAUDE CODE pills and a session count, which
 * together are wider than the default 240 px sidebar. The pills never
 * truncate, so the label group overflowed: the agent name was
 * squeezed to zero width and the pills slid under the row's stop-all
 * and directives buttons. The label group now wraps its trailing
 * items to a second line instead.
 *
 * Asserted per row: the label group does not overflow horizontally,
 * the name is at least a few characters wide, and no label item
 * intersects the action buttons. Theme-agnostic; runs under both
 * Playwright projects.
 */
test.describe("T116 — Fleet sidebar agent rows fit", () => {
  test("names stay visible and labels never run under the action buttons", async ({
    page,
  }) => {
    await page.goto("/");
    const rows = page.locator('[data-testid^="fleet-sidebar-agent-"]').filter({
      has: page.locator('[data-testid="fleet-sidebar-agent-label"]'),
    });
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    // A coding-agent row is the case that overflowed; the seed always
    // has one.
    await expect(
      rows.filter({ has: page.locator('[data-testid="coding-agent-badge"]') }).first(),
    ).toBeVisible();

    const problems = await rows.evaluateAll((els) =>
      els.flatMap((row) => {
        const label = row.querySelector<HTMLElement>('[data-testid="fleet-sidebar-agent-label"]');
        const actions = row.querySelector<HTMLElement>('[data-testid="fleet-sidebar-agent-actions"]');
        if (!label) return [];
        const id = row.getAttribute("data-testid");
        const out: string[] = [];
        if (label.scrollWidth > label.clientWidth + 1) {
          out.push(`${id}: label overflows (${label.scrollWidth} > ${label.clientWidth})`);
        }
        const name = label.querySelector<HTMLElement>(".font-mono.text-xs");
        // A short name is narrower than 40 px untruncated; only flag a
        // name that is narrower than both.
        if (name && name.getBoundingClientRect().width < Math.min(40, name.scrollWidth)) {
          out.push(`${id}: name only ${Math.round(name.getBoundingClientRect().width)}px wide`);
        }
        const a = actions?.getBoundingClientRect();
        if (a && a.width > 0) {
          for (const child of Array.from(label.children)) {
            const c = child.getBoundingClientRect();
            if (c.right > a.left && c.left < a.right && c.bottom > a.top && c.top < a.bottom) {
              out.push(`${id}: label item overlaps the action buttons`);
            }
          }
        }
        return out;
      }),
    );
    expect(problems).toEqual([]);
  });
});
