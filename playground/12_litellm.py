"""litellm -- completion via Anthropic endpoint (KI21 bypass case).

litellm.completion routes to many underlying providers through a single
entry point. Its Anthropic route uses raw httpx instead of the
Anthropic SDK, so the sensor's SDK-class patches never see the call --
this is exactly the case KI21 was filed for. After
``flightdeck_sensor.patch()`` the module-level ``litellm.completion``
is swapped with a wrapper that routes every call through the sensor's
pre/post-call plumbing (see ``interceptor/litellm.py``).

The Anthropic model string below exercises the bypass case; swapping
for ``gpt-4o-mini`` would exercise the openai-via-litellm route (which
DOES get intercepted pre-KI21 via the OpenAI SDK patch, but post-KI21
lands through the litellm wrapper instead). Either works to prove
the wrapper fires.
"""
from __future__ import annotations

import sys
import time
import uuid

try:
    import litellm
except ImportError:
    print("SKIP: pip install litellm")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result


def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-litellm")
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:12_litellm] session_id={session_id}")

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

    # The assertion ties the event to the specific model we just
    # called so the test distinguishes the litellm-routed call from
    # any other events that happen to land for this session.
    assert_event_landed(
        session_id,
        "post_call",
        timeout=8,
        model_contains="claude-haiku-4-5",
    )
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
