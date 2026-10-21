"""Direct OpenAI SDK -- sync, async, streaming (sync + async), responses,
structured outputs (chat + Responses ``parse()``), the Responses
raw-response path, Responses tool calls (function + hosted web search),
prompt-cache usage, embeddings (single + list inputs), auth-error
classification.

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
    from pydantic import BaseModel
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
    wait_for_streamed_post_calls,
)

MODEL = "gpt-4o-mini"
# Streamed calls this script makes: sync chat stream, async chat stream,
# plain chat iteration, Responses stream; each must land one metered
# post_call.
EXPECTED_STREAMED_CALLS = 4
HI = [{"role": "user", "content": "hi"}]
# OpenAI caches prompt prefixes from 1024 tokens; this prompt is well
# past that so its second send can report a prompt-cache read under
# prompt_tokens_details.cached_tokens, which the sensor maps to
# tokens_cache_read.
LONG_PROMPT = ("The quick brown fox jumps over the lazy dog near the river bank. " * 220) + (
    "Reply with the single word OK."
)
WEATHER_TOOL = {
    "type": "function",
    "name": "get_weather",
    "description": "Current weather for a city",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
        "additionalProperties": False,
    },
    "strict": True,
}
# How long the script waits for every non-streamed post_call and tool_call
# of the new paths to land; same order of magnitude as the streamed wait,
# the drain and the worker batch are the only latency.
NEW_PATH_EVENTS_DEADLINE_S = 20.0
# Poll gap for that wait: quick enough to notice the last event promptly,
# slow enough not to hammer the API.
NEW_PATH_EVENTS_POLL_S = 0.5


class CityAnswer(BaseModel):
    city: str
    country: str


# The worker writes an event's row before its event_content row, so a
# capture-on event can be listed with has_content=true a moment before
# its content is fetchable. Content trails the row by well under a
# second; 10 s bounds the wait at an order of magnitude above that.
CONTENT_LANDED_DEADLINE_S = 10.0
CONTENT_POLL_S = 0.3


def _fetch_event_content(event_id: str) -> dict:
    """GET /v1/events/{id}/content; returns the parsed JSON body.

    Polls through 404 until ``CONTENT_LANDED_DEADLINE_S``: this script
    runs with capture on, so a 404 here means the content row has not
    landed yet, not that capture is off. The last 404 is raised.
    """
    import json

    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    deadline = time.monotonic() + CONTENT_LANDED_DEADLINE_S
    while True:
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as exc:
            if exc.code != 404 or time.monotonic() > deadline:
                raise
        time.sleep(CONTENT_POLL_S)


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-direct-openai")
    flightdeck_sensor.patch(providers=[Provider.OPENAI], quiet=True)
    print(f"[playground:02_direct_openai] session_id={session_id}")

    t0 = time.monotonic()
    r = openai.OpenAI().chat.completions.create(model=MODEL, max_tokens=5, messages=HI)
    print_result(
        "OpenAI().chat.completions.create",
        True,
        int((time.monotonic() - t0) * 1000),
        f"{r.usage.total_tokens} tokens",
    )

    # Async clients are closed with ``async with`` while their loop is
    # alive; 01_direct_anthropic.py explains why.
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

    # Sync streaming.
    t0 = time.monotonic()
    with openai.OpenAI().chat.completions.create(
        model=MODEL, max_tokens=5, messages=HI, stream=True
    ) as s:
        for _ in s:
            pass
    print_result(
        "OpenAI().chat.completions (sync stream)",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    # Async streaming -- must actually exercise async iteration so
    # GuardedAsyncStream populates streaming.ttft_ms on post_call.
    async def _async_stream() -> None:
        async with openai.AsyncOpenAI() as client:
            s = await client.chat.completions.create(
                model=MODEL,
                max_tokens=8,
                messages=HI,
                stream=True,
            )
            async with s:
                async for _ in s:
                    pass

    t0 = time.monotonic()
    asyncio.run(_async_stream())
    print_result(
        "AsyncOpenAI().chat.completions (async stream)",
        True,
        int((time.monotonic() - t0) * 1000),
    )

    # Chat stream iterated with no ``with`` block, the pattern in the
    # OpenAI README.
    t0 = time.monotonic()
    plain_chunks = 0
    for _ in openai.OpenAI().chat.completions.create(
        model=MODEL,
        max_tokens=5,
        messages=HI,
        stream=True,
    ):
        plain_chunks += 1
    print_result(
        "OpenAI().chat.completions (plain iteration)",
        plain_chunks > 0,
        int((time.monotonic() - t0) * 1000),
        f"{plain_chunks} chunks",
    )

    # Responses API stream: usage arrives on response.completed.
    t0 = time.monotonic()
    resp_events = 0
    for _ in openai.OpenAI().responses.create(
        model=MODEL,
        input="hi",
        max_output_tokens=16,
        stream=True,
    ):
        resp_events += 1
    print_result(
        "OpenAI().responses.create(stream=True)",
        resp_events > 0,
        int((time.monotonic() - t0) * 1000),
        f"{resp_events} events",
    )

    t0 = time.monotonic()
    openai.OpenAI().responses.create(model=MODEL, input="hi", max_output_tokens=16)
    print_result("OpenAI().responses.create", True, int((time.monotonic() - t0) * 1000))

    # Structured outputs: chat.completions.parse(). The parsed object
    # carries the request id the SDK stamps on it; the post_call reports
    # it under provider_metadata.request_id.
    question = [{"role": "user", "content": "Capital of France? Answer as JSON."}]
    t0 = time.monotonic()
    parsed = openai.OpenAI().chat.completions.parse(
        model=MODEL, max_tokens=40, messages=question, response_format=CityAnswer,
    )
    parse_rid = parsed._request_id
    print_result(
        "OpenAI().chat.completions.parse", parsed.choices[0].message.parsed is not None,
        int((time.monotonic() - t0) * 1000),
        f"{parsed.usage.total_tokens} tokens, request_id={parse_rid}",
    )

    # A billed call that fails for the caller: five output tokens cannot
    # hold the JSON object, so the completion arrives (HTTP 200, billed)
    # with finish_reason=length and the SDK raises. The sensor emits the
    # post_call from that completion and then the llm_error.
    t0 = time.monotonic()
    length_raised = False
    try:
        openai.OpenAI().chat.completions.parse(
            model=MODEL, max_tokens=5, messages=question, response_format=CityAnswer,
        )
    except openai.LengthFinishReasonError:
        length_raised = True
    print_result(
        "OpenAI().chat.completions.parse (max_tokens too small)", length_raised,
        int((time.monotonic() - t0) * 1000), "LengthFinishReasonError raised",
    )
    if not length_raised:
        raise AssertionError("parse() with max_tokens=5 did not raise LengthFinishReasonError")

    # Structured outputs on the Responses API.
    t0 = time.monotonic()
    rparsed = openai.OpenAI().responses.parse(
        model=MODEL, input="Capital of France? Answer as JSON.",
        text_format=CityAnswer, max_output_tokens=40,
    )
    rparse_rid = rparsed._request_id
    print_result(
        "OpenAI().responses.parse", rparsed.output_parsed is not None,
        int((time.monotonic() - t0) * 1000),
        f"{rparsed.usage.total_tokens} tokens, request_id={rparse_rid}",
    )

    # Raw-response path on the Responses API: headers stay reachable and
    # .parse() still yields the Response.
    t0 = time.monotonic()
    raw = openai.OpenAI().responses.with_raw_response.create(
        model=MODEL, input="hi", max_output_tokens=16,
    )
    raw_rid = raw.headers.get("x-request-id")
    raw_body = raw.parse()
    print_result(
        "OpenAI().responses.with_raw_response.create",
        bool(raw_rid) and raw_body.usage.total_tokens > 0,
        int((time.monotonic() - t0) * 1000),
        f"{raw_body.usage.total_tokens} tokens, request_id={raw_rid}",
    )

    # Responses function tool call: the sensor emits one tool_call event
    # per function_call output item.
    t0 = time.monotonic()
    tool_resp = openai.OpenAI().responses.create(
        model=MODEL, input="What is the weather in Paris? Use the tool.",
        tools=[WEATHER_TOOL], tool_choice="required", max_output_tokens=64,
    )
    function_calls = [o for o in tool_resp.output if o.type == "function_call"]
    print_result(
        "OpenAI().responses.create(tools=[function])", len(function_calls) > 0,
        int((time.monotonic() - t0) * 1000), f"{len(function_calls)} function_call items",
    )
    if not function_calls:
        raise AssertionError(f"no function_call in output: {tool_resp.output!r}")

    # Hosted tool: web search runs server-side and lands as a
    # web_search_call output item -> tool_call event named after the item.
    t0 = time.monotonic()
    search_resp = openai.OpenAI().responses.create(
        model=MODEL,
        input="Search the web: in what year was the Eiffel Tower completed? One sentence.",
        tools=[{"type": "web_search_preview"}], tool_choice={"type": "web_search_preview"},
        max_output_tokens=80,
    )
    web_searches = [o for o in search_resp.output if o.type == "web_search_call"]
    print_result(
        "OpenAI().responses.create(tools=[web_search_preview])", len(web_searches) > 0,
        int((time.monotonic() - t0) * 1000), f"{len(web_searches)} web_search_call items",
    )
    if not web_searches:
        raise AssertionError(f"no web_search_call in output: {search_resp.output!r}")

    # Prompt cache: the same long prompt twice. The provider reports the
    # hit on the second call; the sensor maps it to tokens_cache_read.
    long_messages = [{"role": "user", "content": LONG_PROMPT}]
    openai.OpenAI().chat.completions.create(model=MODEL, max_tokens=5, messages=long_messages)
    t0 = time.monotonic()
    cached_call = openai.OpenAI().chat.completions.create(
        model=MODEL, max_tokens=5, messages=long_messages,
    )
    cached_rid = cached_call._request_id
    details = cached_call.usage.prompt_tokens_details
    provider_cached = (details.cached_tokens if details else 0) or 0
    print_result(
        "prompt cache usage reported by provider", True, int((time.monotonic() - t0) * 1000),
        f"cached_tokens={provider_cached} of {cached_call.usage.prompt_tokens} prompt tokens",
    )

    # Embeddings: single string. capture_prompts=True (helper default)
    # means has_content=True and the input round-trips via /v1/events/:id/content.
    single_payload = "playground single-string capture"
    t0 = time.monotonic()
    openai.OpenAI().embeddings.create(
        model="text-embedding-3-small", input=single_payload
    )
    print_result(
        "OpenAI().embeddings.create (single)", True, int((time.monotonic() - t0) * 1000)
    )

    # Embeddings: list of strings. Distinct shape so a single failure
    # narrows to one input form.
    list_payload = ["item one", "item two", "item three"]
    t0 = time.monotonic()
    openai.OpenAI().embeddings.create(
        model="text-embedding-3-small", input=list_payload
    )
    print_result(
        "OpenAI().embeddings.create (list)", True, int((time.monotonic() - t0) * 1000)
    )

    assert_event_landed(session_id, "post_call", timeout=8)

    # Every streamed call must land a post_call with streaming.ttft_ms;
    # the later streams flush asynchronously, so wait for all of them.
    events, streamed = wait_for_streamed_post_calls(session_id, EXPECTED_STREAMED_CALLS)
    ttft_ok = any(
        (e["payload"]["streaming"].get("ttft_ms") is not None) for e in streamed
    )
    print_result(
        "streaming.ttft_ms populated on post_call",
        ttft_ok,
        0,
        f"{len(streamed)} streamed post_call events observed",
    )
    if not ttft_ok:
        raise AssertionError(
            f"no post_call carried streaming.ttft_ms; events={events!r}"
        )

    # Every streamed post_call must carry the token counts the provider
    # sent inside the stream, not the pre-call estimate with zero output.
    metered = [
        e
        for e in streamed
        if (e.get("tokens_output") or 0) > 0 and (e.get("tokens_input") or 0) > 0
    ]
    metered_ok = len(streamed) >= EXPECTED_STREAMED_CALLS and len(metered) == len(
        streamed
    )
    print_result(
        "streamed post_call events carry real token usage",
        metered_ok,
        0,
        f"{len(metered)}/{len(streamed)} streamed post_calls metered "
        f"(expected at least {EXPECTED_STREAMED_CALLS})",
    )
    if not metered_ok:
        raise AssertionError(
            f"streamed post_call without real usage; events={events!r}",
        )

    # The new paths: every post_call is matched to its call by the request
    # id the provider returned, and must carry the provider's token counts.
    wanted = {
        "chat.completions.parse": parse_rid,
        "responses.parse": rparse_rid,
        "responses.with_raw_response.create": raw_rid,
        "prompt cache second send": cached_rid,
    }
    deadline = time.monotonic() + NEW_PATH_EVENTS_DEADLINE_S
    by_rid: dict[str, dict] = {}
    tool_names: list[str] = []
    while True:
        events = fetch_events_for_session(
            session_id, expect_event_types=["tool_call"], timeout_s=5.0,
        )
        by_rid = {
            ((e.get("payload") or {}).get("provider_metadata") or {}).get("request_id"): e
            for e in events
            if e.get("event_type") == "post_call"
        }
        tool_names = [
            e.get("tool_name") or (e.get("payload") or {}).get("tool_name") or ""
            for e in events
            if e.get("event_type") == "tool_call"
        ]
        if all(rid in by_rid for rid in wanted.values()) and (
            "get_weather" in tool_names and "web_search_call" in tool_names
        ):
            break
        if time.monotonic() > deadline:
            break
        time.sleep(NEW_PATH_EVENTS_POLL_S)
    for label, rid in wanted.items():
        event = by_rid.get(rid)
        metered = bool(event) and (event.get("tokens_input") or 0) > 0 \
            and (event.get("tokens_output") or 0) > 0
        print_result(
            f"post_call landed with tokens: {label}", metered, 0,
            f"request_id={rid} tokens_input={event.get('tokens_input') if event else None} "
            f"tokens_output={event.get('tokens_output') if event else None}",
        )
        if not metered:
            raise AssertionError(f"{label}: no metered post_call for request_id={rid}")
    cache_event = by_rid[cached_rid]
    cache_read = cache_event.get("tokens_cache_read")
    print_result(
        "tokens_cache_read matches the provider's cached_tokens",
        cache_read == provider_cached, 0,
        f"tokens_cache_read={cache_read} provider cached_tokens={provider_cached}",
    )
    if cache_read != provider_cached:
        raise AssertionError(f"tokens_cache_read={cache_read!r} != cached_tokens={provider_cached}")
    tools_ok = "get_weather" in tool_names and "web_search_call" in tool_names
    print_result(
        "Responses tool_call events landed", tools_ok, 0, f"tool_name={sorted(tool_names)}",
    )
    if not tools_ok:
        raise AssertionError(f"missing Responses tool_call events; saw {tool_names!r}")

    # The billed-but-failed parse: an llm_error with http_status 200 and
    # provider_error_code "length", chained to a metered post_call.
    length_errors = [
        e for e in events
        if e.get("event_type") == "llm_error"
        and ((e.get("payload") or {}).get("error") or {}).get("provider_error_code") == "length"
    ]
    length_err = (length_errors[-1].get("payload") or {}) if length_errors else {}
    origin = length_err.get("originating_event_id")
    billed = next((e for e in events if e.get("id") == origin), None)
    length_ok = (
        bool(length_errors)
        and (length_err.get("error") or {}).get("error_type") == "invalid_request"
        and (length_err.get("error") or {}).get("http_status") == 200
        and billed is not None
        and billed.get("event_type") == "post_call"
        and (billed.get("tokens_input") or 0) > 0
        and (billed.get("tokens_output") or 0) > 0
    )
    print_result(
        "billed-but-failed parse landed as post_call + llm_error", length_ok, 0,
        f"error={length_err.get('error')!r} "
        f"post_call tokens={(billed or {}).get('tokens_input')}/{(billed or {}).get('tokens_output')}",
    )
    if not length_ok:
        raise AssertionError(
            f"length failure not reported as post_call + llm_error; "
            f"errors={length_errors!r} billed={billed!r}",
        )

    # Embeddings event-shape + capture round-trip. Two embedding events
    # land (single + list); fetch_events_for_session returns as soon as
    # ``embeddings`` first appears in the seen-set, so a naive call can
    # see the first event before the second has flushed. Poll until
    # ≥2 embedding events are visible.
    embeds: list[dict] = []
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id,
            expect_event_types=["embeddings"],
            timeout_s=2.0,
        )
        embeds = [e for e in events if e.get("event_type") == "embeddings"]
        if len(embeds) >= 2:
            break
        time.sleep(0.3)
    if len(embeds) < 2:
        raise AssertionError(
            f"expected ≥2 embeddings events; got {len(embeds)}: {embeds!r}"
        )
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
    print_result(
        "embeddings capture round-trip", True, 0, f"captured {len(captured)} inputs"
    )
    # First was single_payload, second was list_payload.
    if (
        single_payload not in (captured[0] if isinstance(captured[0], str) else "")
        and captured[0] != single_payload
    ):
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
            model=MODEL,
            max_tokens=4,
            messages=HI,
        )
    except Exception:
        auth_raised = True
    print_result("auth-error raises", auth_raised, 0)
    if not auth_raised:
        raise AssertionError("auth-error call did not raise")

    # Several llm_errors exist by now (the billed-but-failed parse above),
    # so poll for the authentication one rather than for any llm_error.
    deadline = time.monotonic() + NEW_PATH_EVENTS_DEADLINE_S
    error_types: list[str | None] = []
    while True:
        events = fetch_events_for_session(
            session_id,
            expect_event_types=["llm_error"],
            timeout_s=5.0,
        )
        error_types = [
            ((e.get("payload") or {}).get("error") or {}).get("error_type")
            for e in events
            if e.get("event_type") == "llm_error"
        ]
        if "authentication" in error_types or time.monotonic() > deadline:
            break
        time.sleep(NEW_PATH_EVENTS_POLL_S)
    is_auth = "authentication" in error_types
    print_result(
        "auth-error classified",
        is_auth,
        0,
        f"llm_error types={error_types!r}",
    )
    if not is_auth:
        raise AssertionError(f"auth-error fell through; llm_error types={error_types!r}")

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
