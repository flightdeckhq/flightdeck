import { test, expect, type Page } from "@playwright/test";
import { OTLP_AGENT, waitForInvestigateReady } from "./_fixtures";

// T129 — a sub-agent of a Claude Code session reported over
// OpenTelemetry is a child session closed by its subagent_completed
// record: its run drawer names the source, shows it closed with no
// Stop control and links back to the parent, and the parent's
// Sub-agents tab lists it. Theme-agnostic (Rule 40c.3).

async function openRun(page: Page, sessionId: string) {
  const params = new URLSearchParams({
    from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    run: sessionId,
  });
  await page.goto(`/events?${params.toString()}`);
  await waitForInvestigateReady(page);
  const drawer = page.getByTestId("session-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("T129 — OTLP sub-agent child session", () => {
  test("the child is closed, names its source, has no Stop and points at its parent", async ({
    page,
  }) => {
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions/${OTLP_AGENT.childSessionId}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "the seeded OTLP child session must exist").toBe(true);
    const body = (await resp.json()) as {
      session: { state: string; parent_session_id: string; agent_role: string };
      events: { event_type: string; payload?: { close_reason?: string } | null }[];
    };
    expect(body.session.parent_session_id).toBe(OTLP_AGENT.rootSessionId);
    expect(body.session.agent_role).toBe("general-purpose");
    expect(body.session.state).toBe("closed");
    expect(
      body.events.find((e) => e.event_type === "session_end")?.payload?.close_reason,
    ).toBe("normal_exit");

    const drawer = await openRun(page, OTLP_AGENT.childSessionId);
    await expect(drawer.getByTestId("session-source-label")).toHaveText("via OpenTelemetry");
    await expect(drawer.getByText("closed", { exact: true }).first()).toBeVisible();
    await expect(drawer.getByTestId("session-drawer-stop-agent")).toHaveCount(0);

    await drawer.getByTestId("drawer-tab-sub-agents").click();
    const spawnedFrom = drawer.getByTestId("sub-agents-spawned-from");
    await expect(spawnedFrom).toBeVisible();
    await expect(spawnedFrom).toContainText(OTLP_AGENT.name);
  });

  test("the parent's Sub-agents tab lists the child", async ({ page }) => {
    const drawer = await openRun(page, OTLP_AGENT.rootSessionId);
    await drawer.getByTestId("drawer-tab-sub-agents").click();
    const children = drawer.getByTestId("sub-agents-children");
    await expect(children).toBeVisible();
    await expect(children).toContainText("general-purpose");
  });
});
