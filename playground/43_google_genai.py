"""Direct google-genai (Gemini API) -- generate, stream, async, async
stream, chat, automatic function calling, thinking, embeddings and a
policy block, against the real Gemini API and the dev stack.

Copy-paste starter for the raw ``google-genai`` package. The sensor's
``patch()`` covers every ``genai.Client`` (``client.models``,
``client.aio.models``, ``client.chats``): each request the provider bills
is one ``post_call`` (``embeddings`` for ``embed_content``), each round of
automatic function calling included. Checked through the API: every call
landed with ``provider=google``, the Gemini API platform, tokens and a
canonical model; the thinking call's reasoning tokens; the function call
as a ``tool_call``; the stored content in Gemini's own terms; and the
block raised before any request.

The thinking call tries ``THINKING_MODELS`` in order and uses the first
that answers: a model the API reports as overloaded (503) or out of
quota (429), or that does not answer within ``THINKING_TIMEOUT_MS``, is
skipped, its rejected call checked as an ``llm_error``; the script fails
when none answers.

Exits 2 (SKIP) without ``GEMINI_API_KEY`` (or ``GOOGLE_API_KEY``) or
without google-genai installed. Live spend: a dozen short calls on
``gemini-3.1-flash-lite`` and one thinking call, well under a cent.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from typing import Any

try:
    import httpx
    from google import genai
    from google.genai import errors, types
except ImportError:
    print("SKIP: pip install google-genai to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    assert_token_cost_fields,
    fetch_event_content,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_dev_stack,
)
from flightdeck_sensor import BudgetExceededError, Provider
from flightdeck_sensor.core.policy import PolicyCache

FLAVOR = "playground-google-genai"
MODEL = "gemini-3.1-flash-lite"
# Models that think before they answer and report their thoughts with
# this thinking config, tried in order: the larger model first, then the
# script's own model, which also thinks when asked to. The catalogue
# prices both on the Gemini API.
THINKING_MODELS = ("gemini-3.5-flash", "gemini-3.1-flash-lite")
# The statuses that mean a model is busy or out of quota for now, not
# that the request is wrong: the next model is tried.
UNAVAILABLE_STATUSES = frozenset({429, 503})
# How long one thinking attempt may take before the next model is tried:
# a thinking call answers in seconds when the model is not busy, and a
# busy one has been seen to take minutes. Two attempts stay inside
# run_all.py's 180 s budget for this script.
THINKING_TIMEOUT_MS = 45_000
EMBED_MODEL = "gemini-embedding-001"
# Enough for a word or a sentence; the calls stay cheap.
MAX_TOKENS = 40
# Room for the thinking model's thoughts plus its short answer.
THINKING_MAX_TOKENS = 600
THINKING_BUDGET = 256
SYSTEM = "Answer in at most five words."
# The calls this script expects to land: generate, stream, async, async
# stream, two chat turns, two automatic-function-calling rounds, thinking.
EXPECTED_POST_CALLS = 9
# Time for the session's events to land through the stack.
LANDED_S = 30.0
POLL_S = 0.5
MS_PER_S = 1000


def get_weather(city: str) -> str:
    """Returns the current weather in a city."""
    return f"sunny, 21 C in {city}"


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * MS_PER_S)


def _check(label: str, ok: bool, detail: Any = "") -> None:
    print_result(label, ok, 0, "" if ok else str(detail)[:1500])
    if not ok:
        raise AssertionError(f"{label}: {detail}")


def _think(client: genai.Client) -> tuple[str, Any, list[str]]:
    """The thinking call on the first of ``THINKING_MODELS`` that answers:
    that model, its response and the models skipped as unavailable (a 503
    or 429, or no answer within ``THINKING_TIMEOUT_MS``). Raises the last
    model's error when none answers."""
    skipped: list[str] = []
    for model in THINKING_MODELS:
        try:
            response = client.models.generate_content(
                model=model,
                contents="What is 17 * 23? Answer with the number only.",
                config=types.GenerateContentConfig(
                    max_output_tokens=THINKING_MAX_TOKENS,
                    thinking_config=types.ThinkingConfig(
                        thinking_budget=THINKING_BUDGET, include_thoughts=True
                    ),
                    http_options=types.HttpOptions(timeout=THINKING_TIMEOUT_MS),
                ),
            )
        except (errors.APIError, httpx.TimeoutException) as exc:
            code = exc.code if isinstance(exc, errors.APIError) else None
            unavailable = code in UNAVAILABLE_STATUSES or code is None
            if not unavailable or model == THINKING_MODELS[-1]:
                raise
            reason = f"{code} {exc.status}" if isinstance(exc, errors.APIError) else "timed out"
            print(f"  note: {model} unavailable ({reason}); trying the next model")
            skipped.append(model)
            continue
        return model, response, skipped
    raise AssertionError("no thinking model to try")


