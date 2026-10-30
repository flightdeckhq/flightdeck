# Flightdeck -- Claude Code Rules

> These rules exist because something went wrong or almost went wrong without them.
> Follow them without exception. If a rule conflicts with a task instruction, raise
> the conflict with the maintainer before proceeding.
>
> Component-specific rules live in `dashboard/CLAUDE.md` (frontend + E2E
> discipline) and `sensor/CLAUDE.md` (sensor + framework coverage). They load
> automatically when working on files under those directories.

---

## Before Every Session

1. **Read ARCHITECTURE.md in full.** Not a skim. Every section. The architecture
   is the source of truth. Code that contradicts it is wrong, not the architecture.

2. **Check for open TODO, FIXME, and HACK comments** in any file you are about to
   touch. List them in your plan before proposing changes.

3. **Write architectural decisions down before the code.** A decision ARCHITECTURE.md
   does not cover is recorded first (rules 42 and 43): ARCHITECTURE.md, then
   DECISIONS.md when it qualifies, otherwise the PR description. Ask the maintainer
   instead of deciding when the choice changes scope, removes existing behaviour or
   content, or is a product call the docs do not settle.

---

## Planning Rules

4. **Always plan before implementing.** For every task, write down every file you
   will create or modify and why (a scratch plan or the PR description). Implement
   without waiting for approval unless a rule here asks for the maintainer's go.

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

Frontend code rules (11-17) live in `dashboard/CLAUDE.md`.

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
    provider-specific rendering -- do not change this logic without the maintainer's approval.

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
    `provider` reads the sensor-stamped `events.provider` and falls back
    to a SQL CASE over `model` for older rows. `agent_role` groups by the framework-supplied
    sub-agent role string; sessions with null `agent_role` bucket as `(root)`.
    `parent_session_id` groups by the parent session UUID; root
    sessions bucket as `(root)`. The `group_by` query param accepts **one or
    two** dimensions comma-separated: `?group_by=dim1` keeps the
    single-axis shape; `?group_by=dim1,dim2` returns a two-key rollup
    where `dim1` is the primary (outer) axis and `dim2` is the secondary
    (inner) axis. Both positions accept any value from the locked list above.

26. **Available metrics are exactly:** `tokens`, `sessions`, `latency_avg`,
    `latency_p50`, `latency_p95`, `policy_events`, `estimated_cost`,
    `parent_token_sum`, `child_token_sum`, `child_count`,
    `parent_to_first_child_latency_ms`. Same rule applies. `estimated_cost`
    sums metered calls only and prices them from the `model_pricing`
    table, which `api/internal/store/pricing_loader.go` rebuilds at API
    startup from the vendored litellm catalogue and the `pricing.yaml`
    overrides; refresh the catalogue with `make
    pricing-refresh` (CONTRIBUTING.md has the steps).
    The four sub-agent-aware metrics operate over the parent / child
    relationship via recursive
    CTE on `parent_session_id`; see ARCHITECTURE.md analytics endpoint section
    for the contract and the known-performance-characteristic note.

---

## Sensor Rules

Sensor rules (27-32) live in `sensor/CLAUDE.md`.

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
     has shipped real bugs in this repo (a litellm interceptor that passed
     mocked tests and never fired live, a workers binary that drifted from
     its source, CI annotations that only surfaced on Node 20). The rule is
     the lesson.

40a.A. **Every playground script must declare a meaningful ``agent_type`` and
     ``flavor``.** Never ``"unknown"``, never empty, never inherited defaults.
     Convention:
     - ``agent_type = "coding"`` (dev smoke, from the locked agent_type vocabulary)
     - ``flavor = "playground-<script-name>"``

     Enforced mechanically by ``playground/_helpers.py::init_sensor``.

     Without this rule every playground run lands as ``flavor="unknown"`` /
     ``agent_type="autonomous"`` -- outside the locked agent_type vocabulary
     (``coding``, ``production``) -- which makes the Fleet view unreadable.

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

40c. E2E discipline rules (40c through 40c.4) live in `dashboard/CLAUDE.md`.

