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
 * by its data: every agent in the database is named ``e2e-...``, as the
 * seed's fixtures and these runs are. A database holding any other agent
 * (a real Claude Code session, a playground run, the integration suite's
 * agents) is not one, and there it deletes nothing. The address does not
 * tell: CI's E2E stack and a developer's own dev stack both answer on
 * http://localhost:4000 with the container ``docker-postgres-1``.
 *
 * A helper or spec that makes runs of its own takes its host from here.
 */
import { spawnSync } from "node:child_process";
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

// How long the pre-flight's one psql call may take. It deletes in bulk,
// a few statements over at most some thousands of rows on a dev
// database that has run the suite many times, in well under a second;
// the ceiling surfaces a stalled Docker daemon or Postgres container as
// a failed run instead of a globalSetup that hangs.
const PREFLIGHT_PSQL_TIMEOUT_MS = 60_000;

/** What ``clearPrivateFixtures`` found and removed. */
export interface ClearedPrivateFixtures {
  /** Agents not named ``e2e-...``: more than none means the database is
   *  not an E2E stack, and nothing was deleted. */
  foreignAgents: number;
  sessions: number;
  agents: number;
}

// One transaction.
//
// e2e_stack counts the agents not named with the prefix; the runs to
// remove are the sessions on one of the hosts, and only when that count
// is zero (and, with ``scoped``, only those in ``only``). Their agents
// are to go with them, with (unscoped) any agent on one of the hosts
// that has no run left. The DO block fails the transaction when one of
// them names an agent outside the prefix.
//
// Children before parents, as the foreign keys want: a run's content and
// events, its directives and start receipts, the runs (a sub-agent's run
// and its parent's go in the one statement; session_attachments follows
// by cascade), then each of those agents left with no run at all. A run
// on any other host that hangs off one of these runs (as a sub-agent's
// run) makes the sessions delete fail, which rolls everything back.
const CLEAR_SQL = `
BEGIN;
CREATE TEMP TABLE e2e_prefix ON COMMIT DROP AS SELECT :'prefix'::text AS prefix;
CREATE TEMP TABLE e2e_stack ON COMMIT DROP AS
  SELECT count(*) AS foreign_agents FROM agents, e2e_prefix
   WHERE agent_name IS NULL OR left(agent_name, length(prefix)) <> prefix;
SELECT 'foreign=' || foreign_agents FROM e2e_stack;
CREATE TEMP TABLE e2e_private_sessions ON COMMIT DROP AS
  SELECT session_id, agent_id, agent_name FROM sessions
   WHERE host = ANY (:'hosts'::text[])
     AND (SELECT foreign_agents FROM e2e_stack) = 0
     AND (NOT :'scoped'::boolean OR session_id = ANY (:'only'::uuid[]));
CREATE TEMP TABLE e2e_private_agents ON COMMIT DROP AS
  SELECT agent_id, agent_name FROM agents
   WHERE agent_id IN (SELECT agent_id FROM e2e_private_sessions)
      OR (NOT :'scoped'::boolean
          AND (SELECT foreign_agents FROM e2e_stack) = 0
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
COMMIT;
`;

/**
 * Remove, in one psql transaction against the stack's Postgres, every
 * private run (see the marker above) and every agent such a run leaves
 * with no run, on an E2E stack only (see the stack above): elsewhere it
 * deletes nothing and says so in ``foreignAgents``. Idempotent: on a
 * freshly seeded database it removes nothing. Throws when the deletion
 * cannot complete, so the run stops instead of starting from a half-
 * cleaned fleet: the transaction leaves either every leftover gone or
 * none.
 *
 * ``only`` limits it to those runs (and their agents), for a spec that
 * checks what it removes while other specs' private runs are live.
 *
 * The suite runs on Postgres only (``_stack.ts``; ``globalSetup`` stops
 * on a stack on SQLite before it gets here), and this is the mechanism
 * its specs clean up with (``removeRun``): the API has no endpoint that
 * deletes a run or an agent.
 */
export function clearPrivateFixtures(only?: readonly string[]): ClearedPrivateFixtures {
  if (!POSTGRES_CONTAINER || !POSTGRES_DB) {
    throw new Error("clearPrivateFixtures: no Postgres container and database name the stack under test");
  }
  const hosts = `{${Object.values(PRIVATE_FIXTURE_HOSTS).join(",")}}`;
  const result = spawnSync(
    "docker",
    [
      "exec", "-i", POSTGRES_CONTAINER,
      "psql", "-U", "flightdeck", "-d", POSTGRES_DB, "-qtA",
      "-v", "ON_ERROR_STOP=1",
      "-v", `hosts=${hosts}`,
      "-v", `prefix=${E2E_AGENT_NAME_PREFIX}`,
      "-v", `scoped=${only ? "true" : "false"}`,
      "-v", `only={${(only ?? []).join(",")}}`,
    ],
    { input: CLEAR_SQL, encoding: "utf8", timeout: PREFLIGHT_PSQL_TIMEOUT_MS },
  );
  if (result.error) {
    throw new Error(`clearPrivateFixtures: psql did not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`clearPrivateFixtures: psql exited ${result.status}: ${result.stderr.trim()}`);
  }
  const count = (key: string) => {
    const line = result.stdout.split("\n").find((l) => l.startsWith(`${key}=`));
    if (line === undefined) {
      throw new Error(`clearPrivateFixtures: psql did not report ${key}: ${result.stdout.trim()}`);
    }
    return Number(line.slice(key.length + 1));
  };
  return { foreignAgents: count("foreign"), sessions: count("sessions"), agents: count("agents") };
}
