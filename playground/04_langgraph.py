"""LangGraph -- minimal StateGraph routing through ChatAnthropic.

Proves the sensor's class-level patch survives LangGraph's dependency
chain: the graph compiles, runs, and the LLM node's call emits post_call
events just like a bare `ChatAnthropic().invoke()` would.
"""
from __future__ import annotations

import sys
import time
import uuid

try:
    from langgraph.graph import END, START, StateGraph
    from langchain_anthropic import ChatAnthropic
    from typing_extensions import TypedDict
except ImportError:
    print("SKIP: pip install langgraph langchain-anthropic")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


class State(TypedDict):
    text: str


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id)
    flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
    print(f"[playground:04_langgraph] session_id={session_id}")

    llm = ChatAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5)

    def call(state: State) -> State:
        llm.invoke(state["text"])
        return state

    graph = StateGraph(State)
    graph.add_node("call", call)
    graph.add_edge(START, "call")
    graph.add_edge("call", END)

    t0 = time.monotonic()
    graph.compile().invoke({"text": "hi"})
    print_result("StateGraph.compile().invoke", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
