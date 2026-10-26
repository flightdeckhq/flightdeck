import { test, expect } from "@playwright/test";

// T121 — the event detail drawer shows a call's token, serving and
// cost detail. The seed's call_fields_post_call (on the sensor agent's
// mcp-active session) carries every per-call field: cache reads and
// writes with a one-hour split, reasoning tokens, stop reason, the
// requested model alias, billing mode, platform, service tier, speed,
// inference geo, server tool counts and a client-computed cost. The
// drawer is deep-linked by event id, read from the API first.
// Theme-agnostic per Rule 40c.3: assertions read test ids and text.

// uuid5 of flightdeck-e2e/e2e-test-sensor-agent-prod/mcp-active (see
// seed.py).
const MCP_ACTIVE_SESSION_ID = "f53c6626-fcdb-5452-9cf6-8472ef15dfca";

test.describe("T121 — event detail shows a call's per-call fields", () => {
  test("the drawer lists cache, reasoning, serving, billing and cost rows", async ({ page }) => {
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions/${MCP_ACTIVE_SESSION_ID}?events_limit=100`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "session API call must succeed").toBe(true);
    const body = (await resp.json()) as {
      events?: Array<{ id: string; event_type: string; payload?: { stop_reason?: string } | null }>;
    };
    const call = (body.events ?? []).find(
      (e) => e.event_type === "post_call" && e.payload?.stop_reason === "end_turn",
    );
    expect(call, "the seed's call_fields_post_call must exist").toBeDefined();

    await page.goto(`/events?event=${call!.id}&event_session=${MCP_ACTIVE_SESSION_ID}`);
    const summary = page.getByTestId("event-detail-drawer").getByTestId("detail-summary");
    await expect(summary).toBeVisible();
    for (const text of [
      "Cache read",
      "1,800",
      "600 · 400 for 1h",
      "Reasoning tokens",
      "Stop reason",
      "end_turn",
      "anthropic/claude-sonnet-4-5",
      "Metered",
      "Service tier",
      "Inference geo",
      "2 web searches",
      "$0.041 · computed by the client",
    ]) {
      await expect(summary).toContainText(text);
    }
  });
});
