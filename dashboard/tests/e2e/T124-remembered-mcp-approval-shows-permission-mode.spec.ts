import { test, expect } from "@playwright/test";

// T124 — a remembered MCP approval names its server and the Claude
// Code permission mode it was given in. The seed's
// mcp_policy_user_remembered (on the coding agent's policy-active
// session) carries permission_mode bypassPermissions; the event
// detail drawer lists the server, its URL, when it was approved, the
// mode and the fingerprint, and the drawer's event list shows the feed
// line on its neighbors tab. The drawer is deep-linked by event id, read from the API.
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
    const body = (await resp.json()) as { events?: Array<{ id: string; event_type: string }> };
    const approval = (body.events ?? []).find((e) => e.event_type === "mcp_policy_user_remembered");
    expect(approval, "the seed's mcp_policy_user_remembered must exist").toBeDefined();

    await page.goto(`/events?event=${approval!.id}&event_session=${POLICY_ACTIVE_SESSION_ID}`);
    const drawer = page.getByTestId("event-detail-drawer");
    const summary = drawer.getByTestId("detail-summary");
    await expect(summary).toBeVisible();
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
    await drawer.getByTestId("detail-tab-neighbors").click();
    await expect(drawer.getByTestId("surrounding-anchor")).toContainText(
      "e2e-remembered-server approved · bypassPermissions",
    );
  });
});
