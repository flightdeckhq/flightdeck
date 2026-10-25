"""The token, model and cost fields a post_call carries.

Each provider reads what its responses report beyond the basic token
counts (reasoning and one-hour cache shares, the served model, service
tier, speed, data residency, server-tool counters, a reported cost), the
endpoint settles the provider and the billing mode, and the interceptor
puts them on the wire only when known (ARCHITECTURE.md, POST /v1/events).
Responses are built from the real SDK types.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from anthropic.types import Message, RawMessageDeltaEvent, RawMessageStartEvent
from openai.types.chat import ChatCompletion, ChatCompletionChunk

import flightdeck_sensor
from flightdeck_sensor.core.exceptions import ConfigurationError
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import CallDetails, SensorConfig, TokenUsage
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.interceptor.anthropic import SensorMessages, _vertex_scope
from flightdeck_sensor.interceptor.platform import (
    endpoint_of,
    is_loopback_host,
    platform_for_host,
)
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.client import ControlPlaneClient

KW = {"model": "claude-sonnet-4-5", "messages": [{"role": "user", "content": "hi"}]}
OPENAI_KW = {"model": "gpt-5.1", "messages": [{"role": "user", "content": "hi"}]}


def _session(billing_mode: str | None = None) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        billing_mode=billing_mode,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None)
    return session


def _post_call(session: Session) -> dict[str, Any]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    (payload,) = [
        c.args[0]
        for c in queue.enqueue.call_args_list
        if c.args[0].get("event_type") == "post_call"
    ]
    return payload


def _anthropic_usage(**overrides: Any) -> dict[str, Any]:
    usage: dict[str, Any] = {
        "input_tokens": 100,
        "output_tokens": 400,
        "cache_read_input_tokens": 2000,
        "cache_creation_input_tokens": 600,
        "cache_creation": {"ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 400},
        "output_tokens_details": {"thinking_tokens": 150},
        "server_tool_use": {"web_search_requests": 2, "web_fetch_requests": 0},
        "service_tier": "standard",
        "speed": "fast",
        "inference_geo": "us",
    }
    usage.update(overrides)
    return usage


def _anthropic_message(**usage_overrides: Any) -> Message:
    return Message.model_validate(
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5-20250929",
            "content": [{"type": "text", "text": "Hello"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": _anthropic_usage(**usage_overrides),
        }
    )


class _FakeStream:
    """Iterable context manager with ``close()``, the shape of
    ``anthropic.Stream``."""

    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __enter__(self) -> _FakeStream:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __iter__(self) -> Any:
        return iter(self._events)

    def close(self) -> None:
        pass


# ----- Anthropic ---------------------------------------------------------


def test_anthropic_call_carries_every_reported_field() -> None:
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_anthropic_message())
    provider = AnthropicProvider(platform="bedrock", inference_scope="regional")
    SensorMessages(real, session, provider).create(**KW)

    pc = _post_call(session)
    assert pc["model_requested"] == "claude-sonnet-4-5"
    assert pc["model_served"] == "claude-sonnet-4-5-20250929"
    assert pc["provider"] == "anthropic"
    assert pc["billing_mode"] == "metered"
    assert pc["tokens_reasoning"] == 150
    assert pc["tokens_cache_creation"] == 600
    assert pc["tokens_cache_creation_1h"] == 400
    assert pc["service_tier"] == "standard"
    assert pc["speed"] == "fast"
    assert pc["inference_geo"] == "us"
    assert pc["inference_scope"] == "regional"
    assert pc["server_tool_use"] == {"web_search_requests": 2}
    assert pc["stop_reason"] == "end_turn"
    assert pc["provider_metadata"]["platform"] == "bedrock"
    assert "cost_reported" not in pc and "cost_source" not in pc


def test_anthropic_stream_folds_fields_from_its_events() -> None:
    start = _anthropic_message(
        output_tokens=1,
        output_tokens_details=None,
        server_tool_use=None,
    ).model_dump()
    start["content"] = []
    start["stop_reason"] = None
    events = [
        RawMessageStartEvent.model_validate({"type": "message_start", "message": start}),
        RawMessageDeltaEvent.model_validate(
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {
                    "output_tokens": 400,
                    "output_tokens_details": {"thinking_tokens": 150},
                    "server_tool_use": {"web_search_requests": 3, "web_fetch_requests": 0},
                },
            }
        ),
    ]
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=_FakeStream(events))
    list(SensorMessages(real, session, AnthropicProvider()).create(stream=True, **KW))

    pc = _post_call(session)
    assert pc["model_served"] == "claude-sonnet-4-5-20250929"
    assert pc["tokens_output"] == 400
    assert pc["tokens_reasoning"] == 150
    assert pc["tokens_cache_creation_1h"] == 400
    assert pc["service_tier"] == "standard"
    assert pc["speed"] == "fast"
    assert pc["server_tool_use"] == {"web_search_requests": 3}
    assert pc["stop_reason"] == "end_turn"


def test_unreported_fields_stay_off_the_wire() -> None:
    message = Message.model_validate(
        {
            "id": "msg_2",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [{"type": "text", "text": "Hi"}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 5, "output_tokens": 2},
        }
    )
    session = _session()
    real = MagicMock()
    real.create = MagicMock(return_value=message)
    SensorMessages(real, session, AnthropicProvider()).create(**KW)

    pc = _post_call(session)
    for key in (
        "tokens_reasoning",
        "tokens_cache_creation_1h",
        "service_tier",
        "speed",
        "inference_geo",
        "inference_scope",
        "server_tool_use",
        "cost_reported",
    ):
        assert key not in pc, key


def test_a_share_larger_than_its_total_is_left_out() -> None:
    # Ingestion rejects reasoning > output and 1h > cache writes; the
    # sensor drops such a share rather than lose the whole event.
    session = _session()
    real = MagicMock()
    real.create = MagicMock(
        return_value=_anthropic_message(
            output_tokens=10,
            cache_creation_input_tokens=100,
        )
    )
    SensorMessages(real, session, AnthropicProvider()).create(**KW)

    pc = _post_call(session)
    assert pc["tokens_output"] == 10
    assert "tokens_reasoning" not in pc
    assert "tokens_cache_creation_1h" not in pc


def test_vertex_scope_follows_the_client_region() -> None:
    assert _vertex_scope(MagicMock(region="global"), "vertex") == "global"
    assert _vertex_scope(MagicMock(region="us-east5"), "vertex") == "regional"
    assert _vertex_scope(MagicMock(region=None), "vertex") is None
    assert _vertex_scope(MagicMock(region="us-east5"), "bedrock") is None


# ----- OpenAI -------------------------------------------------------------


def _chat_completion(model: str = "gpt-5.1-2025-11-13") -> ChatCompletion:
    return ChatCompletion.model_validate(
        {
            "id": "chatcmpl_1",
            "object": "chat.completion",
            "created": 1,
            "model": model,
            "service_tier": "flex",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "ok"},
                }
            ],
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 30,
                "total_tokens": 80,
                "completion_tokens_details": {"reasoning_tokens": 12},
            },
        }
    )


@pytest.mark.parametrize(
    ("platform", "local", "provider", "billing"),
    [
        ("openai", False, "openai", "metered"),
        ("azure", False, "openai", "metered"),
        ("api.x.ai", False, None, "metered"),
        ("localhost", True, None, "local"),
    ],
)
def test_openai_call_fields_follow_the_endpoint(
    platform: str, local: bool, provider: str | None, billing: str
) -> None:
    session = _session()
    base._post_call(
        session,
        OpenAIProvider(platform=platform, local=local),
        _chat_completion(),
        10,
        5,
        OPENAI_KW,
    )
    pc = _post_call(session)
    assert pc.get("provider") == provider
    assert pc["billing_mode"] == billing
    assert pc["provider_metadata"]["platform"] == platform
    assert pc["model_requested"] == "gpt-5.1"
    assert pc["model_served"] == "gpt-5.1-2025-11-13"
    assert pc["service_tier"] == "flex"
    assert pc["tokens_reasoning"] == 12
    assert pc["stop_reason"] == "stop"


def test_openai_stream_chunk_details() -> None:
    chunk = ChatCompletionChunk.model_validate(
        {
            "id": "chatcmpl_1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-5.1-2025-11-13",
            "service_tier": "priority",
            "choices": [],
        }
    )
    details = OpenAIProvider().call_details_from_stream_chunk(chunk)
    assert details == CallDetails(model_served="gpt-5.1-2025-11-13", service_tier="priority")


def test_configured_billing_mode_wins() -> None:
    session = _session(billing_mode="subscription")
    base._post_call(
        session,
        OpenAIProvider(platform="localhost", local=True),
        _chat_completion(),
        10,
        5,
        OPENAI_KW,
    )
    assert _post_call(session)["billing_mode"] == "subscription"


# ----- litellm ------------------------------------------------------------


def _litellm_response(cost: Any) -> Any:
    response = MagicMock()
    response.usage = None
    response.model = "claude-sonnet-4-5"
    response._hidden_params = {"response_cost": cost, "api_base": "https://user:pw@gw.example"}
    return response


def test_litellm_reports_its_computed_cost() -> None:
    details = LitellmProvider().call_details(_litellm_response(0.0042))
    assert details == CallDetails(
        model_served="claude-sonnet-4-5", cost_reported=0.0042, cost_source="agent"
    )


@pytest.mark.parametrize("cost", [None, -1, "0.1", True, 1_000_000])
def test_litellm_ignores_a_cost_ingestion_would_reject(cost: Any) -> None:
    details = LitellmProvider().call_details(_litellm_response(cost))
    assert details == CallDetails(model_served="claude-sonnet-4-5")


def test_litellm_never_sends_a_provider() -> None:
    session = _session()
    base._post_call(session, LitellmProvider(), _litellm_response(0.01), 10, 5, KW)
    pc = _post_call(session)
    assert "provider" not in pc
    assert pc["cost_reported"] == 0.01
    assert pc["cost_source"] == "agent"
    assert "gw.example" not in repr(pc)


# ----- shared pieces ------------------------------------------------------


def test_call_details_merge() -> None:
    first = CallDetails(model_served="m", service_tier="standard", server_tool_use={"a": 2})
    later = CallDetails(speed="fast", server_tool_use={"a": 1, "b": 4})
    assert first.merged(later) == CallDetails(
        model_served="m",
        service_tier="standard",
        speed="fast",
        server_tool_use={"a": 2, "b": 4},
    )


def test_merge_usage_keeps_the_optional_shares() -> None:
    start = TokenUsage(input_tokens=10, cache_creation_tokens=5, cache_creation_1h_tokens=5)
    delta = TokenUsage(output_tokens=20, reasoning_tokens=8)
    merged = base._merge_usage(start, delta)
    assert merged.reasoning_tokens == 8
    assert merged.cache_creation_1h_tokens == 5
    assert base._merge_usage(TokenUsage(), TokenUsage()).reasoning_tokens is None


@pytest.mark.parametrize(
    ("host", "platform"),
    [
        ("api.openai.com", "openai"),
        ("my-resource.openai.azure.com", "azure"),
        ("my-resource.cognitiveservices.azure.com", "azure"),
        ("api.anthropic.com", "anthropic"),
        ("openai.com.evil.example", "openai.com.evil.example"),
        ("localhost", "localhost"),
    ],
)
def test_platform_for_openai_and_azure_hosts(host: str, platform: str) -> None:
    assert platform_for_host(host) == platform


@pytest.mark.parametrize(
    ("host", "local"),
    [
        ("localhost", True),
        ("model.localhost", True),
        ("127.0.0.1", True),
        ("127.8.9.1", True),
        ("::1", True),
        ("[::1]", True),
        ("10.0.0.5", False),
        ("192.168.1.20", False),
        ("api.openai.com", False),
    ],
)
def test_loopback_hosts(host: str, local: bool) -> None:
    assert is_loopback_host(host) is local


def test_endpoint_of_reads_the_client_host() -> None:
    client = MagicMock()
    client.base_url.host = "127.0.0.1"
    assert endpoint_of(client, "openai").local is True
    assert endpoint_of(object(), "openai").platform == "openai"


# ----- init ---------------------------------------------------------------


def test_init_rejects_an_unknown_billing_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FLIGHTDECK_BILLING_MODE", raising=False)
    with pytest.raises(ConfigurationError, match="billing_mode"):
        flightdeck_sensor.init(server="http://localhost:9999", token="tok", billing_mode="free")


def test_billing_mode_env_overrides_the_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLIGHTDECK_BILLING_MODE", "bogus")
    with pytest.raises(ConfigurationError, match="bogus"):
        flightdeck_sensor.init(server="http://localhost:9999", token="tok", billing_mode="metered")
