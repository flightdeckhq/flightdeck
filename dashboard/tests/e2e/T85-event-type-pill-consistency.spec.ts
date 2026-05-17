/**
 * T85 — the event-type pill is byte-identical across the three
 * surfaces that render it.
 *
 * Polish Batch 2 Fix 3 — the run drawer's Timeline event rows, the
 * /events table EventRow, and the agent drawer's Events tab all
 * render the shared `EventTypePill` component. Before the fix the
 * run drawer used a solid tinted pill while /events and the agent
 * drawer used a divergent dot + label.
 *
 * The pill carries `data-testid="event-type-pill"` plus a
 * `data-event-type` attribute. This spec pins ONE event type
 * (`tool_call` — emitted by every seeded session and recent enough
 * to land on the first page of each surface) and asserts the
 * rendered pill is byte-identical — tag, class attribute, inline
 * style, and label text — across all three surfaces. Pinning the
 * event type makes the comparison exact: same type → same
 * `getBadge` colour → identical inline style, not just identical
 * layout classes. The `/events` surface is additionally filtered to
 * the pinned type via the `event_type` URL facet so the row is
 * guaranteed visible regardless of newest-first pagination.
 *
 * Theme-agnostic — structural locators only; runs under both the
 * neon-dark and clean-light theme projects (the compared `style`
 * attribute is the literal CSS-variable string, identical in both).
 */
import { test, expect, type Locator } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

const PINNED_TYPE = "tool_call";
const PILL = `[data-testid="event-type-pill"][data-event-type="${PINNED_TYPE}"]`;

/** The full rendered signature of an event-type pill: tag, class
 *  attribute, inline style, and trimmed label text. Two pills
 *  rendered by the same component for the same event type produce
 *  byte-identical signatures. */
async function pillSignature(pill: Locator) {
  return {
    tag: (await pill.evaluate((el) => el.tagName)).toUpperCase(),
    cls: (await pill.getAttribute("class")) ?? "",
    style: (await pill.getAttribute("style")) ?? "",
    label: ((await pill.textContent()) ?? "").trim(),
  };
}

test.describe("T85 — EventTypePill renders consistently on all three surfaces", () => {
  test("the /events, run drawer, and agent drawer event-type pills are byte-identical", async ({
    page,
  }) => {
    // --- Surface 1: the /events table EventRow ----------------------
    // Filter the table to the pinned type so the row is on the
    // first page regardless of newest-first pagination.
    await page.goto(`/events?event_type=${PINNED_TYPE}`);
    await waitForInvestigateReady(page);
    const eventsPill = page.locator(PILL).first();
    await expect(
      eventsPill,
      `the /events table must render a ${PINNED_TYPE} event-type pill`,
    ).toBeVisible({ timeout: 10_000 });
    const eventsSig = await pillSignature(eventsPill);
    expect(eventsSig.label, "the /events pill must carry a label").not.toBe("");

    // --- Surface 2: the run drawer's Timeline event rows ------------
    // Open the run drawer via the first row's run badge — the
    // canonical run-drawer entry point on the event table.
    await page
      .locator('[data-testid="events-row-run-badge"]')
      .first()
      .click();
    const runDrawer = page.locator('[data-testid="session-drawer"]');
    await expect(runDrawer).toBeVisible({ timeout: 10_000 });
    const runDrawerPill = runDrawer.locator(PILL).first();
    await expect(
      runDrawerPill,
      "the run drawer must render the pinned-type event pill",
    ).toBeVisible({ timeout: 10_000 });
    const runDrawerSig = await pillSignature(runDrawerPill);

    // --- Surface 3: the agent drawer's Events tab -------------------
    await page.goto("/agents");
    const firstAgentRow = page
      .locator('[data-testid^="agent-row-"][data-agent-id]')
      .first();
    await expect(firstAgentRow).toBeVisible({ timeout: 10_000 });
    await firstAgentRow.click();
    const agentDrawer = page.locator('[data-testid="agent-drawer"]');
    await expect(agentDrawer).toBeVisible();
    const agentDrawerPill = agentDrawer.locator(PILL).first();
    await expect(
      agentDrawerPill,
      "the agent drawer Events tab must render the pinned-type event pill",
    ).toBeVisible({ timeout: 10_000 });
    const agentDrawerSig = await pillSignature(agentDrawerPill);

    // --- The three signatures must be byte-identical ----------------
    // Same component + same pinned event type → identical tag, class
    // attribute, inline style (the chroma is style-driven), and
    // label. A deep equality is the strongest "same component"
    // assertion the DOM affords.
    expect(
      runDrawerSig,
      "the run drawer pill must be byte-identical to the /events pill",
    ).toEqual(eventsSig);
    expect(
      agentDrawerSig,
      "the agent drawer pill must be byte-identical to the /events pill",
    ).toEqual(eventsSig);
  });
});
