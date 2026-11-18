"""An event body is always JSON, also when what it captured holds a NaN or
an infinity.

Python's json module writes ``float('nan')`` and ``float('inf')`` as
``NaN`` / ``Infinity``, which is not JSON: ingestion rejects such a body
whole, and the call's token counts and metadata go with it. Such a float
reaches an event through a reply the SDK parsed leniently (an
OpenAI-compatible server's ``-Infinity`` logprob, a ``NaN`` in a tool
call's arguments or input) or through framework state handed to a
sub-agent. The provider SDKs' own encoders refuse it, and the provider
never received it as JSON, so content that holds one is sent without its
content, with one warning per event type, as for any object JSON cannot
write; a sub-agent message body that holds one is dropped. Nothing is
rewritten to ``null`` or a string the provider never sent.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import anthropic
import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig, SubagentMessage
from flightdeck_sensor.interceptor.anthropic import (
    patch_anthropic_classes,
    unpatch_anthropic_classes,
)
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
from flightdeck_sensor.transport import body_limit
from flightdeck_sensor.transport.body_limit import serialize_event
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Iterator

NON_FINITE = [float("nan"), float("inf"), float("-inf")]
NON_FINITE_IDS = ["nan", "inf", "-inf"]


def _strict(body: bytes) -> dict[str, Any]:
    """``body`` parsed as JSON, refusing the ``NaN`` / ``Infinity``
    constants Python's json module accepts but JSON does not."""

    def refuse(token: str) -> Any:
        raise ValueError(f"not JSON: {token}")

    parsed: dict[str, Any] = json.loads(body, parse_constant=refuse)
    return parsed


@pytest.fixture(autouse=True)
def _fresh_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(body_limit, "_warned_unencodable", set())


@pytest.mark.parametrize("value", NON_FINITE, ids=NON_FINITE_IDS)
def test_content_holding_a_non_finite_float_is_sent_as_json_without_it(
    value: float, caplog: pytest.LogCaptureFixture
) -> None:
    payload = {
        "event_type": EventType.POST_CALL.value,
        "tokens_input": 7,
        "provider_metadata": {"request_id": "req_1"},
        "has_content": True,
        "content": {"messages": [], "response": {"logprob": value}},
    }
    with caplog.at_level(logging.DEBUG, logger="flightdeck_sensor"):
        sent = [_strict(serialize_event(dict(payload))) for _ in range(3)]
    assert all(e["has_content"] is False and e["content"] is None for e in sent)
    assert all(e["tokens_input"] == 7 for e in sent)
    assert all(e["provider_metadata"] == {"request_id": "req_1"} for e in sent)
    named = [r for r in caplog.records if "non-finite float" in r.getMessage()]
    assert [r.levelno for r in named] == [logging.WARNING, logging.DEBUG, logging.DEBUG]
    assert "post_call" in named[0].getMessage()


def test_a_non_finite_float_outside_the_content_is_never_sent() -> None:
    """The sensor writes no such value itself; one that got there anyway
    raises, as any other value outside the content JSON cannot write,
    rather than going out as a body ingestion rejects."""
    payload = {"event_type": "post_call", "latency_ms": float("nan"), "content": None}
    with pytest.raises(TypeError, match="non-finite float"):
        serialize_event(payload)
    payload["content"] = {"response": {"x": float("inf")}}
    with pytest.raises(TypeError, match="outside its content"):
        serialize_event(payload)


def test_finite_floats_are_written_unchanged() -> None:
    payload = {"event_type": "post_call", "content": {"response": {"logprob": -1.25e-7}}}
    assert _strict(serialize_event(payload))["content"]["response"]["logprob"] == -1.25e-7


# ----- through the SDKs ------------------------------------------------------------

SERVED = "gpt-4o-mini-2024-07-18"
HI = [{"role": "user", "content": "hi"}]


def _session() -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="non-finite",
        agent_type="production",
        quiet=True,
        capture_prompts=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


