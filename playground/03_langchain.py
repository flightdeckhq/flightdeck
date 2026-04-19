"""LangChain -- ChatAnthropic + ChatOpenAI.

LangChain constructs Anthropic() / OpenAI() clients internally. Because
`flightdeck_sensor.patch()` mutates those classes at import time, every
LangChain `ChatAnthropic(...).invoke(...)` call emits pre/post events
with no framework-specific wiring.
"""
from __future__ import annotations

import sys
import time
import uuid

try:
    from langchain_anthropic import ChatAnthropic
    from langchain_openai import ChatOpenAI
except ImportError:
    print("SKIP: pip install langchain-anthropic langchain-openai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id)
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:03_langchain] session_id={session_id}")

    t0 = time.monotonic()
    ChatAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5).invoke("hi")
    print_result("ChatAnthropic.invoke", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    ChatOpenAI(model="gpt-4o-mini", max_tokens=5).invoke("hi")
    print_result("ChatOpenAI.invoke", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