40d. Framework coverage rules live in `sensor/CLAUDE.md`.

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
    - ``DECISIONS.md`` for the durable decisions rule 43 describes.
    - PR descriptions and commit bodies for phase decisions, V-pass
      methodology notes, pre-existing bugs surfaced during audit,
      and phase-ancestry of individual features.

    D-numbers (D057, D094, D115, etc.) are NOT acceptable in
    ARCHITECTURE.md either, nor in code, comments or log strings.
    Decision-record pointers belong in CHANGELOG.md, DECISIONS.md
    itself, and PR/commit bodies — a
    reader should not need a D-number lookup to understand what the
    system does today. Architecture prose states the fact directly
    with the WHY in plain English.

42. **When any planned decision changes, update docs before merging code.**
    The order is always: update ARCHITECTURE.md → record the decision
    (in DECISIONS.md when rule 43 says so, otherwise in the PR
    description) → write the code → tests pass → report back.
    Never merge code that contradicts the architecture docs.

43. **DECISIONS.md records the decisions future contributors would otherwise
    relitigate, and only those.** Add an entry, before the code, when a
    decision changes a contract (event payload, API, wire or file format),
    changes the database schema, moves a trust or security boundary, or
    rejects an alternative someone would plausibly propose again. Keep it
    to 10-15 lines: decision, why, rejected alternative (format in the
    file's header). Every other pivot (switching library X for Y, a plan
    change, a review finding) is explained in the PR description and
    commit body. Entries D001-D213 are frozen in DECISIONS-ARCHIVE.md.

44. **Phase plan changes must be approved by the maintainer.** If a task reveals
    that a planned deliverable is wrong in scope, sequencing, or approach, raise
    it before changing the plan. Do not silently resequence phases or remove
    deliverables. The maintainer decides whether to update the plan or stay the
    course.

45. **Acceptance criteria can be revised if they are wrong.** If a criterion
    turns out to be untestable, overconstrained, or based on a wrong assumption,
    raise it with the maintainer. Do not silently skip a criterion.

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
    `README.md` (the `## Roadmap` section) as a user-prioritizable bullet. The prior
    `KNOWN_ISSUES.md` / `Deferred to v0.4.0` bucket was retired; it had
    become a dumping ground where items sat for months. The Roadmap is
    public (user-facing README) so the work is visible and user demand can
    prioritize it.

    When you would have filed a KI, instead:
    - If it's a bug that needs fixing now: fix it in this commit or the
      next release. Don't file, don't defer.
    - If it's a legitimate architectural trade-off: document the decision
      in the PR body, or in DECISIONS.md when rule 43 applies (with a
      follow-up pointer if there's a real path to revisit), and close the
      matter.
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
    - Regenerate the docs with `make -C <component> build` (it runs
      `go tool swag`, the version the component's `go.mod` pins; ingestion
      writes OpenAPI 3.1 with `--v3.1`, the api Swagger 2.0)
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
    maintainer, not deferred unilaterally. There is no separate
    "follow-ups" file — the Roadmap and the current PR are the
    only two destinations.

    This rule applies to Claude Code's "preserve intentionally" or
    "flag for deferral" proposals — the default answer is "address
    now", not "defer". The maintainer authorizes deferral
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

Do not implement without explicit maintainer instruction:

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

### No destructive operations without explicit maintainer approval

The following are DESTRUCTIVE -- they rewrite history, drop commits, or
make remote state unrecoverable from the branch. Never run any of these
without the maintainer approving the exact command in the chat:

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
- How the maintainer can verify the result is what was intended
- What the rollback path is if it goes wrong

The maintainer must explicitly respond with `go` before execution.

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
task unless the maintainer explicitly says to continue. Canonical
sequence:

```
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/<descriptive-name>
```

If the working tree is dirty, stop and ask the maintainer before
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
3. If not fast-forwardable, report the situation to the maintainer with
   `git log --oneline origin/main feat/<branch> --not --graph` and ask
   before merging, rebasing, or resolving.

Never silently rebase a feature branch onto main. Squash merges from PRs
create non-linear history that rebase does not handle cleanly -- the
rebase earlier in this project kept only one commit and dropped 27.

### PR and merge workflow

When a PR is squash-merged to main, the feature branch's local history
diverges from main because the 20 commits on the branch become 1 commit
on main. Do NOT try to "clean this up" with rebase. Either:

- Delete the feature branch and start a new one from updated main for
  the next piece of work
- OR keep working on the feature branch, treating it as
  divergent-but-valuable, and merge main in periodically with
  `git merge --ff-only origin/main` (or a non-ff merge if ff is
  impossible, with the maintainer's approval)
