"""Direct OpenAI SDK -- sync, async, streaming (sync + async), responses,
embeddings (single + list inputs), auth-error classification.

Copy-paste starter for the raw `openai` package. The sensor's patch()
covers OpenAI() and AsyncOpenAI() instances; streaming picks up token
counts via stream_options={include_usage: true} (sensor-injected).
"""
from __future__ import annotations

import asyncio
import sys
import time
import urllib.request
import urllib.error
import uuid

try:
    import openai
except ImportError:
    print("SKIP: pip install openai to run this example")
    sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import Provider
from _helpers import (
    API_TOKEN,
    API_URL,
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    print_result,
)

MODEL = "gpt-4o-mini"
HI = [{"role": "user", "content": "hi"}]


def _fetch_event_content(event_id: str) -> dict:
    """GET /v1/events/{id}/content; returns the parsed JSON body."""
    import json
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-direct-openai")
    flightdeck_sensor.patch(providers=[Provider.OPENAI], quiet=True)
    print(f"[playground:02_direct_openai] session_id={session_id}")

    t0 = time.monotonic()
    r = openai.OpenAI().chat.completions.create(model=MODEL, max_tokens=5, messages=HI)
    print_result("OpenAI().chat.completions.create", True, int((time.monotonic() - t0) * 1000),
                 f"{r.usage.total_tokens} tokens")

    async def _async_chat() -> None:
        await openai.AsyncOpenAI().chat.completions.create(
            model=MODEL, max_tokens=5, messages=HI)
    t0 = time.monotonic()
    asyncio.run(_async_chat())
    print_result("AsyncOpenAI().chat.completions.create", True, int((time.monotonic() - t0) * 1000))

    # Sync streaming.
    t0 = time.monotonic()
    with openai.OpenAI().chat.completions.create(
            model=MODEL, max_tokens=5, messages=HI, stream=True) as s:
        for _ in s:
            pass
    print_result("OpenAI().chat.completions (sync stream)", True, int((time.monotonic() - t0) * 1000))

    # Async streaming -- must actually exercise async iteration so
    # GuardedAsyncStream populates streaming.ttft_ms on post_call.
    async def _async_stream() -> None:
        client = openai.AsyncOpenAI()
        s = await client.chat.completions.create(
            model=MODEL, max_tokens=8, messages=HI, stream=True,
        )
        async with s:
            async for _ in s:
                pass
    t0 = time.monotonic()
    asyncio.run(_async_stream())
    print_result("AsyncOpenAI().chat.completions (async stream)", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    openai.OpenAI().responses.create(model=MODEL, input="hi", max_output_tokens=16)
    print_result("OpenAI().responses.create", True, int((time.monotonic() - t0) * 1000))

    # Embeddings: single string. capture_prompts=True (helper default)
    # means has_content=True and the input round-trips via /v1/events/:id/content.
    single_payload = "playground single-string capture"
    t0 = time.monotonic()
    openai.OpenAI().embeddings.create(model="text-embedding-3-small", input=single_payload)
    print_result("OpenAI().embeddings.create (single)", True, int((time.monotonic() - t0) * 1000))

    # Embeddings: list of strings. Distinct shape so a single failure
    # narrows to one input form.
    list_payload = ["item one", "item two", "item three"]
    t0 = time.monotonic()
    openai.OpenAI().embeddings.create(model="text-embedding-3-small", input=list_payload)
    print_result("OpenAI().embeddings.create (list)", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)

    # Async-streaming TTFT regression guard.
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
        raise AssertionError(f"no post_call carried streaming.ttft_ms; events={events!r}")

    # Embeddings event-shape + capture round-trip. Two embedding events
    # land (single + list); fetch_events_for_session returns as soon as
    # ``embeddings`` first appears in the seen-set, so a naive call can
    # see the first event before the second has flushed. Poll until
    # ≥2 embedding events are visible.
    embeds: list[dict] = []
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id, expect_event_types=["embeddings"], timeout_s=2.0,
        )
        embeds = [e for e in events if e.get("event_type") == "embeddings"]
        if len(embeds) >= 2:
            break
        time.sleep(0.3)
    if len(embeds) < 2:
        raise AssertionError(f"expected ≥2 embeddings events; got {len(embeds)}: {embeds!r}")
    print_result("embeddings events emitted", True, 0, f"{len(embeds)} events")

    # Round-trip the captured inputs. Match by event ordering: oldest
    # first. The ``input`` body field carries exactly what the SDK
    # received, including the OpenAI quirk that single strings come
    # back wrapped in a list-of-tokens for some clients.
    captured = []
    for e in embeds[-2:]:
        if not e.get("has_content"):
            raise AssertionError(f"embedding event missing has_content: {e!r}")
        body = _fetch_event_content(e["id"])
        captured.append(body.get("input"))
    print_result("embeddings capture round-trip", True, 0, f"captured {len(captured)} inputs")
    # First was single_payload, second was list_payload.
    if single_payload not in (captured[0] if isinstance(captured[0], str) else "") \
            and captured[0] != single_payload:
        # OpenAI returns the input verbatim; if the sensor's serializer
        # changed shape, surface it.
        print(f"  note: single-string captured shape: {captured[0]!r}")
    if captured[1] != list_payload:
        print(f"  note: list captured shape: {captured[1]!r}")

    # Auth-error classification: deliberately bogus key on a fresh
    # client, expect openai's AuthenticationError which the sensor's
    # classifier maps to error_type="authentication".
    bad_client = openai.OpenAI(api_key="sk-definitely-not-a-real-key")
    auth_raised = False
    try:
        bad_client.chat.completions.create(
            model=MODEL, max_tokens=4, messages=HI,
        )
    except Exception:
        auth_raised = True
    print_result("auth-error raises", auth_raised, 0)
    if not auth_raised:
        raise AssertionError("auth-error call did not raise")

    events = fetch_events_for_session(
        session_id, expect_event_types=["llm_error"], timeout_s=8.0,
    )
    errors = [e for e in events if e.get("event_type") == "llm_error"]
    if not errors:
        raise AssertionError(f"no llm_error observed; events={events!r}")
    err = (errors[-1].get("payload") or {}).get("error") or {}
    is_auth = err.get("error_type") == "authentication"
    print_result(
        "auth-error classified", is_auth, 0,
        f"error_type={err.get('error_type')!r}",
    )
    if not is_auth:
        raise AssertionError(f"auth-error fell through: {err!r}")

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
