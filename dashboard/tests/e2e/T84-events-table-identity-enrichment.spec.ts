/**
 * T84 — the /events table EventRow carries the session-identity
 * enrichment.
 *
 * D157 Fix 5 contract: GET /v1/events joins `sessions` to project
 * framework / client_type / agent_type onto every event row. The
 * EventRow renders them inline within the existing seven columns —
 * the AGENT cell gains the client_type pill + agent_type badge, the
 * MODEL cell gains the provider logo + framework pill for LLM
 * events, and rows whose event carries captured content show a
 * prompt-capture indicator in the DETAIL cell.
 *
 * Theme-agnostic — structural locators only; runs under both the
 * neon-dark and clean-light theme projects.
 */
import { test, expect } from "@playwright/test";
import { waitForInvestigateReady } from "./_fixtures";

test.describe("T84 — /events EventRow identity enrichment", () => {
  test("event rows carry the client_type pill and agent_type badge", async ({
    page,
  }) => {
    await page.goto("/events");
    await waitForInvestigateReady(page);

    const rows = page.locator('[data-testid="events-row"]');
    await expect
      .poll(async () => rows.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // client_type and agent_type are session-scoped identity — every
    // seeded event resolves to a real session row, so the pill and
    // badge render on the event rows.
    await expect(
      page.locator('[data-testid="events-row-client-pill"]').first(),
      "the AGENT cell must render the client_type pill",
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="events-row-agent-type"]').first(),
      "the AGENT cell must render the agent_type badge",
    ).toBeVisible();
  });

  test("LLM rows show the provider logo + framework pill, and captured rows show the prompt-capture indicator", async ({
    page,
  }) => {
    await page.goto("/events");
    await waitForInvestigateReady(page);

    await expect
      .poll(async () => page.locator('[data-testid="events-row"]').count(), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // The seed emits post_call events that carry a model and a
    // framework attribution, so the MODEL-cell cluster renders.
    await expect(
      page.locator('[data-testid="events-row-provider-logo"]').first(),
      "an LLM event row must render the provider logo",
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="events-row-framework"]').first(),
      "an LLM event row must render the framework pill",
    ).toBeVisible();

    // The seed emits events with captured content (capture-enabled
    // sessions), so at least one row carries the capture indicator.
    await expect(
      page
        .locator('[data-testid="events-row-capture-indicator"]')
        .first(),
      "a captured-content event row must render the prompt-capture indicator",
    ).toBeVisible();
  });
});
