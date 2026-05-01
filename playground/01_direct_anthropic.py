"""Direct Anthropic SDK -- sync, async, streaming (sync + async), beta.messages,
plus an invalid-model error-classification demo.

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
from flightdeck_sensor import Provider
from _helpers import (
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    print_result,
)

MODEL = "claude-haiku-4-5-20251001"
HI = [{"role": "user", "content": "hi"}]


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-direct-anthropic")
    flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
    print(f"[playground:01_direct_anthropic] session_id={session_id}")

    t0 = time.monotonic()
    r = anthropic.Anthropic().messages.create(model=MODEL, max_tokens=5, messages=HI)
    print_result("Anthropic().messages.create", True, int((time.monotonic() - t0) * 1000),
                 f"{r.usage.output_tokens} output tokens")

    async def _async_call() -> None:
        await anthropic.AsyncAnthropic().messages.create(model=MODEL, max_tokens=5, messages=HI)
    t0 = time.monotonic()
    asyncio.run(_async_call())
    print_result("AsyncAnthropic().messages.create", True, int((time.monotonic() - t0) * 1000))

    # Sync streaming: iterate chunks so GuardedStream's __next__ records
    # chunk timestamps for the streaming sub-object on post_call.
    t0 = time.monotonic()
    with anthropic.Anthropic().messages.stream(model=MODEL, max_tokens=5, messages=HI) as s:
        for _ in s:
            pass
    print_result("Anthropic().messages.stream", True, int((time.monotonic() - t0) * 1000))

    # Async streaming: must actually exercise the async iteration path
    # so GuardedAsyncStream's __anext__ fires per chunk and the
    # post_call event carries a populated streaming.ttft_ms field.
    async def _async_stream() -> None:
        client = anthropic.AsyncAnthropic()
        async with client.messages.stream(
            model=MODEL, max_tokens=8, messages=HI,
        ) as stream:
            async for _ in stream:
                pass
    t0 = time.monotonic()
    asyncio.run(_async_stream())
    print_result("AsyncAnthropic().messages.stream", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    anthropic.Anthropic().beta.messages.create(
        model=MODEL, max_tokens=5, messages=HI, betas=["prompt-caching-2024-07-31"])
    print_result("Anthropic().beta.messages.create", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)

    # Verify the async-streaming TTFT actually landed (regression guard
    # — earlier playground iterations didn't exercise the async path
    # at all, so the post_call event for an async stream never carried
    # streaming.ttft_ms). Look at all post_call events with a streaming
    # sub-object; require at least one populated ttft_ms.
    events = fetch_events_for_session(
        session_id, expect_event_types=["post_call"], timeout_s=8.0,
    )
    streamed = [
        e for e in events
        if e.get("event_type") == "post_call"
        and (e.get("payload") or {}).get("streaming")
    ]
    ttft_ok = any(
        (e["payload"]["streaming"].get("ttft_ms") is not None)
        for e in streamed
    )
    print_result(
        "streaming.ttft_ms populated on post_call", ttft_ok, 0,
        f"{len(streamed)} streamed post_call events observed",
    )
    if not ttft_ok:
        raise AssertionError(
            f"no post_call carried streaming.ttft_ms; events={events!r}",
        )

    # Invalid-model llm_error: the sensor's classifier must categorize
    # this as something other than "other" (the catch-all fallback).
    # Anthropic returns 404 for unknown models which classifies as
    # not_found or invalid_request; both are acceptable, "other" is not.
    error_seen = False
    try:
        anthropic.Anthropic().messages.create(
            model="this-model-does-not-exist", max_tokens=5, messages=HI,
        )
    except Exception:
        error_seen = True
    print_result("invalid model raises", error_seen, 0)
    if not error_seen:
        raise AssertionError("invalid-model call did not raise")

    events = fetch_events_for_session(
        session_id, expect_event_types=["llm_error"], timeout_s=8.0,
    )
    errors = [e for e in events if e.get("event_type") == "llm_error"]
    if not errors:
        raise AssertionError(f"no llm_error observed; events={events!r}")
    err = (errors[-1].get("payload") or {}).get("error") or {}
    classified = err.get("error_type") != "other"
    print_result(
        "invalid-model llm_error classified", classified, 0,
        f"error_type={err.get('error_type')!r}",
    )
    if not classified:
        raise AssertionError(
            f"invalid-model llm_error fell through to 'other': {err!r}",
        )

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
