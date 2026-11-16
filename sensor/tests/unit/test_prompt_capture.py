"""Tests for prompt capture: extract_content on/off, payload correctness."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import anthropic
import httpx
import pytest
import respx

from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.interceptor.anthropic import SensorMessages
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.litellm import LitellmProvider
from flightdeck_sensor.providers.openai import OpenAIProvider
from flightdeck_sensor.transport.body_limit import serialize_event
from flightdeck_sensor.transport.client import ControlPlaneClient


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


# An Anthropic ``system`` in the form prompt caching uses: a list of text
# blocks, a breakpoint on the first.
SYSTEM_BLOCKS: list[dict[str, Any]] = [
    {
        "type": "text",
        "text": "You are a terse assistant. SECRET-SYSTEM-BLOCK-3f1a",
        "cache_control": {"type": "ephemeral"},
    },
    {"type": "text", "text": "Answer in one word."},
]


def test_capture_on_anthropic_keeps_a_block_list_system() -> None:
    """A ``system`` given as a list of content blocks is stored as that
    list: the same blocks in the same order, ``cache_control`` kept,
    never joined into one string."""
    provider = AnthropicProvider(capture_prompts=True)
    sent = copy.deepcopy(SYSTEM_BLOCKS)
    result = provider.extract_content(
        {
            "model": "claude-haiku-4-5",
            "system": sent,
            "messages": [{"role": "user", "content": "Capital of France?"}],
        },
        _MockResponse(),
    )

    assert result is not None
    assert isinstance(result.system, list)
    assert result.system == SYSTEM_BLOCKS
    assert sent == SYSTEM_BLOCKS  # the caller's list is left as it was


ANTHROPIC_URL = "https://api.anthropic.com"


def _sensor_session(capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


def _enqueued(session: Session, event_type: str) -> list[dict[str, Any]]:
    queue = session.event_queue
    assert isinstance(queue, MagicMock)
    return [
        c.args[0] for c in queue.enqueue.call_args_list if c.args[0].get("event_type") == event_type
    ]


@pytest.mark.parametrize("capture", [True, False])
@respx.mock(base_url=ANTHROPIC_URL)
def test_anthropic_call_with_a_block_list_system_sends_the_list(
    respx_mock: respx.MockRouter, capture: bool
) -> None:
    """Through the real SDK client: the post_call's content carries
    ``system`` as the list the provider received, and the body the sensor
    POSTs holds it as a JSON array with each block's ``cache_control``.
    With capture off no block's text reaches any event."""
    route = respx_mock.post("/v1/messages").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-haiku-4-5",
                "content": [{"type": "text", "text": "Paris."}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 1200,
                    "output_tokens": 3,
                    "cache_creation_input_tokens": 1100,
                    "cache_read_input_tokens": 0,
                },
            },
        )
    )
    session = _sensor_session(capture)
    messages = SensorMessages(
        anthropic.Anthropic(api_key="sk-test", max_retries=0).messages,
        session,
        AnthropicProvider(capture_prompts=capture),
    )
    messages.create(
        model="claude-haiku-4-5",
        max_tokens=16,
        system=copy.deepcopy(SYSTEM_BLOCKS),  # type: ignore[arg-type]
        messages=[{"role": "user", "content": "Capital of France?"}],
    )

    assert json.loads(route.calls.last.request.content)["system"] == SYSTEM_BLOCKS
    (post_call,) = _enqueued(session, "post_call")
    if not capture:
        assert not post_call["has_content"]
        assert post_call.get("content") is None
        assert "SECRET-SYSTEM-BLOCK" not in json.dumps(post_call, default=str)
        return
    assert post_call["has_content"] is True
    assert post_call["content"]["system"] == SYSTEM_BLOCKS
    wire = json.loads(serialize_event(post_call))
    assert wire["content"]["system"] == SYSTEM_BLOCKS
    assert wire["content"]["system"][0]["cache_control"] == {"type": "ephemeral"}


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
# Embeddings content capture.
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
        kwargs,
        MagicMock(),
        event_type=EventType.EMBEDDINGS,
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
        kwargs,
        MagicMock(),
        event_type=EventType.EMBEDDINGS,
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
        kwargs,
        MagicMock(),
        event_type=EventType.EMBEDDINGS,
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
        kwargs,
        MagicMock(),
        event_type=EventType.EMBEDDINGS,
    )
    assert pc is not None
    assert pc.input == ["a", "b"]


def test_chat_default_event_type_unchanged() -> None:
    """``extract_content`` without an explicit ``event_type`` falls
    back to chat-shaped extraction. Callers
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
