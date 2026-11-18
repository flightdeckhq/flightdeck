/**
 * The runs the browser specs make for themselves through ingestion,
 * outside the seed, and the pre-flight that removes what earlier runs
 * left of them.
 *
 * CI starts every run from a freshly seeded database. A local stack
 * keeps what each run's specs posted: the private agents of
 * ``createPrivateAgent`` (ended, never removed), T130's fixed-id agents,
 * and the run of any spec killed before its ``afterEach`` removed it. The
 * Fleet's first render mounts every agent's row once, so every run left
 * behind makes the next run's pages slower. ``clearPrivateFixtures``,
 * called by ``globalSetup`` before it seeds, removes them, so a local run
 * starts from the seeded fleet as CI's does.
 *
 * The marker. Every such run sends one of the hosts below as its
 * ``host`` (stored in ``sessions.host``) and its ``hostname`` (stored in
 * ``agents.hostname``), and names its agent ``e2e-...``. The hosts are
 * exact strings that only these helpers and specs send: the seed, the
 * integration fixtures, the sensor, the plugin and the playground send
 * none of them. A run is removed only when its host is one of them
 * (matched exactly, never by prefix) and its agent is named ``e2e-...``;
 * a row on one of the hosts that names any other agent is not one of
 * these runs, and the pre-flight then deletes nothing and fails.
 *
 * The stack. The pre-flight deletes only on an E2E stack, which it tells
 * by its data, on two conditions checked in the transaction that deletes:
 *
 *   - every agent in the database is named ``e2e-...``, as the seed's
 *     fixtures and these runs are: a real Claude Code session, a
 *     playground run or the integration suite's agents rule it out;
 *   - the database holds the seed's coding fixture agent, by the id the
 *     seed derives for it from canonical.json: a database the E2E seed
 *     never wrote is not one.
 *
 * Elsewhere it deletes nothing and says why. The address does not tell:
 * CI's E2E stack and a developer's own dev stack both answer on
 * http://localhost:4000 with the container ``docker-postgres-1``.
 *
 * A helper or spec that makes runs of its own takes its host from here.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAgentId, type AgentIdentity } from "./_identity";
import { POSTGRES_CONTAINER, POSTGRES_DB } from "./_stack";

/** The host each producer of private runs sends. */
export const PRIVATE_FIXTURE_HOSTS = {
  /** ``createPrivateAgent`` / ``createPrivateSubAgent`` and every
   *  ``postPrivate*`` call on their runs (_fixtures.ts). */
  privateAgent: "e2e-host-private",
  /** ``newRun`` (_tool-content-run.ts): T14, T162, T163, T165, T166, T178. */
  toolContentRun: "e2e-tool-content-host",
  /** T130's fixed-id agents. */
  fleetControls: "e2e-fleet-controls-host",
  /** T149's run. */
  t149: "e2e-t149-host",
  /** T150's run. */
  t150: "e2e-t150-host",
  /** T164's run. */
  t164: "e2e-t164-host",
} as const;

/** The prefix every agent of an E2E stack is named with: the seed's
 *  fixtures' and the private runs'. */
export const E2E_AGENT_NAME_PREFIX = "e2e-";

/** The seed's fixture agent whose presence marks a database the E2E seed
 *  wrote: the coding agent, in every seeded database (T01 and others read
 *  it), and deleted by no spec. */
const SEED_GATE_AGENT_NAME = "e2e-test-coding-agent";

/** canonical.json, the fixture declaration seed.py reads. */
const CANONICAL_JSON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "tests",
  "e2e-fixtures",
  "canonical.json",
);

/** The seed's gate agent: its name and the id the seed sends for it,
 *  derived from its canonical.json entry as the seed derives it. */
export function seedGateAgent(): { id: string; name: string } {
  const canonical = JSON.parse(readFileSync(CANONICAL_JSON, "utf8")) as {
    agents: AgentIdentity[];
  };
  const entry = canonical.agents.find((a) => a.agent_name === SEED_GATE_AGENT_NAME);
  if (!entry) {
    throw new Error(`seedGateAgent: ${SEED_GATE_AGENT_NAME} is not in ${CANONICAL_JSON}`);
  }
  return { id: deriveAgentId(entry), name: entry.agent_name };
}

