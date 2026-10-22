"""Anthropic platform matrix -- the raw and streaming views,
structured-output ``parse``, and the cloud clients (Bedrock, Vertex, Foundry)
with per-platform self-skipping.

What ``01_direct_anthropic.py`` does not cover: ``with_raw_response.create``
(sync + async), ``with_streaming_response.create`` settled by ``parse()`` /
``await parse()`` and by ``stream=True`` iteration, ``messages.parse`` with a
pydantic ``output_format``, ``beta.messages`` through the raw view, and the
platform attribution every post_call carries under
``provider_metadata.platform``. The first-party sections need
ANTHROPIC_API_KEY (the script exits 2 without it); each cloud section runs
only when its credentials are present and prints a SKIP line otherwise, so
``make playground-all`` stays green on a box without cloud access.
"""
from __future__ import annotations

import asyncio
import inspect
import os
import sys
import time
import uuid
from typing import Any

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic to run this example")
    sys.exit(2)

from pydantic import BaseModel

import flightdeck_sensor
from flightdeck_sensor import Provider
from _helpers import (
    STREAMED_POST_CALL_DEADLINE_S,
    STREAMED_POST_CALL_FETCH_TIMEOUT_S,
    STREAMED_POST_CALL_POLL_S,
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
)

MODEL = "claude-haiku-4-5-20251001"
# Cloud model ids differ per platform; override via env when a deployment
# uses another alias.
BEDROCK_MODEL = os.environ.get("ANTHROPIC_BEDROCK_MODEL", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
VERTEX_MODEL = os.environ.get("ANTHROPIC_VERTEX_MODEL", "claude-haiku-4-5@20251001")
FOUNDRY_MODEL = os.environ.get("ANTHROPIC_FOUNDRY_MODEL", "claude-haiku-4-5")
HI = [{"role": "user", "content": "hi"}]
# First-party calls this script makes; each must land one post_call with
# real token usage attributed to platform "anthropic".
EXPECTED_ANTHROPIC_CALLS = 8


class Greeting(BaseModel):
    """Structured output for the ``parse`` section."""

    greeting: str
    language: str


def _bedrock_available() -> bool:
    return bool(os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")) and bool(
        (os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"))
        or os.environ.get("AWS_PROFILE")
        or os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    )


def _vertex_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_VERTEX_PROJECT_ID")) and bool(
        os.environ.get("CLOUD_ML_REGION")
    )


def _foundry_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_FOUNDRY_API_KEY")) and bool(
        os.environ.get("ANTHROPIC_FOUNDRY_BASE_URL") or os.environ.get("ANTHROPIC_FOUNDRY_RESOURCE")
    )


def _wait_for_post_calls(session_id: str, expected: int) -> list[dict[str, Any]]:
    """Poll until ``expected`` post_calls have landed or the deadline passes."""
    deadline = time.monotonic() + STREAMED_POST_CALL_DEADLINE_S
    while True:
        events = fetch_events_for_session(
            session_id,
            expect_event_types=["post_call"],
            timeout_s=STREAMED_POST_CALL_FETCH_TIMEOUT_S,
        )
        posts = [e for e in events if e.get("event_type") == "post_call"]
        if len(posts) >= expected or time.monotonic() > deadline:
            return posts
        time.sleep(STREAMED_POST_CALL_POLL_S)


