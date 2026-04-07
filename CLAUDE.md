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
    `agent_type`, `team`. No other values. Do not add dimensions without updating
    ARCHITECTURE.md first.

26. **Available metrics are exactly:** `tokens`, `sessions`, `latency_avg`,
    `policy_events`. Same rule applies.

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

---

## API and Schema Rules

32. **Never change the event payload schema without updating ARCHITECTURE.md first.**
    The schema is a contract between the sensor and the ingestion API.

33. **All database migrations must be reversible.** Every migration has an up and
    a down. Test both.

34. **No raw SQL outside `api/internal/store/`.** SQL lives in the store package only.

35. **Validate all event payloads at the ingestion API boundary.** Do not pass
    invalid events to NATS.

36. **GET /v1/events/:id/content returns 404 when capture is disabled** for that
    session. Not 200 with empty data. Not 403. 404 -- the resource does not exist.

---

## Reporting Rules

37. **After every task, report:**
    - Every file created or modified
    - Every decision made not explicitly covered in ARCHITECTURE.md
    - Test count before and after (must increase)
    - Whether both themes pass (for frontend tasks)
    - Any blockers

38. **If you find a discrepancy between code and ARCHITECTURE.md, report it
    immediately.** Log it, fix it, report it.

39. **Do not report a task complete if tests are failing.**

---

## Living Document Rules

40. **ARCHITECTURE.md is a living document, not a contract carved in stone.**
    When implementation reveals that a planned approach is wrong, impractical,
    or superseded by a better idea, update the document to reflect reality.
    A codebase that matches a stale ARCHITECTURE.md is worse than no
    ARCHITECTURE.md at all.

41. **When any planned decision changes, update docs before merging code.**
    The order is always: update ARCHITECTURE.md → update DECISIONS.md (record
    the pivot and why) → write the code → tests pass → report back.
    Never merge code that contradicts the architecture docs.

42. **DECISIONS.md records every pivot immediately.** If the plan says to use
    library X and you switch to library Y mid-implementation, stop. Add a
    DECISIONS.md entry: what changed, what was rejected, why. Then proceed.
    Future contributors must understand why the code looks different from the plan.

43. **Phase plan changes must be approved by the Supervisor.** If a task reveals
    that a planned deliverable is wrong in scope, sequencing, or approach, raise
    it before changing the plan. Do not silently resequence phases or remove
    deliverables. The Supervisor decides whether to update the plan or stay the
    course.

44. **Acceptance criteria can be revised if they are wrong.** If a criterion
    turns out to be untestable, overconstrained, or based on a wrong assumption,
    raise it with the Supervisor. Do not silently skip a criterion.

---

## Git Rules

45. **Never commit directly to main.** All changes go through a branch.

46. **Commit messages follow conventional commits:**
    `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`

47. **Never commit secrets, API keys, or tokens.**

---

## Known Issues Rules

48. **At the start of every phase, run this command:**
        grep -rn "TODO(KI" . \
          --include="*.go" \
          --include="*.py" \
          --include="*.ts" \
          --include="*.yml" \
          | grep "\[Phase N\]"
    Replace N with the current phase number. Every result must be raised with
    the Supervisor and included in the phase plan before any feature work begins.

    When a KI item is resolved:
    - Remove the TODO comment from the code entirely. Never leave a resolved
      TODO in the code.
    - Remove the row from the Open table in KNOWN_ISSUES.md.
    - Add it to the Resolved table in KNOWN_ISSUES.md with the phase it was
      resolved in.
    - Record the fix in DECISIONS.md.
    - If the resolved item corresponds to a trade-off entry in DECISIONS.md
      (D039-D048 range), update that entry to add:
        "Resolved in: Phase N"
        "Resolution: <one-line summary of what was done>"
      Do not delete the DECISIONS.md entry -- it is a historical record.
      Only update it.

    When the Open table in KNOWN_ISSUES.md is empty:
    - Delete KNOWN_ISSUES.md entirely.
    - Do not leave an empty file or a Resolved-only file.

    Before any release tag is pushed:
    - Verify KNOWN_ISSUES.md does not exist.
    - If it exists, all open items must be resolved and the file deleted
      before the tag is pushed, OR the Supervisor must explicitly approve
      shipping with known issues and state which items are acceptable.
    - Never push a release tag with open KI items without explicit Supervisor
      approval.

---

## API Documentation Rules

49. **Every API endpoint must have complete Swagger documentation.**

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

## What Is Out of Scope

Do not implement without explicit Supervisor instruction:

- Dollar cost conversion (v2)
- Notification infrastructure: Slack, email, PagerDuty (v2)
- TimescaleDB migration (v2 -- analytics page works on plain Postgres)
- Proxy or gateway pattern for LLM traffic interception
- MCP server
- Multi-tenant SaaS (self-hosted only in v1)