// How long the pre-flight's one psql call may take. It deletes in bulk,
// a few statements over at most some thousands of rows on a dev
// database that has run the suite many times, in well under a second;
// the ceiling surfaces a stalled Docker daemon or Postgres container as
// a failed run instead of a globalSetup that hangs.
const PREFLIGHT_PSQL_TIMEOUT_MS = 60_000;

/** What ``clearPrivateFixtures`` found and removed. */
export interface ClearedPrivateFixtures {
  /** Runs on the private hosts, before either condition is applied. */
  candidates: number;
  /** Agents not named ``e2e-...`` (nor, with a scope's narrower prefix,
   *  that prefix): more than none means the database is not an E2E
   *  stack, and nothing was deleted. */
  foreignAgents: number;
  /** Whether the seed's gate agent is in the database (and, with a
   *  scope's seed agent id, that agent too): without it the database is
   *  not an E2E stack, and nothing was deleted. */
  seedFound: boolean;
  sessions: number;
  agents: number;
}

// One transaction.
//
// The DO block before anything else refuses prefixes other than the
// fixed one (``prefix`` must be e2e-, ``gate_prefix`` must extend it).
// e2e_stack holds the two conditions and the count of runs on the
// private hosts. The not-an-E2E-stack count takes every agent outside
// the fixed prefix and every agent outside ``gate_prefix``, so a scope's
// prefix can only add to it; the seed condition needs the seed's gate
// agent and, as well, the agent ``check_seed_id`` names (the same agent
// unless a scope names another), so a scope's id can only fail it. The
// runs to remove are the runs on the private hosts (with ``scoped``, only
// those in ``only``), and only when both conditions hold. Their agents
// are to go with them, with (unscoped) any agent on one of the hosts
// that has no run left. The second DO block fails the transaction when
// one of them names an agent outside the fixed prefix, whatever a scope
// passed.
//
// Children before parents, as the foreign keys want: a run's content and
// events, its directives and start receipts, the runs (a sub-agent's run
// and its parent's go in the one statement; session_attachments follows
// by cascade), then each of those agents left with no run at all. A run
// on any other host that hangs off one of these runs (as a sub-agent's
// run) makes the sessions delete fail, which rolls everything back.
//
// The statements without their BEGIN and COMMIT: T192 runs them inside a
// transaction of its own that it rolls back, against rows only that
// transaction holds.
export const PREFLIGHT_SQL_BODY = `
CREATE TEMP TABLE e2e_prefix ON COMMIT DROP AS
  SELECT :'prefix'::text AS prefix, :'gate_prefix'::text AS gate_prefix;
DO $$
BEGIN
  IF (SELECT prefix <> 'e2e-' OR left(gate_prefix, length(prefix)) <> prefix FROM e2e_prefix) THEN
    RAISE EXCEPTION 'the agent-name prefixes must be e2e- and extend it: nothing deleted';
  END IF;
END $$;
CREATE TEMP TABLE e2e_stack ON COMMIT DROP AS
  SELECT
    (SELECT count(*) FROM agents, e2e_prefix
      WHERE agent_name IS NULL
         OR left(agent_name, length(prefix)) <> prefix
         OR left(agent_name, length(gate_prefix)) <> gate_prefix) AS foreign_agents,
    (EXISTS (SELECT 1 FROM agents WHERE agent_id = :'seed_id'::uuid AND agent_name = :'seed_name')
     AND EXISTS (SELECT 1 FROM agents WHERE agent_id = :'check_seed_id'::uuid AND agent_name = :'seed_name'))
      AS seed_found,
    (SELECT count(*) FROM sessions
      WHERE host = ANY (:'hosts'::text[])
        AND (NOT :'scoped'::boolean OR session_id = ANY (:'only'::uuid[]))) AS candidates;
SELECT 'foreign=' || foreign_agents, 'seed=' || seed_found, 'candidates=' || candidates FROM e2e_stack;
CREATE TEMP TABLE e2e_private_sessions ON COMMIT DROP AS
  SELECT session_id, agent_id, agent_name FROM sessions
   WHERE host = ANY (:'hosts'::text[])
     AND (SELECT foreign_agents = 0 AND seed_found FROM e2e_stack)
     AND (NOT :'scoped'::boolean OR session_id = ANY (:'only'::uuid[]));
CREATE TEMP TABLE e2e_private_agents ON COMMIT DROP AS
  SELECT agent_id, agent_name FROM agents
   WHERE agent_id IN (SELECT agent_id FROM e2e_private_sessions)
      OR (NOT :'scoped'::boolean
          AND (SELECT foreign_agents = 0 AND seed_found FROM e2e_stack)
          AND hostname = ANY (:'hosts'::text[]));
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM e2e_private_sessions, e2e_prefix
        WHERE agent_name IS NULL OR left(agent_name, length(prefix)) <> prefix)
     OR EXISTS (
       SELECT 1 FROM e2e_private_agents, e2e_prefix
        WHERE agent_name IS NULL OR left(agent_name, length(prefix)) <> prefix) THEN
    RAISE EXCEPTION 'a row on a private-fixture host names no e2e- agent: nothing deleted';
  END IF;
END $$;
DELETE FROM event_content WHERE session_id IN (SELECT session_id FROM e2e_private_sessions);
DELETE FROM events WHERE session_id IN (SELECT session_id FROM e2e_private_sessions);
DELETE FROM directives WHERE session_id IN (SELECT session_id FROM e2e_private_sessions);
DELETE FROM session_start_receipts WHERE session_id IN (SELECT session_id FROM e2e_private_sessions);
WITH gone AS (
  DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM e2e_private_sessions)
  RETURNING 1
) SELECT 'sessions=' || count(*) FROM gone;
WITH gone AS (
  DELETE FROM agents a
   WHERE a.agent_id IN (SELECT agent_id FROM e2e_private_agents)
     AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.agent_id = a.agent_id)
  RETURNING 1
) SELECT 'agents=' || count(*) FROM gone;
`;

