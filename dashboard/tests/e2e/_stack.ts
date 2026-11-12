/**
 * The stack the browser suite runs against.
 *
 * The defaults are the dev stack `make dev` starts: the dashboard, /api
 * and /ingest on http://localhost:4000, and the Postgres container
 * `docker-postgres-1` with the database `flightdeck`. A second stack
 * beside it (another port, another compose project) is named with the
 * same variables the integration fixtures read
 * (tests/shared/fixtures.py), which `scripts/dev-stack.sh env` prints:
 *
 *   FLIGHTDECK_TEST_BASE_URL            the origin, no trailing slash
 *   FLIGHTDECK_TEST_POSTGRES_CONTAINER  the container psql runs in
 *   FLIGHTDECK_TEST_DB                  the database in that container
 *
 * playwright.config.ts takes the origin from here. A spec that builds
 * an absolute URL or shells into Postgres must take it from here too:
 * a literal `localhost:4000` or `docker-postgres-1` in a spec talks to
 * the default dev stack whatever stack the run was pointed at.
 */
export const BASE_URL = (process.env.FLIGHTDECK_TEST_BASE_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);
export const API_URL = `${BASE_URL}/api`;
export const INGEST_URL = `${BASE_URL}/ingest`;
export const POSTGRES_CONTAINER =
  process.env.FLIGHTDECK_TEST_POSTGRES_CONTAINER ?? "docker-postgres-1";
export const POSTGRES_DB = process.env.FLIGHTDECK_TEST_DB ?? "flightdeck";
