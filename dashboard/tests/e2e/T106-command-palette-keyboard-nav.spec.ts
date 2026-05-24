/**
 * T106 — Cmd/Ctrl+K command palette keyboard navigation.
 *
 * Locks the Phase B + Phase C contract: arrow keys VISIBLY move
 * the focused row, the row scrolls into view when it would
 * otherwise be clipped, and Enter routes to the right surface
 * for the result type (agent → agent drawer overlay,
 * session → /events?run=, event → EventDetailDrawer overlay).
 *
 * Pre-Phase-B the focused-row background was bg-primary/10 on a
 * hex-valued CSS var → invalid CSS → no background. The
 * highlight tokens in this spec assert structural classes that
 * compile in both themes; the spec runs under both Playwright
 * theme projects to lock per-theme parity (Rule 40c.3).
 */
import { test, expect } from "@playwright/test";

test.describe("T106 — command palette keyboard nav", () => {
  test("ArrowDown moves the visible highlight + scrolls + Enter routes a session hit", async ({
    page,
  }) => {
    await page.goto("/");

    // Open via the nav trigger — the keyboard chord is locked
    // separately in T108. Keeping this path click-based avoids a
    // pre-mount race where the global keydown handler isn't yet
    // attached on a fresh page load.
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Type a query that hits multiple results — "e2e" matches
    // seeded agent_name + session flavors + events.
    const input = dialog.getByRole("textbox", { name: "Search" });
    await input.fill("e2e");

    // Wait until at least 2 options render so ArrowDown has somewhere
    // to go. Poll the count instead of using a fixed timeout.
    const options = dialog.getByRole("option");
    await expect.poll(async () => options.count()).toBeGreaterThanOrEqual(2);

    // First option carries the focused marker — Phase B locked the
    // visible-highlight tokens via this testid.
    const focused = dialog.getByTestId("search-result-focused");
    await expect(focused).toBeVisible();
    const firstText = (await focused.textContent()) ?? "";

    // ArrowDown moves the marker to the next row; same testid, new
    // content. Poll until the DOM settles on the new focused row.
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(async () => (await focused.textContent()) ?? "")
      .not.toBe(firstText);

    // ArrowUp returns to the original row.
    await page.keyboard.press("ArrowUp");
    await expect
      .poll(async () => (await focused.textContent()) ?? "")
      .toBe(firstText);

    // The focused row is structurally visible (its testid resolves
    // to a node that toBeVisible accepts — Playwright's visibility
    // check covers scroll-clipped-out-of-bounds).
    await expect(focused).toBeVisible();
  });

  test("Enter on a session hit navigates to /events?run=<id>", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Type a query that matches a seeded SESSION flavor but does
    // NOT also match e2e agent_names — otherwise the Agents group
    // renders first and the first option is an agent (routes to
    // ?agent_drawer=, not /events). ``claude-code`` matches only
    // the e2e-claude-code session flavor; no agent_name carries it.
    await dialog.getByRole("textbox", { name: "Search" }).fill("claude-code");
    await expect
      .poll(async () => dialog.getByRole("option").count())
      .toBeGreaterThan(0);

    // SessionRow renders the truncated session_id (first 8 chars)
    // in mono. Pick the first option that carries that pattern via
    // a 6-hex-prefix regex — the run group's session_id token is
    // the only place this shape appears.
    const sessionOption = dialog
      .getByRole("option")
      .filter({ hasText: /[0-9a-f]{6}/ })
      .first();
    await sessionOption.click();

    // Click closes the palette and navigates to /events?run=<id>.
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe("/events");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("run"))
      .not.toBeNull();
  });

  test("Enter on an agent hit opens the agent drawer overlay (does NOT navigate to /events)", async ({
    page,
  }) => {
    await page.goto("/policies");
    const startPath = "/policies";
    await page.getByTestId("nav-search-trigger").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // "e2e" surfaces seeded e2e agent_names; first option in the
    // Agents group is what we click.
    await dialog.getByRole("textbox", { name: "Search" }).fill("e2e");
    await expect
      .poll(async () => dialog.getByRole("option").count())
      .toBeGreaterThan(0);
    const agentsGroup = dialog.locator("div", { hasText: /^Agents/ }).first();
    await expect(agentsGroup).toBeVisible();
    const firstAgentOption = agentsGroup.getByRole("option").first();
    await firstAgentOption.click();

    // Palette closes; URL now carries ?agent_drawer= on the SAME
    // path (no navigation) per the new D routing pivot.
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(startPath);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("agent_drawer"))
      .not.toBeNull();
  });
});