/** An agent-name prefix that extends ``e2e-`` (``e2e-`` itself included). */
export type E2eAgentNamePrefix = `e2e-${string}`;

/** Limits for a spec that checks the pre-flight on rows of its own. Each
 *  can only narrow what goes: none can make it delete a row the unscoped
 *  pre-flight keeps. */
export interface ClearPrivateFixturesScope {
  /** Only these runs (and their agents) can go: uuids. */
  only: readonly string[];
  /** Require this agent as well as the seed's gate agent, by this id and
   *  the gate agent's name: a spec checks the no-seed condition with an
   *  id no database holds. A uuid. */
  seedAgentId?: string;
  /** Count every agent outside this prefix as foreign too: a spec checks
   *  the not-an-E2E-stack condition with a prefix the rest of the fleet
   *  does not carry. It must extend ``e2e-``. It never replaces ``e2e-``
   *  where a run to delete is checked. */
  agentNamePrefix?: E2eAgentNamePrefix;
}

/** The psql variables ``PREFLIGHT_SQL_BODY`` takes. */
export interface PreflightSqlVariables {
  /** The fixed prefix; the SQL refuses any value but ``e2e-``. */
  prefix: string;
  /** The not-an-E2E-stack prefix; the SQL refuses one that does not
   *  extend ``prefix``. */
  gatePrefix: string;
  seedId: string;
  checkSeedId: string;
  seedName: string;
  scoped: boolean;
  only: readonly string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ``docker exec ... psql`` arguments that run ``PREFLIGHT_SQL_BODY``
 * with these variables, as given, in the stack's Postgres. The SQL
 * refuses on its own the prefixes ``clearPrivateFixtures`` refuses, and
 * casts every id to a uuid, so a malformed one fails it: T192 runs the
 * body with variables the TypeScript check would stop, inside a
 * transaction it rolls back.
 */
export function preflightPsqlArgs(vars: PreflightSqlVariables): string[] {
  if (!POSTGRES_CONTAINER || !POSTGRES_DB) {
    throw new Error("clearPrivateFixtures: no Postgres container and database name the stack under test");
  }
  return [
    "exec", "-i", POSTGRES_CONTAINER,
    "psql", "-U", "flightdeck", "-d", POSTGRES_DB, "-qtA",
    "-v", "ON_ERROR_STOP=1",
    "-v", `hosts={${Object.values(PRIVATE_FIXTURE_HOSTS).join(",")}}`,
    "-v", `prefix=${vars.prefix}`,
    "-v", `gate_prefix=${vars.gatePrefix}`,
    "-v", `seed_id=${vars.seedId}`,
    "-v", `check_seed_id=${vars.checkSeedId}`,
    "-v", `seed_name=${vars.seedName}`,
    "-v", `scoped=${vars.scoped ? "true" : "false"}`,
    "-v", `only={${vars.only.join(",")}}`,
  ];
}

/** Run the pre-flight's one transaction with these variables. Throws
 *  when psql fails, with nothing deleted. */
function runPreflightSql(vars: PreflightSqlVariables): ClearedPrivateFixtures {
  const result = spawnSync("docker", preflightPsqlArgs(vars), {
    input: `BEGIN;\n${PREFLIGHT_SQL_BODY}\nCOMMIT;\n`,
    encoding: "utf8",
    timeout: PREFLIGHT_PSQL_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`clearPrivateFixtures: psql did not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`clearPrivateFixtures: psql exited ${result.status}: ${result.stderr.trim()}`);
  }
  const value = (key: string) => {
    const field = result.stdout
      .split(/[\n|]/)
      .find((f) => f.startsWith(`${key}=`));
    if (field === undefined) {
      throw new Error(`clearPrivateFixtures: psql did not report ${key}: ${result.stdout.trim()}`);
    }
    return field.slice(key.length + 1);
  };
  return {
    candidates: Number(value("candidates")),
    foreignAgents: Number(value("foreign")),
    seedFound: value("seed") === "true",
    sessions: Number(value("sessions")),
    agents: Number(value("agents")),
  };
}

/**
 * Remove, in one psql transaction against the stack's Postgres, every
 * private run (see the marker above) and every agent such a run leaves
 * with no run, on an E2E stack only (see the stack above): elsewhere it
 * deletes nothing and says why. Idempotent: on a freshly seeded database
 * it removes nothing, and on a database not seeded yet it removes
 * nothing either (CI's, before globalSetup's seed: nothing to remove).
 * Throws when the deletion cannot complete, so the run stops instead of
 * starting from a half-cleaned fleet: the transaction leaves either every
 * leftover gone or none.
 *
 * ``scope`` limits it to listed runs, for a spec that checks what it
 * removes while other specs' private runs are live, and can make either
 * condition stricter (see ``ClearPrivateFixturesScope``). A scope this
 * refuses (a prefix not extending ``e2e-``, an id that is not a uuid)
 * throws before psql starts.
 *
 * The suite runs on Postgres only (``_stack.ts``; ``globalSetup`` stops
 * on a stack on SQLite before it gets here), and this is the mechanism
 * its specs clean up with (``removeRun``): the API has no endpoint that
 * deletes a run or an agent.
 */
export function clearPrivateFixtures(scope?: ClearPrivateFixturesScope): ClearedPrivateFixtures {
  const prefix: string | undefined = scope?.agentNamePrefix;
  if (prefix !== undefined && !prefix.startsWith(E2E_AGENT_NAME_PREFIX)) {
    throw new Error(
      `clearPrivateFixtures: the agent-name prefix ${JSON.stringify(prefix)} does not extend ` +
        `${E2E_AGENT_NAME_PREFIX}: nothing deleted`,
    );
  }
  if (scope?.seedAgentId !== undefined && !UUID_RE.test(scope.seedAgentId)) {
    throw new Error(`clearPrivateFixtures: the seed agent id ${JSON.stringify(scope.seedAgentId)} is not a uuid`);
  }
  for (const id of scope?.only ?? []) {
    if (!UUID_RE.test(id)) {
      throw new Error(`clearPrivateFixtures: the listed run ${JSON.stringify(id)} is not a uuid`);
    }
  }
  const seed = seedGateAgent();
  return runPreflightSql({
    prefix: E2E_AGENT_NAME_PREFIX,
    gatePrefix: prefix ?? E2E_AGENT_NAME_PREFIX,
    seedId: seed.id,
    checkSeedId: scope?.seedAgentId ?? seed.id,
    seedName: seed.name,
    scoped: scope !== undefined,
    only: scope?.only ?? [],
  });
}

/** The pre-flight's one log line for what ``clearPrivateFixtures`` did. */
export function describeCleared(cleared: ClearedPrivateFixtures): string {
  const notE2e: string[] = [];
  if (cleared.foreignAgents > 0) notE2e.push(`${cleared.foreignAgents} agents here are not named e2e-`);
  if (!cleared.seedFound) notE2e.push("no E2E seed found");
  if (cleared.candidates === 0) {
    return "pre-flight: no runs earlier runs' specs left";
  }
  if (notE2e.length > 0) {
    return `pre-flight deleted nothing: ${notE2e.join(" and ")}, so this is not an E2E stack`;
  }
  return `pre-flight removed ${cleared.sessions} runs and ${cleared.agents} agents earlier runs' specs left`;
}
