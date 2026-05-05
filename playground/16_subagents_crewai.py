"""CrewAI sub-agent observability — real Crew with Researcher + Writer.

Drives a real two-agent CrewAI Crew through ``flightdeck_sensor``'s
CrewAI sub-agent interceptor (D126). The interceptor patches
``crewai.Agent.execute_task`` so each Crew member's turn lands as
its own child session in Flightdeck, with role attribution from
``Agent.role`` and cross-agent message capture (incoming = task
description, outgoing = return value) gated on ``capture_prompts``.

The Crew is intentionally tight (haiku model, ``max_iter=1``,
short tasks) so the demo finishes inside ``run_all.py``'s subprocess
timeout. ``OPENAI_API_KEY`` is required only for CrewAI's embedder
default; the actual chat traffic flows through Anthropic. When
either ``ANTHROPIC_API_KEY`` or ``OPENAI_API_KEY`` is missing the
script self-skips (exit 2).

Assertions cover the D126 contract:
* Every ``Agent.role`` produces a child ``session_start`` +
  ``session_end`` pair tied to the parent via ``parent_session_id``.
* ``agent_role`` on each child equals the corresponding
  ``Agent.role`` string verbatim.
* ``agent_id`` differs across roles (deterministic per-role
  derivation per D126 § 1).
* ``incoming_message.body`` round-trips the CrewAI Task description.
* ``outgoing_message.body`` carries the Agent's return value as the
  framework produced it.
"""

from __future__ import annotations

import sys
import time
import uuid

from _helpers import (
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
    wait_for_dev_stack,
)


