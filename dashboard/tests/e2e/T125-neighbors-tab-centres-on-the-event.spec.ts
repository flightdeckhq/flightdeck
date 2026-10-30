import { test, expect } from "@playwright/test";

// T125 — the event drawer's neighbors tab lists the events around the
// open event, however deep in its session that event is. The seed puts
// 25 history_padding tool_calls ahead of the coding agent's
// policy-active remembered MCP approval, so the approval is past the
// first 21 events of its session (the page the tab once fetched from
// the session's start). The tab must mark it as the anchor and list
// the events just before it in time order. The drawer is deep-linked
// by event id, read from the API. Theme-agnostic per Rule 40c.3.

// uuid5 of flightdeck-e2e/e2e-test-coding-agent/policy-active (see
// seed.py).
const POLICY_ACTIVE_SESSION_ID = "91e0c5c2-7023-5e81-8b27-aac132d827d2";

type Ev = { id: string; event_type: string; occurred_at: string };

test.describe("T125 — neighbors tab centres on the open event", () => {
  test("the anchor is the open event and the rows before it are its predecessors", async ({ page }) => {
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions/${POLICY_ACTIVE_SESSION_ID}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "session API call must succeed").toBe(true);
    const body = (await resp.json()) as { events?: Ev[] };
    const events = [...(body.events ?? [])].sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id),
    );
    const idx = events.findIndex((e) => e.event_type === "mcp_policy_user_remembered");
    expect(idx, "the seed's mcp_policy_user_remembered must sit past its session's first 21 events").toBeGreaterThanOrEqual(21);
    const approval = events[idx]!;
    // The events strictly before the anchor do not change while the
    // keep-alive adds newer ones, so they pin the window.
    const before = events
      .slice(0, idx)
      .filter((e) => Date.parse(e.occurred_at) < Date.parse(approval.occurred_at))
      .slice(-5)
      .map((e) => e.id);

    await page.goto(`/events?event=${approval.id}&event_session=${POLICY_ACTIVE_SESSION_ID}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await drawer.getByTestId("detail-tab-neighbors").click();
    const anchor = drawer.getByTestId("surrounding-anchor");
    await expect(anchor).toHaveAttribute("data-event-id", approval.id);
    await expect(anchor).toContainText("approved · bypassPermissions");
    const rows = drawer.getByTestId(/surrounding-(row|anchor)/);
    await expect
      .poll(async () => {
        const ids = await rows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-event-id")));
        const at = ids.indexOf(approval.id);
        return ids.slice(Math.max(0, at - before.length), at);
      })
      .toEqual(before);
  });
});
