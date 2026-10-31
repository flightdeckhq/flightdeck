import { test, expect } from "@playwright/test";

// T126 — Claude Code's compaction and model switch reach the dashboard
// as session_signal events. The seed puts two on the coding agent's
// recent-closed session: a compaction with a captured summary and a
// model switch. The compaction's drawer lists the signal and its
// trigger and shows the summary on the Prompts tab; the model switch's
// Events row reads "model <from> → <to> · <source>". Both are
// deep-linked by event id, read from the API. Theme-agnostic per Rule
// 40c.3.

// uuid5 of flightdeck-e2e/e2e-test-coding-agent/recent-closed (see
// seed.py).
const RECENT_CLOSED_SESSION_ID = "a2fbef57-8602-57ae-95d2-8c12ccd88534";

type Ev = { id: string; event_type: string; occurred_at: string; payload?: { signal?: string } | null };

test.describe("T126 — session signals: compaction and model switch", () => {
  test("a compaction lists its signal and trigger and shows its summary; a model switch names both models", async ({
    page,
  }) => {
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions/${RECENT_CLOSED_SESSION_ID}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "session API call must succeed").toBe(true);
    const body = (await resp.json()) as { events?: Ev[] };
    const signals = (body.events ?? []).filter((e) => e.event_type === "session_signal");
    const compacted = signals.find((e) => e.payload?.signal === "context_compacted");
    const switched = signals.find((e) => e.payload?.signal === "model_switched");
    expect(compacted, "the seed's context_compacted signal must exist").toBeDefined();
    expect(switched, "the seed's model_switched signal must exist").toBeDefined();

    await page.goto(`/events?event=${compacted!.id}&event_session=${RECENT_CLOSED_SESSION_ID}`);
    const drawer = page.getByTestId("event-detail-drawer");
    const summary = drawer.getByTestId("detail-summary");
    await expect(summary).toBeVisible();
    for (const text of ["Signal", "context compacted", "Trigger", "auto"]) {
      await expect(summary).toContainText(text);
    }
    await drawer.getByTestId("detail-tab-prompts").click();
    await expect(drawer.getByTestId("signal-content-compact_summary")).toContainText(
      "E2E compaction summary: the agent fixed the parser.",
    );

    const at = Date.parse(switched!.occurred_at);
    const params = new URLSearchParams({
      event_type: "session_signal",
      from: new Date(at - 60_000).toISOString(),
      to: new Date(at + 60_000).toISOString(),
    });
    await page.goto(`/events?${params.toString()}`);
    await expect(page.locator(`[data-testid="events-row"][data-event-id="${switched!.id}"]`)).toContainText(
      "model claude-sonnet-4-5 → claude-opus-4-7 · command",
    );
  });

  test("notifications, denials, commands, tasks, directory, settings changes and MCP input name what happened in the feed line", async ({ page }) => {
    const resp = await page.request.get(
      `http://localhost:4000/api/v1/sessions/${RECENT_CLOSED_SESSION_ID}`,
      { headers: { Authorization: "Bearer tok_dev" } },
    );
    expect(resp.ok(), "session API call must succeed").toBe(true);
    const body = (await resp.json()) as { events?: Ev[] };
    const signals = (body.events ?? []).filter((e) => e.event_type === "session_signal");
    const cases: Array<[string, string]> = [
      ["notification", "notification · idle prompt"],
      ["permission_denied", "permission denied · Bash · [Irreversible Local Destruction]"],
      ["command_expanded", "command · /review"],
      ["task_completed", "task completed · e2e-tester"],
      ["cwd_changed", "cwd → /work/e2e/api"],
      ["config_changed", "settings changed · project settings"],
      ["elicitation_responded", "MCP input declined · e2e-asker"],
    ];
    for (const [name, line] of cases) {
      const event = signals.find((e) => e.payload?.signal === name);
      expect(event, `the seed's ${name} signal must exist`).toBeDefined();
      const at = Date.parse(event!.occurred_at);
      const params = new URLSearchParams({
        event_type: "session_signal",
        from: new Date(at - 60_000).toISOString(),
        to: new Date(at + 60_000).toISOString(),
      });
      await page.goto(`/events?${params.toString()}`);
      await expect(page.locator(`[data-testid="events-row"][data-event-id="${event!.id}"]`)).toContainText(line);
    }
  });
});