@pytest.fixture
def sensored(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    session = _session()
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_anthropic_classes(quiet=True)
    patch_openai_classes(quiet=True)
    yield session
    unpatch_anthropic_classes()
    unpatch_openai_classes()


def _sent(session: Session) -> list[dict[str, Any]]:
    calls = session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
    return [_strict(serialize_event(dict(c.args[0]))) for c in calls]


def _json_reply(body: str) -> httpx.Response:
    """A reply as an OpenAI-compatible server can send it: ``NaN`` and
    ``Infinity`` constants, which the SDKs parse."""
    return httpx.Response(200, content=body.encode(), headers={"content-type": "application/json"})


def _chat_with_logprob(constant: str) -> httpx.Response:
    return _json_reply(
        '{"id":"c","object":"chat.completion","created":1,"model":"' + SERVED + '",'
        '"choices":[{"index":0,"finish_reason":"stop",'
        '"message":{"role":"assistant","content":"Hi"},'
        '"logprobs":{"content":[{"token":"Hi","logprob":' + constant + ","
        '"bytes":[72,105],"top_logprobs":[]}]}}],'
        '"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}'
    )


def _chat_with_tool_arguments(arguments: str) -> httpx.Response:
    call = {"id": "t1", "type": "function", "function": {"name": "f", "arguments": arguments}}
    return httpx.Response(
        200,
        json={
            "id": "c",
            "object": "chat.completion",
            "created": 1,
            "model": SERVED,
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                }
            ],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
        },
    )


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_an_openai_reply_holding_a_non_finite_logprob_keeps_its_metered_event(
    constant: str, sensored: Session
) -> None:
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_chat_with_logprob(constant)
        )
        openai.OpenAI(api_key="k", max_retries=0).chat.completions.create(
            model="gpt-4o-mini", messages=HI, logprobs=True
        )
    post = next(e for e in _sent(sensored) if e["event_type"] == "post_call")
    assert (post["tokens_input"], post["tokens_output"]) == (3, 1)
    assert post["model"] == SERVED
    assert post["has_content"] is False


def test_a_tool_call_whose_arguments_hold_nan_keeps_its_event_without_the_input(
    sensored: Session,
) -> None:
    """The arguments string is stored as the provider returned it on the
    post_call; the tool_call event's parsed input holds the NaN, so that
    event goes without its content and keeps its tool name."""
    arguments = '{"x": NaN, "y": Infinity}'
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=_chat_with_tool_arguments(arguments)
        )
        openai.OpenAI(api_key="k", max_retries=0).chat.completions.create(
            model="gpt-4o-mini",
            messages=HI,
            tools=[{"type": "function", "function": {"name": "f", "parameters": {}}}],
        )
    events = _sent(sensored)
    post = next(e for e in events if e["event_type"] == "post_call")
    tool = next(e for e in events if e["event_type"] == "tool_call")
    stored_call = post["content"]["response"]["choices"][0]["message"]["tool_calls"][0]
    assert stored_call["function"]["arguments"] == arguments
    assert tool["tool_name"] == "f"
    assert tool["has_content"] is False


def test_an_anthropic_reply_holding_nan_keeps_its_metered_events(sensored: Session) -> None:
    reply = _json_reply(
        '{"id":"m","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001",'
        '"content":[{"type":"tool_use","id":"t1","name":"f","input":{"x":NaN}}],'
        '"stop_reason":"tool_use","stop_sequence":null,'
        '"usage":{"input_tokens":3,"output_tokens":1}}'
    )
    with respx.mock(assert_all_called=False) as router:
        router.post("https://api.anthropic.com/v1/messages").mock(return_value=reply)
        anthropic.Anthropic(api_key="k", max_retries=0).messages.create(
            model="claude-haiku-4-5", max_tokens=8, messages=HI
        )
    events = _sent(sensored)
    post = next(e for e in events if e["event_type"] == "post_call")
    tool = next(e for e in events if e["event_type"] == "tool_call")
    assert (post["tokens_input"], post["tokens_output"]) == (3, 1)
    assert post["has_content"] is False
    assert tool["tool_name"] == "f"
    assert tool["has_content"] is False


@pytest.mark.parametrize("value", NON_FINITE, ids=NON_FINITE_IDS)
def test_a_sub_agent_body_holding_a_non_finite_float_is_dropped_and_its_event_sent(
    value: float, caplog: pytest.LogCaptureFixture
) -> None:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="non-finite",
        agent_type="production",
        capture_prompts=True,
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    body = {"state": {"score": value}, "text": "hand-off"}
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        session.emit_subagent_session_start(
            child_session_id="c-1",
            child_agent_id="agent-1",
            child_agent_name="parent/role",
            agent_role="role",
            incoming_message=SubagentMessage(body=body, captured_at="2026-11-18T00:00:00Z"),
        )
    starts = [c.args[0] for c in client.post_event.call_args_list]
    start = next(p for p in starts if p["event_type"] == "session_start")
    sent = _strict(serialize_event(dict(start)))
    assert sent.get("incoming_message") is None
    assert any("not JSON-encodable" in r.getMessage() for r in caplog.records)
