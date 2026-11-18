/**
 * T192 — The E2E pre-flight removes a private run and nothing else.
 *
 * ``globalSetup`` calls ``clearPrivateFixtures`` (_private-fixtures.ts)
 * before it seeds, to remove the runs earlier runs' specs left. This spec
 * gives it three runs and checks what goes:
 *
 *   - a private agent's run, made with ``createPrivateAgent`` and
 *     ``startPrivateAgent``: removed, with its agent;
 *   - a look-alike: an agent named the way ``createPrivateAgent`` names
 *     one (``e2e-test-<label>-<8 hex>``), on a host that extends the
 *     private host by a suffix (what a prefix match would take): kept;
 *   - a seeded fixture's run (the ancient agent's): kept.
 *
 * Limited to those three runs (``clearPrivateFixtures(only)``), so the
 * other specs' live private runs are untouched. On a stack that is not
 * an E2E stack (an agent not named ``e2e-...``) the pre-flight deletes
 * nothing, and the spec checks that instead.
 *
 * Data only: no page; it runs unchanged under both theme projects.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  ANCIENT_AGENT,
  createPrivateAgent,
  fixtureSessionId,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";
import { PRIVATE_FIXTURE_HOSTS, clearPrivateFixtures } from "./_private-fixtures";
import { POSTGRES_CONTAINER, POSTGRES_DB } from "./_stack";
import { newRun, removeRun, seedRun, sessionStart, type Run } from "./_tool-content-run";

/** A host the pre-flight must not take: the private host plus a suffix. */
const LOOKALIKE_HOST = `${PRIVATE_FIXTURE_HOSTS.privateAgent}-lookalike`;

/** How many of these sessions and agents the database holds, by id. */
function rowsPresent(sessionIds: string[], agentIds: string[]): { sessions: number; agents: number } {
  const result = spawnSync(
    "docker",
    [
      "exec", "-i", POSTGRES_CONTAINER, "psql", "-U", "flightdeck", "-d", POSTGRES_DB,
      "-qtA", "-v", "ON_ERROR_STOP=1",
      "-v", `sids={${sessionIds.join(",")}}`, "-v", `aids={${agentIds.join(",")}}`,
    ],
    {
      input:
        "SELECT 'sessions=' || count(*) FROM sessions WHERE session_id = ANY (:'sids'::uuid[]);\n" +
        "SELECT 'agents=' || count(*) FROM agents WHERE agent_id = ANY (:'aids'::uuid[]);\n",
      encoding: "utf8",
    },
  );
  if (result.error) throw new Error(`psql: failed to run docker: ${result.error.message}`);
  expect(result.status, `psql: ${result.stderr}`).toBe(0);
  const count = (key: string) =>
    Number(result.stdout.split("\n").find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1));
  return { sessions: count("sessions"), agents: count("agents") };
}

test.describe("T192 — the pre-flight removes only private runs", () => {
  let agent: PrivateAgent | undefined;
  let lookalike: Run | undefined;

  test.afterEach(() => {
    // The look-alike is this spec's own and the pre-flight keeps it.
    if (lookalike) removeRun(lookalike);
  });

  test("a private run goes; a look-alike and a seeded fixture stay", async ({ page }, testInfo) => {
    agent = createPrivateAgent("t192-preflight", 1);
    await startPrivateAgent(page, agent);

    const run = newRun("t192", testInfo.project.name);
    lookalike = { ...run, agentName: `e2e-test-t192-lookalike-${randomUUID().slice(0, 8)}` };
    await seedRun(page.request, lookalike, [
      {
        ...sessionStart(lookalike, false),
        host: LOOKALIKE_HOST,
        hostname: LOOKALIKE_HOST,
        context: { os: "Linux", arch: "x86_64", hostname: LOOKALIKE_HOST, user: "e2e" },
      },
    ]);

    const seededSession = fixtureSessionId(ANCIENT_AGENT.name, "ancient-only");
    const privateSession = agent.sessionIds[0]!;
    expect(
      rowsPresent([privateSession, lookalike.sessionId, seededSession], [agent.agentId, lookalike.agentId]),
      "the three runs and the two agents exist before the pre-flight",
    ).toEqual({ sessions: 3, agents: 2 });

    const cleared = clearPrivateFixtures([privateSession, lookalike.sessionId, seededSession]);

    if (cleared.foreignAgents > 0) {
      // Not an E2E stack: the pre-flight deletes nothing at all.
      testInfo.annotations.push({
        type: "not an E2E stack",
        description: `${cleared.foreignAgents} agents are not named e2e-; the pre-flight deleted nothing`,
      });
      expect(cleared).toMatchObject({ sessions: 0, agents: 0 });
      expect(
        rowsPresent([privateSession, lookalike.sessionId, seededSession], [agent.agentId, lookalike.agentId]),
      ).toEqual({ sessions: 3, agents: 2 });
      return;
    }

    expect(cleared, "removed: the private run and its agent").toMatchObject({ sessions: 1, agents: 1 });
    expect(rowsPresent([privateSession], [agent.agentId]), "the private run and agent are gone").toEqual({
      sessions: 0,
      agents: 0,
    });
    expect(
      rowsPresent([lookalike.sessionId], [lookalike.agentId]),
      "the look-alike run and agent stay",
    ).toEqual({ sessions: 1, agents: 1 });
    expect(rowsPresent([seededSession], []), "the seeded fixture's run stays").toEqual({
      sessions: 1,
      agents: 0,
    });
  });
});
