"""litellm Router -- streaming through a Router, sync and async, and a
Router fallback, against the real Gemini API through litellm and the dev
stack.

A litellm ``Router`` calls ``litellm.completion`` / ``acompletion`` for
each deployment attempt and inspects the stream it gets back: it wraps a
``CustomStreamWrapper`` in a stream wrapper of its own (which runs its
fallbacks when the stream fails before its first chunk), reads its
``_hidden_params``, and sends a Gemini stream's request itself before
handing it back. After ``flightdeck_sensor.patch()`` the stream an
attempt returns is still litellm's own class, so the Router does all of
this as without the sensor: the caller gets the Router's wrapper, and
each request a deployment attempt sends is reported once.

Four Router calls on ``gemini-3.1-flash-lite``: ``completion(stream=True)``
read with ``for``, ``acompletion(stream=True)`` read with ``async for``,
and the same two on a model group whose deployment names a Gemini model
that does not exist, which the API refuses (404) and the Router answers
with its fallback group. Checked through the API: one ``pre_call`` per
request the attempts sent (six), a ``post_call`` per answered call, each
a completed stream with the provider's tokens, and the refused attempt
of each fallback call as its ``llm_error``.

Exits 2 (SKIP) without ``GEMINI_API_KEY`` (or ``GOOGLE_API_KEY``) or
without litellm installed. Live spend: four short calls on
``gemini-3.1-flash-lite``, well under a cent.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from typing import Any

try:
    import litellm
    from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper
except ImportError:
    print("SKIP: pip install 'flightdeck-sensor[litellm]' (litellm>=1.83.0)")
    sys.exit(2)

import flightdeck_sensor

from _helpers import (
    MS_PER_S,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_dev_stack,
)

FLAVOR = "playground-litellm-router"
MODEL = "gemini/gemini-3.1-flash-lite"
# A Gemini model id the API does not serve: it answers 404, which the
# Router answers with the deployment group's fallback.
MISSING_MODEL = "gemini/gemini-0.0-not-a-model"
PROMPT = [{"role": "user", "content": "Name three colours, one word each."}]
MAX_TOKENS = 30
# The Router calls the script makes, and the requests they send: one
# each, and two for a call its fallback answers.
CALLS = 4
REQUESTS = 6
# How long the script waits for the events to land: the worker writes
# within a second or two on an idle stack; 30 s covers a loaded one.
EVENTS_DEADLINE_S = 30.0
EVENTS_POLL_S = 0.5


def _router(api_key: str) -> Any:
    return litellm.Router(
        model_list=[
            {"model_name": "flash", "litellm_params": {"model": MODEL, "api_key": api_key}},
            {
                "model_name": "missing",
                "litellm_params": {"model": MISSING_MODEL, "api_key": api_key},
            },
        ],
        fallbacks=[{"missing": ["flash"]}],
        num_retries=0,
    )


def _text(chunks: list[Any]) -> str:
    return "".join((c.choices[0].delta.content or "") if c.choices else "" for c in chunks)


def _check_stream(label: str, stream: Any, chunks: list[Any], t0: float) -> None:
    """The Router handed back its own stream wrapper, a
    ``CustomStreamWrapper``, and the model's text came through it."""
    wrapper = type(stream).__name__
    ok = isinstance(stream, CustomStreamWrapper) and wrapper.endswith("FallbackStreamWrapper")
    text = _text(chunks)
    print_result(
        label,
        ok and bool(text),
        int((time.monotonic() - t0) * MS_PER_S),
        f"{wrapper}, {len(chunks)} chunks, {text!r}",
    )
    if not ok:
        raise AssertionError(f"{label}: the Router returned {type(stream).__mro__!r}")
    if not text:
        raise AssertionError(f"{label}: no text streamed")


def _events_landed(session_id: str) -> list[dict[str, Any]]:
    deadline = time.monotonic() + EVENTS_DEADLINE_S
    events: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id, expect_event_types=["post_call", "llm_error"], timeout_s=5.0
        )
        ends = [e for e in events if e.get("event_type") in ("post_call", "llm_error")]
        if len(ends) >= REQUESTS:
            return events
        time.sleep(EVENTS_POLL_S)
    return events


def main() -> None:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("SKIP: this script requires GEMINI_API_KEY (or GOOGLE_API_KEY)", file=sys.stderr)
        sys.exit(2)
    wait_for_dev_stack()
    litellm.suppress_debug_info = True
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor=FLAVOR)
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:44_litellm_router] session_id={session_id}")
    router = _router(api_key)

    t0 = time.monotonic()
    stream = router.completion(model="flash", messages=PROMPT, max_tokens=MAX_TOKENS, stream=True)
    _check_stream("Router.completion(stream=True), for", stream, list(stream), t0)

    async def _async_read(group: str) -> tuple[Any, list[Any]]:
        made = await router.acompletion(
            model=group, messages=PROMPT, max_tokens=MAX_TOKENS, stream=True
        )
        return made, [chunk async for chunk in made]

    t0 = time.monotonic()
    stream, chunks = asyncio.run(_async_read("flash"))
    _check_stream("Router.acompletion(stream=True), async for", stream, chunks, t0)

    t0 = time.monotonic()
    stream = router.completion(model="missing", messages=PROMPT, max_tokens=MAX_TOKENS, stream=True)
    _check_stream(
        "Router.completion(stream=True) answered by its fallback", stream, list(stream), t0
    )

    t0 = time.monotonic()
    stream, chunks = asyncio.run(_async_read("missing"))
    _check_stream("Router.acompletion(stream=True) answered by its fallback", stream, chunks, t0)
    del stream, chunks

    flightdeck_sensor.teardown()

    events = _events_landed(session_id)
    of = {
        kind: [e for e in events if e.get("event_type") == kind]
        for kind in ("pre_call", "post_call", "llm_error")
    }
    counts = {kind: len(found) for kind, found in of.items()}
    print_result(
        "one pre_call per request, one post_call per answered call",
        counts == {"pre_call": REQUESTS, "post_call": CALLS, "llm_error": REQUESTS - CALLS},
        0,
        f"{counts}",
    )
    if counts != {"pre_call": REQUESTS, "post_call": CALLS, "llm_error": REQUESTS - CALLS}:
        raise AssertionError(f"events do not match the requests: {counts}")
    problems = []
    for post_call in of["post_call"]:
        streaming = (post_call.get("payload") or {}).get("streaming") or {}
        if streaming.get("final_outcome") != "completed":
            problems.append(f"{post_call['id']}: stream {streaming!r}")
        tokens = (post_call.get("tokens_input") or 0, post_call.get("tokens_output") or 0)
        if not (tokens[0] > 0 and tokens[1] > 0):
            problems.append(f"{post_call['id']}: tokens {tokens}")
        if "gemini-3.1-flash-lite" not in (post_call.get("model") or ""):
            problems.append(f"{post_call['id']}: model {post_call.get('model')!r}")
    for error in of["llm_error"]:
        if "gemini-0.0-not-a-model" not in str(error.get("model_requested") or error.get("model")):
            problems.append(f"{error['id']}: llm_error for {error.get('model')!r}")
    print_result(
        "streamed post_calls carry the provider's tokens; the refused attempts are llm_errors",
        not problems,
        0,
        "; ".join(
            f"{e.get('model')} {e.get('tokens_input')}in/{e.get('tokens_output')}out"
            for e in of["post_call"]
        ),
    )
    if problems:
        raise AssertionError(f"post_calls wrong: {problems}")


if __name__ == "__main__":
    main()
