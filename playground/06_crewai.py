"""CrewAI -- LLM(...).call() via the OpenAI-backed path.

CrewAI's `LLM` class fronts a provider SDK. The `openai/<model>` prefix
tells it to use the openai package, which `flightdeck_sensor.patch()`
intercepts at the class level. The Anthropic route goes through
litellm which does not re-use the raw `anthropic.Anthropic()` client
and therefore is NOT currently intercepted -- use the OpenAI path
here, or drive Anthropic through LangChain / LlamaIndex.
"""
from __future__ import annotations

import sys
import time
import uuid

try:
    from crewai import LLM
except ImportError:
    print("SKIP: pip install crewai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id)
    flightdeck_sensor.patch(providers=["openai"], quiet=True)
    print(f"[playground:06_crewai] session_id={session_id}")

    t0 = time.monotonic()
    LLM(model="openai/gpt-4o-mini").call("hi")
    print_result("crewai.LLM.call", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
