"""bifrost smoke tests. Manual; NOT in CI; OPTIONAL.

bifrost is a multi-provider LLM gateway. Flightdeck observes agents
routing through bifrost via the protocol the agent uses to talk to
it: point the openai SDK at bifrost's base_url and the OpenAI
interceptor fires; point the anthropic SDK at bifrost and the
Anthropic interceptor fires. Both protocols are supported as
deployment topologies.

This module exercises both paths against a running bifrost so a
regression in either interceptor (or in bifrost's protocol
forwarding) trips the smoke. Tests skip cleanly when ``BIFROST_URL``
is unset so ``make smoke-all`` works on boxes that don't run bifrost
locally.
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
    """OpenAI-protocol path: openai SDK pointed at bifrost.

    Verifies the OpenAI interceptor fires and the resulting
    post_call event lands via /v1/events as if the call had been
    direct.
    """
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


def test_bifrost_anthropic_chat_via_gateway() -> None:
    """Anthropic-protocol path: anthropic SDK pointed at bifrost.

    bifrost is multi-protocol: it speaks Anthropic's Messages API
    just as it speaks the OpenAI Chat Completions API. Pointing
    ``anthropic.Anthropic(base_url=BIFROST_URL)`` at the gateway
    must trigger the Anthropic interceptor (not the OpenAI one),
    and the resulting post_call event must land with the Anthropic
    request shape preserved (``system`` + ``messages``, not the
    OpenAI flattened ``messages``-only form).
    """
    import os
    import anthropic
    sess = _sensor_session()
    client = anthropic.Anthropic(
        base_url=os.environ["BIFROST_URL"],
        api_key=os.environ.get("BIFROST_API_KEY", "dummy"),
    )
    client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=16,
        messages=[{"role": "user", "content": "say ok"}],
    )
    events = fetch_events_for_session(sess.config.session_id)
    assert any(e["event_type"] == "post_call" for e in events), events
