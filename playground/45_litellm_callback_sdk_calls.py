"""litellm callback SDK calls -- a litellm callback that makes SDK calls of
its own while the litellm call is in flight, against the real Gemini API
and the dev stack.

A litellm call runs under its mark, and the sensor hands the provider
request litellm itself sends through the OpenAI SDK to the SDK untouched,
since the litellm wrapper reports it. Every other SDK call made while the
litellm call is in flight is an ordinary call: policed when made and
reported. Here a ``CustomLogger.log_pre_api_call`` callback, which litellm
runs inside the call before its request, asks Gemini a question of its
own twice: through the OpenAI SDK (Gemini's OpenAI-compatible endpoint)
and through google-genai.

Two litellm calls on ``gemini-3.1-flash-lite``: one on litellm's Gemini
route (litellm's own HTTP handler), and one streamed on litellm's OpenAI
route pointed at Gemini's OpenAI-compatible endpoint, whose request
litellm sends through the OpenAI SDK -- the request that must still be
reported once. Checked through the API: six calls, each one ``pre_call``
and one ``post_call`` with the provider's tokens; the four callback calls
carry their own prompt in their stored content (capture is on).

Exits 2 (SKIP) without ``GEMINI_API_KEY`` (or ``GOOGLE_API_KEY``), or
without litellm, openai or google-genai installed. Live spend: six short
calls on ``gemini-3.1-flash-lite``, well under a cent.
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from typing import Any

try:
    import litellm
    import openai
    from google import genai
    from litellm.integrations.custom_logger import CustomLogger
except ImportError:
    print("SKIP: pip install litellm openai google-genai to run this example")
    sys.exit(2)

import flightdeck_sensor

from _helpers import (
    MS_PER_S,
    fetch_event_content,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_dev_stack,
)

FLAVOR = "playground-litellm-callback-sdk-calls"
MODEL = "gemini-3.1-flash-lite"
# Gemini's OpenAI-compatible endpoint, which the OpenAI SDK and litellm's
# OpenAI route can call with the Gemini key.
GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"
PROMPT = [{"role": "user", "content": "Name one colour, one word."}]
# The callback's own questions: text no other call sends, so its calls
# are found by their stored content.
OPENAI_SDK_QUESTION = "Name one fruit, one word."
GENAI_QUESTION = "Name one animal, one word."
MAX_TOKENS = 20
# Two litellm calls, and the callback's two SDK calls in each.
CALLS = 6
# How long the script waits for the events to land: the worker writes
# within a second or two on an idle stack; 30 s covers a loaded one.
EVENTS_DEADLINE_S = 30.0
EVENTS_POLL_S = 0.5


class _AsksItsOwnQuestions(CustomLogger):  # type: ignore[misc]
    """A callback litellm runs inside each call, before its request."""

    def __init__(self, api_key: str) -> None:
        super().__init__()
        self._openai = openai.OpenAI(api_key=api_key, base_url=GEMINI_OPENAI_BASE)
        self._genai = genai.Client(api_key=api_key)
        self.answers: list[str] = []

    def log_pre_api_call(self, model: Any, messages: Any, kwargs: Any) -> None:
        reply = self._openai.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": OPENAI_SDK_QUESTION}],
            max_tokens=MAX_TOKENS,
        )
        self.answers.append(reply.choices[0].message.content or "")
        answer = self._genai.models.generate_content(model=MODEL, contents=GENAI_QUESTION)
        self.answers.append(answer.text or "")


def _events_landed(session_id: str) -> list[dict[str, Any]]:
    deadline = time.monotonic() + EVENTS_DEADLINE_S
    events: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id, expect_event_types=["post_call"], timeout_s=5.0
        )
        if len([e for e in events if e.get("event_type") == "post_call"]) >= CALLS:
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
    print(f"[playground:45_litellm_callback_sdk_calls] session_id={session_id}")

    callback = _AsksItsOwnQuestions(api_key)
    kept = list(litellm.callbacks)
    litellm.callbacks = [*kept, callback]
    try:
        t0 = time.monotonic()
        reply = litellm.completion(
            model=f"gemini/{MODEL}", messages=PROMPT, max_tokens=MAX_TOKENS, api_key=api_key
        )
        text = reply.choices[0].message.content or ""
        print_result(
            "litellm.completion on its Gemini route, the callback asking twice",
            bool(text) and len(callback.answers) == 2,
            int((time.monotonic() - t0) * MS_PER_S),
            f"{text.strip()!r}; callback: {[a.strip() for a in callback.answers]}",
        )

        t0 = time.monotonic()
        stream = litellm.completion(
            model=f"openai/{MODEL}",
            api_base=GEMINI_OPENAI_BASE,
            api_key=api_key,
            messages=PROMPT,
            max_tokens=MAX_TOKENS,
            stream=True,
        )
        text = "".join((c.choices[0].delta.content or "") if c.choices else "" for c in stream)
        print_result(
            "litellm.completion(stream=True) through the OpenAI SDK, the callback asking twice",
            bool(text) and len(callback.answers) == 4,
            int((time.monotonic() - t0) * MS_PER_S),
            f"{text.strip()!r}; callback: {[a.strip() for a in callback.answers[2:]]}",
        )
    finally:
        litellm.callbacks = kept
    flightdeck_sensor.teardown()

    events = _events_landed(session_id)
    pre_calls = [e for e in events if e.get("event_type") == "pre_call"]
    post_calls = [e for e in events if e.get("event_type") == "post_call"]
    errors = [e for e in events if e.get("event_type") == "llm_error"]
    counts = (len(pre_calls), len(post_calls), len(errors))
    print_result(
        "six calls, each one pre_call and one post_call",
        counts == (CALLS, CALLS, 0),
        0,
        f"pre_call={counts[0]} post_call={counts[1]} llm_error={counts[2]}",
    )
    if counts != (CALLS, CALLS, 0):
        raise AssertionError(f"events do not match the calls: {counts}")
    asked: dict[str, int] = {OPENAI_SDK_QUESTION: 0, GENAI_QUESTION: 0}
    problems = []
    for post_call in post_calls:
        tokens = (post_call.get("tokens_input") or 0, post_call.get("tokens_output") or 0)
        if not (tokens[0] > 0 and tokens[1] > 0):
            problems.append(f"{post_call['id']}: tokens {tokens}")
        stored = str(fetch_event_content(post_call["id"]))
        for question in asked:
            if question in stored:
                asked[question] += 1
    print_result(
        "the callback's calls are its own, with its questions stored",
        not problems and asked == {OPENAI_SDK_QUESTION: 2, GENAI_QUESTION: 2},
        0,
        "; ".join(
            f"{e.get('provider')} {e.get('model')} {e.get('tokens_input')}in/"
            f"{e.get('tokens_output')}out"
            for e in post_calls
        ),
    )
    if problems or asked != {OPENAI_SDK_QUESTION: 2, GENAI_QUESTION: 2}:
        raise AssertionError(f"post_calls wrong: {problems} {asked}")


if __name__ == "__main__":
    main()
