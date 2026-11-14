import { test, expect } from "@playwright/test";
import { GENAI_FIXTURE, genaiEvents, genaiSession, newestGenaiRun } from "./_fixtures";
import { API_URL } from "./_stack";

// T160 — a run whose exporter declared prompt capture, but whose
// framework sent no content (Pydantic AI with its own content switch
// off), stores no content at all. Its Prompts tab says the run
// recorded none, and why, rather than claiming capture is off: the
// drawer reads the run's stored posture (``capture_prompts`` on
// ``GET /v1/sessions/:id``). The run is a recorded export the E2E seed
// replays with capture on through the OTLP receiver
// (tests/e2e-fixtures/genai_seed.py). Assertions are structural and
// theme-agnostic (Rule 40c.3).

const AUTH = { Authorization: "Bearer tok_dev" };

test.describe("T160 — a capture-on run without content says so", () => {
  test("the API carries the run's capture posture, and no event stored content", async ({
    page,
  }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.noContent);
    const agent = genaiSession(run, `${GENAI_FIXTURE.noContent}/weather_agent`);
    const resp = await page.request.get(
      `${API_URL}/v1/sessions/${agent.session_id}`,
      { headers: AUTH },
    );
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      session: { capture_prompts: boolean | null; capture_enabled: boolean };
      events: { has_content: boolean }[];
    };
    expect(body.session.capture_prompts).toBe(true);
    expect(body.session.capture_enabled).toBe(false);
    expect(body.events.some((e) => e.has_content)).toBe(false);
  });

  test("the run's Prompts tab says it recorded no content, and why", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.noContent);
    const agent = genaiSession(run, `${GENAI_FIXTURE.noContent}/weather_agent`);
    await page.goto(`/events?run=${agent.session_id}`);
    const drawer = page.getByTestId("session-drawer");
    await expect(drawer.getByTestId("otel-session-badge")).toBeVisible();
    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.getByTestId("prompts-no-content-for-run")).toContainText(
      "No content was recorded for this run.",
    );
    await expect(drawer.getByTestId("prompts-no-content-reason")).toContainText(
      "the framework sent no content for any call",
    );
    await expect(drawer.getByText("Prompt capture is not enabled for this deployment.")).toHaveCount(0);
  });

  test("a call's Prompts tab says the call recorded none", async ({ page }) => {
    const run = await newestGenaiRun(page, GENAI_FIXTURE.noContent);
    const agent = genaiSession(run, `${GENAI_FIXTURE.noContent}/weather_agent`);
    const [call] = (await genaiEvents(page, agent.session_id)).filter(
      (e) => e.event_type === "post_call",
    );
    await page.goto(`/events?event=${call!.id}&event_session=${agent.session_id}`);
    const eventDrawer = page.getByTestId("event-detail-drawer");
    await expect(eventDrawer).toBeVisible();
    await eventDrawer.getByTestId("detail-tab-prompts").click();
    await expect(eventDrawer.getByTestId("prompts-no-content-for-event")).toContainText(
      "No content was recorded for this event.",
    );
    await expect(eventDrawer.getByTestId("prompts-no-content-reason")).toContainText(
      "A call that carries only its tool definitions stores none.",
    );
  });

  test("a capture-off run keeps the disabled state", async ({ page }) => {
    // The control: the same framework's run replayed without capture.
    const run = await newestGenaiRun(page, GENAI_FIXTURE.captureOff);
    const agent = genaiSession(run, `${GENAI_FIXTURE.captureOff}/weather_agent`);
    const resp = await page.request.get(
      `${API_URL}/v1/sessions/${agent.session_id}`,
      { headers: AUTH },
    );
    expect(((await resp.json()) as { session: { capture_prompts: boolean | null } }).session.capture_prompts).toBe(false);
    await page.goto(`/events?run=${agent.session_id}`);
    const drawer = page.getByTestId("session-drawer");
    await expect(drawer.getByTestId("otel-session-badge")).toBeVisible();
    await drawer.getByTestId("drawer-tab-prompts").click();
    await expect(drawer.getByTestId("prompts-capture-disabled")).toHaveText(
      "Prompt capture is not enabled for this deployment.",
    );
    await expect(drawer.getByTestId("prompts-no-content-for-run")).toHaveCount(0);
  });
});
