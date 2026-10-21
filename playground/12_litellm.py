"""litellm -- multi-provider chat (Anthropic + OpenAI routes), sync and
async streaming, single-count through the OpenAI SDK, embeddings,
embeddings capture round-trip, and invalid-model error classification.

litellm.completion routes to many underlying providers through a single
entry point. The Anthropic route uses raw httpx instead of the
Anthropic SDK -- the gap the litellm interceptor exists to close. After
``flightdeck_sensor.patch()`` the module-level ``litellm.completion``
is swapped with a wrapper that routes every call through the sensor's
pre/post-call plumbing (see ``interceptor/litellm.py``). The OpenAI
route is served through the OpenAI SDK, whose ``chat.completions`` the
sensor also patches: the litellm wrapper marks the call as in flight
and the SDK descriptor passes it through, so each litellm call lands
exactly once. Both routes covered here so an SDK-class-rename in either
provider can't escape the canary, and the post_call count is asserted
so a double count can't either.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.request
import uuid

try:
    import litellm
except ImportError:
    print("SKIP: pip install 'flightdeck-sensor[litellm]' (litellm>=1.83.0)")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    API_TOKEN,
    API_URL,
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_streamed_post_calls,
)

# Chat calls this script makes through litellm.completion / acompletion
# (two non-streaming, two streaming). Exactly this many post_calls must
# land: one more would be the OpenAI SDK descriptor reporting a
# litellm call a second time.
CHAT_CALLS = 4
# A duplicate post_call could land after the expected ones (the workers
# write in batches), so the count is read until it has not changed over
# this many consecutive polls -- a 1.5 s quiet window at the poll gap
# below, longer than any batch gap seen on the dev stack -- or until
# the deadline, which bounds the wait on a stack that keeps landing rows.
POST_CALL_SETTLE_POLLS = 3
POST_CALL_SETTLE_POLL_S = 0.5
POST_CALL_SETTLE_DEADLINE_S = 15.0


def settled_post_calls(session_id: str) -> tuple[list[dict], list[dict]]:
    """``(events, post_calls)`` once the post_call count has stopped
    changing, so a late duplicate cannot slip past the single-count
    assertion between two reads."""
    deadline = time.monotonic() + POST_CALL_SETTLE_DEADLINE_S
    events: list[dict] = []
    post_calls: list[dict] = []
    stable = 0
    last = -1
    while stable < POST_CALL_SETTLE_POLLS and time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id, expect_event_types=["post_call"], timeout_s=5.0,
        )
        post_calls = [e for e in events if e.get("event_type") == "post_call"]
        stable = stable + 1 if len(post_calls) == last else 0
        last = len(post_calls)
        time.sleep(POST_CALL_SETTLE_POLL_S)
    return events, post_calls


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-litellm")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:12_litellm] session_id={session_id}")

    # Anthropic route -- the raw-httpx bypass case.
    t0 = time.monotonic()
    litellm.completion(
        model="claude-haiku-4-5-20251001",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=5,
    )
    print_result(
        "litellm.completion (Anthropic route)",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    # OpenAI route -- different transport but same wrapper.
    t0 = time.monotonic()
    litellm.completion(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=5,
    )
    print_result(
        "litellm.completion (OpenAI route)",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    assert_event_landed(
        session_id,
        "post_call",
        timeout=8,
        model_contains="claude-haiku-4-5",
    )
    assert_event_landed(
        session_id,
        "post_call",
        timeout=8,
        model_contains="gpt-4o-mini",
    )

    # Sync streaming on the Anthropic route (litellm's raw-httpx path).
    # The caller does not ask for usage, so the loop sees content chunks
    # only; the sensor meters the usage chunk litellm appends.
    t0 = time.monotonic()
    sync_chunks = 0
    sync_text = ""
    for chunk in litellm.completion(
        model="claude-haiku-4-5-20251001",
        messages=[{"role": "user", "content": "Count from one to five."}],
        max_tokens=30,
        stream=True,
    ):
        sync_chunks += 1
        sync_text += (chunk.choices[0].delta.content or "") if chunk.choices else ""
    print_result(
        "litellm.completion(stream=True) (Anthropic route)",
        sync_chunks > 0 and bool(sync_text),
        int((time.monotonic() - t0) * 1000),
        f"{sync_chunks} chunks",
    )
    if not sync_chunks or not sync_text:
        raise AssertionError("sync litellm stream delivered no content")

    # Async streaming on the OpenAI route, served through the OpenAI SDK.
    async def _astream() -> tuple[int, str]:
        stream = await litellm.acompletion(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Count from one to five."}],
            max_tokens=30,
            stream=True,
        )
        n = 0
        text = ""
        async for chunk in stream:
            n += 1
            text += (chunk.choices[0].delta.content or "") if chunk.choices else ""
        return n, text

    t0 = time.monotonic()
    async_chunks, async_text = asyncio.run(_astream())
    print_result(
        "litellm.acompletion(stream=True) (OpenAI route)",
        async_chunks > 0 and bool(async_text),
        int((time.monotonic() - t0) * 1000),
        f"{async_chunks} chunks",
    )
    if not async_chunks or not async_text:
        raise AssertionError("async litellm stream delivered no content")

    events, streamed = wait_for_streamed_post_calls(session_id, expected=2)
    if len(streamed) < 2:
        raise AssertionError(
            f"expected 2 streamed post_calls, saw {len(streamed)}; events={events!r}"
        )
    for e in streamed:
        streaming = e["payload"]["streaming"]
        if streaming.get("final_outcome") != "completed":
            raise AssertionError(f"streamed post_call not completed: {e!r}")
        if not ((e.get("tokens_input") or 0) > 0 and (e.get("tokens_output") or 0) > 0):
            raise AssertionError(f"streamed post_call without in-stream usage: {e!r}")
    print_result(
        "streamed post_calls carry in-stream usage", True, 0,
        ", ".join(
            f"{e.get('model')}: {e.get('tokens_input')}in/{e.get('tokens_output')}out "
            f"ttft={e['payload']['streaming'].get('ttft_ms')}ms"
            for e in streamed
        ),
    )

    # Single count. Two of the four chat calls went through the OpenAI
    # SDK the sensor also patches; the outer-call mark keeps each
    # litellm call to one post_call. The count is read until it settles
    # so a late duplicate cannot evade the assertion.
    events, post_calls = settled_post_calls(session_id)
    print_result(
        "litellm calls served by the OpenAI SDK are counted once",
        len(post_calls) == CHAT_CALLS,
        0,
        f"{len(post_calls)} post_calls for {CHAT_CALLS} chat calls",
    )
    if len(post_calls) != CHAT_CALLS:
        raise AssertionError(
            f"expected {CHAT_CALLS} post_calls, saw {len(post_calls)}: "
            f"{[(e.get('model'), (e.get('payload') or {}).get('streaming')) for e in post_calls]!r}"
        )
    without_usage = [
        e for e in post_calls
        if not ((e.get("tokens_input") or 0) > 0 and (e.get("tokens_output") or 0) > 0)
    ]
    print_result("every post_call carries provider usage", not without_usage, 0)
    if without_usage:
        raise AssertionError(f"post_calls without usage: {without_usage!r}")

    # Embeddings via litellm. text-embedding-3-small routes to OpenAI;
    # capture_prompts=True (helper default) means has_content=True and
    # the input round-trips via /v1/events/:id/content.
    payload = "playground litellm embeddings capture"
    t0 = time.monotonic()
    litellm.embedding(
        model="text-embedding-3-small",
        input=payload,
    )
    print_result(
        "litellm.embedding", True,
        int((time.monotonic() - t0) * 1000),
    )

    events = fetch_events_for_session(
        session_id, expect_event_types=["embeddings"], timeout_s=8.0,
    )
    embeds = [e for e in events if e.get("event_type") == "embeddings"]
    if not embeds:
        raise AssertionError(f"no embeddings event observed; events={events!r}")
    embed = embeds[-1]
    print_result("litellm embeddings event emitted", True, 0)

    if not embed.get("has_content"):
        raise AssertionError(f"embeddings event missing has_content: {embed!r}")
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{embed['id']}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        body = json.loads(r.read())
    captured_input = body.get("input")
    print_result(
        "litellm embeddings capture round-trip", captured_input is not None, 0,
        f"captured input shape: {type(captured_input).__name__}",
    )

    # Invalid-model path -- litellm raises BadRequestError /
    # NotFoundError depending on routing; the sensor must classify it
    # as something other than "other".
    raised = False
    try:
        litellm.completion(
            model="not-a-real-model",
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
    except Exception:
        raised = True
    print_result("litellm invalid-model raises", raised, 0)
    if not raised:
        raise AssertionError("invalid-model call did not raise")

    events = fetch_events_for_session(
        session_id, expect_event_types=["llm_error"], timeout_s=8.0,
    )
    errors = [e for e in events if e.get("event_type") == "llm_error"]
    if not errors:
        raise AssertionError(f"no llm_error observed; events={events!r}")
    print_result("litellm llm_error emitted", True, 0,
                 f"error_type={(errors[-1].get('payload') or {}).get('error', {}).get('error_type')!r}")

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