def _events(session_id: str, event_type: str, least: int) -> list[dict[str, Any]]:
    deadline = time.monotonic() + LANDED_S
    while True:
        events = fetch_events_for_session(session_id, expect_event_types=[event_type])
        found = [e for e in events if e.get("event_type") == event_type]
        if len(found) >= least or time.monotonic() > deadline:
            return found
        time.sleep(POLL_S)


def main() -> None:
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        print("SKIP: this script requires GEMINI_API_KEY (or GOOGLE_API_KEY)", file=sys.stderr)
        sys.exit(2)
    wait_for_dev_stack()
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor=FLAVOR)
    flightdeck_sensor.patch(providers=[Provider.GOOGLE_GENAI], quiet=True)
    print(f"[playground:43_google_genai] session_id={session_id}")
    client = genai.Client()
    config = types.GenerateContentConfig(system_instruction=SYSTEM, max_output_tokens=MAX_TOKENS)

    try:
        t0 = time.monotonic()
        r = client.models.generate_content(model=MODEL, contents="Say hi.", config=config)
        print_result("models.generate_content", bool(r.text), _ms(t0), repr(r.text))

        t0 = time.monotonic()
        chunks = list(
            client.models.generate_content_stream(
                model=MODEL, contents="Count to three.", config=config
            )
        )
        print_result(
            "models.generate_content_stream", bool(chunks), _ms(t0), f"{len(chunks)} chunks"
        )

        async def _async_calls() -> tuple[str | None, int]:
            answer = await client.aio.models.generate_content(
                model=MODEL, contents="Name a colour.", config=config
            )
            stream = await client.aio.models.generate_content_stream(
                model=MODEL, contents="Name a fruit.", config=config
            )
            count = 0
            async for _ in stream:
                count += 1
            return answer.text, count

        t0 = time.monotonic()
        text, count = asyncio.run(_async_calls())
        print_result("aio.models.generate_content + _stream", bool(text) and count > 0, _ms(t0))

        t0 = time.monotonic()
        chat = client.chats.create(model=MODEL, config=config)
        chat.send_message("My name is Ada.")
        reply = chat.send_message("What is my name?")
        print_result(
            "chats.send_message x2", "ada" in (reply.text or "").lower(), _ms(t0), repr(reply.text)
        )

        t0 = time.monotonic()
        weather = client.models.generate_content(
            model=MODEL,
            contents="What is the weather in Paris? Use the tool.",
            config=types.GenerateContentConfig(tools=[get_weather], max_output_tokens=MAX_TOKENS),
        )
        rounds = len(weather.automatic_function_calling_history or [])
        print_result("automatic function calling", rounds >= 3, _ms(t0), repr(weather.text))

        t0 = time.monotonic()
        thinking_model, thought, skipped = _think(client)
        usage = thought.usage_metadata
        print_result(
            "thinking model",
            "391" in (thought.text or ""),
            _ms(t0),
            f"{thinking_model} answered; thoughts={usage.thoughts_token_count if usage else None}",
        )

        t0 = time.monotonic()
        embedded = client.models.embed_content(model=EMBED_MODEL, contents=["hello", "world"])
        print_result("models.embed_content (batch)", len(embedded.embeddings or []) == 2, _ms(t0))

        # A policy block: the next call raises before any request. A
        # one-token budget stands in for a server policy (08_enforcement.py
        # drives a real one), with the identity the server's would carry.
        session = flightdeck_sensor._session
        assert session is not None
        policy = session.policy
        blocking = PolicyCache(token_limit=1, block_at_pct=1)
        blocking.policy_id = str(uuid.uuid4())
        blocking.matched_policy_scope = f"flavor:{FLAVOR}"
        session.policy = blocking
        t0 = time.monotonic()
        try:
            client.models.generate_content(model=MODEL, contents="never sent", config=config)
            blocked = False
        except BudgetExceededError:
            blocked = True
        finally:
            session.policy = policy
        print_result("policy BLOCK raises BudgetExceededError", blocked, _ms(t0))
        _check("policy BLOCK raised", blocked)
    finally:
        flightdeck_sensor.teardown()

    post_calls = _events(session_id, "post_call", EXPECTED_POST_CALLS)
    _check(
        f"{EXPECTED_POST_CALLS} post_calls landed (each automatic-function-calling round one)",
        len(post_calls) == EXPECTED_POST_CALLS,
        [(p.get("model"), p.get("tokens_total")) for p in post_calls],
    )
    assert_token_cost_fields(session_id, provider="google", platform="gemini-api")
    # The model that answered the thinking call can be another than the
    # one asked for (gemini-3.5-flash is answered by gemini-3.6-flash).
    _check(
        "every post_call has tokens and a canonical model",
        all((p.get("tokens_total") or 0) > 0 for p in post_calls)
        and {p.get("model") for p in post_calls} <= {MODEL, thinking_model, thought.model_version},
        [(p.get("model"), p.get("tokens_total")) for p in post_calls],
    )
    if skipped:
        errors_landed = _events(session_id, "llm_error", len(skipped))
        _check(
            "each unavailable thinking model is an llm_error",
            sorted(e.get("model_requested") or e.get("model") for e in errors_landed)
            == sorted(skipped)
            and all(
                (e.get("payload") or {}).get("error", {}).get("error_type")
                in {"overloaded", "rate_limit", "quota_exceeded", "timeout"}
                for e in errors_landed
            ),
            errors_landed,
        )
    thinking = [
        p
        for p in post_calls
        if p.get("model_requested") == thinking_model and (p.get("tokens_reasoning") or 0) > 0
    ]
    _check(
        "the thinking call reports its thoughts as reasoning tokens",
        len(thinking) == 1
        and (thinking[0].get("tokens_reasoning") or 0) > 0
        and thinking[0]["tokens_output"] >= thinking[0]["tokens_reasoning"],
        thinking,
    )
    streamed = [p for p in post_calls if (p.get("payload") or {}).get("streaming")]
    _check(
        "the two streams report a completed outcome and a time to first token",
        len(streamed) == 2
        and all(
            p["payload"]["streaming"]["final_outcome"] == "completed"
            and p["payload"]["streaming"]["ttft_ms"] is not None
            for p in streamed
        ),
        [p.get("payload") for p in streamed],
    )
    tools = _events(session_id, "tool_call", 1)
    _check(
        "the model's function call is a tool_call",
        [t.get("tool_name") for t in tools] == ["get_weather"],
        tools,
    )
    embeddings = _events(session_id, "embeddings", 1)
    _check(
        "embed_content is an embeddings event",
        len(embeddings) == 1 and embeddings[0].get("provider") == "google",
        embeddings,
    )
    first = fetch_event_content(post_calls[0]["id"])
    _check(
        "the stored content is in Gemini's own terms",
        first.get("provider") == "google"
        and first.get("input") == "Say hi."
        and first.get("system_prompt") == SYSTEM
        and "candidates" in (first.get("response") or {}),
        first,
    )
    print(f"[playground:43_google_genai] sessions: {session_id}")


if __name__ == "__main__":
    main()
