# Flightdeck -- Claude Code Rules

> These rules exist because something went wrong or almost went wrong without them.
> Follow them without exception. If a rule conflicts with a task instruction, raise
> the conflict with the Supervisor before proceeding.

---

## Before Every Session

1. **Read ARCHITECTURE.md in full.** Not a skim. Every section. The architecture
   is the source of truth. Code that contradicts it is wrong, not the architecture.

2. **Check for open TODO, FIXME, and HACK comments** in any file you are about to
   touch. List them in your plan before proposing changes.

3. **Never make architectural decisions.** If a task requires a decision not covered
   by ARCHITECTURE.md, stop and ask the Supervisor. Do not invent a solution.

---

## Planning Rules

4. **Always plan before implementing.** For every task, produce a written plan
   listing every file you will create or modify and why. Wait for explicit approval
   before writing any code.

5. **Scope tasks tightly.** If a task touches more than 5-8 files, propose splitting
   it. Large tasks drift and produce hard-to-review changes.

6. **State your assumptions.** If the task is ambiguous, list your assumptions in
   the plan. Do not silently assume.

---

## Code Rules

7. **Tests are not optional.** Every task that produces code must also produce tests.
   A task with no tests is incomplete. Run the full test suite before reporting done.

8. **Never break existing tests.** If your change breaks a test you did not touch,
   fix it before reporting back.

9. **Backend unit tests:** Go testing package for Go components. pytest for
   flightdeck-sensor. No real API calls. Mock all external services.

10. **Integration tests:** pytest. Full pipeline. Real NATS and Postgres in Docker
    Compose. Run with `make test-integration`.

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

## Prompt Capture Rules (CRITICAL)

18. **Never store or log prompt content when capture_prompts=false.**
    This is a hard rule with no exceptions. When capture is off, event payloads
    contain only token counts, model names, latency, and tool names. No message
    content. No system prompts. No tool inputs or outputs. No response text.
    If you find code that stores content when capture is off, it is a bug.

19. **Content goes in event_content table only.** Prompt content is never stored
    inline in the events table. The events table always contains metadata only.
    Content is fetched on demand via `GET /v1/events/:id/content`.

20. **Preserve provider terminology.** Never normalize Anthropic's `system` +
    `messages` into OpenAI's `messages`-only format or vice versa. Store and display
    exactly what the provider received. The `PromptViewer` component handles
    provider-specific rendering -- do not change this logic without Supervisor approval.

21. **The Prompts tab in the session drawer shows a clear disabled state** when
    capture is off for that session: "Prompt capture is not enabled for this
    deployment." Never show an empty tab, a loading spinner that never resolves,
    or an error message.

---

## Analytics Rules

22. **Every analytics chart must have a working group-by control.**
    A chart without a functional `DimensionPicker` is an incomplete task.
    The group-by dropdown must change the chart data, not just the label.

23. **The global time range picker applies to all charts simultaneously.**
    If you implement a chart that ignores the global time range, it is wrong.

24. **All analytics charts use the same `GET /v1/analytics` endpoint.**
    Different charts pass different `metric` and `group_by` parameters.
    Do not create separate endpoints per chart.

25. **Available dimensions are exactly:** `flavor`, `model`, `framework`, `host`,
    `agent_type`, `team`, `provider`, `agent_role`, `parent_session_id`. No other
    values. Do not add dimensions without updating ARCHITECTURE.md first.
    `provider` is derived at query time via SQL CASE over `model` (see
    DECISIONS.md D098). `agent_role` (D126) groups by the framework-supplied
    sub-agent role string; sessions with null `agent_role` bucket as `(root)`.
    `parent_session_id` (D126 § 6.4) groups by the parent session UUID; root
    sessions bucket as `(root)`. The `group_by` query param accepts **one or
    two** dimensions comma-separated (D126 § 6.4): `?group_by=dim1` keeps the
    pre-D126 single-axis shape; `?group_by=dim1,dim2` returns a two-key rollup
    where `dim1` is the primary (outer) axis and `dim2` is the secondary
    (inner) axis. Both positions accept any value from the locked list above.

