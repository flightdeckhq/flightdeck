# Flightdeck Dashboard -- Claude Code Rules

> Component-specific rules moved out of the root CLAUDE.md so they load only
> when working under dashboard/. All root CLAUDE.md rules still apply; the
> numbering below keeps the original rule numbers.

## Frontend Code Rules

11. **Frontend unit tests:** Vitest + React Testing Library. Every component that
    handles data or state must have unit tests.

12. **E2E tests:** Playwright. Full user flows in both neon dark and clean light.

13. **Never use MUI, Ant Design, or Chakra UI.** shadcn/ui and custom components only.

14. **Both themes must work at all times.** After any frontend change, verify both
    neon dark and clean light render correctly. Breaking one theme is an incomplete task.

15. **Never casually edit globals.css or themes.css.** These define both themes.
    Only edit with explicit Supervisor approval.

16. **D3 is used for math only.** In the timeline component, D3 is used exclusively
    for `d3-scale` and `d3-time` calculations. D3 must never manipulate the DOM.

17. **No placeholder UI.** If a feature is not ready it does not appear in the UI.
    No grey boxes, no "coming soon" panels, no disabled stubs for incomplete features.

---

## E2E Discipline

40c. **E2E test discipline.** Every phase that adds or changes
     user-visible UI behavior adds corresponding E2E tests at
     `dashboard/tests/e2e/` covering the new behavior. Tests are
     named after the user journey they cover
     (``Tnn-<kebab-case-journey>.spec.ts``), one journey per file so
     a failing test's filename tells you what's broken without
     opening the trace. The V-pass for any UI phase MUST list the
     E2E tests that will be added before implementation starts.

     Why: Phases 1 and 2 each shipped UI regressions (KI20 phantom
     rows, KI22 font-mono collapse, PR #24 bucket-divider
     misalignment) that unit tests missed. The common shape: a
     single component's mock test passed while the rendered
     dashboard misbehaved. E2E tests exercising the real dashboard
     against a seeded dev stack would have caught each one. The
     Phase 3 Playwright foundation exists so every post-v0.4.0 UI
     change inherits that floor.

     How to apply: when planning a UI-touching task, name the E2E
     tests in the plan. When implementing, write those tests before
     or alongside the behavior change -- not after. When reviewing,
     reject a UI PR whose only test coverage is unit tests.

40c.1. **E2E stability — tests that flake are fixed or deleted,
     never merged as-is.** CI retry is a tolerance buffer for
     genuine infrastructure blips (stack boot race, NATS reconnect,
     WSL disk flush), NOT for tests. The Playwright config sets
     ``retries: 1`` on CI and ``0`` locally so flakes surface on
     the first run and get fixed. A test that fails on the second
     sequential local run against unchanged code is a flake and
     must not ship.

     Why: flaky tests teach reviewers to ignore failures ("it's
     just that flaky one") which is indistinguishable from
     abandoned test coverage. One trusted test is worth ten flaky
     ones.

     How to apply: after writing a test, run the suite twice in a
     row locally against a fresh dev stack + seed. Both must pass
     cleanly. If any test flakes, debug the root cause (timing
     assumption, race condition, implicit state) rather than
     adding retry.

40c.2. **E2E as the pre-commit smoke gate for UI work.** After any
     UI edit, run ``cd dashboard && npm run test:e2e`` locally
     BEFORE committing. The suite must pass against a fresh dev
     stack + seed. This is the minimum verification bar for UI
     changes, below which work is not considered complete.

     Inherits from rule 40b (pre-commit live test): where 40b is
     about runtime behaviour generally, 40c.2 specialises to the
     dashboard and requires the Playwright suite specifically.

40c.3. **E2E theme coverage.** Tests run under both ``neon-dark``
     and ``clean-light`` theme projects via Playwright's
     ``projects`` config. Tests MUST NOT hardcode theme-specific
     selectors or computed colour values; assertions are
     theme-agnostic. Any new theme-dependent rendering logic
     requires E2E coverage that passes under both themes. The
     config already wires storageState per project; spec authors
     just keep assertions structural.

     Why: rule 14 requires both themes to work at all times.
     Without automated per-theme coverage, "both themes work"
     degrades to "dark theme works, light theme breaks on Tuesdays"
     -- which is exactly the regression shape KI22 had until a
     manual light-theme pass caught it.

40c.4. **Live-load Chrome verification after every dashboard
     step.** When a step touches dashboard chrome (a page route,
     a panel, a route-level component, or any UI surface end
     users navigate to), the step does not close until the dev
     stack has been built with branch HEAD AND the affected
     surfaces have been opened in a real Chrome window AND the
     happy-path interaction has been performed manually. Mock-
     based unit tests, Vitest passing, and TypeScript clean are
     all necessary but insufficient — they verify the contract
     between component and props, not the contract between
     component and the live API / WebSocket / theme stylesheet
     / fleet store under real network conditions.

     The verification log for the step must list:
     - Which routes were opened (e.g. ``/mcp-policies``,
       ``/investigate``, ``/fleet``).
     - Which interactions were exercised (e.g. open dialog →
       fill required fields → submit; trigger 403 path; open
       SessionDrawer on a session emitting target events).
     - Which themes were checked (rule 14 requires both).
     - The dev-stack build SHA (so the verification is pinned to
       branch HEAD, not a stale prod-image layer per Rule 40b).

     Inherits from Rule 40a (live-stack verification). Where 40a
     is "exercise new runtime code paths against the live stack
     before claiming they work" and 40b is "rebuild the stack
     with branch HEAD before pre-commit testing", 40c.4 is the
     specialisation for dashboard chrome: a live Chrome session
     is the only thing that surfaces theme-token gaps, fleet-WS
     re-fetch wiring, focus traps inside Radix portals, and the
     "Mock said handler fires, real stack says backend 500"
     class of bug.

     Why: every step in the MCP Protection Policy work surfaced
     at least one polish gap that mocks missed and Chrome caught
     — empty MCP SERVERS panel on a live session (D140), tab
     overflow on small viewports, hardcoded amber-500 in the
     soft-launch banner, "Admin token required" without an
     actionable hint. Two-hat Chrome verification (operator
     pretends to be a fresh user, then a hostile auditor) is the
     only methodology that reliably surfaces these without
     shipping them. Step 6.6 codifies the pattern after step 6
     proved its value the hard way.
