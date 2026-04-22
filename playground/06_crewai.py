"""CrewAI native providers -- both Anthropic and OpenAI are intercepted.

CrewAI 1.14.1's LLM factory routes `anthropic/` and `openai/` model
prefixes to native provider classes that construct
`anthropic.Anthropic()` and `openai.OpenAI()` directly.
`flightdeck_sensor.patch()` hooks those SDK classes, so CrewAI calls
land on the same interception path as direct SDK usage. Both blocks
below prove this end-to-end.
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


def _run(label: str, provider: str, model: str, contains: str) -> None:
    # Fresh session_id per block -- assertion queries filter by
    # session_id, so distinct ids keep the two blocks independent.
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-crewai")
    flightdeck_sensor.patch(providers=[provider], quiet=True)
    print(f"[playground:06_crewai] {label} session_id={session_id}")
    t0 = time.monotonic()
    LLM(model=model).call("hi")
    print_result(f"crewai.LLM.call ({label})", True, int((time.monotonic() - t0) * 1000))
    assert_event_landed(session_id, "post_call", timeout=8, model_contains=contains)
    flightdeck_sensor.teardown()


def main() -> None:
    _run("anthropic", "anthropic", "anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5")
    _run("openai", "openai", "openai/gpt-4o-mini", "gpt-4o-mini")


if __name__ == "__main__":
    main()
