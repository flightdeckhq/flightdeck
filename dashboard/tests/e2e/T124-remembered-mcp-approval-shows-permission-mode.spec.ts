import { test, expect } from "@playwright/test";

// T124 — a remembered MCP approval names its server and the Claude
// Code permission mode it was given in. The seed's
// mcp_policy_user_remembered (on the coding agent's policy-active
// session) carries permission_mode bypassPermissions; the event
// detail drawer lists the server, its URL, when it was approved, the
// mode and the fingerprint, and the Events table row shows the feed
// line. Both are deep-linked by event id, read from the API.
// Theme-agnostic per Rule 40c.3: assertions read test ids and text.

// uuid5 of flightdeck-e2e/e2e-test-coding-agent/policy-active (see
// seed.py).
const POLICY_ACTIVE_SESSION_ID = "91e0c5c2-7023-5e81-8b27-aac132d827d2";

test.describe("T124 — remembered MCP approval shows its permission mode", () => {
  test("the drawer lists the server, approval time and permission mode", async ({ page }) => {
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions/${POLICY_ACTIVE_SESSION_ID}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "session API call must succeed").toBe(true);
    const body = (await resp.json()) as {
      events?: Array<{ id: string; event_type: string; occurred_at: string }>;
    };
    const approval = (body.events ?? []).find((e) => e.event_type === "mcp_policy_user_remembered");
    expect(approval, "the seed's mcp_policy_user_remembered must exist").toBeDefined();

    await page.goto(`/events?event=${approval!.id}&event_session=${POLICY_ACTIVE_SESSION_ID}`);
    const drawer = page.getByTestId("event-detail-drawer");
    const summary = drawer.getByTestId("detail-summary");
    await expect(summary).toBeVisible();
    await expect(drawer).toContainText("MCP SERVER APPROVED");
    for (const text of [
      "Server",
      "e2e-remembered-server",
      "Server URL",
      "https://mcp.e2e.example/remembered",
      "Approved at",
      "Permission mode",
      "bypassPermissions",
      "Fingerprint",
      "e2e0remembered01",
    ]) {
      await expect(summary).toContainText(text);
    }

    // The feed line, on the event's own row in the Events table: the
    // window brackets the event so the row is on the first page however
    // many events the session has gathered.
    const at = Date.parse(approval!.occurred_at);
    const params = new URLSearchParams({
      event_type: "mcp_policy_user_remembered",
      from: new Date(at - 60_000).toISOString(),
      to: new Date(at + 60_000).toISOString(),
    });
    await page.goto(`/events?${params.toString()}`);
    await expect(page.locator(`[data-testid="events-row"][data-event-id="${approval!.id}"]`)).toContainText(
      "e2e-remembered-server approved · bypassPermissions",
    );
  });
});
