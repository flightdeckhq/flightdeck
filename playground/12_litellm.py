"""litellm -- multi-provider chat (Anthropic + OpenAI routes), embeddings,
embeddings capture round-trip, and invalid-model error classification.

litellm.completion routes to many underlying providers through a single
entry point. The Anthropic route uses raw httpx instead of the
Anthropic SDK -- the case KI21 was filed for. After
``flightdeck_sensor.patch()`` the module-level ``litellm.completion``
is swapped with a wrapper that routes every call through the sensor's
pre/post-call plumbing (see ``interceptor/litellm.py``). The OpenAI
route would also be intercepted via the OpenAI SDK patch, but
post-KI21 lands through the litellm wrapper instead. Both routes
covered here so an SDK-class-rename in either provider can't escape
the canary.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import uuid

try:
    import litellm
except ImportError:
    print("SKIP: pip install litellm")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    API_TOKEN,
    API_URL,
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    print_result,
)


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-litellm")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:12_litellm] session_id={session_id}")

    # Anthropic route -- the KI21 bypass case.
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
