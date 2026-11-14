/**
 * The browser suite's stack settings (tests/e2e/_stack.ts): which
 * stack a run may write to. Three of the suite's files run psql in a
 * Postgres container, and the seeder writes through ingestion, so a
 * run pointed at one stack must never fall back to another stack's
 * container. These are the rules tests/shared/fixtures.py applies to
 * the integration suite, plus the suite's need for Postgres.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_STACK_DATABASE,
  DEV_STACK_POSTGRES_CONTAINER,
  readStackState,
  stackConfigurationError,
  stackSettings,
} from "../e2e/_stack";

const DEV = "http://localhost:4000";
const SECOND = "http://localhost:4410";

describe("readStackState", () => {
  it("reads the FLIGHTDECK_TEST_* lines of a state file and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-state-"));
    try {
      const file = join(dir, "stack.env");
      writeFileSync(
        file,
        [
          "# The running dev stack",
          "FLIGHTDECK_DEV_MODE=postgres",
          "FLIGHTDECK_TEST_BASE_URL=http://localhost:4000",
          "FLIGHTDECK_TEST_WORKER_CONTAINER=",
          "FLIGHTDECK_TEST_DB=flightdeck",
          "PG_BASE_URL=postgres://u:p@127.0.0.1:5432",
          "",
        ].join("\n"),
      );
      expect(readStackState(file)).toEqual({
        FLIGHTDECK_TEST_BASE_URL: "http://localhost:4000",
        FLIGHTDECK_TEST_WORKER_CONTAINER: "",
        FLIGHTDECK_TEST_DB: "flightdeck",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is empty when there is no state file", () => {
    expect(readStackState(join(tmpdir(), "no-such-dir", "stack.env"))).toEqual({});
  });
});

describe("stackSettings", () => {
  const state = { FLIGHTDECK_TEST_DB: "flightdeck", FLIGHTDECK_TEST_POSTGRES_CONTAINER: "docker-postgres-1" };

  it("takes the state file's settings on the dev stack, the environment's first", () => {
    expect(stackSettings(DEV, { FLIGHTDECK_TEST_DB: "mine", PATH: "/bin" }, state)).toEqual({
      FLIGHTDECK_TEST_DB: "mine",
      FLIGHTDECK_TEST_POSTGRES_CONTAINER: "docker-postgres-1",
    });
  });

  it("never reads the state file for a stack at another address", () => {
    expect(stackSettings(SECOND, { FLIGHTDECK_TEST_BASE_URL: SECOND }, state)).toEqual({
      FLIGHTDECK_TEST_BASE_URL: SECOND,
    });
  });
});

describe("stackConfigurationError", () => {
  it("lets the dev stack on Postgres run", () => {
    expect(stackConfigurationError(DEV, "flightdeck", "", "docker-postgres-1")).toBeNull();
  });

  it("lets a second stack run when it names its own container and database", () => {
    expect(stackConfigurationError(SECOND, "flightdeck", "", "fd2-postgres-1")).toBeNull();
  });

  it("refuses a stack on SQLite, at the dev stack's address or another", () => {
    for (const url of [DEV, SECOND]) {
      const why = stackConfigurationError(url, "", "/data/flightdeck.db", undefined);
      expect(why).toContain("runs on SQLite");
      expect(why).toContain("needs a stack on Postgres");
    }
  });

  it("refuses the dev stack's address when no state file names its database", () => {
    const why = stackConfigurationError(DEV, "", "", undefined, "/repo/.dev/stack.env");
    expect(why).toContain("no dev stack state at /repo/.dev/stack.env");
  });

  it("refuses another address when the container or the database is not named", () => {
    for (const [db, container] of [
      ["", undefined],
      ["flightdeck", undefined],
      ["", "fd2-postgres-1"],
    ] as const) {
      const why = stackConfigurationError(SECOND, db, "", container);
      expect(why).toContain("is not the dev stack");
      expect(why).toContain("would write to the dev stack's database");
    }
  });

  it("refuses another address that names the dev stack's own database", () => {
    const why = stackConfigurationError(SECOND, DEV_STACK_DATABASE, "", DEV_STACK_POSTGRES_CONTAINER);
    expect(why).toContain("the dev stack's own database");
  });

  it("refuses two databases at once", () => {
    expect(stackConfigurationError(DEV, "flightdeck", "/data/flightdeck.db", undefined)).toContain(
      "are both set",
    );
  });
});
