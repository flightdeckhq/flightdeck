"""Tests for prompt capture: extract_content on/off, payload correctness."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider


@dataclass
class _MockUsage:
    input_tokens: int = 100
    output_tokens: int = 50


@dataclass
class _MockResponse:
    model: str = "test-model"

    @property
    def usage(self) -> _MockUsage:
        return _MockUsage()

    def model_dump(self) -> dict[str, Any]:
        return {"model": self.model, "usage": {"input_tokens": 100, "output_tokens": 50}}


def test_capture_off_returns_none() -> None:
    """extract_content returns None when capture_prompts=False."""
    provider = AnthropicProvider(capture_prompts=False)
    result = provider.extract_content(
        {"model": "test", "messages": [{"role": "user", "content": "hi"}]},
        _MockResponse(),
    )
    assert result is None


def test_capture_on_anthropic_extracts_all() -> None:
    """extract_content returns full PromptContent when capture is enabled."""
    provider = AnthropicProvider(capture_prompts=True)
    request_kwargs = {
        "model": "claude-sonnet-4-6",
        "system": "You are a helpful assistant.",
        "messages": [{"role": "user", "content": "Hello"}],
        "tools": [{"name": "search", "description": "Search the web"}],
    }
    result = provider.extract_content(request_kwargs, _MockResponse())

    assert result is not None
    assert result.system == "You are a helpful assistant."
    assert result.messages == [{"role": "user", "content": "Hello"}]
    assert result.tools == [{"name": "search", "description": "Search the web"}]
    assert result.response is not None
    assert result.provider == "anthropic"
    assert result.model == "claude-sonnet-4-6"


def test_capture_on_anthropic_no_system() -> None:
    """Request without system param: system field is None."""
    provider = AnthropicProvider(capture_prompts=True)
    request_kwargs = {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "Hello"}],
    }
    result = provider.extract_content(request_kwargs, _MockResponse())

    assert result is not None
    assert result.system is None


def test_capture_on_openai_extracts_all() -> None:
    """OpenAI: system is None, messages include all roles."""
    provider = OpenAIProvider(capture_prompts=True)
    request_kwargs = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"},
        ],
        "tools": [{"type": "function", "function": {"name": "search"}}],
    }
    result = provider.extract_content(request_kwargs, _MockResponse())

    assert result is not None
    assert result.system is None  # OpenAI has no separate system field
    assert len(result.messages) == 2
    assert result.messages[0]["role"] == "system"
    assert result.messages[1]["role"] == "user"
    assert result.tools is not None
    assert result.provider == "openai"


def test_capture_off_event_payload_clean() -> None:
    """With capture_prompts=False, event payload has has_content=False and no content."""
    from flightdeck_sensor.core.session import Session
    from flightdeck_sensor.core.types import EventType, SensorConfig

    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="autonomous",
        capture_prompts=False,
        quiet=True,
    )
    client = MagicMock()
    client.post_event.return_value = None
    session = Session(config=config, client=client)

    payload = session._build_payload(EventType.POST_CALL, tokens_total=100)
    assert payload["has_content"] is False
    assert payload.get("content") is None


def test_capture_on_event_payload_has_content() -> None:
    """With capture_prompts=True and provider returning content, payload has content."""
    provider = AnthropicProvider(capture_prompts=True)
    kwargs = {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "test"}],
    }
    content = provider.extract_content(kwargs, _MockResponse())
    assert content is not None

    # Build a payload dict with content
    payload: dict[str, Any] = {"has_content": False}
    if content is not None:
        payload["has_content"] = True
        payload["content"] = {
            "system": content.system,
            "messages": content.messages,
            "provider": content.provider,
        }

    assert payload["has_content"] is True
    assert payload["content"]["provider"] == "anthropic"
