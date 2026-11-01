"""Newly metered call paths, each landing exactly one post_call:
OpenAI ``client.beta.chat.completions.parse()``, an async streaming view
closed with its stream parsed but never read, and litellm's
``text_completion`` / ``atext_completion`` and ``responses`` /
``aresponses`` on every route kind -- one litellm serves through the
OpenAI SDK, its own httpx routes (Anthropic, the native Responses API),
and a Responses call it bridges through its own ``completion``.

The sensor patches the OpenAI SDK and litellm together, and litellm
calls both underneath (``text_completion`` reaches the OpenAI SDK through
``completion``; ``responses`` on Anthropic bridges through
``litellm.completion``), so a double count would show as an extra
post_call: the script waits until the post_call count stops changing and
asserts it equals the number of calls made.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

try:
    import litellm
    import openai
    from pydantic import BaseModel
except ImportError:
    print("SKIP: pip install 'flightdeck-sensor[litellm]' openai to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
)

OPENAI_MODEL = "gpt-4o-mini"
ANTHROPIC_MODEL = "anthropic/claude-haiku-4-5-20251001"
# Output caps: tiny calls. 16 is the Responses API's minimum
# max_output_tokens; 40 leaves room for the structured-output JSON.
MAX_TOKENS = 8
RESPONSES_MAX_OUTPUT_TOKENS = 16
PARSE_MAX_TOKENS = 40
PROMPT = "Say hi in one word."
# The input of the captured Responses call, looked up in its stored content.
CAPTURED_INPUT = "Reply with the single word: flightdeck-route-check"
# A duplicate post_call could land after the expected ones (the workers
# write in batches), so the count is read until it has not changed over
# this many consecutive polls -- a 1.5 s quiet window at the poll gap
# below, longer than any batch gap seen on the dev stack -- or until the
# deadline, which bounds the wait on a stack that keeps landing rows.
POST_CALL_SETTLE_POLLS = 3
POST_CALL_SETTLE_POLL_S = 0.5
POST_CALL_SETTLE_DEADLINE_S = 20.0


class CityAnswer(BaseModel):
    city: str


def settled_post_calls(session_id: str) -> list[dict]:
    """The session's post_calls, oldest first, once their count has
    stopped changing."""
    deadline = time.monotonic() + POST_CALL_SETTLE_DEADLINE_S
    post_calls: list[dict] = []
    stable, last = 0, -1
    while stable < POST_CALL_SETTLE_POLLS and time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id, expect_event_types=["post_call"], timeout_s=5.0
        )
        post_calls = [e for e in events if e.get("event_type") == "post_call"]
        stable = stable + 1 if len(post_calls) == last else 0
        last = len(post_calls)
        time.sleep(POST_CALL_SETTLE_POLL_S)
    return sorted(post_calls, key=lambda e: e.get("occurred_at") or "")


def event_content(event_id: str) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, {}


def timed(label: str, fn, detail=lambda result: "") -> object:
    t0 = time.monotonic()
    result = fn()
    print_result(label, True, int((time.monotonic() - t0) * 1000), detail(result))
    return result


def main() -> None:
    require_env("OPENAI_API_KEY", "ANTHROPIC_API_KEY")
    litellm.suppress_debug_info = True
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-parse-and-litellm-routes")
    flightdeck_sensor.patch(quiet=True)  # the OpenAI SDK and litellm, both live
    print(f"[playground:30_parse_and_litellm_routes] session_id={session_id}")
    labels: list[str] = []

    # 1. Structured output on the SDK's beta resource.
    parsed = timed(
        "OpenAI().beta.chat.completions.parse",
        lambda: openai.OpenAI().beta.chat.completions.parse(
            model=OPENAI_MODEL,
            max_tokens=PARSE_MAX_TOKENS,
            messages=[
                {"role": "user", "content": "Capital of France? Answer as JSON."}
            ],
            response_format=CityAnswer,
        ),
        lambda r: f"parsed={r.choices[0].message.parsed!r}",
    )
    if parsed.choices[0].message.parsed is None:
        raise AssertionError("beta.chat.completions.parse returned no parsed object")
    labels.append("beta parse")

    # 2. An async streaming view left with its stream parsed, never read.
    async def _unread_view() -> None:
        client = openai.AsyncOpenAI()
        try:
            async with client.chat.completions.with_streaming_response.create(
                model=OPENAI_MODEL,
                max_tokens=MAX_TOKENS,
                messages=[{"role": "user", "content": PROMPT}],
                stream=True,
            ) as response:
                await response.parse()
        finally:
            # Closed while its loop is alive (01_direct_anthropic.py says why).
            await client.close()

    timed(
        "AsyncOpenAI streaming view, stream never read",
        lambda: asyncio.run(_unread_view()),
    )
    labels.append("unread view")

    # 3-6. litellm text_completion: through the OpenAI SDK and on
    # litellm's own Anthropic route, plain, streamed and async.
    timed(
        "litellm.text_completion (OpenAI, through the SDK)",
        lambda: litellm.text_completion(
            model=OPENAI_MODEL, prompt=PROMPT, max_tokens=MAX_TOKENS
        ),
        lambda r: f"text={r.choices[0].text!r}",
    )
    labels.append("text_completion openai")
    timed(
        "litellm.text_completion(stream=True) (OpenAI)",
        lambda: "".join(
            c.choices[0].text or ""
            for c in litellm.text_completion(
                model=OPENAI_MODEL, prompt=PROMPT, max_tokens=MAX_TOKENS, stream=True
            )
        ),
        lambda text: f"text={text!r}",
    )
    labels.append("text_completion openai stream")
    timed(
        "litellm.text_completion (Anthropic, litellm httpx)",
        lambda: litellm.text_completion(
            model=ANTHROPIC_MODEL, prompt=PROMPT, max_tokens=MAX_TOKENS
        ),
        lambda r: f"text={r.choices[0].text!r}",
    )
    labels.append("text_completion anthropic")
    timed(
        "litellm.atext_completion (Anthropic)",
        lambda: asyncio.run(
            litellm.atext_completion(
                model=ANTHROPIC_MODEL, prompt=PROMPT, max_tokens=MAX_TOKENS
            )
        ),
        lambda r: f"text={r.choices[0].text!r}",
    )
    labels.append("atext_completion anthropic")

    # 7-9. litellm responses: native (OpenAI), streamed async, and
    # bridged through litellm.completion (Anthropic).
    native = timed(
        "litellm.responses (OpenAI, native)",
        lambda: litellm.responses(
            model=OPENAI_MODEL,
            input=CAPTURED_INPUT,
            max_output_tokens=RESPONSES_MAX_OUTPUT_TOKENS,
        ),
        lambda r: f"usage={r.usage.input_tokens}/{r.usage.output_tokens}",
    )
    labels.append("responses openai")

    async def _aresponses_stream() -> list[str]:
        stream = await litellm.aresponses(
            model=OPENAI_MODEL,
            input=PROMPT,
            max_output_tokens=RESPONSES_MAX_OUTPUT_TOKENS,
            stream=True,
        )
        return [getattr(event, "type", "?") async for event in stream]

    kinds = timed(
        "litellm.aresponses(stream=True) (OpenAI)",
        lambda: asyncio.run(_aresponses_stream()),
        lambda k: f"last event={k[-1] if k else None}",
    )
    if "response.completed" not in kinds:
        raise AssertionError(
            f"aresponses stream ended without response.completed: {kinds!r}"
        )
    labels.append("aresponses openai stream")
    timed(
        "litellm.responses (Anthropic, bridged)",
        lambda: litellm.responses(
            model=ANTHROPIC_MODEL,
            input=PROMPT,
            max_output_tokens=RESPONSES_MAX_OUTPUT_TOKENS,
        ),
        lambda r: f"usage={r.usage.input_tokens}/{r.usage.output_tokens}",
    )
    labels.append("responses anthropic bridged")

    flightdeck_sensor.teardown()

    # ---- what landed -------------------------------------------------------
    post_calls = settled_post_calls(session_id)
    count_ok = len(post_calls) == len(labels)
    print_result(
        "one post_call per call",
        count_ok,
        0,
        f"{len(post_calls)} post_calls for {len(labels)} calls",
    )
    if not count_ok:
        raise AssertionError(
            f"expected {len(labels)} post_calls, got {len(post_calls)}"
        )

    for label, event in zip(labels, post_calls, strict=True):
        streaming = (event.get("payload") or {}).get("streaming")
        tokens = (event.get("tokens_input"), event.get("tokens_output"))
        detail = f"model={event.get('model')} tokens={tokens[0]}/{tokens[1]}"
        if streaming:
            detail += (
                f" streaming={streaming.get('final_outcome')}"
                f"/{streaming.get('chunk_count')} chunks"
            )
        if label == "unread view":
            ok = (
                streaming is not None
                and streaming.get("final_outcome") == "aborted"
                and streaming.get("chunk_count") == 0
                and (tokens[0] or 0) > 0
                and tokens[1] == 0
            )
        else:
            ok = (tokens[0] or 0) > 0 and (tokens[1] or 0) > 0
            if label.endswith("stream"):
                ok = (
                    ok
                    and streaming is not None
                    and streaming.get("final_outcome") == "completed"
                )
        print_result(f"post_call: {label}", ok, 0, detail)
        if not ok:
            raise AssertionError(f"{label}: unexpected post_call {event!r}")

    # Content capture (on in the playground) stores the Responses input.
    native_event = post_calls[labels.index("responses openai")]
    status, content = event_content(native_event["id"])
    stored_input = content.get("input")
    content_ok = status == 200 and stored_input == CAPTURED_INPUT
    print_result(
        "responses content stored",
        content_ok,
        0,
        f"status={status} input={stored_input!r}",
    )
    if not content_ok:
        raise AssertionError(
            f"content of the native responses call: {status} {content!r}"
        )
    print(
        f"[playground:30_parse_and_litellm_routes] native responses id={native.id} "
        f"event_id={native_event['id']}"
    )


if __name__ == "__main__":
    main()
