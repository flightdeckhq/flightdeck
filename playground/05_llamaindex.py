"""LlamaIndex -- Anthropic.complete + OpenAI.complete.

LlamaIndex's `llama-index-llms-*` packages construct Anthropic() /
OpenAI() clients internally. Class-level patching in the sensor means
`.complete(...)` emits post_call events without any LlamaIndex-side
wiring.
"""
from __future__ import annotations

import sys
import time
import uuid

try:
    from llama_index.llms.anthropic import Anthropic as LlamaAnthropic
    from llama_index.llms.openai import OpenAI as LlamaOpenAI
except ImportError:
    print("SKIP: pip install llama-index-llms-anthropic llama-index-llms-openai")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id)
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:05_llamaindex] session_id={session_id}")

    t0 = time.monotonic()
    LlamaAnthropic(model="claude-haiku-4-5-20251001", max_tokens=5).complete("hi")
    print_result("LlamaAnthropic.complete", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    LlamaOpenAI(model="gpt-4o-mini", max_tokens=5).complete("hi")
    print_result("LlamaOpenAI.complete", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
