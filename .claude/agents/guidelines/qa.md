# QA automation guidelines

## Hard rules

- No `time.sleep`, `time.Sleep`, `setTimeout`, `await asyncio.sleep`, or `await page.waitForTimeout` for synchronization in any test, at any level (unit, integration, E2E). Polling only, with a timeout and a clear failure message.
- The only acceptable use of a real sleep call is inside a polling helper, and only as the inter-poll interval.
- No real wall-clock time in unit tests. Use a fake clock (`freezegun` in Python, an injectable clock interface with a fake in Go, `vi.useFakeTimers()` in Vitest, `jest.useFakeTimers()` in Jest).
- No real network in unit tests. Use fakes or HTTP mocking libraries (`responses`, `respx`, `httptest.Server`, `msw`).
- No order-dependent tests. Each test sets up and tears down its own state.
- No retry-and-pass in CI. A flake is a failure. Quarantine, fix, or delete.

## Polling patterns to use instead of sleep

### Python (pytest)

Write or import a `wait_until` helper. The QA agent prescribes one if the project does not already have an equivalent.

```python
import time
from typing import Callable, TypeVar

T = TypeVar("T")

def wait_until(
    predicate: Callable[[], T],
    *,
    timeout: float = 5.0,
    interval: float = 0.05,
    message: str = "condition not met",
) -> T:
    """Poll predicate until it returns truthy or timeout elapses."""
    deadline = time.monotonic() + timeout
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except Exception as exc:
            last_exc = exc
        time.sleep(interval)  # only acceptable use: inside this helper
    raise AssertionError(f"{message} (waited {timeout}s)") from last_exc
```

For async code, an `await asyncio.sleep(interval)` confined to the equivalent async helper is acceptable. For retries on flaky external calls in integration tests, `tenacity` or `backoff` with explicit attempts, max delay, and jitter.

### Go

Use a polling loop with a ticker and a context. Never a bare `time.Sleep` in a test.

```go
func WaitUntil(ctx context.Context, t *testing.T, interval time.Duration, cond func() bool, msg string) {
    t.Helper()
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for {
        if cond() {
            return
        }
        select {
        case <-ctx.Done():
            t.Fatalf("WaitUntil: %s: %v", msg, ctx.Err())
        case <-ticker.C:
        }
    }
}
```

The caller passes a `context.WithTimeout` so the time budget is explicit. The single sleep-equivalent (the ticker tick) is contained in the helper.

For coordinating goroutine work, use `sync.WaitGroup`, channels, or `errgroup.Group`. Never sleep to "let the goroutine finish".

### JavaScript / TypeScript (Vitest, Jest, Playwright)

- React Testing Library: `await waitFor(() => expect(...).toBe(...), { timeout, interval })`.
- Vanilla helper: poll with `setInterval` and resolve on success or reject on timeout. Wrap once in a project utility, do not inline.
- Playwright: use built-in retry-until-timeout assertions. `await expect(locator).toBeVisible({ timeout: 5000 })`. Never `await page.waitForTimeout(ms)`.
- For network-driven state: `await page.waitForResponse(predicate)` or `waitForRequest`, not arbitrary delays.

### General principles for any poll

- Every poll has a timeout. No infinite loops.
- Every poll has an interval that is not too tight (avoid CPU spin) and not too loose (avoid slow tests). 50ms is a reasonable default for fast assertions, 100 to 250ms for I/O-bound conditions.
- Every poll failure produces a message that names the condition that did not happen. A CI failure should point at the cause without needing to read the test source.
- The polling helper is the one place real time is allowed in test code. Audit for any other occurrence and remove it.

## Test pyramid (target ratios, not rigid)

- Unit: ~70%. Fast, isolated, no IO.
- Integration: ~20%. Real adapters at the boundary (db, http, queue) but not full stack.
- E2E: ~10%. Critical user journeys only. Slow, expensive, fragile if overused.

## Test design

- AAA pattern (Arrange, Act, Assert) or Given / When / Then. One per test.
- Test names describe behavior, not implementation: `test_user_cannot_login_with_disabled_account`, not `test_login_function_returns_false`.
- One concept per test. Multiple asserts on the same concept are fine.
- No conditionals or loops inside test bodies that change which assertions run. Parametrize instead.
- Independent tests. Order should not matter. No shared mutable state.
- Setup via fixtures or factories. Fixtures for shared environment, factories (factory-boy, faker, gofakeit) for objects.
- Test the public API, not private internals. If something cannot be tested via the public API, the design is leaking.

## Coverage

- Branch coverage is more useful than line coverage.
- Coverage is a floor, not a goal. 80%+ on changed lines is a reasonable bar. 100% is a smell, you are testing trivia.
- Untested error paths are the most common gap. Look there first.
- Critical paths (auth, payment, data write) need higher coverage than glue code.

## Mocks, fakes, stubs