26. **Available metrics are exactly:** `tokens`, `sessions`, `latency_avg`,
    `latency_p50`, `latency_p95`, `policy_events`, `estimated_cost`,
    `parent_token_sum`, `child_token_sum`, `child_count`,
    `parent_to_first_child_latency_ms`. Same rule applies. `estimated_cost`
    uses the static pricing table in `api/internal/store/pricing.go` (D099);
    update the table when provider list prices change. The four sub-agent-aware
    metrics (D126) operate over the parent / child relationship via recursive
    CTE on `parent_session_id`; see ARCHITECTURE.md analytics endpoint section
    for the contract and the known-performance-characteristic note.

---

## Sensor Rules

27. **The sensor must never add meaningful latency to the agent's hot path.**
    All control plane communication is fire-and-forget or background.
    Never introduce synchronous blocking calls in the LLM call intercept path.

28. **The sensor must fail open.** If the control plane is unreachable and
    FLIGHTDECK_UNAVAILABLE_POLICY=continue, the agent proceeds with no enforcement.
    Do not raise exceptions for connectivity failures.

29. **Token counting carries over from tokencap.** Do not rewrite the counting logic.
    Extend it. Pre-call estimation, post-call reconciliation, delta correction -- these
    are proven and must not be changed without Supervisor approval.

30. **capture_prompts defaults to False.** The default init() call never captures
    content. Always verify this default has not been accidentally changed.

31. **init() limit param fires WARN only.** Never upgrade a local limit to BLOCK
    or DEGRADE regardless of what the server policy says. See DECISIONS.md D035.

32. **The sensor is a library wrapper, not an OS agent.** Never add background
    threads, polling loops, or daemon threads to the sensor beyond the existing
    event queue drain thread. If a feature requires background activity
    independent of LLM calls, it does not belong in the sensor.

---

## API and Schema Rules

33. **Never change the event payload schema without updating ARCHITECTURE.md first.**
    The schema is a contract between the sensor and the ingestion API.

34. **All database schema changes must use golang-migrate.** Create a new numbered
    migration pair in `docker/postgres/migrations/`:
      `000NNN_description.up.sql`
      `000NNN_description.down.sql`
    The down file must be the exact inverse of the up file. Never add schema
    changes to `init.sql` -- it contains seed data only. Never modify an existing
    migration file that has already been applied. Always add a new migration.

35. **No raw SQL outside `api/internal/store/`.** SQL lives in the store package only.

36. **Validate all event payloads at the ingestion API boundary.** Do not pass
    invalid events to NATS.

37. **GET /v1/events/:id/content returns 404 when capture is disabled** for that
    session. Not 200 with empty data. Not 403. 404 -- the resource does not exist.

---

## Reporting Rules

38. **After every task, report:**
    - Every file created or modified
    - Every decision made not explicitly covered in ARCHITECTURE.md
    - Test count before and after (must increase)
    - Whether both themes pass (for frontend tasks)
    - Any blockers

39. **If you find a discrepancy between code and ARCHITECTURE.md, report it
    immediately.** Log it, fix it, report it.

40. **Do not report a task complete if tests are failing.**

---

## Live Stack Verification Rule

