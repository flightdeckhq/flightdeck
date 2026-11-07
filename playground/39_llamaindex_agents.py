"""LlamaIndex agent workflows as child sessions, on real OpenAI calls.

The sensor's LlamaIndex wrap (``patch()``, ``Provider.LLAMA_INDEX``)
reports each agent of an agent workflow run as a child session of the
sensor's session; the agents' model calls and tool calls stay on the
sensor's session, as for the CrewAI and LangGraph wraps. This script
runs three real runs on ``gpt-4o-mini`` (streaming, the agents'
default) under one sensor session:

1. a single ``FunctionAgent`` (``solo_calculator``) with a ``multiply``
   tool;
2. a multi-agent ``AgentWorkflow``: ``calculator`` multiplies and hands
   off to ``writer``, which states the answer;
3. a ``ReActAgent`` (``react_calculator``), whose tool call the model
   writes as text.

It asserts, through the query API:

* one child per agent, parented on the sensor's session, closed, with
  the agent's name as ``agent_role``, carrying only its start and end
  (and, on ``calculator``, the hand-off signal) and no tokens;
* the hand-off: an ``agent_handoff`` signal on ``calculator`` naming
  ``writer``, and ``writer``'s ``incoming_message``;
* every model call on the sensor's session, their tokens equal to its
  row's ``tokens_used``;
* exactly one ``multiply`` ``tool_call`` per run, all on the sensor's
  session: from the model's response for the two FunctionAgent runs,
  from the wrap for the ReActAgent (the only one with a captured tool
  output);
* stored content (200 from ``GET /v1/events/:id/content``) for a model
  call.

Requires OPENAI_API_KEY and llama-index-core 0.14+ with
llama-index-llms-openai. Prints the session ids, so the run can be found
on the dashboard and deleted by id.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
    wait_for_dev_stack,
)

FLAVOR = "playground-llamaindex-agents"
MODEL = "gpt-4o-mini"
# Small answers keep the run cheap; the agents only multiply and say it.
MAX_TOKENS = 200
# Time for every child's events to land: the sensor drains asynchronously
# and the worker writes within seconds on an idle stack.
EVENTS_LANDED_S = 25.0
POLL_S = 0.5
HTTP_TIMEOUT_S = 5.0
CONTENT_PRESENT_STATUS = 200
# The runs below, and the fewest model calls they make: two per
# FunctionAgent or ReActAgent turn that calls a tool (the call that
# asks for it, the call that answers), the calculator's two and the
# writer's one in the workflow.
RUNS = 3
MIN_MODEL_CALLS = 7
# How much of the fetched events a failure message quotes.
FAILURE_DUMP_CHARS = 2000
MS_PER_S = 1000
SCRIPT = "[playground:39_llamaindex_agents]"


def multiply(a: int, b: int) -> int:
    """Multiply two integers and return the product."""
    return a * b


def _get(path: str) -> Any:
    req = urllib.request.Request(
        f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
        return json.loads(r.read())


def _content_status(event_id: str) -> int:
    try:
        req = urllib.request.Request(
            f"{API_URL}/v1/events/{event_id}/content",
            headers={"Authorization": f"Bearer {API_TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            return int(r.status)
    except urllib.error.HTTPError as err:
        return int(err.code)


def _children(root_id: str, want_roles: set[str]) -> dict[str, dict[str, Any]]:
    """The closed child sessions of ``root_id`` by role, once every role in
    ``want_roles`` has one."""
    deadline = time.monotonic() + EVENTS_LANDED_S
    by_role: dict[str, dict[str, Any]] = {}
    while time.monotonic() < deadline:
        try:
            sessions = _get(f"/v1/sessions?parent_session_id={root_id}&limit=50")["sessions"]
        except Exception:
            sessions = []
        by_role = {s["agent_role"]: s for s in sessions}
        closed = {r for r, s in by_role.items() if s.get("state") == "closed"}
        if want_roles <= closed:
            return by_role
        time.sleep(POLL_S)
    raise AssertionError(f"children {sorted(want_roles)} not all closed: {by_role}")


def _events(session_id: str, expect: list[str]) -> list[dict[str, Any]]:
    return fetch_events_for_session(
        session_id, timeout_s=EVENTS_LANDED_S, expect_event_types=expect
    )


def _of(events: list[dict[str, Any]], event_type: str) -> list[dict[str, Any]]:
    return [e for e in events if e.get("event_type") == event_type]


def _check(label: str, ok: bool, t0: float, details: str, dump: Any = None) -> None:
    print_result(label, ok, int((time.monotonic() - t0) * MS_PER_S), details)
    if not ok:
        raise AssertionError(f"{label}: {details} {json.dumps(dump)[:FAILURE_DUMP_CHARS]}")


def _check_structure_only(
    label: str, child: dict[str, Any], root_id: str, want: set[str], t0: float
) -> list[dict[str, Any]]:
    """A child carries the run's structure: its start, its end and, on an
    agent handing off, the hand-off signal; no calls, no tokens."""
    events = _events(child["session_id"], ["session_start", "session_end"])
    types = {e.get("event_type") for e in events}
    ok = (
        child.get("parent_session_id") == root_id
        and types == want
        and int(child.get("tokens_used") or 0) == 0
    )
    _check(
        label,
        ok,
        t0,
        f"session={child['session_id']} events={sorted(t for t in types if t)}"
        f" tokens={child.get('tokens_used')}",
        events,
    )
    return events


def _tool_output(event_id: str) -> Any:
    """The stored ``tool_output`` of a tool call's content."""
    return _get(f"/v1/events/{event_id}/content").get("tool_output")


