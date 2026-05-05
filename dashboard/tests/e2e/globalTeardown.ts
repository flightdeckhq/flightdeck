// Playwright global teardown hook. Stops the keep-alive watchdog the
// globalSetup hook spawned so the active-class E2E fixtures don't age
// past the workers reconciler's 2-min stale threshold during long
// test runs. See globalSetup.ts for the rationale; this file's
// responsibility is just to send the SIGTERM that ends the bash loop.
//
// PID is stashed on ``globalThis.__flightdeck_e2e_keepalive_pid`` by
// globalSetup. We read it off the runner's process state — same Node
// process, so the assignment survives until teardown runs. If the PID
// is missing or already gone we no-op silently rather than fail
// teardown; this hook must never block the runner from completing.

export default async function globalTeardown(): Promise<void> {
  const pid = (globalThis as unknown as Record<string, unknown>)
    .__flightdeck_e2e_keepalive_pid as number | undefined;
  if (!pid) {
    return;
  }
  try {
    // Negative PID targets the process group — kills the bash shell
    // AND any in-flight ``python seed.py`` child it spawned. The
    // ``detached: true`` in globalSetup made the child its own
    // process-group leader, so this works without orphaning.
    process.kill(-pid, "SIGTERM");
    console.log(
      `[playwright globalTeardown] keep-alive watchdog stopped (pid=${pid})`,
    );
  } catch (err) {
    // ESRCH = already gone (CI killed it earlier, or it crashed).
    // Either way nothing to clean up.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ESRCH") {
      console.warn(
        `[playwright globalTeardown] failed to stop watchdog ` +
          `pid=${pid}: ${(err as Error).message}`,
      );
    }
  }
}