40a. **Any new runtime code path must be exercised against the live dev stack
     before claiming it works.** Passing unit tests with mocks is insufficient
     evidence on its own. A playground script or smoke test that pytest never
     executes -- real API calls, real dev stack, real event persistence -- is
     the verification standard.

     Applies to:
     - New sensor framework interceptors (Anthropic, OpenAI, litellm, and every
       future addition).
     - New playground scripts.
     - New worker code paths (state transitions, revive logic, session guards).
     - New dashboard behavior where the claim is user-facing ("state revives
       on event", "filter composes with flavor").
     - Any "this should work" claim that unit tests alone can't verify.

     Does NOT apply to:
     - Pure refactors where behavior is identical and tests pass.
     - Docs-only changes.
     - Type-only fixes.

     If a live-run is genuinely not feasible (requires production credentials,
     or the dev stack can't exercise the path), flag explicitly in the commit
     body:

        Not verified against live stack because <reason>. Unit tests cover
        <paths>; live verification deferred to <mechanism>.

     Never silently claim verification that wasn't done. Mock-only coverage
     has shipped real bugs in this repo (KI21 pre-fix, workers binary pre-D105
     drift, KI24 Node-20 annotations). The rule is the lesson.

40a.A. **Every playground script must declare a meaningful ``agent_type`` and
     ``flavor``.** Never ``"unknown"``, never empty, never inherited defaults.
     Convention:
     - ``agent_type = "coding"`` (dev smoke matching the D114 vocabulary)
     - ``flavor = "playground-<script-name>"``

     Enforced by ``playground/_helpers.py::init_sensor`` -- ``flavor`` is a
     required keyword-only parameter with no default, ``agent_type`` defaults
     to ``"coding"``. Scripts that need a flavor-scoped policy or directive
     (currently ``07_directives.py``, ``08_enforcement.py``) append a hex
     suffix for per-run uniqueness (``playground-directives-a1b2c3``).

     Without this rule every playground run lands as ``flavor="unknown"`` /
     ``agent_type="autonomous"`` -- the sensor's pre-D114 defaults -- which
     makes the Fleet view unreadable and violates the agent_type vocabulary
     lock.

40a.B. **Every playground script must enable maximum capture.**
     ``capture_prompts=True`` is the default in
     ``playground/_helpers.py::init_sensor``. Any future sensor capture flag
     (currently only ``capture_prompts`` exists) defaults to its most
     expansive setting in the helper. Playground is the highest-fidelity
     smoke surface -- it demonstrates what the sensor can see, not a minimal
     happy path.

     The one legitimate override is ``09_capture.py`` which exercises the
     ``capture_prompts=False`` / ``True`` matrix explicitly to verify the
     ``GET /v1/events/{id}/content`` 404-vs-200 contract. Any other script
     that turns capture off needs a commit-body justification.

     Both sub-rules inherit from rule 40a. Any new playground script must
     satisfy both at creation.

40b. **Before committing changes that touch code paths with runtime
     behavior, run the full test suite against a locally-running dev
     stack that reflects the current branch state.** CI is not the
     first-line detector for runtime bugs — local pre-commit
     verification is. Unit tests with mocks pass while live queries
     500 exactly when the mocks diverge from reality. The
     `feedback_pre_commit_live_test.md` entry in the auto-memory
     captures this rule in permanent agent memory.

     How to apply:
     - For sensor / ingestion / worker / API / dashboard API-contract
       changes: rebuild the affected container(s) so the dev stack is
       running branch HEAD, then run the component's full test suite
       (unit + integration) locally. Don't push until green.
     - The project's dev stack uses the `docker-compose.dev.yml`
       override (mounts source, runs `go run ./cmd/` / vite dev) — a
       plain `docker compose up --build` without the override rebuilds
       a stale prod-image layer and will NOT reflect your edits. Use
       `make dev` or `docker compose -f docker-compose.yml -f
       docker-compose.dev.yml up --build -d <service>`.
     - Exempt: pure docs, comments, type-only fixes, and formatting
       passes that cannot change runtime behavior.

     Inherits from rule 40a (live-stack verification). Where 40a says
     "new runtime code must be exercised live before claiming it
     works," 40b says "and that verification happens before the
     commit, not after push-to-CI."

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

40d. **Framework coverage discipline.** Any phase that adds
     framework support OR changes framework-emission behaviour
     MUST include BOTH:

     1. **Real-provider playground demos** per affected framework --
        manual, NOT in CI (they cost money and need live API
        credentials). Live under ``playground/`` and self-skip
        (exit 2) when the relevant API key / framework / optional
        gateway URL is missing so ``make playground-all`` runs
        cleanly on any box. Driven via ``make playground-<script>``
        targets. Each demo asserts payload shape inline using
        ``print_result`` + ``raise AssertionError``; ``run_all.py``
        exits 0 only when every script returned 0 (PASS) or 2
        (SKIP). Results documented in the phase's audit doc before
        PR merge.
     2. **Integration tests** per framework × behaviour combo,
        mock-free (or lightly mocked at the network boundary),
        running in CI via the existing Integration job. Seed a
        realistic event payload for each new framework + behaviour
        combination and verify end-to-end landing.

     V-pass for such a phase MUST enumerate the playground demos
     and integration tests that will be added before
     implementation starts. Skipping either is a phase-gate
     failure.

     Why: Phase 4 (agent communication coverage hardening) shipped
     embeddings, streaming semantics, structured error events, and
     session-lifecycle edge-case fixes. Mock-only coverage would
     have let a future SDK upgrade silently break the classifier
     (anthropic renames ``RateLimitError`` to ``QuotaError`` and
     our classifier falls through to ``other``; no CI gate catches
     it). The playground matrix is the only thing that exercises
     the real class hierarchy every provider ships.

     Applies to: every phase from Phase 4 onwards that touches
     ``sensor/flightdeck_sensor/interceptor/*``, adds a new
     interceptor file, or changes the event-emission shape for an
     existing framework.

     Does NOT apply to: non-framework sensor work (transport,
     policy, directives) — those are covered by the standard unit
     + integration suites.

40e. **Pre-push lint is a hard rule.** Before pushing any code,
     run the appropriate linter for every component touched and
     fix every finding. Component → command:

     - Sensor / playground / tests (Python): ``ruff check .`` and
       ``ruff format --check .`` from the component root. ``mypy
       --strict`` on sensor.
     - Ingestion / workers / api (Go): ``golangci-lint run`` from
       the component root. The binary lives at
       ``/home/omria/go/bin/golangci-lint`` on the dev box (PATH may
       not include it). ``go test ./...`` alone misses ``unused``
       and other lints CI enforces.
     - Dashboard (TypeScript): ``npm run lint`` and
       ``npm run typecheck`` from ``dashboard/``.

     CI runs these gates and a push that lands red blocks the PR.
     Catching the failure locally takes seconds; catching it after
     a CI run wastes ~5-10 minutes per cycle. Inherits from rule
     40b (pre-commit live test). Where 40b is about runtime
     behaviour, 40e is about static checks; both must pass before
     push.

     Does NOT apply to: docs-only commits with no source-file
     changes. A README/CHANGELOG/CLAUDE.md edit is exempt.

---

## Living Document Rules

41. **ARCHITECTURE.md is a living document, not a contract carved in stone.**
    When implementation reveals that a planned approach is wrong, impractical,
    or superseded by a better idea, update the document to reflect reality.
    A codebase that matches a stale ARCHITECTURE.md is worse than no
    ARCHITECTURE.md at all.

    **ARCHITECTURE.md describes what the system IS, not how it got there.**
    A new contributor with zero project history must be able to read it and
    learn the system as it stands today. Phase references, "was added in
    Phase X", "previously did Y", "pre-fix the worker dropped Z", and other
    temporal qualifiers do not belong in ARCHITECTURE. They belong in:

    - ``CHANGELOG.md`` for user-visible changes per release.
    - ``DECISIONS.md`` for durable D-numbered decisions.
    - PR descriptions and commit bodies for phase decisions, V-pass
      methodology notes, pre-existing bugs surfaced during audit,
      and phase-ancestry of individual features.

    D-numbers (D057, D094, D115, etc.) ARE acceptable in ARCHITECTURE
    when they explain why the system is shaped a particular way — they
    are durable references that point to DECISIONS.md, not phase tags.

42. **When any planned decision changes, update docs before merging code.**
    The order is always: update ARCHITECTURE.md → update DECISIONS.md (record
    the pivot and why) → write the code → tests pass → report back.
    Never merge code that contradicts the architecture docs.

43. **DECISIONS.md records every pivot immediately.** If the plan says to use
    library X and you switch to library Y mid-implementation, stop. Add a
    DECISIONS.md entry: what changed, what was rejected, why. Then proceed.
    Future contributors must understand why the code looks different from the plan.

44. **Phase plan changes must be approved by the Supervisor.** If a task reveals
    that a planned deliverable is wrong in scope, sequencing, or approach, raise
    it before changing the plan. Do not silently resequence phases or remove
    deliverables. The Supervisor decides whether to update the plan or stay the
    course.

45. **Acceptance criteria can be revised if they are wrong.** If a criterion
    turns out to be untestable, overconstrained, or based on a wrong assumption,
    raise it with the Supervisor. Do not silently skip a criterion.

---

## Git Rules

46. **Never commit directly to main.** All changes go through a branch.

47. **Commit messages follow conventional commits:**
    `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`

48. **Never commit secrets, API keys, or tokens.**

---

## Issue Tracking Rules

49. **No indefinite deferral bucket.** Issues land in one of three states:
    fixed in the release they are filed in, declined with a documented reason
    (typically in the commit body or DECISIONS.md), or on the Roadmap in
    `README.md` as a user-prioritizable post-v0.4.0 bullet. The prior
    `KNOWN_ISSUES.md` / `Deferred to v0.4.0` bucket was retired; it had
    become a dumping ground where items sat for months. The Roadmap is
    public (user-facing README) so the work is visible and user demand can
    prioritize it.

    When you would have filed a KI, instead:
    - If it's a bug that needs fixing now: fix it in this commit or the
      next release. Don't file, don't defer.
    - If it's a legitimate architectural trade-off: document the decision
      in DECISIONS.md (with a follow-up pointer if there's a real path to
      revisit) and close the matter.
    - If it's a post-launch follow-up that might matter to users but has
      no concrete owner yet: add or update a Roadmap bullet in README.md.
    - If it's outside scope entirely (feature creep, hypothetical): decline
      in the PR or commit body with reason. No entry anywhere.

    `TODO(KI...)` comments in code are retired. If a comment refers to
    deferred work, use `TODO: <short description>` with a pointer to the
    Roadmap section when applicable. Plain `TODO` for local "come back to
    this after the branch merges" work is still fine.

---

## API Documentation Rules

50. **Every API endpoint must have complete Swagger documentation.**

    When any new endpoint is added to ingestion or api:
    - Add swaggo annotations to the handler before the task is considered complete
    - Required annotations: @Summary, @Description, @Tags, @Accept, @Produce,
      @Param (every param including query params), @Success with the correct
      response struct, @Failure for every error code the handler can return, @Router
    - Run `swag init -g cmd/main.go -o docs` in the component after adding annotations
    - Commit the regenerated `docs/` directory

    At the end of every phase audit, verify:
    - Every endpoint listed in ARCHITECTURE.md has a Swagger annotation in the handler
    - The Swagger spec accurately reflects the actual request and response schemas
      (field names, types, nullable fields marked as omitempty or pointer)
    - `curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/docs/index.html`
      and `curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/ingest/docs/index.html`
      both return 200
    - No endpoint exists in the code that is absent from the Swagger spec

    If any endpoint is undocumented, the phase audit fails. Document it before
    the phase can close.

---

## No-Defer Discipline

51. **No-defer discipline.** When methodology or scope gaps surface
    mid-phase that fit the phase's intent, they land in the current
    PR. They do not get deferred to a follow-up PR. Deferring
    recreates the drift the current phase exists to prevent.

    The phase's intent is defined by its title and goal statement.
    A finding that clearly fits is in scope. A finding that clearly
    doesn't (e.g., unrelated feature work that warrants user
    prioritisation) lands as a Roadmap bullet in README.md and is
    addressed later. Borderline cases are resolved by the
    Supervisor, not deferred unilaterally. There is no separate
    "follow-ups" file — the Roadmap and the current PR are the
    only two destinations.

    This rule applies to Claude Code's "preserve intentionally" or
    "flag for deferral" proposals — the default answer is "address
    now", not "defer". The Supervisor authorizes deferral
    explicitly, or it doesn't happen.

    Why: Phase 4 surfaced multiple gaps mid-phase (embeddings
    content capture, framework attribution always-null, V-DRAWER
    dead-end, ARCHITECTURE phase-tag drift, ARCHITECTURE structural
    reorganization) that a strict reading of the original V-pass
    would have deferred. Each fit the phase's "agent communication
    coverage hardening" intent, was addressed in PR #28, and would
    have compounded as drift if shipped to a follow-up. This rule
    codifies the principle that has been applied ad-hoc throughout
    PR #28.

---

## What Is Out of Scope

Do not implement without explicit Supervisor instruction:

- Notification infrastructure: Slack, email, PagerDuty (v2)
- TimescaleDB migration (v2 -- analytics page works on plain Postgres)
- Proxy or gateway pattern for LLM traffic interception
- MCP server
- Multi-tenant SaaS (self-hosted only in v1)

---

## Git Discipline

These rules exist because a rebase operation earlier orphaned 27 commits
of real work and nearly lost the Analytics v2 feature. The reflog saved
us. The rules below make that class of mistake harder.

### No destructive operations without explicit Supervisor approval

The following are DESTRUCTIVE -- they rewrite history, drop commits, or
make remote state unrecoverable from the branch. Never run any of these
without the Supervisor approving the exact command in the chat:

- `git rebase` (interactive or `--onto`)
- `git reset --hard`
- `git push --force`
- `git push --force-with-lease`
- `git push -f`
- `git branch -D` (force delete)
- `git checkout -- <file>` (when it would discard uncommitted work)
- `git clean -fd`
- `git filter-branch`
- `git commit --amend` (on a commit that has already been pushed)
- Any git operation involving `--onto`, `--orphan`, or reflog manipulation

If any of these feels necessary, stop and write a plan describing:

- What you intend to run (exact command)
- What state you expect before and after
- How the Supervisor can verify the result is what was intended
- What the rollback path is if it goes wrong

The Supervisor must explicitly respond with `go` before execution.

### Default safe operations

For normal work, stick to:

- `git add`, `git commit`
- `git push` (fast-forward only)
- `git pull --ff-only`
- `git fetch` + `git merge --ff-only`
- `git merge` (only when explicitly asked)
- `git stash` / `git stash pop`

### Always start from latest main

Before beginning any task, fetch from origin, fast-forward main to
origin/main, and create a new feature branch from there. Never start
work on a stale branch or on a branch carried over from a previous
task unless the Supervisor explicitly says to continue. Canonical
sequence:

```
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/<descriptive-name>
```

If the working tree is dirty, stop and ask the Supervisor before
proceeding. Never auto-stash, auto-discard, or carry forward
unrelated changes. If main is not fast-forwardable to origin/main
(which would only happen with local commits on main that should
never exist per Rule 46), stop and ask.

This sequence is the FIRST step before any code reading, planning,
or implementation. The branch name uses a descriptive slug for the
work; future PRs use their own.

### Syncing with main

When main moves forward and the feature branch needs updates:

1. `git fetch origin`
2. `git merge --ff-only origin/main` (if possible)
3. If not fast-forwardable, report the situation to the Supervisor with
   `git log --oneline origin/main feat/<branch> --not --graph` and ask
   before merging, rebasing, or resolving.

Never silently rebase a feature branch onto main. Squash merges from PRs
create non-linear history that rebase does not handle cleanly -- the
rebase earlier in this project kept only one commit and dropped 27.

### When something goes wrong

1. Do not panic-fix with another destructive operation.
2. `git reflog` is your friend. Every HEAD movement for the last 30+
   days is recoverable from the reflog.
3. `git fsck --lost-found` finds dangling commits not reachable from any
   ref.
4. Orphaned commits stay in the object store for at least 30 days
   (default `gc.pruneExpire`) before `git gc` removes them. Move fast
   but don't panic.

### PR and merge workflow

When a PR is squash-merged to main, the feature branch's local history
diverges from main because the 20 commits on the branch become 1 commit
on main. Do NOT try to "clean this up" with rebase. Either:

- Delete the feature branch and start a new one from updated main for
  the next piece of work
- OR keep working on the feature branch, treating it as
  divergent-but-valuable, and merge main in periodically with
  `git merge --ff-only origin/main` (or a non-ff merge if ff is
  impossible, with Supervisor approval)