async def _runs() -> None:
    from llama_index.core.agent.workflow import AgentWorkflow, FunctionAgent, ReActAgent
    from llama_index.llms.openai import OpenAI

    llm = OpenAI(model=MODEL, max_tokens=MAX_TOKENS)
    solo = FunctionAgent(
        name="solo_calculator",
        system_prompt="Always use the multiply tool to multiply numbers.",
        tools=[multiply],
        llm=llm,
    )
    print(f"{SCRIPT} solo: {await solo.run(user_msg='What is 6 times 7?')}")

    calculator = FunctionAgent(
        name="calculator",
        description="Multiplies numbers with the multiply tool.",
        system_prompt=(
            "Use the multiply tool to compute the product, then always hand off to "
            "the writer agent with the product in the reason. Never answer yourself."
        ),
        tools=[multiply],
        llm=llm,
        can_handoff_to=["writer"],
    )
    writer = FunctionAgent(
        name="writer",
        description="States the final answer in one sentence.",
        system_prompt="State the product you were handed in one short sentence.",
        llm=llm,
    )
    flow = AgentWorkflow(agents=[calculator, writer], root_agent="calculator")
    print(f"{SCRIPT} workflow: {await flow.run(user_msg='What is 12 times 9?')}")

    react = ReActAgent(name="react_calculator", tools=[multiply], llm=llm)
    print(f"{SCRIPT} react: {await react.run(user_msg='What is 8 times 5? Use the tool.')}")


def main() -> None:
    require_env("OPENAI_API_KEY")
    try:
        import llama_index.core.agent.workflow  # noqa: F401
        import llama_index.llms.openai  # noqa: F401
    except ImportError:
        print("SKIP: pip install 'llama-index-core>=0.14' llama-index-llms-openai")
        sys.exit(2)

    import flightdeck_sensor
    from flightdeck_sensor import Provider

    wait_for_dev_stack()
    root_id = str(uuid.uuid4())
    print(f"{SCRIPT} root session_id={root_id}")
    init_sensor(root_id, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.OPENAI, Provider.LLAMA_INDEX], quiet=True)
    t0 = time.monotonic()
    asyncio.run(_runs())
    flightdeck_sensor.teardown()
    print_result(
        "three LlamaIndex runs on gpt-4o-mini", True, int((time.monotonic() - t0) * MS_PER_S)
    )

    roles = {"solo_calculator", "calculator", "writer", "react_calculator"}
    children = _children(root_id, roles)
    for role, child in sorted(children.items()):
        print(f"{SCRIPT} child {role} session_id={child['session_id']}")
    _check(
        "one closed child per agent, role from the agent's name",
        set(children) == roles,
        t0,
        f"roles={sorted(children)}",
        children,
    )

    structure = {"session_start", "session_end"}
    _check_structure_only(
        "solo FunctionAgent child: structure only",
        children["solo_calculator"],
        root_id,
        structure,
        t0,
    )
    calc_events = _check_structure_only(
        "workflow calculator child: structure and the hand-off",
        children["calculator"],
        root_id,
        structure | {"session_signal"},
        t0,
    )
    writer_events = _check_structure_only(
        "workflow writer child: structure only", children["writer"], root_id, structure, t0
    )
    _check_structure_only(
        "ReActAgent child: structure only", children["react_calculator"], root_id, structure, t0
    )

    signal_data = [
        (s.get("payload") or {}).get("signal_data") for s in _of(calc_events, "session_signal")
    ]
    _check(
        "hand-off signal on the agent handing off",
        signal_data == [{"from": "calculator", "to": "writer"}],
        t0,
        f"signal_data={signal_data}",
        calc_events,
    )
    writer_start = _of(writer_events, "session_start")[0]
    incoming = ((writer_start.get("payload") or {}).get("incoming_message") or {}).get("body")
    _check(
        "the hand-off's reason is the writer's incoming message",
        isinstance(incoming, str) and bool(incoming),
        t0,
        f"incoming={incoming!r}",
    )

    # Every model call and tool call is on the sensor's session.
    root_events = _events(root_id, ["session_start", "post_call", "tool_call", "session_end"])
    calls = _of(root_events, "post_call")
    tokens = sum(int(c.get("tokens_total") or 0) for c in calls)
    root_row = _get(f"/v1/sessions/{root_id}")["session"]
    _check(
        "every model call on the sensor's session, counted on its row",
        len(calls) >= MIN_MODEL_CALLS and tokens == root_row.get("tokens_used"),
        t0,
        f"post_calls={len(calls)} tokens={tokens}/{root_row.get('tokens_used')}",
        root_events,
    )
    multiplies = [t for t in _of(root_events, "tool_call") if t.get("tool_name") == "multiply"]
    outputs = [_tool_output(t["id"]) for t in multiplies]
    from_wrap = [o for o in outputs if o is not None]
    _check(
        "one multiply tool_call per run: two from responses, the ReAct one from the wrap",
        len(multiplies) == RUNS and len(from_wrap) == 1,
        t0,
        f"multiply_tool_calls={len(multiplies)} with_output={from_wrap}",
        multiplies,
    )
    status = _content_status(calls[-1]["id"])
    _check(
        "a model call has its content stored",
        status == CONTENT_PRESENT_STATUS,
        t0,
        f"event={calls[-1]['id']} content={status}",
    )


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
