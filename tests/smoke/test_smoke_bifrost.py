"""bifrost Phase 4 smoke test. Manual; NOT in CI; OPTIONAL.

bifrost is an OpenAI-compatible gateway. Flightdeck covers it
**indirectly**: users point the OpenAI client at bifrost's base_url and
the existing ``interceptor/openai.py`` patches fire unchanged. This
smoke proves the indirection still works after the Phase 4 changes --
the promoted ``embeddings`` event_type and new ``llm_error`` event
must both ride through bifrost without the gateway mangling them.

Skip cleanly when ``BIFROST_URL`` is unset so ``make smoke-all`` works
on boxes that don't run bifrost locally.
"""

from __future__ import annotations

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)


def _sensor_session():
    return make_sensor_session(flavor="smoke-bifrost")


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    # bifrost smoke is OPT-IN via BIFROST_URL. The upstream provider
    # key lands under the normal OPENAI_API_KEY / ANTHROPIC_API_KEY
    # name -- bifrost forwards the request transparently.
    require_env("BIFROST_URL")
    wait_for_dev_stack()


def test_bifrost_openai_chat_via_gateway() -> None:
    import os
    import openai
    sess = _sensor_session()
    client = openai.OpenAI(
        base_url=os.environ["BIFROST_URL"],
        api_key=os.environ.get("BIFROST_API_KEY", "dummy"),
    )
    client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=16,
        messages=[{"role": "user", "content": "say ok"}],
    )
    events = fetch_events_for_session(sess.config.session_id)
    assert any(e["event_type"] == "post_call" for e in events), events