def main() -> None:
    # CrewAI's default LLM stack expects both API keys present even
    # when only one provider is exercised at runtime. Skip cleanly
    # rather than emitting a half-instrumented run.
    require_env("ANTHROPIC_API_KEY", "OPENAI_API_KEY")

    try:
        from crewai import Agent, Crew, LLM, Task  # type: ignore[import-untyped]
    except ImportError:
        print("SKIP: pip install crewai")
        sys.exit(2)

    import flightdeck_sensor
    from flightdeck_sensor import Provider

    wait_for_dev_stack()

    parent_session_id = str(uuid.uuid4())
    init_sensor(parent_session_id, flavor="playground-subagents-crewai")
    # CrewAI provider routes Agent.execute_task through the D126
    # interceptor; ANTHROPIC provider hooks the underlying LLM SDK so
    # the per-call post_call events also land for the parent session.
    flightdeck_sensor.patch(
        providers=[Provider.CREWAI, Provider.ANTHROPIC],
        quiet=True,
    )
    print(
        f"[playground:16_subagents_crewai] parent_session_id={parent_session_id}",
    )

    # max_iter=1 + max_tokens=120 keeps each Agent's turn under a few
    # seconds while still producing a non-trivial response that can
    # be asserted on. Real Anthropic API calls per Rule 40d gate.
    llm = LLM(
        model="anthropic/claude-haiku-4-5-20251001",
        max_tokens=120,
    )
    researcher = Agent(
        role="Researcher",
        goal="Identify the single most important fact about Flightdeck",
        backstory="A senior staff engineer who values brevity over completeness.",
        llm=llm,
        max_iter=1,
        allow_delegation=False,
        verbose=False,
    )
    writer = Agent(
        role="Writer",
        goal="Distill the researcher's finding into one declarative sentence",
        backstory="A technical writer with a hard one-sentence rule.",
        llm=llm,
        max_iter=1,
        allow_delegation=False,
        verbose=False,
    )

    research_task = Task(
        description=(
            "State exactly one specific fact about how Flightdeck observes "
            "agent sessions. Keep it under 25 words. Don't add headings or "
            "bullets — one sentence."
        ),
        expected_output="One short factual sentence.",
        agent=researcher,
    )
    write_task = Task(
        description=(
            "Take the researcher's sentence and rewrite it as one declarative "
            "statement under 30 words. Output the sentence only — no preamble."
        ),
        expected_output="One short declarative sentence.",
        agent=writer,
    )
    crew = Crew(agents=[researcher, writer], tasks=[research_task, write_task])

    t0 = time.monotonic()
    crew_result = crew.kickoff()
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    print_result("crew.kickoff() (Researcher + Writer)", True, elapsed_ms)

    # Tally token usage so the user can audit cost from the
    # playground output. CrewAI's ``crew_result.token_usage`` carries
    # the aggregated counts; falls back gracefully if a future
    # release reshapes the field.
    usage = getattr(crew_result, "token_usage", None) or {}
    total_tokens = (
        getattr(usage, "total_tokens", None)
        if not isinstance(usage, dict)
        else usage.get("total_tokens")
    )
    if total_tokens is not None:
        print(
            f"[playground:16_subagents_crewai] crew token_usage="
            f"{total_tokens} tokens (auditable cost)"
        )

    # The parent session itself receives the LLM post_call events
    # (one per agent turn). The child sessions are addressed by their
    # own ``session_id``; each child's events live there. We assert
    # against the parent's session events list — the worker indexes
    # ``parent_session_id`` so we filter the children client-side.
    events = fetch_events_for_session(
        parent_session_id,
        expect_event_types=["post_call"],
        timeout_s=20.0,
    )
    parent_post_calls = [e for e in events if e.get("event_type") == "post_call"]
    print_result(
        "parent session post_call events emitted",
        len(parent_post_calls) >= 1,
        0,
        f"count={len(parent_post_calls)}",
    )
    if not parent_post_calls:
        raise AssertionError(
            f"no post_call events landed for parent {parent_session_id}; "
            f"events={events!r}",
        )

    # Locate the children via the dedicated API filter. Polling the
    # raw ``/v1/events`` feed and grepping for parent_session_id ran
    # into pagination-eviction (busy dev stacks fill the first 200
    # rows with unrelated session activity). The
    # ``/v1/sessions?parent_session_id=...`` endpoint short-circuits
    # that — it's the same lookup the dashboard uses to render the
    # ``→ N`` sub-agent pill on AgentTable rows.
    import json
    import urllib.request

    from _helpers import API_TOKEN, API_URL

    deadline = time.monotonic() + 25.0
    child_sessions: list[dict] = []
    while time.monotonic() < deadline:
        req = urllib.request.Request(
            f"{API_URL}/v1/sessions?parent_session_id={parent_session_id}&limit=50",
            headers={"Authorization": f"Bearer {API_TOKEN}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                child_sessions = json.loads(r.read()).get("sessions", [])
        except Exception:
            time.sleep(0.4)
            continue
        if len(child_sessions) >= 2:
            break
        time.sleep(0.4)

    # Now fetch the events for each child to inspect agent_role +
    # message capture. The session_start / session_end pair is the
    # entire D126 lifecycle for a sub-agent; both events live on the
    # CHILD's session_id, not the parent's.
    child_starts: list[dict] = []
    child_ends: list[dict] = []
    for s in child_sessions:
        cid = s.get("session_id")
        if not cid:
            continue
        evs = fetch_events_for_session(
            cid,
            expect_event_types=["session_start", "session_end"],
            timeout_s=10.0,
        )
        for e in evs:
            if e.get("event_type") == "session_start":
                child_starts.append(e)
            elif e.get("event_type") == "session_end":
                child_ends.append(e)

    starts_ok = len(child_starts) >= 2
    ends_ok = len(child_ends) >= 2
    print_result(
        "child session_start emitted per Agent.role",
        starts_ok,
        0,
        f"count={len(child_starts)}",
    )
    print_result(
        "child session_end emitted per Agent.role",
        ends_ok,
        0,
        f"count={len(child_ends)}",
    )
    if not (starts_ok and ends_ok):
        raise AssertionError(
            f"expected ≥2 child session_start + ≥2 session_end events "
            f"with parent_session_id={parent_session_id}; "
            f"got starts={len(child_starts)} ends={len(child_ends)}",
        )

    # Role attribution per agent. CrewAI's ``Agent.role`` lands on
    # ``payload.agent_role`` verbatim — D126 § 1's role-string lock.
    roles = sorted({(e.get("payload") or {}).get("agent_role") for e in child_starts})
    role_ok = "Researcher" in roles and "Writer" in roles
    print_result(
        "agent_role attribution covers both Crew roles",
        role_ok,
        0,
        f"saw {roles!r}",
    )
    if not role_ok:
        raise AssertionError(
            f"expected Researcher + Writer in child agent_roles; got {roles!r}",
        )

    # agent_id distinct per role — derive_subagent_id joins the role
    # as the conditional 6th input so two roles under the same parent
    # produce two distinct deterministic ids. The worker projects
    # ``agent_id`` to the SESSION row (not the event payload), so we
    # read it off the session list response collected above.
    agent_ids_by_role: dict[str, str] = {}
    for s in child_sessions:
        agent_ids_by_role[s.get("agent_role")] = s.get("agent_id")
    distinct_ok = (
        agent_ids_by_role.get("Researcher")
        and agent_ids_by_role.get("Writer")
        and agent_ids_by_role["Researcher"] != agent_ids_by_role["Writer"]
    )
    print_result(
        "distinct agent_id per role (D126 § 1 derivation)",
        bool(distinct_ok),
        0,
        f"researcher={agent_ids_by_role.get('Researcher')!r} "
        f"writer={agent_ids_by_role.get('Writer')!r}",
    )
    if not distinct_ok:
        raise AssertionError(
            f"agent_ids should differ per role; got {agent_ids_by_role!r}",
        )

    # incoming_message.body round-trip. The Researcher's child carries
    # the research_task description verbatim; the Writer's carries the
    # write_task description plus optional context.
    incoming_bodies: dict[str, str] = {}
    for e in child_starts:
        pl = e.get("payload") or {}
        msg = pl.get("incoming_message") or {}
        body = msg.get("body")
        if isinstance(body, str):
            incoming_bodies[pl.get("agent_role")] = body
    incoming_ok = "specific fact about how Flightdeck" in (
        incoming_bodies.get("Researcher") or ""
    ) and "rewrite it as one declarative" in (incoming_bodies.get("Writer") or "")
    print_result(
        "incoming_message.body round-trips Task.description",
        incoming_ok,
        0,
        f"researcher_len={len(incoming_bodies.get('Researcher') or '')} "
        f"writer_len={len(incoming_bodies.get('Writer') or '')}",
    )
    if not incoming_ok:
        raise AssertionError(
            f"Task description not preserved on incoming_message; "
            f"bodies={incoming_bodies!r}",
        )

    # outgoing_message.body capture. The body is whatever the agent
    # returned from execute_task — typically the final TaskOutput-ish
    # string. Just assert non-empty + string-ish for both roles; the
    # exact text is an LLM artifact and can't be pinned.
    outgoing_bodies: dict[str, str] = {}
    for e in child_ends:
        pl = e.get("payload") or {}
        msg = pl.get("outgoing_message") or {}
        outgoing_bodies[pl.get("agent_role")] = str(msg.get("body") or "")
    outgoing_ok = (
        len(outgoing_bodies.get("Researcher") or "") > 0
        and len(outgoing_bodies.get("Writer") or "") > 0
    )
    print_result(
        "outgoing_message.body captures Agent return value",
        outgoing_ok,
        0,
        f"researcher_len={len(outgoing_bodies.get('Researcher') or '')} "
        f"writer_len={len(outgoing_bodies.get('Writer') or '')}",
    )
    if not outgoing_ok:
        raise AssertionError(
            f"outgoing_message empty for at least one role; bodies={outgoing_bodies!r}",
        )

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
