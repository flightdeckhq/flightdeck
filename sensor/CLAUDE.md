# Flightdeck Sensor -- Claude Code Rules

> Component-specific rules moved out of the root CLAUDE.md so they load only
> when working under sensor/. All root CLAUDE.md rules still apply; the
> numbering below keeps the original rule numbers.

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

## Framework Coverage Discipline

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
