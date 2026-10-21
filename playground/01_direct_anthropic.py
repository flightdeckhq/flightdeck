"""Direct Anthropic SDK -- sync, async, streaming (sync + async), beta.messages,
plus an invalid-model error-classification demo.

A developer using the raw `anthropic` package copies this file, drops
in their own prompts, and has Flightdeck telemetry on every call. The
sensor's patch() replaces `create` / `stream` / `parse` on the SDK's
Messages resource classes so every Anthropic() instance emits pre/post
events.
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
    wait_for_streamed_post_calls,
)

MODEL = "claude-haiku-4-5-20251001"
# Streamed calls this script makes: sync stream helper, async stream helper,
# async helper read via text_stream, async helper settled via
# get_final_message, raw create(stream=True); each must land one metered
# post_call.
EXPECTED_STREAMED_CALLS = 5
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

    # Each async section closes its client with ``async with`` while its
    # event loop is alive: the SDK's httpx wrapper otherwise schedules its
    # own close from a destructor, which lands on whatever loop is running
    # when the client is collected and prints "Event loop is closed".
    async def _async_call() -> None:
        async with anthropic.AsyncAnthropic() as client:
            await client.messages.create(model=MODEL, max_tokens=5, messages=HI)
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
        async with anthropic.AsyncAnthropic() as client, client.messages.stream(
            model=MODEL, max_tokens=8, messages=HI,
        ) as stream:
            async for _ in stream:
                pass
    t0 = time.monotonic()
    asyncio.run(_async_stream())
    print_result("AsyncAnthropic().messages.stream", True, int((time.monotonic() - t0) * 1000))

    # Async helper consumed through text_stream only: the guard re-implements
    # text_stream on itself, so these reads are metered like event iteration.
    async def _async_text_stream() -> None:
        async with anthropic.AsyncAnthropic() as client, client.messages.stream(
            model=MODEL, max_tokens=8, messages=HI,
        ) as stream:
            async for _ in stream.text_stream:
                pass
    t0 = time.monotonic()
    asyncio.run(_async_text_stream())
    print_result("AsyncAnthropic().messages.stream via text_stream", True,
                 int((time.monotonic() - t0) * 1000))

    # Async helper settled only through get_final_message(), no iteration.
    async def _async_final_message() -> int:
        async with anthropic.AsyncAnthropic() as client, client.messages.stream(
            model=MODEL, max_tokens=8, messages=HI,
        ) as stream:
            message = await stream.get_final_message()
        return message.usage.output_tokens
    t0 = time.monotonic()
    final_out = asyncio.run(_async_final_message())
    print_result("AsyncAnthropic().messages.stream via get_final_message", final_out > 0,
                 int((time.monotonic() - t0) * 1000), f"{final_out} output tokens")

    # Raw event stream, iterated with no ``with`` block: the SDK's own
    # documented pattern for messages.create(stream=True).
    t0 = time.monotonic()
    raw_events = 0
    for _ in anthropic.Anthropic().messages.create(
        model=MODEL, max_tokens=5, messages=HI, stream=True,
    ):
        raw_events += 1
    print_result(
        "Anthropic().messages.create(stream=True) plain iteration", raw_events > 0,
        int((time.monotonic() - t0) * 1000), f"{raw_events} events",
    )

    t0 = time.monotonic()
    anthropic.Anthropic().beta.messages.create(
        model=MODEL, max_tokens=5, messages=HI, betas=["prompt-caching-2024-07-31"])
    print_result("Anthropic().beta.messages.create", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)

    # Every streamed call, async ones included, must land a post_call
    # whose streaming sub-object carries ttft_ms. The later streams flush
    # asynchronously, so wait for all of them rather than the first.
    events, streamed = wait_for_streamed_post_calls(session_id, EXPECTED_STREAMED_CALLS)
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

    # Every streamed post_call must carry the token counts the provider
    # sent inside the stream, not the pre-call estimate with zero output.
    metered = [
        e for e in streamed
        if (e.get("tokens_output") or 0) > 0 and (e.get("tokens_input") or 0) > 0
    ]
    metered_ok = len(streamed) >= EXPECTED_STREAMED_CALLS and len(metered) == len(streamed)
    print_result(
        "streamed post_call events carry real token usage", metered_ok, 0,
        f"{len(metered)}/{len(streamed)} streamed post_calls metered "
        f"(expected at least {EXPECTED_STREAMED_CALLS})",
    )
    if not metered_ok:
        raise AssertionError(
            f"streamed post_call without real usage; events={events!r}",
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
