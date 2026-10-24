import { test, expect, type Page } from "@playwright/test";
import { CODING_AGENT, waitForInvestigateReady } from "./_fixtures";

// T15 — streaming indicators on post_call
// rows. Two seeded variants:
//   - fresh-active role: a happy-path streaming post_call (final
//     outcome=completed). Expectation: ``stream-badge-<id>`` is
//     visible with the ``STREAM`` label and a title attribute that
//     carries chunks/p50/p95/max_gap.
//   - error-active role: an aborted streaming post_call (final
//     outcome=aborted). Expectation: ``stream-aborted-<id>`` is
//     visible with the ``ABORTED`` label and the title attribute
//     carries abort_reason.
//
// Both scenes deep-link into the session via ``?session=<id>`` --
// the dashboard's drawer URL param. Sequential row clicks against
// the drawer overlay are flaky, deep-linking avoids the
// choreography entirely.
//
// The session ids are derived deterministically by the seed (uuid5
// of ``flightdeck-e2e/<agent>/<role>``, see seed.py), and the
// streaming event's id is read from the API first, so each test
// waits on the one badge it expects. Probing badge counts before
// the drawer's events had loaded read as "no badge" and failed
// under CI load.
const FRESH_ACTIVE_SESSION_ID = "8660f293-7039-5cae-9f0a-f4c3428f20d6";
const ERROR_ACTIVE_SESSION_ID = "bff110c2-9605-5359-8161-92b58cb461fe";

// The drawer's default page size; the streaming event has to be
// inside it to render without "Show older".
const DRAWER_EVENTS_LIMIT = 100;

test.describe("T15 — Streaming indicators", () => {
  test("happy-path streaming post_call shows STREAM badge with chunk stats", async ({
    page,
  }) => {
    const eventId = await findStreamingEventId(
      page,
      FRESH_ACTIVE_SESSION_ID,
      "completed",
    );
    await openDrawer(page, FRESH_ACTIVE_SESSION_ID);

    const drawer = page.locator('[data-testid="session-drawer"]');
    const badge = drawer.locator(`[data-testid="stream-badge-${eventId}"]`);
    await expect(
      badge,
      "fresh-active session must surface a STREAM badge",
    ).toBeVisible();
    await expect(badge).toHaveText("STREAM");
    await expect(badge).toHaveAttribute("title", /chunks=42/);
    await expect(badge).toHaveAttribute("title", /p50=25ms/);
    await expect(badge).toHaveAttribute("title", /p95=80ms/);
    await expect(badge).toHaveAttribute("title", /max_gap=150ms/);
    await expect(
      drawer.locator('[data-testid^="stream-aborted-"]'),
    ).toHaveCount(0);
  });

  test("aborted streaming post_call shows ABORTED badge with abort_reason", async ({
    page,
  }) => {
    const eventId = await findStreamingEventId(
      page,
      ERROR_ACTIVE_SESSION_ID,
      "aborted",
    );
    await openDrawer(page, ERROR_ACTIVE_SESSION_ID, "rate_limit");

    const drawer = page.locator('[data-testid="session-drawer"]');
    const badge = drawer.locator(`[data-testid="stream-aborted-${eventId}"]`);
    await expect(
      badge,
      "error-active session must surface an ABORTED stream badge",
    ).toBeVisible();
    await expect(badge).toHaveText("ABORTED");
    await expect(badge).toHaveAttribute("title", /abort_reason=client_aborted/);
  });
});

async function openDrawer(
  page: Page,
  sessionId: string,
  errorType?: string,
): Promise<void> {
  const params = new URLSearchParams({
    from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
    flavor: CODING_AGENT.flavor,
    ...(errorType ? { error_type: errorType } : {}),
    session: sessionId,
  });
  await page.goto(`/investigate?${params.toString()}`);
  await waitForInvestigateReady(page);
  await expect(page.locator('[data-testid="session-drawer"]')).toBeVisible();
}

/**
 * Return the id of the session's streaming post_call with the given
 * final outcome, from the same page of events the drawer loads.
 */
async function findStreamingEventId(
  page: Page,
  sessionId: string,
  finalOutcome: "completed" | "aborted",
): Promise<string> {
  const resp = await page.request.get(
    `http://localhost:4000/api/v1/sessions/${sessionId}?events_limit=${DRAWER_EVENTS_LIMIT}`,
    { headers: { Authorization: "Bearer tok_dev" } },
  );
  expect(resp.ok(), `GET session ${sessionId}`).toBe(true);
  const body = (await resp.json()) as {
    events?: Array<{
      id: string;
      event_type: string;
      payload?: { streaming?: { final_outcome?: string } } | null;
    }>;
  };
  const match = (body.events ?? []).find(
    (e) =>
      e.event_type === "post_call" &&
      e.payload?.streaming?.final_outcome === finalOutcome,
  );
  expect(
    match,
    `seeded session ${sessionId} must carry a ${finalOutcome} streaming post_call ` +
      `within the drawer's first ${DRAWER_EVENTS_LIMIT} events`,
  ).toBeDefined();
  return match!.id;
}
