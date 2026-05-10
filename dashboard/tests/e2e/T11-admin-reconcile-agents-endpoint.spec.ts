import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { findAgentTableRow } from "./_fixtures";

// T11 — the POST /v1/admin/reconcile-agents endpoint end-to-end.
// Creates a drifted fixture directly via psql (same pattern the
// Python ``create_drifted_agent`` helper uses), posts to the
// reconcile endpoint with the regular bearer token, asserts the
// response reports a correction, and verifies the Fleet table
// re-renders the ground-truth value. Theme-agnostic per rule 40c.3.
//
// Why bypass the API for seeding: the whole point of the fixture is
// drift — an event-driven setup would re-sync the counters the worker
// maintains, defeating the regression we're checking. Direct psql
// inserts match the Go unit tests and the Python integration tests.

function psqlExec(sql: string): void {
  const result = spawnSync(
    "docker",
    ["exec", "docker-postgres-1", "psql", "-U", "flightdeck",
      "-d", "flightdeck", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql exec failed (status ${result.status}): ${result.stderr?.trim()}`,
    );
  }
}

function createDriftedAgent(args: {
  agentName: string;
  actualSessions: number;
  actualTokensPerSession: number;
  driftedSessions: number;
  driftedTokens: number;
}): string {
  const agentID = randomUUID();
  const escapedName = args.agentName.replace(/'/g, "''");
  const sessions: string[] = [];
  for (let i = 0; i < args.actualSessions; i++) {
    const minutesAgo = args.actualSessions - i;
    sessions.push(`
      INSERT INTO sessions (
        session_id, agent_id, flavor, state,
        started_at, last_seen_at, tokens_used,
        agent_type, client_type
      ) VALUES (
        gen_random_uuid(), '${agentID}'::uuid, 'e2e-t11-drift', 'closed',
        NOW() - INTERVAL '${minutesAgo} minutes',
        NOW() - INTERVAL '${minutesAgo} minutes',
        ${args.actualTokensPerSession},
        'production', 'flightdeck_sensor'
      );`);
  }
  psqlExec(`
    INSERT INTO agents (
      agent_id, agent_type, client_type, agent_name,
      user_name, hostname,
      first_seen_at, last_seen_at,
      total_sessions, total_tokens
    ) VALUES (
      '${agentID}'::uuid, 'production', 'flightdeck_sensor', '${escapedName}',
      'e2e-t11', 'e2e-t11-host',
      NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour',
      ${args.driftedSessions}, ${args.driftedTokens}
    );
    ${sessions.join("\n")}
  `);
  return agentID;
}

function deleteAgent(agentID: string): void {
  try {
    psqlExec(
      `DELETE FROM sessions WHERE agent_id = '${agentID}'::uuid; ` +
      `DELETE FROM agents WHERE agent_id = '${agentID}'::uuid;`,
    );
  } catch {
    // Best-effort teardown; don't fail the test on cleanup issues.
  }
}

async function postReconcile(
  request: APIRequestContext,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post("/api/v1/admin/reconcile-agents");
  return {
    status: res.status(),
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

test.describe("T11 — POST /v1/admin/reconcile-agents corrects drift end-to-end", () => {
  test("drifted fixture → reconcile → Fleet shows ground-truth counters", async ({
    page,
    request,
  }) => {
    // Agent name deliberately does NOT carry the ``e2e-test-`` prefix:
    // T9 (swimlane-table-parity) counts ``e2e-test-*`` agents and
    // expects exactly 3 (the canonical fixtures). Using a disjoint
    // prefix keeps T11's transient fixture out of T9's query under
    // fullyParallel test scheduling.
    const name = `t11-recon-${randomUUID().slice(0, 8)}`;
    const actualSessions = 2;
    const actualTokensPerSession = 150;
    const driftedSessions = 99;
    const driftedTokens = 999_999;
    const groundTruthTokens = actualSessions * actualTokensPerSession;

    const agentID = createDriftedAgent({
      agentName: name,
      actualSessions,
      actualTokensPerSession,
      driftedSessions,
      driftedTokens,
    });

    try {
      // Navigate to Fleet, flip to table view so the counter columns
      // are visible, and confirm the drifted agent surfaces with
      // WRONG counts. This establishes the baseline the reconcile is
      // about to correct.
      await page.goto("/?view=table");
      const row = findAgentTableRow(page, name);
      await expect(row).toBeVisible({ timeout: 15_000 });
      // The row should show 99 sessions (the drifted value) BEFORE
      // reconcile. Cell text is the raw number; match loosely on the
      // row's text content to avoid brittle column-index parsing.
      await expect(row).toContainText(String(driftedSessions));

      // Single-tier auth: the regular bearer token from the global
      // extraHTTPHeaders config has full access (D156).
      const { status, body } = await postReconcile(request);
      expect(status).toBe(200);
      const countersUpdated =
        (body.counters_updated as Record<string, number> | undefined) ?? {};
      expect(
        countersUpdated.total_sessions ?? 0,
        `reconcile response should report total_sessions correction: ${JSON.stringify(body)}`,
      ).toBeGreaterThanOrEqual(1);
      expect(countersUpdated.total_tokens ?? 0).toBeGreaterThanOrEqual(1);

      // Refresh Fleet and assert ground truth is now shown. A full
      // reload re-queries /v1/fleet and unambiguously reflects the
      // post-reconcile DB state. The drifted-to-correct transition
      // for ``total_sessions`` (99 → 2) is the headline assertion.
      await page.reload();
      const refreshedRow = findAgentTableRow(page, name);
      await expect(refreshedRow).toBeVisible({ timeout: 15_000 });
      await expect(refreshedRow).toContainText(String(actualSessions));
      await expect(
        refreshedRow,
        "drifted session count must no longer appear in the row after reconcile",
      ).not.toContainText(String(driftedSessions));
      // total_tokens shows formatted (e.g. "300" or "1.2K" via
      // formatTokens). For 300 tokens the raw value appears literally.
      await expect(refreshedRow).toContainText(String(groundTruthTokens));
    } finally {
      deleteAgent(agentID);
    }
  });
});
