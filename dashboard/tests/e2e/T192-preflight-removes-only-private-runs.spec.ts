/**
 * T192 — The E2E pre-flight removes a private run and nothing else, and
 * only on an E2E stack.
 *
 * ``globalSetup`` calls ``clearPrivateFixtures`` (_private-fixtures.ts)
 * before it seeds, to remove the runs earlier runs' specs left. These
 * tests give it runs of their own, limited to those runs
 * (``clearPrivateFixtures({ only })``), so the other specs' live private
 * runs are untouched:
 *
 *   - a private agent's run, made with ``createPrivateAgent`` and
 *     ``startPrivateAgent``: removed, with its agent;
 *   - a look-alike: an agent named the way ``createPrivateAgent`` names
 *     one (``e2e-test-<label>-<8 hex>``), on a host that extends the
 *     private host by a suffix (what a prefix match would take): kept;
 *   - a seeded fixture's run (the ancient agent's): kept.
 *
 * And it deletes nothing when either condition of an E2E stack fails:
 * checked with a seed agent id no database holds, and with an agent-name
 * prefix the rest of the fleet does not carry, so no second database is
 * needed. On a stack that is not an E2E stack (an agent not named
 * ``e2e-...``, or no E2E seed) the tests check instead that nothing went.
 *
 * Data only: no page; they run unchanged under both theme projects.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  ANCIENT_AGENT,
  createPrivateAgent,
  fixtureSessionId,
  startPrivateAgent,
} from "./_fixtures";
import {
  PRIVATE_FIXTURE_HOSTS,
  clearPrivateFixtures,
  seedGateAgent,
  type ClearedPrivateFixtures,
} from "./_private-fixtures";
import { POSTGRES_CONTAINER, POSTGRES_DB } from "./_stack";
import { newRun, removeRun, seedRun, sessionStart, type Run } from "./_tool-content-run";

/** A host the pre-flight must not take: the private host plus a suffix. */
const LOOKALIKE_HOST = `${PRIVATE_FIXTURE_HOSTS.privateAgent}-lookalike`;

/** Run SQL against the stack's Postgres with values bound as psql
 *  variables, and return the ``key=value`` fields it prints. */
