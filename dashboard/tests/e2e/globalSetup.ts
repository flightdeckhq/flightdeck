import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright global setup hook. Seeds the canonical E2E fixture
// dataset into the running dev stack before any project starts.
//
// The seeder lives outside the dashboard package because the same
// event-builder helpers (tests/shared/fixtures.py) drive the pytest
// integration suite — one copy of the HTTP/identity contract is
// better than two that drift. Shelling to python3 from TypeScript is
// the cost of that sharing, paid once per `playwright test` invocation.
//
// Interpreter selection: respect the PYTHON env var when set
// (CI threads PYTHON=python through the workflow; local dev loops
// without venv activation can point at sensor/.venv/bin/python). Fall
// back to python3 on PATH — works whether the user has the venv
// activated or installed flightdeck_sensor into the system interpreter.
//
// The script is idempotent: repeat runs against an already-seeded
// stack skip sessions whose event counts clear the completeness bar,
// so local dev loops don't pay the seed cost every time the user
// re-runs Playwright.
//
// dashboard/package.json is ``"type": "module"`` so __dirname is not
// injected. Recover it from import.meta.url the ESM way.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async function globalSetup(): Promise<void> {
  const repoRoot = resolve(__dirname, "..", "..", "..");
  const seedScript = resolve(repoRoot, "tests", "e2e-fixtures", "seed.py");
  const python = process.env.PYTHON ?? "python3";

  const t0 = Date.now();
  const result = spawnSync(python, [seedScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw new Error(
      `globalSetup: failed to spawn ${python} seeder: ${result.error.message}. ` +
        `Is ${python} on PATH? Set PYTHON to override. ` +
        `Is the dev stack running (make dev)?`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `globalSetup: seeder exited with status ${result.status}. ` +
        `Check stderr above for details (commonly: dev stack not up, or ` +
        `FLIGHTDECK_* env vars interfering).`,
    );
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  // Keep the success line terse; the seeder itself prints per-session
  // seeded/skipped/backdated counts so re-printing them here would be
  // noise.
  console.log(`[playwright globalSetup] seed complete in ${elapsed}s`);
}
