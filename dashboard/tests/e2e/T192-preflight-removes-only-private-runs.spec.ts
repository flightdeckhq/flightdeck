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
 * A scope can only narrow it: a prefix that does not extend ``e2e-``, or
 * an id that is not a uuid, throws before psql starts; and the SQL itself
 * refuses such a prefix, and refuses to delete a listed run whose agent
 * is not named ``e2e-...``, whatever the scope passed. Those SQL checks
 * run inside a transaction the test rolls back, against a real-like
 * agent (``dev@dev-laptop``) that only that transaction holds, so no
 * other session, spec or database ever sees it.
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
  E2E_AGENT_NAME_PREFIX,
  PREFLIGHT_SQL_BODY,
  PRIVATE_FIXTURE_HOSTS,
  clearPrivateFixtures,
  preflightPsqlArgs,
  seedGateAgent,
  type ClearedPrivateFixtures,
  type E2eAgentNamePrefix,
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

/** The pre-flight's statements, with these prefixes, scoped to one run
 *  that only this transaction holds: a run on the private host of an
 *  agent named ``agentName``, whose own row names it ``sessionAgentName``.
 *  The transaction is rolled back whatever happens, so nothing it holds
 *  is ever seen outside it. Returns psql's exit status and output; after
 *  the pre-flight's statements it reports whether that run is still
 *  there (``planted=1``). */
function preflightOnPlantedRun(opts: {
  prefix: string;
  gatePrefix: string;
  agentName: string;
  sessionAgentName: string;
}): { status: number | null; stdout: string; stderr: string } {
  const seed = seedGateAgent();
  const sessionId = randomUUID();
  const args = preflightPsqlArgs({
    prefix: opts.prefix,
    gatePrefix: opts.gatePrefix,
    seedId: seed.id,
    checkSeedId: seed.id,
    seedName: seed.name,
    scoped: true,
    only: [sessionId],
  });
  args.push(
    "-v", `planted_sid=${sessionId}`,
    "-v", `planted_aid=${randomUUID()}`,
    "-v", `planted_agent=${opts.agentName}`,
    "-v", `planted_session_agent=${opts.sessionAgentName}`,
    "-v", `planted_host=${PRIVATE_FIXTURE_HOSTS.privateAgent}`,
  );
  const input =
    "BEGIN;\n" +
    "INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname) " +
    "VALUES (:'planted_aid'::uuid, 'coding', 'claude_code', :'planted_agent', 'dev', 'dev-laptop');\n" +
    "INSERT INTO sessions (session_id, flavor, agent_type, host, agent_id, client_type, agent_name) " +
    "VALUES (:'planted_sid'::uuid, 'claude-code', 'coding', :'planted_host', :'planted_aid'::uuid, " +
    "'claude_code', :'planted_session_agent');\n" +
    PREFLIGHT_SQL_BODY +
    "SELECT 'planted=' || count(*) FROM sessions WHERE session_id = :'planted_sid'::uuid;\n" +
    "ROLLBACK;\n";
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.error) throw new Error(`psql: failed to run docker: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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

  test("a scope that does not narrow throws before psql, and nothing goes", async ({ page }, testInfo) => {
    const { agent, sessionId } = await privateRun(page, "t192-scope");
    // What the type refuses, passed past it.
    const notExtending = (prefix: string) => prefix as E2eAgentNamePrefix;

    for (const prefix of ["", "o", "e2e", "E2E-"]) {
      expect(
        () => clearPrivateFixtures({ only: [sessionId], agentNamePrefix: notExtending(prefix) }),
        `prefix ${JSON.stringify(prefix)}`,
      ).toThrow(/does not extend e2e-/);
    }
    expect(() => clearPrivateFixtures({ only: [sessionId], seedAgentId: "not-a-uuid" })).toThrow(/not a uuid/);
    expect(() => clearPrivateFixtures({ only: [`${sessionId},${randomUUID()}`] })).toThrow(/not a uuid/);
    expect(rowsPresent([sessionId], [agent.agentId]), "the private run is still there").toEqual({
      sessions: 1,
      agents: 1,
    });

    const real = clearPrivateFixtures({ only: [sessionId] });
    if (!isE2eStack(real)) {
      testInfo.annotations.push({ type: "not an E2E stack", description: JSON.stringify(real) });
      return;
    }
    expect(real).toMatchObject({ sessions: 1, agents: 1 });
  });

  test("the SQL refuses a widening prefix and a listed run of a non-e2e- agent", () => {
    // A real Claude Code agent's run on the private host, listed: the
    // reviewer's case. Prefixes that do not extend e2e- are refused by
    // the SQL itself, before any delete.
    for (const [prefix, gatePrefix] of [
      [E2E_AGENT_NAME_PREFIX, ""],
      [E2E_AGENT_NAME_PREFIX, "o"],
      ["", ""],
      ["o", "o"],
    ] as const) {
      const run = preflightOnPlantedRun({
        prefix,
        gatePrefix,
        agentName: "dev@dev-laptop",
        sessionAgentName: "dev@dev-laptop",
      });
      expect(run.status, `prefix ${JSON.stringify(prefix)}, gate ${JSON.stringify(gatePrefix)}`).not.toBe(0);
      expect(run.stderr).toContain("the agent-name prefixes must be e2e- and extend it");
      expect(run.stdout).not.toContain("sessions=");
    }

    // A prefix that narrows: the real agent counts as foreign, so the
    // run stays.
    const narrowed = preflightOnPlantedRun({
      prefix: E2E_AGENT_NAME_PREFIX,
      gatePrefix: "e2e-test-t192-",
      agentName: "dev@dev-laptop",
      sessionAgentName: "dev@dev-laptop",
    });
    expect(narrowed.status, narrowed.stderr).toBe(0);
    expect(narrowed.stdout).toContain("sessions=0");
    expect(narrowed.stdout).toContain("planted=1");

    // A run whose agent row is named e2e- (so the stack passes for an
    // E2E stack) but whose own row names a real agent: the check of the
    // runs to delete uses the fixed prefix and refuses it. On a stack
    // that is not an E2E stack nothing is selected, and the run stays.
    const shadow = preflightOnPlantedRun({
      prefix: E2E_AGENT_NAME_PREFIX,
      gatePrefix: E2E_AGENT_NAME_PREFIX,
      agentName: `e2e-test-t192-shadow-${randomUUID().slice(0, 8)}`,
      sessionAgentName: "dev@dev-laptop",
    });
    if (shadow.status === 0) {
      expect(shadow.stdout, "not an E2E stack: nothing selected").toContain("sessions=0");
      expect(shadow.stdout).toContain("planted=1");
    } else {
      expect(shadow.stderr).toContain("names no e2e- agent: nothing deleted");
      expect(shadow.stdout).not.toContain("sessions=");
    }
  });
});