function psqlFields(sql: string, vars: Record<string, string>): Record<string, string> {
  const args = ["exec", "-i", POSTGRES_CONTAINER, "psql", "-U", "flightdeck", "-d", POSTGRES_DB, "-qtA", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  const result = spawnSync("docker", args, { input: sql, encoding: "utf8" });
  if (result.error) throw new Error(`psql: failed to run docker: ${result.error.message}`);
  expect(result.status, `psql: ${result.stderr}`).toBe(0);
  const fields: Record<string, string> = {};
  for (const f of result.stdout.split(/[\n|]/)) {
    const at = f.indexOf("=");
    if (at > 0) fields[f.slice(0, at)] = f.slice(at + 1);
  }
  return fields;
}

/** How many of these sessions and agents the database holds, by id. */
function rowsPresent(sessionIds: string[], agentIds: string[]): { sessions: number; agents: number } {
  const fields = psqlFields(
    "SELECT 'sessions=' || count(*) FROM sessions WHERE session_id = ANY (:'sids'::uuid[]);\n" +
      "SELECT 'agents=' || count(*) FROM agents WHERE agent_id = ANY (:'aids'::uuid[]);\n",
    { sids: `{${sessionIds.join(",")}}`, aids: `{${agentIds.join(",")}}` },
  );
  return { sessions: Number(fields.sessions), agents: Number(fields.agents) };
}

/** Whether the pre-flight's two conditions of an E2E stack hold. */
function isE2eStack(cleared: ClearedPrivateFixtures): boolean {
  return cleared.foreignAgents === 0 && cleared.seedFound;
}

/** A private agent with one stored, active run. */
async function privateRun(page: Page, label: string) {
  const agent = createPrivateAgent(label, 1);
  await startPrivateAgent(page, agent);
  return { agent, sessionId: agent.sessionIds[0]! };
}

test.describe("T192 — the pre-flight removes only private runs", () => {
  let lookalike: Run | undefined;

  test.afterEach(() => {
    // The look-alike is this spec's own and the pre-flight keeps it.
    if (lookalike) removeRun(lookalike);
    lookalike = undefined;
  });

  test("the seed's gate agent is the agent the seed wrote", () => {
    // The pre-flight derives the id from canonical.json as the seed
    // does; this pins that derivation to what the seed stored.
    const seed = seedGateAgent();
    const fields = psqlFields(
      "SELECT 'name=' || coalesce((SELECT agent_name FROM agents WHERE agent_id = :'aid'::uuid), '<none>');\n",
      { aid: seed.id },
    );
    expect(fields.name, `agent ${seed.id}`).toBe(seed.name);
  });

  test("a private run goes; a look-alike and a seeded fixture stay", async ({ page }, testInfo) => {
    const { agent, sessionId: privateSession } = await privateRun(page, "t192-preflight");

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
    const sessions = [privateSession, lookalike.sessionId, seededSession];
    const agents = [agent.agentId, lookalike.agentId];
    expect(rowsPresent(sessions, agents), "the three runs and the two agents exist before").toEqual({
      sessions: 3,
      agents: 2,
    });

    const cleared = clearPrivateFixtures({ only: sessions });
    expect(cleared.candidates, "one of the three is on a private host").toBe(1);

    if (!isE2eStack(cleared)) {
      testInfo.annotations.push({ type: "not an E2E stack", description: JSON.stringify(cleared) });
      expect(cleared).toMatchObject({ sessions: 0, agents: 0 });
      expect(rowsPresent(sessions, agents)).toEqual({ sessions: 3, agents: 2 });
      return;
    }

    expect(cleared, "removed: the private run and its agent").toMatchObject({ sessions: 1, agents: 1 });
    expect(rowsPresent([privateSession], [agent.agentId]), "the private run and agent are gone").toEqual({
      sessions: 0,
      agents: 0,
    });
    expect(rowsPresent([lookalike.sessionId], [lookalike.agentId]), "the look-alike stays").toEqual({
      sessions: 1,
      agents: 1,
    });
    expect(rowsPresent([seededSession], []), "the seeded fixture's run stays").toEqual({
      sessions: 1,
      agents: 0,
    });
  });

  test("without an E2E seed, or with an agent outside the prefix, nothing goes", async ({ page }, testInfo) => {
    const { agent, sessionId } = await privateRun(page, "t192-gate");

    // A seed agent no database holds: the no-seed condition.
    const noSeed = clearPrivateFixtures({ only: [sessionId], seedAgentId: randomUUID() });
    expect(noSeed, "no E2E seed: nothing deleted").toMatchObject({
      seedFound: false,
      candidates: 1,
      sessions: 0,
      agents: 0,
    });
    expect(rowsPresent([sessionId], [agent.agentId])).toEqual({ sessions: 1, agents: 1 });

    // A prefix only this spec's agents carry: every other agent of the
    // fleet counts as foreign, the not-an-E2E-stack condition.
    const foreign = clearPrivateFixtures({ only: [sessionId], agentNamePrefix: "e2e-test-t192-" });
    expect(foreign.foreignAgents, "the rest of the fleet counts as foreign").toBeGreaterThan(0);
    expect(foreign, "agents outside the prefix: nothing deleted").toMatchObject({ sessions: 0, agents: 0 });
    expect(rowsPresent([sessionId], [agent.agentId])).toEqual({ sessions: 1, agents: 1 });

    // With both conditions as they are, the run goes (on an E2E stack).
    const real = clearPrivateFixtures({ only: [sessionId] });
    if (!isE2eStack(real)) {
      testInfo.annotations.push({ type: "not an E2E stack", description: JSON.stringify(real) });
      expect(real).toMatchObject({ sessions: 0, agents: 0 });
      return;
    }
    expect(real).toMatchObject({ sessions: 1, agents: 1 });
    expect(rowsPresent([sessionId], [agent.agentId])).toEqual({ sessions: 0, agents: 0 });
  });
});