def main() -> None:
    require_env("ANTHROPIC_API_KEY")
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-anthropic-platforms")
    flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
    print(f"[playground:27_anthropic_platforms] session_id={session_id}")

    # --- first-party API: the raw and streaming views -------------------------
    t0 = time.monotonic()
    raw = anthropic.Anthropic().messages.with_raw_response.create(
        model=MODEL, max_tokens=5, messages=HI,
    )
    message = raw.parse()
    print_result("Anthropic().messages.with_raw_response.create", message.usage.output_tokens > 0,
                 int((time.monotonic() - t0) * 1000),
                 f"{message.usage.output_tokens} output tokens, request-id {raw.headers.get('request-id')}")

    async def _async_raw() -> int:
        async with anthropic.AsyncAnthropic() as client:
            raw = await client.messages.with_raw_response.create(model=MODEL, max_tokens=5, messages=HI)
            # A synchronous parse() up to the 0.x SDKs, a coroutine from 2.x.
            message = raw.parse()
            if inspect.isawaitable(message):
                message = await message
            return message.usage.output_tokens
    t0 = time.monotonic()
    out = asyncio.run(_async_raw())
    print_result("AsyncAnthropic().messages.with_raw_response.create", out > 0,
                 int((time.monotonic() - t0) * 1000), f"{out} output tokens")

    # Streaming-response view: the body is unread until parse(); the
    # sensor meters at that point and never reads the body itself.
    t0 = time.monotonic()
    with anthropic.Anthropic().messages.with_streaming_response.create(
        model=MODEL, max_tokens=5, messages=HI,
    ) as response:
        message = response.parse()
    print_result("Anthropic().messages.with_streaming_response.create + parse()",
                 message.usage.output_tokens > 0, int((time.monotonic() - t0) * 1000),
                 f"{message.usage.output_tokens} output tokens")

    async def _async_streaming_response() -> int:
        async with anthropic.AsyncAnthropic() as client, client.messages.with_streaming_response.create(
            model=MODEL, max_tokens=5, messages=HI,
        ) as response:
            message = await response.parse()
        return message.usage.output_tokens
    t0 = time.monotonic()
    out = asyncio.run(_async_streaming_response())
    print_result("AsyncAnthropic().messages.with_streaming_response.create + await parse()",
                 out > 0, int((time.monotonic() - t0) * 1000), f"{out} output tokens")

    # Streaming-response view with stream=True: parse() yields the event
    # stream, which the guard meters as it is iterated.
    t0 = time.monotonic()
    with anthropic.Anthropic().messages.with_streaming_response.create(
        model=MODEL, max_tokens=5, messages=HI, stream=True,
    ) as response:
        events = sum(1 for _ in response.parse())
    print_result("Anthropic().messages.with_streaming_response.create(stream=True)",
                 events > 0, int((time.monotonic() - t0) * 1000), f"{events} events")

    # Structured output through messages.parse().
    t0 = time.monotonic()
    parsed = anthropic.Anthropic().messages.parse(
        model=MODEL, max_tokens=64, output_format=Greeting,
        messages=[{"role": "user", "content": "Greet me in French."}],
    )
    greeting = parsed.parsed_output
    print_result("Anthropic().messages.parse(output_format=Greeting)",
                 isinstance(greeting, Greeting) and bool(greeting.greeting),
                 int((time.monotonic() - t0) * 1000), f"parsed_output={greeting!r}")

    # beta.messages through the raw view, and the async beta parse path.
    t0 = time.monotonic()
    beta_raw = anthropic.Anthropic().beta.messages.with_raw_response.create(
        model=MODEL, max_tokens=5, messages=HI,
    )
    print_result("Anthropic().beta.messages.with_raw_response.create",
                 beta_raw.parse().usage.output_tokens > 0, int((time.monotonic() - t0) * 1000))

    async def _async_beta_parse() -> bool:
        async with anthropic.AsyncAnthropic() as client:
            parsed = await client.beta.messages.parse(
                model=MODEL, max_tokens=64, output_format=Greeting,
                messages=[{"role": "user", "content": "Greet me in Spanish."}],
            )
            return isinstance(parsed.parsed_output, Greeting)
    t0 = time.monotonic()
    ok = asyncio.run(_async_beta_parse())
    print_result("AsyncAnthropic().beta.messages.parse(output_format=Greeting)", ok,
                 int((time.monotonic() - t0) * 1000))

    # --- cloud platforms: each runs only with its own credentials -------------
    expected_platforms: dict[str, int] = {"anthropic": EXPECTED_ANTHROPIC_CALLS}

    if _bedrock_available():
        t0 = time.monotonic()
        message = anthropic.AnthropicBedrock().messages.create(model=BEDROCK_MODEL, max_tokens=5, messages=HI)
        print_result("AnthropicBedrock().messages.create", message.usage.output_tokens > 0,
                     int((time.monotonic() - t0) * 1000), f"{message.usage.output_tokens} output tokens")
        expected_platforms["bedrock"] = 1
    else:
        print("  SKIP  AnthropicBedrock (set AWS_REGION plus AWS credentials or AWS_BEARER_TOKEN_BEDROCK)")

    if _vertex_available():
        t0 = time.monotonic()
        message = anthropic.AnthropicVertex().messages.create(model=VERTEX_MODEL, max_tokens=5, messages=HI)
        print_result("AnthropicVertex().messages.create", message.usage.output_tokens > 0,
                     int((time.monotonic() - t0) * 1000), f"{message.usage.output_tokens} output tokens")
        expected_platforms["vertex"] = 1
    else:
        print("  SKIP  AnthropicVertex (set ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION)")

    if _foundry_available():
        t0 = time.monotonic()
        message = anthropic.AnthropicFoundry().messages.create(model=FOUNDRY_MODEL, max_tokens=5, messages=HI)
        print_result("AnthropicFoundry().messages.create", message.usage.output_tokens > 0,
                     int((time.monotonic() - t0) * 1000), f"{message.usage.output_tokens} output tokens")
        expected_platforms["foundry"] = 1
    else:
        print("  SKIP  AnthropicFoundry (set ANTHROPIC_FOUNDRY_API_KEY and "
              "ANTHROPIC_FOUNDRY_BASE_URL or ANTHROPIC_FOUNDRY_RESOURCE)")

    # --- assertions on what landed --------------------------------------------
    expected_total = sum(expected_platforms.values())
    posts = _wait_for_post_calls(session_id, expected_total)
    by_platform: dict[str, list[dict[str, Any]]] = {}
    for post in posts:
        platform = ((post.get("payload") or {}).get("provider_metadata") or {}).get("platform")
        by_platform.setdefault(str(platform), []).append(post)
    counts = {k: len(v) for k, v in by_platform.items()}
    landed_ok = counts == expected_platforms
    print_result("post_call per platform landed", landed_ok, 0,
                 f"observed {counts}, expected exactly {expected_platforms}")
    if not landed_ok:
        raise AssertionError(f"post_call platform attribution mismatch; events={posts!r}")

    unmetered = [
        p for p in posts
        if not ((p.get("tokens_input") or 0) > 0 and (p.get("tokens_output") or 0) > 0)
    ]
    print_result("every post_call carries real token usage", not unmetered, 0,
                 f"{len(posts) - len(unmetered)}/{len(posts)} metered")
    if unmetered:
        raise AssertionError(f"post_call without real usage; events={unmetered!r}")

    # Exactly one call streamed (stream=True through the streaming view),
    # read to its end.
    streamed = [p for p in posts if (p.get("payload") or {}).get("streaming")]
    outcomes = [p["payload"]["streaming"].get("final_outcome") for p in streamed]
    streamed_ok = len(streamed) == 1 and outcomes == ["completed"]
    print_result("stream=True view call completed through the guard", streamed_ok, 0,
                 f"{len(streamed)} streamed post_call(s), outcomes {outcomes}")
    if not streamed_ok:
        raise AssertionError(f"unexpected streamed post_calls; events={streamed!r}")

    # Capture is on for every playground run: every post_call stored content.
    uncaptured = [p for p in posts if not p.get("has_content")]
    print_result("captured content landed on every post_call", not uncaptured, 0,
                 f"{len(posts) - len(uncaptured)}/{len(posts)} with content")
    if uncaptured:
        raise AssertionError(f"post_call without captured content; events={uncaptured!r}")

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