- Mock at boundaries you do not own (third-party APIs, time, randomness).
- Do not mock what you own. Use the real thing or a fake.
- Prefer fakes (in-memory implementations) over mocks (call recorders) for collaborators used a lot.
- Snapshot tests sparingly, only for outputs that are genuinely complex and stable.

## Flakiness: root causes and the fix

- Real time, including `sleep`, `now()`, timers. Fix: fake clocks, polling helpers with explicit timeouts.
- Real network. Fix: HTTP mocks (`responses`, `respx`, `msw`, `httptest.Server`).
- Real randomness. Fix: seed it explicitly.
- Test order dependency. Fix: each test sets up and tears down its own state.
- Parallel tests sharing state. Fix: isolate per worker (separate db schemas, temp dirs, ports).
- Race conditions in production code surfaced only by timing. Fix the production code, not the test.

A test that passes on retry is a test that fails. Treat it as a bug, not as noise.

## E2E and UI testing

- Critical user journeys: login, signup, primary purchase or core action, account changes. Not every screen.
- Locator priority: role and accessible name > test id > text > CSS > XPath. Playwright recommends `getByRole`, `getByLabel`, `getByTestId`.
- Add explicit `data-testid` to elements you intend to test. Do not rely on classnames.
- Wait for state, never sleep. Use the framework's polling assertions.
- Each E2E test sets up its own data via API calls (fast) or DB seeds, not via UI clicks (slow and brittle).
- Run a smoke subset of E2E in CI on every PR. Run the full suite nightly if it is slow.

## Performance and contract

- Performance tests for critical paths: have a baseline and an alarm threshold, not just a number.
- Contract tests at service boundaries (Pact or equivalent) when teams own different sides of an API.

## Project-specific notes

Flightdeck conventions (see `CLAUDE.md`):

- **Test stack lock (rules 9–12).** Go components use the Go `testing`
  package; flightdeck-sensor uses `pytest`. No real API calls in unit
  tests — mock all external services. Integration tests live under
  `pytest` and use real NATS and Postgres in Docker Compose; run with
  `make test-integration`. Frontend unit tests use Vitest + React
  Testing Library; every component that handles data or state has unit
  tests. E2E tests use Playwright covering full user flows in both
  `neon-dark` and `clean-light` themes.
- **Live-stack verification (rule 40a).** Any new runtime code path is
  exercised against the live dev stack before claiming it works.
  Passing unit tests with mocks is insufficient evidence on its own.
  A playground script or smoke test that pytest never executes — real
  API calls, real dev stack, real event persistence — is the
  verification standard. Applies to new sensor interceptors, new
  playground scripts, new worker code paths (state transitions,
  revive, session guards), new dashboard behaviour where the claim is
  user-facing.
- **Playground discipline (rules 40a.A / 40a.B).** Every playground
  script declares a meaningful `agent_type` and `flavor` (never
  `"unknown"`, never empty) and enables maximum capture
  (`capture_prompts=True`) — `09_capture.py` is the one legitimate
  override.
- **Pre-commit live test (rule 40b).** Before committing code that
  touches runtime behaviour, rebuild the affected container(s) so the
  dev stack reflects branch HEAD, then run the component's full test
  suite (unit + integration) locally. CI is not the first-line
  detector. Use `make dev` or `docker compose -f docker-compose.yml -f
  docker-compose.dev.yml up --build -d <service>` — a plain
  `docker compose up --build` without the dev override rebuilds a
  stale prod-image layer and will not reflect your edits.
- **E2E discipline (rules 40c / 40c.1–4).** Every phase that adds or
  changes user-visible UI behaviour adds Playwright tests at
  `dashboard/tests/e2e/`, one journey per file, named
  `Tnn-<kebab-case-journey>.spec.ts`. Flakes are fixed or deleted,
  never merged as-is (CI retries=1, local=0). Run `npm run test:e2e`
  locally against a fresh dev stack before committing. Tests run
  under both theme projects; assertions stay theme-agnostic
  (no hardcoded colours).
- **Framework playground gate (rule 40d).** Any phase touching
  `sensor/flightdeck_sensor/interceptor/*`, adding a new interceptor,
  or changing event-emission shape includes both (1) real-provider
  playground demos (manual, NOT in CI; self-skip with exit 2 when
  API keys are missing) and (2) mock-free integration tests in CI.
  V-pass enumerates both before implementation starts.
- **Pre-push lint (rule 40e).** Run the relevant linters before
  pushing: `ruff check .` + `ruff format --check .` for Python,
  `golangci-lint run` for Go (binary at `/home/omria/go/bin/`),
  `npm run lint` + `npm run typecheck` for the dashboard. `go test`
  alone misses `unused` violations CI enforces.

The polling helpers above are load-bearing reference for any new
test author on this project. Keep them in scope when prescribing
fixes for flaky tests — Flightdeck's CI history has more than one
incident tied to `time.sleep` / `waitForTimeout` in tests.
