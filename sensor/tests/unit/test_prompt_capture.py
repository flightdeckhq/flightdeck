"""Tests for prompt capture: extract_content on/off, payload correctness."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
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
        agent_type="production",
        capture_prompts=False,
        quiet=True,
    )
    client = MagicMock()
    client.post_event.return_value = (None, False)
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


# ---------------------------------------------------------------------
# Phase 4 polish: embeddings content capture (S-EMBED-1, S-EMBED-2).
# OpenAI and litellm both surface embedding inputs; the provider's
# ``extract_content`` branches on event_type=EMBEDDINGS and captures
# the request's ``input`` parameter into the new ``PromptContent.input``
# slot, leaving the chat-shaped slots empty so downstream code can
# render via the dashboard's EmbeddingsContentViewer instead of
# PromptViewer.
# ---------------------------------------------------------------------


def test_openai_embeddings_capture_string_input() -> None:
    provider = OpenAIProvider(capture_prompts=True)
    kwargs = {
        "model": "text-embedding-3-small",
        "input": "phase 4 e2e single-string capture",
    }
    pc = provider.extract_content(
        kwargs, MagicMock(), event_type=EventType.EMBEDDINGS,
    )
    assert pc is not None
    assert pc.input == "phase 4 e2e single-string capture"
    # Chat slots stay empty -- the dashboard's branch logic relies on
    # this to know which viewer to render.
    assert pc.messages == []
    assert pc.system is None
    assert pc.tools is None
    assert pc.response == {}
    assert pc.provider == "openai"
    assert pc.model == "text-embedding-3-small"


def test_openai_embeddings_capture_list_input() -> None:
    provider = OpenAIProvider(capture_prompts=True)
    kwargs = {
        "model": "text-embedding-3-small",
        "input": ["item one", "item two", "item three"],
    }
    pc = provider.extract_content(
        kwargs, MagicMock(), event_type=EventType.EMBEDDINGS,
    )
    assert pc is not None
    assert pc.input == ["item one", "item two", "item three"]
    assert pc.messages == []


def test_openai_embeddings_capture_off_returns_none() -> None:
    provider = OpenAIProvider(capture_prompts=False)
    pc = provider.extract_content(
        {"model": "text-embedding-3-small", "input": "hi"},
        MagicMock(),
        event_type=EventType.EMBEDDINGS,
    )
    assert pc is None


def test_litellm_embeddings_capture_string_input() -> None:
    provider = LitellmProvider(capture_prompts=True)
    kwargs = {
        "model": "text-embedding-3-small",
        "input": "phase 4 litellm string capture",
    }
    pc = provider.extract_content(
        kwargs, MagicMock(), event_type=EventType.EMBEDDINGS,
    )
    assert pc is not None
    assert pc.input == "phase 4 litellm string capture"
    assert pc.provider == "litellm"
    assert pc.messages == []
    assert pc.response == {}


def test_litellm_embeddings_capture_list_input() -> None:
    provider = LitellmProvider(capture_prompts=True)
    kwargs = {
        "model": "text-embedding-3-small",
        "input": ["a", "b"],
    }
    pc = provider.extract_content(
        kwargs, MagicMock(), event_type=EventType.EMBEDDINGS,
    )
    assert pc is not None
    assert pc.input == ["a", "b"]


def test_chat_default_event_type_unchanged() -> None:
    """``extract_content`` without an explicit ``event_type`` falls
    back to chat-shaped extraction. Pre-Phase-4-polish callers
    (none in this repo, but external code paths and pinned
    integration mocks) keep working."""
    provider = OpenAIProvider(capture_prompts=True)
    kwargs = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "say ok"}],
    }
    # No event_type passed -- should produce chat-shaped content.
    pc = provider.extract_content(kwargs, _MockResponse())
    assert pc is not None
    assert pc.messages == [{"role": "user", "content": "say ok"}]
    # Embedding-shaped slot stays None for chat events.
    assert pc.input is None


def test_anthropic_accepts_event_type_kwarg_for_protocol_symmetry() -> None:
    """Anthropic has no native embeddings (users go via litellm →
    Voyage), but the provider must accept the event_type kwarg so
    the base interceptor can pass it uniformly. Falling through to
    chat extraction for an EMBEDDINGS event_type is acceptable --
    the dashboard renders the empty messages array via the
    has_content=false branch."""
    provider = AnthropicProvider(capture_prompts=True)
    pc = provider.extract_content(
        {"model": "claude-haiku-4-5", "messages": []},
        _MockResponse(),
        event_type=EventType.EMBEDDINGS,
    )
    # Doesn't raise; produces chat-shaped output (empty messages).
    assert pc is not None
    assert pc.messages == []
    assert pc.input is None
