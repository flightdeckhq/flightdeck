import { test, expect, type APIRequestContext } from "@playwright/test";
import { CODING_AGENT } from "./_fixtures";

// T12 — the Investigate agent-id chip resolves its label via the
// ``/v1/agents/{id}`` endpoint when the fleet-store roster misses.
//
// Repro shape. The chip label resolver walks four sources in order:
//   1. fleet-store agents[] (hydrated on Investigate mount)
//   2. sessions list for the current filter window
//   3. /v1/agents/{id} cache (S5a — the endpoint under test)
//   4. 8-char UUID prefix (final fallback + console.warn)
//
// To force path (3) we intercept /v1/fleet to return an empty roster
// and point the Investigate URL at a time range with no sessions. That
// eliminates (1) and (2) so only the new by-id fetch can produce a
// human-readable label. Intercepting /v1/fleet (instead of wiping
// Postgres) is deterministic and leaves the shared dev DB untouched
// for the other specs running in parallel.

async function fetchAgentIdByName(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  // Use tok_dev (the default extraHTTPHeaders token) to look up
  // CODING_AGENT's agent_id from /v1/fleet. We cannot precompute
  // the id in _fixtures because the seed generates a fresh UUID per
  // run.
  const res = await request.get(
    `/api/v1/fleet?page=1&per_page=200`,
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    agents: Array<{ agent_id: string; agent_name: string }>;
  };
  const match = body.agents.find((a) => a.agent_name === name);
  if (!match) {
    throw new Error(
      `T12 setup: agent ${name} not found in /v1/fleet. Re-seed with make seed-e2e.`,
    );
  }
  return match.agent_id;
}

test.describe("T12 — agent-id chip resolves via /v1/agents/{id}", () => {
  test("fleet-roster-empty + no-session-match → chip shows real agent_name", async ({
    page,
    request,
  }) => {
    const agentId = await fetchAgentIdByName(request, CODING_AGENT.name);

    // Intercept /v1/fleet for this page context only. The handler
    // returns an empty agents[] so the Investigate fleet-store load
    // produces no roster entries; the resolver must then fall back
    // to /v1/agents/{id}. The /v1/agents/{id} call goes through to
    // the real backend (we do not intercept that route).
    await page.route("**/api/v1/fleet**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agents: [],
          total: 0,
          page: 1,
          per_page: 200,
          context_facets: {},
        }),
      });
    });

    // Point the time range at ancient history so the sessions list
    // for this agent is empty too — no session_match source to lean on.
    const from = new Date("2001-01-01T00:00:00Z").toISOString();
    const to = new Date("2001-01-02T00:00:00Z").toISOString();
    const params = new URLSearchParams({ agent_id: agentId, from, to });
    await page.goto(`/investigate?${params.toString()}`);

    // Wait for the active-filter bar to render. The chip label lands
    // after /v1/agents/{id} resolves, which should happen within the
    // default timeout. The assertion must be the POSITIVE one: chip
    // shows CODING_AGENT.name. If the regression returned, the label
    // would be the 8-char UUID prefix and this assertion would fail.
    const pills = page.locator('[data-testid="active-filter-pill"]');
    await expect(pills).toHaveCount(1);
    await expect(pills.first()).toContainText(`agent:${CODING_AGENT.name}`);

    // Negative guard: chip must not fall back to the 8-char UUID prefix.
    const uuidPrefix = agentId.slice(0, 8);
    await expect(
      pills.first(),
      "chip must not fall back to UUID prefix when /v1/agents/{id} is available",
    ).not.toContainText(`agent:${uuidPrefix}`);
  });
});
