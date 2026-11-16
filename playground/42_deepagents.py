"""Deep Agents: one child session per ``task`` sub-agent run.

Drives a real Deep Agent on ``claude-haiku-4-5`` through the sensor's
LangGraph wrap (Deep Agents is built on LangGraph; the sensor imports no
Deep Agents module), two runs, each under its own sensor session:

1. **Sync** (``invoke``): the main agent delegates the question to its
   one custom sub-agent, ``researcher``, through the ``task`` tool; the
   researcher calls its ``lookup_capital`` tool and answers. One closed
   child session lands, ``agent_role`` ``researcher``, parented on the
   sensor's session, carrying only its start and end, with the task
   description in its incoming message and its answer in its outgoing
   one. The model calls and the ``task`` tool call stay on the sensor's
   session.
2. **Async** (``astream``): the same delegation, streamed; the same one
   child. Both runs use one ``ChatAnthropic``, kept across
   ``teardown()``, so the second run's model calls must land on the
   second session.

Self-skips (exit 2) without ``ANTHROPIC_API_KEY`` or without
``deepagents`` / ``langchain-anthropic``.
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

FLAVOR = "playground-deepagents"
MODEL = "claude-haiku-4-5-20251001"
# Short answers keep the run cheap; a tool call needs a few tokens.
MAX_TOKENS = 300
SUB_AGENT = "researcher"
# The capital the sub-agent's tool knows, for the one country it is asked
# about; every answer of the run must name it.
COUNTRY = "france"
CAPITAL = "Paris"
QUESTION = (
    "What is the capital of France? Delegate this to the researcher sub-agent"
    " with the task tool, then reply with its answer in one sentence."
)
# How long to wait for the worker to write the child sessions: the
# sensor posts them as the run goes, the worker writes them in batches.
CHILDREN_DEADLINE_S = 25.0
CHILDREN_POLL_S = 0.4
# One sessions request never blocks longer than this, so the deadline
# above stays the only bound on the wait; a healthy API answers in ms.
SESSIONS_FETCH_TIMEOUT_S = 5.0
# A page of child sessions: a run here opens one; a page this size shows
# any extra one instead of hiding it.
SESSIONS_PAGE_LIMIT = 50


def _children(parent_id: str, want: int) -> list[dict[str, Any]]:
    """The sessions whose parent is ``parent_id``, once ``want`` have
    landed (or what landed by the deadline)."""
    deadline = time.monotonic() + CHILDREN_DEADLINE_S
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        req = urllib.request.Request(
            f"{API_URL}/v1/sessions?parent_session_id={parent_id}&limit={SESSIONS_PAGE_LIMIT}",
            headers={"Authorization": f"Bearer {API_TOKEN}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=SESSIONS_FETCH_TIMEOUT_S) as r:
                rows = json.loads(r.read()).get("sessions", [])
        except (urllib.error.URLError, OSError, ValueError):
            # Not answering yet, or not JSON yet: poll again until the
            # deadline, which reports what did land.
            rows = []
        if len(rows) >= want:
            return rows
        time.sleep(CHILDREN_POLL_S)
    return rows


def _check(label: str, ok: bool, details: str = "") -> None:
    print_result(label, ok, 0, details)
    if not ok:
        raise AssertionError(f"{label}: {details}")


def _assert_one_researcher(root: str, label: str) -> None:
    """One closed researcher child under ``root``, start and end only,
    with its messages; the model calls and the task call on ``root``."""
    children = _children(root, 1)
    roles = [c.get("agent_role") for c in children]
    _check(
        f"{label}: one child session named after the sub-agent",
        roles == [SUB_AGENT],
        f"children of the sensor's session={roles}",
    )
    (child,) = children
    _check(
        f"{label}: the child's parent is the sensor's session",
        child.get("parent_session_id") == root,
        f"parent_session_id={child.get('parent_session_id')!r}",
    )
    events = fetch_events_for_session(
        child["session_id"], expect_event_types=["session_start", "session_end"]
    )
    kinds = sorted({e.get("event_type") for e in events})
    _check(
        f"{label}: the child carries its start and end only",
        kinds == ["session_end", "session_start"],
        f"saw {kinds}",
    )
    start = next(e for e in events if e.get("event_type") == "session_start")
    end = next(e for e in events if e.get("event_type") == "session_end")
    end_payload = end.get("payload") or {}
    _check(
        f"{label}: the child closed without an error",
        "error" not in end_payload and end_payload.get("state") in (None, "closed"),
        f"payload state={end_payload.get('state')!r}",
    )
    incoming = (start.get("payload") or {}).get("incoming_message")
    outgoing = end_payload.get("outgoing_message")
    _check(
        f"{label}: the child carries the sub-agent's input and its answer",
        bool(incoming) and bool(outgoing) and CAPITAL in json.dumps(outgoing),
        f"incoming={'yes' if incoming else 'no'} outgoing={json.dumps(outgoing)[:200]}",
    )

    root_events = fetch_events_for_session(root, expect_event_types=["post_call", "tool_call"])
    posts = [e for e in root_events if e.get("event_type") == "post_call"]
    tools = [e.get("tool_name") for e in root_events if e.get("event_type") == "tool_call"]
    _check(
        f"{label}: the model calls and the task call are on the sensor's session",
        len(posts) >= 3 and "task" in tools,
        f"post_calls={len(posts)} tool_calls={tools}",
    )


def main() -> None:
    require_env("ANTHROPIC_API_KEY")
    try:
        from deepagents import create_deep_agent
        from langchain_anthropic import ChatAnthropic
        from langchain_core.tools import tool
    except ImportError:
        print("SKIP: pip install deepagents langchain-anthropic")
        sys.exit(2)

    import flightdeck_sensor
    from flightdeck_sensor import Provider

    wait_for_dev_stack()

    @tool
    def lookup_capital(country: str) -> str:
        """Look up the capital city of a country."""
        return {COUNTRY: CAPITAL}.get(country.strip().lower(), "unknown")

    # One model for both runs, kept across teardown(): each run's calls
    # report to the session active when it makes them.
    model = ChatAnthropic(model=MODEL, max_tokens=MAX_TOKENS)

    def agent() -> Any:
        return create_deep_agent(
            model=model,
            tools=[],
            system_prompt=(
                "You never answer from your own knowledge. You delegate every"
                f" question to the {SUB_AGENT} sub-agent with the task tool"
                f" (subagent_type {SUB_AGENT!r}), once, and reply with its answer."
            ),
            subagents=[
                {
                    "name": SUB_AGENT,
                    "description": "Looks up the capital city of a country.",
                    "system_prompt": (
                        "Call lookup_capital once with the country, then answer in one sentence."
                    ),
                    "tools": [lookup_capital],
                }
            ],
        )

    request = {"messages": [{"role": "user", "content": QUESTION}]}

    # ---- 1: invoke ------------------------------------------------------
    root = str(uuid.uuid4())
    init_sensor(root, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.LANGGRAPH, Provider.ANTHROPIC], quiet=True)
    print(f"[playground:42_deepagents] invoke session_id={root}")
    t0 = time.monotonic()
    result = agent().invoke(request)
    print_result("Deep Agent run (invoke)", True, int((time.monotonic() - t0) * 1000))
    answer = str(result["messages"][-1].content)
    _check(f"the run answered {CAPITAL}", CAPITAL in answer, f"answer={answer!r}")
    flightdeck_sensor.teardown()
    _assert_one_researcher(root, "invoke")

    # ---- 2: astream -----------------------------------------------------
    async_root = str(uuid.uuid4())
    init_sensor(async_root, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.LANGGRAPH, Provider.ANTHROPIC], quiet=True)
    print(f"[playground:42_deepagents] astream session_id={async_root}")

    async def streamed() -> dict[str, Any]:
        last: dict[str, Any] = {}
        async for state in agent().astream(request, stream_mode="values"):
            last = state
        return last

    t0 = time.monotonic()
    final = asyncio.run(streamed())
    print_result("Deep Agent run (astream)", True, int((time.monotonic() - t0) * 1000))
    streamed_answer = str(final["messages"][-1].content)
    _check(f"the streamed run answered {CAPITAL}", CAPITAL in streamed_answer, streamed_answer)
    flightdeck_sensor.teardown()
    _assert_one_researcher(async_root, "astream")


if __name__ == "__main__":
    main()
