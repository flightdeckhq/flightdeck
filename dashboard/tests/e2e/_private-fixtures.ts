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
 * The marker: every such run sends one of the hosts below as its
 * ``host`` (stored in ``sessions.host``) and its ``hostname`` (stored in
 * ``agents.hostname``), and names its agent ``e2e-...``. The hosts are
 * exact strings that only these helpers and specs send: the seed, the
 * integration fixtures, the sensor, the plugin and the playground send
 * none of them. The pre-flight matches them exactly, never by prefix,
 * and refuses to delete anything when a row carrying one of them names
 * an agent outside ``e2e-...``: such a row is not one of these runs.
 * A helper or spec that makes runs of its own takes its host from here.
 */
import { spawnSync } from "node:child_process";
import { POSTGRES_CONTAINER, POSTGRES_DB } from "./_stack";

/** The host each producer of private runs sends. */
export const PRIVATE_FIXTURE_HOSTS = {
  /** ``createPrivateAgent`` / ``createPrivateSubAgent`` (_fixtures.ts). */
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

/** The prefix every private run's agent name starts with. */
const PRIVATE_AGENT_NAME_PREFIX = "e2e-";

// How long the pre-flight's one psql call may take. It deletes in bulk,
// a few statements over at most some thousands of rows on a dev
// database that has run the suite many times, in well under a second;
// the ceiling surfaces a stalled Docker daemon or Postgres container as
// a failed run instead of a globalSetup that hangs.
const PREFLIGHT_PSQL_TIMEOUT_MS = 60_000;

/** What ``clearPrivateFixtures`` removed. */
export interface ClearedPrivateFixtures {
  sessions: number;
  agents: number;
}

// One transaction. The runs to remove are the sessions whose host is one
// of the hosts above, and their agents with the agents whose hostname is
// one of them; the DO block refuses (rolls everything back) when any of
// them names an agent outside the prefix. Children before parents, as
// the foreign keys want: a run's content and events, its directives and
// start receipts, the runs (a sub-agent's run and its parent's go in the
// one statement; session_attachments follows by cascade), then each
// agent left with no run at all. A run of any other host that hangs off
// one of these runs (as a sub-agent's run) makes the sessions delete
// fail, which rolls the whole transaction back.
const CLEAR_SQL = `
BEGIN;
CREATE TEMP TABLE e2e_private_sessions ON COMMIT DROP AS
  SELECT session_id, agent_id, agent_name FROM sessions
   WHERE host = ANY (:'hosts'::text[]);
CREATE TEMP TABLE e2e_private_agents ON COMMIT DROP AS
  SELECT agent_id, agent_name FROM agents
   WHERE agent_id IN (SELECT agent_id FROM e2e_private_sessions)
      OR hostname = ANY (:'hosts'::text[]);
CREATE TEMP TABLE e2e_private_prefix ON COMMIT DROP AS SELECT :'prefix'::text AS prefix;
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM e2e_private_sessions, e2e_private_prefix
        WHERE agent_name IS NULL OR left(agent_name, length(prefix)) <> prefix)
     OR EXISTS (
       SELECT 1 FROM e2e_private_agents, e2e_private_prefix
        WHERE agent_name IS NULL OR left(agent_name, length(prefix)) <> prefix) THEN
    RAISE EXCEPTION 'a row carries a private-fixture host but names no e2e- agent: nothing deleted';
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
 * run and agent an earlier run of the suite made outside the seed (see
 * the marker above). Idempotent: on a freshly seeded database it removes
 * nothing. Throws when the deletion cannot complete, so the run stops
 * instead of starting from a half-cleaned fleet: the transaction leaves
 * either every leftover gone or none.
 *
 * The suite runs on Postgres only (``_stack.ts``; ``globalSetup`` stops
 * on a stack on SQLite before it gets here), and this is the mechanism
 * its specs clean up with (``removeRun``): the API has no endpoint that
 * deletes a run or an agent.
 */
export function clearPrivateFixtures(): ClearedPrivateFixtures {
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
      "-v", `prefix=${PRIVATE_AGENT_NAME_PREFIX}`,
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
  return { sessions: count("sessions"), agents: count("agents") };
}
