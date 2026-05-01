"""bifrost gateway -- multi-protocol observation demo.

bifrost is a multi-provider LLM gateway. Flightdeck observes agents
routing through bifrost via the protocol the agent uses to talk to
it: point the openai SDK at bifrost's base_url and the OpenAI
interceptor fires; point the anthropic SDK at bifrost and the
Anthropic interceptor fires. Both protocols are supported as
deployment topologies.

This script exercises both paths against a running bifrost so a
regression in either interceptor (or in bifrost's protocol
forwarding) trips the demo. Skipped cleanly when ``BIFROST_URL`` is
unset so ``make playground-all`` works on boxes that don't run
bifrost locally.

Optional env vars:

* ``BIFROST_URL`` — base URL of the bifrost gateway (e.g.
  ``http://localhost:8080``). Required.
* ``BIFROST_API_KEY`` — opaque key the gateway authenticates against
  upstream. Optional; defaults to ``"dummy"`` for gateways that don't
  enforce a per-request key.
"""
from __future__ import annotations

import os
import sys
import time
import uuid

import flightdeck_sensor
from flightdeck_sensor import Provider
from _helpers import (
    assert_event_landed,
    init_sensor,
    print_result,
    require_env,
    wait_for_dev_stack,
)


def _run_openai_route() -> None:
    """OpenAI-protocol path: openai SDK pointed at bifrost. The OpenAI
    interceptor fires and the post_call event lands as if the call had
    been direct."""
    try:
        import openai
    except ImportError:
        print("SKIP: pip install openai")
        return

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-bifrost-openai")
    flightdeck_sensor.patch(providers=[Provider.OPENAI], quiet=True)
    print(f"[playground:15_bifrost] openai-route session_id={session_id}")

    client = openai.OpenAI(
        base_url=os.environ["BIFROST_URL"],
        api_key=os.environ.get("BIFROST_API_KEY", "dummy"),
    )
    t0 = time.monotonic()
    client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=8,
        messages=[{"role": "user", "content": "say ok"}],
    )
    print_result(
        "openai SDK -> bifrost", True,
        int((time.monotonic() - t0) * 1000),
    )
    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


def _run_anthropic_route() -> None:
    """Anthropic-protocol path: anthropic SDK pointed at bifrost.
    bifrost speaks Anthropic's Messages API just as it speaks OpenAI's
    Chat Completions API. Pointing ``anthropic.Anthropic(base_url=...)``
    at the gateway must trigger the Anthropic interceptor (not the
    OpenAI one) and preserve the Anthropic request shape (``system``
    + ``messages``, not the OpenAI flattened ``messages``-only form)."""
    try:
        import anthropic
    except ImportError:
        print("SKIP: pip install anthropic")
        return

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor="playground-bifrost-anthropic")
    flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
    print(f"[playground:15_bifrost] anthropic-route session_id={session_id}")

    client = anthropic.Anthropic(
        base_url=os.environ["BIFROST_URL"],
        api_key=os.environ.get("BIFROST_API_KEY", "dummy"),
    )
    t0 = time.monotonic()
    client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=8,
        messages=[{"role": "user", "content": "say ok"}],
    )
    print_result(
        "anthropic SDK -> bifrost", True,
        int((time.monotonic() - t0) * 1000),
    )
    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


def main() -> None:
    require_env("BIFROST_URL")
    wait_for_dev_stack()
    _run_openai_route()
    _run_anthropic_route()


if __name__ == "__main__":
    main()
