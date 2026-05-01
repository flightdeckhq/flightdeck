"""Direct Anthropic SDK -- sync, async, streaming, beta.messages.

A developer using the raw `anthropic` package copies this file, drops
in their own prompts, and has Flightdeck telemetry on every call. The
sensor's patch() replaces the class-level `messages` descriptor so
every Anthropic() instance emits pre/post events.
"""
from __future__ import annotations

import asyncio
import sys
import time
import uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result

MODEL = "claude-haiku-4-5-20251001"
HI = [{"role": "user", "content": "hi"}]


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-direct-anthropic")
    flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
    print(f"[playground:01_direct_anthropic] session_id={session_id}")

    t0 = time.monotonic()
    r = anthropic.Anthropic().messages.create(model=MODEL, max_tokens=5, messages=HI)
    print_result("Anthropic().messages.create", True, int((time.monotonic() - t0) * 1000),
                 f"{r.usage.output_tokens} output tokens")

    async def _call() -> None:
        await anthropic.AsyncAnthropic().messages.create(model=MODEL, max_tokens=5, messages=HI)
    t0 = time.monotonic()
    asyncio.run(_call())
    print_result("AsyncAnthropic().messages.create", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    # Iterate the stream rather than calling ``s.get_final_text()`` --
    # that helper consumes the underlying SDK stream directly, bypassing
    # GuardedStream's __next__ where chunk timestamps + counts are
    # captured. Iteration matches what tests/smoke/test_smoke_anthropic.py
    # does and produces complete TTFT / streaming metrics.
    with anthropic.Anthropic().messages.stream(model=MODEL, max_tokens=5, messages=HI) as s:
        for _ in s:
            pass
    print_result("Anthropic().messages.stream", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    anthropic.Anthropic().beta.messages.create(
        model=MODEL, max_tokens=5, messages=HI, betas=["prompt-caching-2024-07-31"])
    print_result("Anthropic().beta.messages.create", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
