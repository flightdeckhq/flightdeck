"""LangGraph sub-agent observability — real graph with two agent-bearing nodes.

Drives a real two-node LangGraph (Researcher + Writer) through
``flightdeck_sensor``'s LangGraph sub-agent interceptor (D126).
The interceptor patches ``StateGraph.add_node`` so every registered
node body lands as its own child session, with role attribution
from the node name and inbound / outbound state capture (gated on
``capture_prompts``).

Two scale points are exercised:

1. **Inline path** — the Researcher node's incoming + outgoing
   state stays comfortably under the 8 KiB inline threshold. The
   bodies ride on ``payload.incoming_message`` /
   ``payload.outgoing_message`` directly (no event_content row
   created).
2. **Overflow path** — the Writer node's incoming state is padded
   past the 8 KiB threshold so the body routes through the D119
   ``event_content`` overflow path. ``has_content=true`` on the
   event payload + a stub ``content_bytes`` count on
   ``incoming_message`` signals the overflow; the full body is
   fetched separately via ``GET /v1/events/{id}/content``.

Self-skip on missing ``langgraph`` / ``langchain-anthropic`` /
``ANTHROPIC_API_KEY`` so the script runs cleanly when the
framework or key isn't available locally.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
import uuid

from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
    wait_for_dev_stack,
)


# Mirror of the threshold in sensor/flightdeck_sensor/core/session.py
# and observe_cli.mjs. Setting the ``Writer`` incoming state body
# above this drives the D119 event_content overflow path; staying
# under it keeps the body inline on payload.
_INLINE_THRESHOLD_BYTES = 8 * 1024


def main() -> None:
    require_env("ANTHROPIC_API_KEY")

    try:
        from langgraph.graph import END, START, StateGraph
        from langchain_anthropic import ChatAnthropic
        from typing_extensions import TypedDict
    except ImportError:
        print("SKIP: pip install langgraph langchain-anthropic")
        sys.exit(2)

    import flightdeck_sensor
    from flightdeck_sensor import Provider

    wait_for_dev_stack()

    parent_session_id = str(uuid.uuid4())
    init_sensor(
        parent_session_id,
        flavor="playground-subagents-langgraph",
        # Constrain the wrap to nodes whose names match the role
        # vocabulary we register below. Without this every internal
        # LangGraph helper node would also emit child sessions and
        # the assertions would have to allow-list noise. The regex
        # gate (D126 langgraph_agent_node_pattern) is the production
        # knob for the same case.
        langgraph_agent_node_pattern="^(Researcher|Writer)$",
    )
    flightdeck_sensor.patch(
        providers=[Provider.LANGGRAPH, Provider.ANTHROPIC],
        quiet=True,
    )
    print(
        f"[playground:17_subagents_langgraph] parent_session_id={parent_session_id}",
    )

    llm = ChatAnthropic(
        model="claude-haiku-4-5-20251001",
        max_tokens=80,
    )

    class State(TypedDict):
        topic: str
        research: str
        # Padding rides on the state so the Writer's incoming state
        # exceeds the 8 KiB inline threshold and routes through the
        # event_content overflow path. The padding is part of the
        # state dict the LangGraph interceptor sees on entry.
        padding: str
        article: str

    def researcher(state: State) -> State:
        # Real Anthropic call — proves the LLM patch survives the
        # sub-agent wrapper composition (the wrapper sits at the
        # node-action layer; the LLM call inside still flows through
        # the patched ChatAnthropic transport).
        result = llm.invoke(
            f"In one sentence under 25 words, describe {state['topic']}.",
        )
        text = (
            result.content if isinstance(result.content, str) else str(result.content)
        )
        return {
            "topic": state["topic"],
            "research": text,
            "padding": state["padding"],
            "article": state["article"],
        }

    def writer(state: State) -> State:
        result = llm.invoke(
            f"Rewrite this in 15 words or fewer: {state['research']}",
        )
        text = (
            result.content if isinstance(result.content, str) else str(result.content)
        )
        return {
            "topic": state["topic"],
            "research": state["research"],
            # Drop the padding from the Writer's outbound state so
            # the outgoing path stays inline — we want exactly one
            # overflow assertion and one inline assertion in the
            # demo, not both layers entangled.
            "padding": "",
            "article": text,
        }

    graph = StateGraph(State)
    graph.add_node("Researcher", researcher)
    graph.add_node("Writer", writer)
    graph.add_edge(START, "Researcher")
    graph.add_edge("Researcher", "Writer")
    graph.add_edge("Writer", END)

    # 12 KiB padding > 8 KiB threshold ⇒ Writer's incoming state
    # crosses the boundary because the same padding rides through
    # the Researcher → Writer edge. The Researcher's incoming state
    # also includes the padding, so BOTH children's incoming sides
    # land on the overflow path. We assert overflow on at least one.
    padding_body = "0123456789ABCDEF" * 768  # 12,288 bytes
    initial_state: State = {
        "topic": "how Flightdeck attributes sub-agent activity",
        "research": "",
        "padding": padding_body,
        "article": "",
    }

    t0 = time.monotonic()
    final_state = graph.compile().invoke(initial_state)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    print_result(
        "graph.compile().invoke (Researcher → Writer)",
        True,
        elapsed_ms,
    )
    if not final_state.get("article"):
        raise AssertionError(
            f"Writer node produced empty article; final_state={final_state!r}",
        )

    # Parent session post_call events — one per LLM invocation.
    parent_events = fetch_events_for_session(
        parent_session_id,
        expect_event_types=["post_call"],
        timeout_s=20.0,
    )
    parent_post_calls = [e for e in parent_events if e.get("event_type") == "post_call"]
    print_result(
        "parent session post_call events emitted",
        len(parent_post_calls) >= 1,
        0,
        f"count={len(parent_post_calls)}",
    )

    # Tally token cost for auditability — sum tokens_total across
    # post_call payloads. Falls back to the per-call tokens if the
    # aggregate field isn't present.
    tokens_total = 0
    for e in parent_post_calls:
        pl = e.get("payload") or {}
        t = pl.get("tokens_total") or 0
        try:
            tokens_total += int(t)
        except (TypeError, ValueError):
            pass
    if tokens_total:
        print(
            f"[playground:17_subagents_langgraph] cumulative LLM tokens="
            f"{tokens_total} (auditable cost)"
        )

    # Locate the children via the dedicated API filter (same as
    # 16_subagents_crewai). Polling the raw ``/v1/events`` feed and
    # grepping for parent_session_id ran into pagination-eviction on
    # busy dev stacks. The ``?parent_session_id=…`` filter returns
    # only the relevant rows.
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
        "child session_start emitted per agent-bearing node",
        starts_ok,
        0,
        f"count={len(child_starts)}",
    )
    print_result(
        "child session_end emitted per agent-bearing node",
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

    roles = sorted({(e.get("payload") or {}).get("agent_role") for e in child_starts})
    role_ok = "Researcher" in roles and "Writer" in roles
    print_result(
        "agent_role attribution covers both nodes",
        role_ok,
        0,
        f"saw {roles!r}",
    )
    if not role_ok:
        raise AssertionError(
            f"expected Researcher + Writer in child agent_roles; got {roles!r}",
        )

    # Distinct agent_id per role. The worker projects agent_id onto
    # the SESSION row, not the event payload — read off child_sessions
    # rather than re-deriving from event payload (see 16_subagents_crewai
    # for the same pattern).
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
    )
    if not distinct_ok:
        raise AssertionError(
            f"agent_ids should differ per role; got {agent_ids_by_role!r}",
        )

    # Overflow path assertion. The Writer's incoming state inherits
    # the Researcher's padding, so its body exceeds the 8 KiB
    # threshold ⇒ the LangGraph interceptor's
    # ``_route_subagent_message`` returns the overflow shape:
    # ``incoming_message`` carries a stub with
    # ``has_content=True + content_bytes=<size>``, and the event
    # itself has ``has_content=true``. Locate at least one child
    # session_start whose payload signals overflow.
    overflow_seen = False
    overflow_event_id: str | None = None
    overflow_size: int | None = None
    for e in child_starts:
        pl = e.get("payload") or {}
        msg = pl.get("incoming_message") or {}
        # The worker projects ``has_content`` from the payload onto the
        # event row's top-level field (D119 contract — the dashboard
        # uses it to decide whether to show the "Show full content"
        # affordance). Read both the event-level signal and the
        # incoming_message stub so a future projection change surfaces
        # in this assertion before it ships a regression.
        if msg.get("has_content") and e.get("has_content"):
            overflow_seen = True
            overflow_event_id = e.get("id")
            overflow_size = msg.get("content_bytes")
            break
    print_result(
        "incoming_message routes to D119 event_content on overflow",
        overflow_seen,
        0,
        f"size={overflow_size!r} event_id={overflow_event_id!r}",
    )
    if not overflow_seen:
        raise AssertionError(
            f"expected at least one child session_start with overflow "
            f"(incoming_message.has_content=true + payload.has_content=true); "
            f"none found across {len(child_starts)} child starts",
        )

    # Inline path assertion on the Writer's outgoing message — the
    # Writer drops the padding so its outbound state stays under the
    # 8 KiB threshold and the body lands inline on
    # ``payload.outgoing_message.body`` directly (no content row).
    writer_end = next(
        (
            e
            for e in child_ends
            if (e.get("payload") or {}).get("agent_role") == "Writer"
        ),
        None,
    )
    if writer_end is None:
        raise AssertionError(
            f"no Writer session_end among {len(child_ends)} child ends",
        )
    writer_outgoing = (writer_end.get("payload") or {}).get("outgoing_message") or {}
    inline_ok = (
        not writer_outgoing.get("has_content")
        and writer_outgoing.get("body") is not None
    )
    print_result(
        "Writer outgoing_message inline (under 8 KiB threshold)",
        inline_ok,
        0,
        f"body_type={type(writer_outgoing.get('body')).__name__}",
    )
    if not inline_ok:
        raise AssertionError(
            f"Writer outgoing_message expected inline body; got {writer_outgoing!r}",
        )

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
