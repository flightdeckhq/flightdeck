"""The OpenAI SDK at the sensor's floor: openai 1.26 to 1.77, whose
client builds ``chat`` and ``embeddings`` in its constructor instead of
through a ``cached_property``.

Runs a sync chat call, an async chat call, a sync and an async chat
stream, and an embeddings call (single and list input), plus a chat call
on a client built before ``patch()``, and asserts each lands one metered
event with real token counts and stored content. Runs from a venv with an
openai release in that range (playground/README.md, "OpenAI floor
venv"); on a newer SDK it exits SKIP, since 02_direct_openai.py covers
that layout.
"""

from __future__ import annotations

import asyncio
import sys
import time
import uuid

try:
    import openai
except ImportError:
    print("SKIP: pip install openai to run this example")
    sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import Provider

from _helpers import (
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
    wait_for_streamed_post_calls,
)

MODEL = "gpt-4o-mini"
EMBEDDING_MODEL = "text-embedding-3-small"
HI = [{"role": "user", "content": "hi"}]
# Chat calls this script makes: sync, async, the pre-patch client, and
# two streams; each must land one post_call with tokens.
EXPECTED_POST_CALLS = 5
EXPECTED_STREAMED_CALLS = 2
EXPECTED_EMBEDDINGS = 2


def main() -> None:
    require_env("OPENAI_API_KEY")
    if "chat" in openai.OpenAI.__dict__:
        print(
            f"SKIP: openai {openai.__version__} builds its resources lazily; "
            "run this from the OpenAI floor venv (openai 1.26 to 1.77)",
            file=sys.stderr,
        )
        sys.exit(2)

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-openai-floor")
    # Built (and its chat resource touched) before the patch: on this
    # layout the resource lives on the instance, and the patch reaches it.
    early_client = openai.OpenAI()
    _ = early_client.chat
    flightdeck_sensor.patch(providers=[Provider.OPENAI], quiet=True)
    print(
        f"[playground:36_openai_floor] openai={openai.__version__} session_id={session_id}"
    )

    t0 = time.monotonic()
    r = openai.OpenAI().chat.completions.create(model=MODEL, max_tokens=5, messages=HI)
    print_result(
        "OpenAI().chat.completions.create",
        True,
        int((time.monotonic() - t0) * 1000),
        f"{r.usage.total_tokens} tokens",
    )

    t0 = time.monotonic()
    early_client.chat.completions.create(model=MODEL, max_tokens=5, messages=HI)
    print_result(
        "client built before patch()", True, int((time.monotonic() - t0) * 1000)
    )

    async def _async_chat() -> None:
        async with openai.AsyncOpenAI() as client:
            await client.chat.completions.create(model=MODEL, max_tokens=5, messages=HI)

    t0 = time.monotonic()
    asyncio.run(_async_chat())
    print_result(
        "AsyncOpenAI().chat.completions.create",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    t0 = time.monotonic()
    chunks = sum(
        1
        for _ in openai.OpenAI().chat.completions.create(
            model=MODEL, max_tokens=5, messages=HI, stream=True
        )
    )
    print_result(
        "sync stream",
        chunks > 0,
        int((time.monotonic() - t0) * 1000),
        f"{chunks} chunks",
    )

    async def _async_stream() -> int:
        async with openai.AsyncOpenAI() as client:
            stream = await client.chat.completions.create(
                model=MODEL, max_tokens=5, messages=HI, stream=True
            )
            return len([chunk async for chunk in stream])

    t0 = time.monotonic()
    chunks = asyncio.run(_async_stream())
    print_result(
        "async stream",
        chunks > 0,
        int((time.monotonic() - t0) * 1000),
        f"{chunks} chunks",
    )

    t0 = time.monotonic()
    client = openai.OpenAI()
    client.embeddings.create(model=EMBEDDING_MODEL, input="flightdeck")
    client.embeddings.create(model=EMBEDDING_MODEL, input=["flight", "deck"])
    print_result(
        "embeddings (single + list)", True, int((time.monotonic() - t0) * 1000)
    )

    flightdeck_sensor.teardown()

    _, streamed = wait_for_streamed_post_calls(session_id, EXPECTED_STREAMED_CALLS)
    events = fetch_events_for_session(
        session_id, expect_event_types=["post_call", "embeddings", "session_end"]
    )
    post_calls = [e for e in events if e.get("event_type") == "post_call"]
    embeddings = [e for e in events if e.get("event_type") == "embeddings"]
    metered = [
        e
        for e in post_calls
        if (e.get("tokens_input") or 0) > 0 and (e.get("tokens_output") or 0) > 0
    ]
    passed = (
        len(post_calls) == EXPECTED_POST_CALLS
        and len(metered) == EXPECTED_POST_CALLS
        and len(streamed) == EXPECTED_STREAMED_CALLS
        and len(embeddings) == EXPECTED_EMBEDDINGS
        and all((e.get("tokens_input") or 0) > 0 for e in embeddings)
        and all(e.get("has_content") for e in post_calls + embeddings)
    )
    print_result(
        "every call metered once, with tokens and content",
        passed,
        0,
        f"{len(metered)}/{len(post_calls)} post_calls with tokens, {len(streamed)} streamed, "
        f"{len(embeddings)} embeddings",
    )
    if not passed:
        raise AssertionError(f"unexpected events: {events!r}")


if __name__ == "__main__":
    main()
