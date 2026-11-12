/**
 * The stack the browser suite runs against.
 *
 * The default is the dev stack `make dev` starts: the dashboard, /api
 * and /ingest on http://localhost:4000. Which database it runs on, and
 * in which Postgres container, comes from the state file the dev stack
 * writes (`.dev/stack.env`, scripts/dev-stack.sh), as it does for the
 * integration fixtures (tests/shared/fixtures.py): this module follows
 * their rules, so the two harnesses agree on which stack they may
 * write to.
 *
 * Any other stack (a second dev stack on another port) is named with
 * FLIGHTDECK_TEST_BASE_URL and describes itself through the
 * environment, which `scripts/dev-stack.sh env` prints and `make
 * test-e2e` sets; the same variables override the state file on the
 * dev stack:
 *
 *   FLIGHTDECK_TEST_BASE_URL            the origin, no trailing slash
 *   FLIGHTDECK_TEST_POSTGRES_CONTAINER  the container psql runs in
 *   FLIGHTDECK_TEST_DB                  the database in that container
 *
 * The suite needs a stack on Postgres: its seeder backdates rows with
 * Postgres SQL, and three of its files run psql in the stack's
 * container. Nothing here defaults to the dev stack's container for a
 * stack that is not the dev stack on Postgres: stackConfigurationError
 * says why the suite must not run, globalSetup stops on it, and the
 * container and database names are blank, so a psql call that got that
 * far is refused by the docker CLI instead of writing to another
 * stack's rows.
 *
 * playwright.config.ts takes the origin from here. A spec that builds
 * an absolute URL or shells into Postgres takes them from here too: a
 * literal `localhost:4000` or `docker-postgres-1` in a spec talks to
 * the default dev stack whatever stack the run was pointed at.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The addresses the dev stack answers on. */
export const DEV_STACK_BASE_URLS: readonly string[] = [
  "http://localhost:4000",
  "http://127.0.0.1:4000",
  "http://[::1]:4000",
];
/** The database the dev stack runs on in its Postgres mode, and the
 *  container that holds it. */
export const DEV_STACK_DATABASE = "flightdeck";
export const DEV_STACK_POSTGRES_CONTAINER = "docker-postgres-1";
/** dashboard/tests/e2e/_stack.ts -> the repo root. The dev stack writes
 *  this file when it starts and removes it when it stops. */
export const DEV_STACK_STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".dev",
  "stack.env",
);
const SETTING_PREFIX = "FLIGHTDECK_TEST_";

/** The FLIGHTDECK_TEST_* settings in a dev stack state file (KEY=VALUE
 *  lines), or none when there is no file. */
export function readStackState(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const settings: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && line.startsWith(SETTING_PREFIX)) settings[line.slice(0, at)] = line.slice(at + 1);
  }
  return settings;
}

/** The FLIGHTDECK_TEST_* settings of the stack at baseUrl: the
 *  environment's, and on the dev stack the state file's for every
 *  setting the environment leaves out. The state file describes the
 *  dev stack only, so a stack at any other address never reads it. */
export function stackSettings(
  baseUrl: string,
  environ: Record<string, string | undefined>,
  state: Record<string, string>,
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(environ)) {
    if (key.startsWith(SETTING_PREFIX) && value !== undefined) settings[key] = value;
  }
  if (DEV_STACK_BASE_URLS.includes(baseUrl)) {
    for (const [key, value] of Object.entries(state)) {
      if (!(key in settings)) settings[key] = value;
    }
  }
  return settings;
}

/** Why the browser suite must not run against baseUrl with these
 *  settings, or null when it may. postgresContainer is undefined when
 *  nothing names one. */
export function stackConfigurationError(
  baseUrl: string,
  testDb: string,
  sqliteDb: string,
  postgresContainer: string | undefined,
  stateFile: string = DEV_STACK_STATE_FILE,
): string | null {
  if (testDb && sqliteDb) {
    return (
      "FLIGHTDECK_TEST_DB and FLIGHTDECK_TEST_SQLITE_DB are both set; the stack " +
      "under test has one database: set the one that names it"
    );
  }
  if (sqliteDb) {
    return (
      `the stack at ${baseUrl} runs on SQLite (FLIGHTDECK_TEST_SQLITE_DB is ${sqliteDb}), ` +
      "and the browser suite needs a stack on Postgres: its seeder backdates rows with " +
      "Postgres SQL and three of its files run psql in the stack's Postgres container, " +
      "which this stack does not have. Start the stack on Postgres (`make dev`, without " +
      "DB=sqlite)."
    );
  }
  const onDevStack = DEV_STACK_BASE_URLS.includes(baseUrl);
  if (onDevStack) {
    if (testDb) return null;
    return (
      `FLIGHTDECK_TEST_BASE_URL is ${baseUrl}, the dev stack's address, but there ` +
      `is no dev stack state at ${stateFile} and FLIGHTDECK_TEST_DB names no ` +
      "database: the specs that run psql cannot tell which database the stack uses. " +
      "Start the stack with `make dev`, or name the database of whatever listens there."
    );
  }
  if (!testDb || !postgresContainer) {
    return (
      `FLIGHTDECK_TEST_BASE_URL is ${baseUrl}, which is not the dev stack ` +
      "(http://localhost:4000), and FLIGHTDECK_TEST_POSTGRES_CONTAINER and " +
      "FLIGHTDECK_TEST_DB do not both name its Postgres: the specs that run psql " +
      "would write to the dev stack's database. Set both, or let `make test-e2e` " +
      'do it (or `eval "$(scripts/dev-stack.sh env)"` for that stack).'
    );
  }
  if (testDb === DEV_STACK_DATABASE && postgresContainer === DEV_STACK_POSTGRES_CONTAINER) {
    return (
      `FLIGHTDECK_TEST_DB is ${DEV_STACK_DATABASE} in ${DEV_STACK_POSTGRES_CONTAINER}, ` +
      `the dev stack's own database, while FLIGHTDECK_TEST_BASE_URL is ${baseUrl}, ` +
      "which is not the dev stack: the specs that run psql would write to the dev " +
      "stack's rows. Give the stack under test a database of its own and name that one."
    );
  }
  return null;
}

export const BASE_URL = (process.env.FLIGHTDECK_TEST_BASE_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);
export const API_URL = `${BASE_URL}/api`;
export const INGEST_URL = `${BASE_URL}/ingest`;

const settings = stackSettings(BASE_URL, process.env, readStackState(DEV_STACK_STATE_FILE));

/** Why this run must not go ahead, or null. globalSetup throws it. */
export const STACK_CONFIGURATION_ERROR = stackConfigurationError(
  BASE_URL,
  settings.FLIGHTDECK_TEST_DB ?? "",
  settings.FLIGHTDECK_TEST_SQLITE_DB ?? "",
  settings.FLIGHTDECK_TEST_POSTGRES_CONTAINER,
);
/** The container and the database the psql helpers use; blank when the
 *  run must not go ahead (see the header). */
export const POSTGRES_CONTAINER = STACK_CONFIGURATION_ERROR
  ? ""
  : (settings.FLIGHTDECK_TEST_POSTGRES_CONTAINER ?? DEV_STACK_POSTGRES_CONTAINER);
export const POSTGRES_DB = STACK_CONFIGURATION_ERROR ? "" : (settings.FLIGHTDECK_TEST_DB ?? "");
