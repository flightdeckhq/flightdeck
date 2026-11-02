import { test, expect, type Page } from "@playwright/test";
import { OTLP_AGENT } from "./_fixtures";

// T128 — the events of a Claude Code session reported over
// OpenTelemetry render as the dashboard renders any client's: the
// prompt (Claude Code's user_prompt names no model) shows no model
// instead of "unknown"; the api_request's post_call shows Claude
// Code's own cost, its TTFT and stream outcome without chunk rows, and
// its request id and query source; the MCP tool call names its server;
// a denied tool reads as a permission_denied signal. Events are
// deep-linked by id, read from the API. Theme-agnostic (Rule 40c.3).

type Ev = {
  id: string;
  event_type: string;
  occurred_at: string;
  payload?: { signal?: string } | null;
};

async function rootEvents(page: Page): Promise<Ev[]> {
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions/${OTLP_AGENT.rootSessionId}`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok(), "the seeded OTLP root session must exist").toBe(true);
  return ((await resp.json()) as { events?: Ev[] }).events ?? [];
}

function one(events: Ev[], type: string, signal?: string): Ev {
  const ev = events.find(
    (e) => e.event_type === type && (!signal || e.payload?.signal === signal),
  );
  expect(ev, `the OTLP fixture's ${signal ?? type} must exist`).toBeDefined();
  return ev!;
}

async function openDetail(page: Page, ev: Ev) {
  await page.goto(`/events?event=${ev.id}&event_session=${OTLP_AGENT.rootSessionId}`);
  const drawer = page.getByTestId("event-detail-drawer");
  const summary = drawer.getByTestId("detail-summary");
  await expect(summary).toBeVisible();
  return { drawer, summary };
}

async function eventsRow(page: Page, ev: Ev) {
  const at = Date.parse(ev.occurred_at);
  const params = new URLSearchParams({
    event_type: ev.event_type,
    from: new Date(at - 60_000).toISOString(),
    to: new Date(at + 60_000).toISOString(),
  });
  await page.goto(`/events?${params.toString()}`);
  const row = page.locator(`[data-testid="events-row"][data-event-id="${ev.id}"]`);
  await expect(row).toBeVisible();
  return row;
}

test.describe("T128 — OTLP session events render", () => {
  test("the prompt names no model: a dash, never 'unknown'", async ({ page }) => {
    const prompt = one(await rootEvents(page), "pre_call");
    const row = await eventsRow(page, prompt);
    await expect(row).not.toContainText("unknown");
    await expect(row.getByTestId("events-row-provider-logo")).toHaveCount(0);

    const { drawer, summary } = await openDetail(page, prompt);
    await expect(summary).toContainText("Model");
    await expect(summary).toContainText("—");
    await expect(summary).not.toContainText("unknown");
    await expect(drawer.getByTestId("detail-metadata")).not.toContainText("unknown");
  });

  test("the call shows Claude Code's cost, TTFT and stream outcome, and its request metadata", async ({
    page,
  }) => {
    const call = one(await rootEvents(page), "post_call");
    const { drawer, summary } = await openDetail(page, call);
    for (const text of [
      OTLP_AGENT.model,
      "TTFT",
      `${OTLP_AGENT.rootCallTtftMs}ms`,
      "Stream outcome",
      "completed",
      "Billing",
      "Subscription",
      "Reported cost",
      "$0.017 · computed by the client",
    ]) {
      await expect(summary).toContainText(text);
    }
    // Claude Code reports no chunk statistics.
    await expect(summary).not.toContainText("Chunks");
    await expect(summary).not.toContainText("Inter-chunk");
    await expect(drawer).toContainText(OTLP_AGENT.rootCallRequestId);
    await expect(drawer).toContainText("repl_main_thread");
  });

  test("the MCP tool call names its server and a denied tool reads as permission denied", async ({
    page,
  }) => {
    const events = await rootEvents(page);
    const mcp = one(events, "mcp_tool_call");
    const mcpRow = await eventsRow(page, mcp);
    await expect(mcpRow).toContainText("echo");
    await expect(mcpRow).toContainText(OTLP_AGENT.mcpServer);

    const denied = one(events, "session_signal", "permission_denied");
    const deniedRow = await eventsRow(page, denied);
    await expect(deniedRow).toContainText(`permission denied · ${OTLP_AGENT.deniedTool}`);
  });
});
