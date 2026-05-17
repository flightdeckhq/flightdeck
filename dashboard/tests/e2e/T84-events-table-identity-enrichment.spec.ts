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

  // Polish Batch 2 Fix 1 — every /events facet sidebar chip carries
  // a leading icon. The AGENT chips carry the client_type pill +
  // agent_type badge, the FRAMEWORK chips carry the FrameworkPill,
  // and the remaining dimensions (MODEL / POLICY / ERROR TYPE / MCP
  // SERVER, etc.) carry a FacetIcon glyph under the
  // events-facet-icon-<key>-<value> testid. The canonical seed
  // covers every dimension below: the coding + sensor agents drive
  // AGENT / FRAMEWORK / MODEL, the policy-active role drives
  // POLICY, the error-active role drives ERROR TYPE, and the
  // mcp-active role drives MCP SERVER.
  test("the facet sidebar renders icons across every dimension", async ({
    page,
  }) => {
    await page.goto("/events");
    await waitForInvestigateReady(page);

    // The sidebar mounts once the first facet group resolves.
    await expect(
      page.locator('[data-testid="investigate-sidebar"]'),
    ).toBeVisible();
    await expect
      .poll(async () => page.locator('[data-testid="events-row"]').count(), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // AGENT chips — client_type pill + agent_type badge. Each agent
    // facet value carries both.
    await expect(
      page
        .locator('[data-testid^="events-facet-client-type-"]')
        .first(),
      "an AGENT facet chip must render the client_type pill",
    ).toBeVisible();
    await expect(
      page
        .locator('[data-testid^="events-facet-agent-type-"]')
        .first(),
      "an AGENT facet chip must render the agent_type badge",
    ).toBeVisible();

    // FRAMEWORK chips — the FrameworkPill, same chrome as the event
    // row's MODEL cell.
    await expect(
      page
        .locator('[data-testid^="events-facet-framework-pill-"]')
        .first(),
      "a FRAMEWORK facet chip must render the FrameworkPill",
    ).toBeVisible();

    // MODEL chips — provider logo via FacetIcon.
    await expect(
      page
        .locator('[data-testid^="events-facet-icon-model-"]')
        .first(),
      "a MODEL facet chip must render the provider-logo icon",
    ).toBeVisible();

    // ERROR TYPE chips — lucide glyph via FacetIcon (error-active
    // role seeds four distinct llm_error taxonomy values).
    await expect(
      page
        .locator('[data-testid^="events-facet-icon-error_type-"]')
        .first(),
      "an ERROR TYPE facet chip must render the FacetIcon glyph",
    ).toBeVisible();

    // POLICY chips — chroma dot via FacetIcon (policy-active role
    // seeds policy_warn / policy_degrade / policy_block).
    await expect(
      page
        .locator('[data-testid^="events-facet-icon-policy_event_type-"]')
        .first(),
      "a POLICY facet chip must render the chroma-dot icon",
    ).toBeVisible();

    // MCP SERVER chips — lucide glyph via FacetIcon (mcp-active role
    // seeds two server fingerprints).
    await expect(
      page
        .locator('[data-testid^="events-facet-icon-mcp_server-"]')
        .first(),
      "an MCP SERVER facet chip must render the FacetIcon glyph",
    ).toBeVisible();
  });
});
