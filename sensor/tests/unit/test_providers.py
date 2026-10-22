"""Tests for AnthropicProvider and OpenAIProvider."""

from __future__ import annotations

import typing
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from flightdeck_sensor.core.types import TokenUsage
from flightdeck_sensor.providers.anthropic import DEFAULT_COUNT_TOKENS_MODEL, AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider


def test_anthropic_estimation_reasonable() -> None:
    provider = AnthropicProvider()
    kwargs = {
        "model": "claude-sonnet-4-20250514",
        "messages": [{"role": "user", "content": "Explain quantum computing in detail"}],
        "system": "You are a helpful assistant",
    }
    estimate, source = provider.estimate_tokens(kwargs)
    assert estimate > 0
    assert source in ("tiktoken", "heuristic")


def test_openai_estimation_reasonable() -> None:
    provider = OpenAIProvider()
    kwargs = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": "Explain quantum computing in detail"},
        ],
    }
    estimate, source = provider.estimate_tokens(kwargs)
    assert estimate > 0
    assert source in ("tiktoken", "heuristic")


def test_extract_usage_returns_zero_on_exception() -> None:
    anthropic = AnthropicProvider()
    openai = OpenAIProvider()
    assert anthropic.extract_usage(None) == TokenUsage(0, 0)
    assert openai.extract_usage(None) == TokenUsage(0, 0)
    assert anthropic.extract_usage("not a response") == TokenUsage(0, 0)
    assert openai.extract_usage("not a response") == TokenUsage(0, 0)


def test_get_model_returns_empty_on_exception() -> None:
    anthropic = AnthropicProvider()
    openai = OpenAIProvider()
    assert anthropic.get_model({}) == ""
    assert openai.get_model({}) == ""
    assert anthropic.get_model(None) == ""  # type: ignore[arg-type]
    assert openai.get_model(None) == ""  # type: ignore[arg-type]


def test_anthropic_extract_usage_sums_cache_tokens(mock_anthropic_response: MagicMock) -> None:
    provider = AnthropicProvider()
    usage = provider.extract_usage(mock_anthropic_response)
    # input_tokens=100 + cache_read=10 + cache_write=5 = 115
    assert usage.input_tokens == 115
    assert usage.output_tokens == 50
    # Cache tokens also surfaced separately so analytics can break them
    # out without losing the billed-total semantics of input_tokens.
    assert usage.cache_read_tokens == 10
    assert usage.cache_creation_tokens == 5


def test_openai_extract_usage_reads_prompt_and_completion(mock_openai_response: MagicMock) -> None:
    provider = OpenAIProvider()
    usage = provider.extract_usage(mock_openai_response)
    assert usage.input_tokens == 120
    assert usage.output_tokens == 60


# ----------------------------------------------------------------------
# LitellmProvider
# ----------------------------------------------------------------------

from flightdeck_sensor.providers.litellm import LitellmProvider  # noqa: E402


def test_litellm_estimation_reasonable() -> None:
    """litellm.token_counter is model-aware; estimate is non-zero for
    a non-empty message list regardless of which underlying provider
    the model string routes to.
    """
    provider = LitellmProvider()
    for model in ("claude-haiku-4-5-20251001", "gpt-4o"):
        estimate, source = provider.estimate_tokens(
            {
                "model": model,
                "messages": [
                    {"role": "user", "content": "Explain quantum computing"},
                ],
            }
        )
        assert estimate > 0, f"expected non-zero estimate for model={model}, got {estimate}"
        assert source in ("tiktoken", "heuristic")


def test_litellm_estimation_falls_back_to_char_heuristic() -> None:
    """When the model string is unknown to litellm.token_counter the
    provider falls back to the char/4 heuristic rather than raising or
    returning zero. Never-raises is a Provider-protocol invariant.
    """
    provider = LitellmProvider()
    # A clearly-invalid model that won't match any litellm tokenizer.
    # The fallback should kick in and return something >= 0.
    estimate, source = provider.estimate_tokens(
        {
            "model": "some-never-seen-provider/xyz-v99",
            "messages": [
                {"role": "user", "content": "A" * 400},
            ],
        }
    )
    assert estimate >= 0
    assert source in ("tiktoken", "heuristic", "none")


def test_litellm_extract_usage_reads_prompt_and_completion() -> None:
    """Litellm ModelResponse carries OpenAI-shaped usage; extract_usage
    reads prompt_tokens / completion_tokens symmetrically.
    """
    provider = LitellmProvider()
    response = MagicMock()
    response.usage = MagicMock()
    response.usage.prompt_tokens = 42
    response.usage.completion_tokens = 17
    usage = provider.extract_usage(response)
    assert usage.input_tokens == 42
    assert usage.output_tokens == 17


def test_litellm_extract_usage_returns_zero_on_exception() -> None:
    """Provider-protocol invariant: never raises. None, bad shapes,
    missing usage all return TokenUsage(0, 0).
    """
    provider = LitellmProvider()
    assert provider.extract_usage(None) == TokenUsage(0, 0)
    assert provider.extract_usage("not a response") == TokenUsage(0, 0)
    no_usage = MagicMock(spec=[])  # spec=[] forbids every attribute access
    assert provider.extract_usage(no_usage) == TokenUsage(0, 0)


def test_litellm_get_model_returns_empty_on_exception() -> None:
    provider = LitellmProvider()
    assert provider.get_model({}) == ""
    assert provider.get_model(None) == ""  # type: ignore[arg-type]
    assert provider.get_model({"model": "claude-haiku-4-5-20251001"}) == (
        "claude-haiku-4-5-20251001"
    )


def test_litellm_extract_tool_invocations_parses_openai_shape() -> None:
    """litellm normalises tool_calls into OpenAI format; extractor
    handles both MagicMock-attribute and dict-literal shapes.
    """
    provider = LitellmProvider()

    # Attribute-style shape (real ModelResponse objects)
    tc = MagicMock()
    tc.id = "call_abc"
    tc.function = MagicMock()
    tc.function.name = "get_weather"
    tc.function.arguments = '{"city": "SF"}'
    message = MagicMock()
    message.tool_calls = [tc]
    choice = MagicMock()
    choice.message = message
    response = MagicMock()
    response.choices = [choice]

    invocations = provider.extract_tool_invocations(response)
    assert len(invocations) == 1
    assert invocations[0].name == "get_weather"
    assert invocations[0].tool_input == {"city": "SF"}
    assert invocations[0].tool_id == "call_abc"


def test_litellm_extract_content_respects_capture_flag() -> None:
    """extract_content returns None when capture_prompts=False; returns
    PromptContent with provider='litellm' when enabled.
    """
    off = LitellmProvider(capture_prompts=False)
    assert off.extract_content({}, MagicMock()) is None

    on = LitellmProvider(capture_prompts=True)
    response = MagicMock()
    response.model_dump = MagicMock(return_value={"id": "resp-1"})
    content = on.extract_content(
        {
            "model": "claude-haiku-4-5-20251001",
            "messages": [{"role": "user", "content": "hi"}],
        },
        response,
    )
    assert content is not None
    assert content.provider == "litellm"
    assert content.model == "claude-haiku-4-5-20251001"
    assert content.messages == [{"role": "user", "content": "hi"}]
    assert content.response == {"id": "resp-1"}


def test_cache_counts_that_are_not_integers_are_ignored() -> None:
    """A provider-shaped stand-in or a malformed counter must not become a
    cache count: only real integers are read, everything else is zero."""
    import types

    for bad in (True, "12", 3.5, MagicMock(), None):
        details = types.SimpleNamespace(cached_tokens=bad, cache_creation_tokens=bad)
        usage = types.SimpleNamespace(
            prompt_tokens=10,
            completion_tokens=4,
            prompt_tokens_details=details,
            cache_read_input_tokens=bad,
            cache_creation_input_tokens=bad,
        )
        result = LitellmProvider().extract_usage(types.SimpleNamespace(usage=usage))
        assert result.input_tokens == 10, bad
        assert result.output_tokens == 4, bad
        assert result.cache_read_tokens == 0, bad
        assert result.cache_creation_tokens == 0, bad


# ----------------------------------------------------------------------
# count_tokens default model: must be a served, priced model id
# ----------------------------------------------------------------------

# pricing.yaml lives at the repo root; tests/unit/<file> is three levels
# below sensor/, which is one below the root.
_PRICING_YAML = Path(__file__).resolve().parents[3] / "pricing.yaml"


def _pricing_row(model_id: str) -> dict[str, str] | None:
    """The pricing.yaml row for ``model_id`` as a flat mapping, read with a
    line scan so the test needs no YAML dependency. ``None`` when absent."""
    rows: list[dict[str, str]] = []
    for raw in _PRICING_YAML.read_text().splitlines():
        line = raw.strip()
        if line.startswith("- model_id:"):
            rows.append({"model_id": line.split(":", 1)[1].strip()})
        elif rows and ":" in line and not line.startswith("#") and not raw.startswith("#"):
            key, value = line.split(":", 1)
            rows[-1].setdefault(key.strip(), value.strip())
    return next((row for row in rows if row["model_id"] == model_id), None)


def test_default_count_tokens_model_is_priced_and_not_retired() -> None:
    """A retired default makes count_tokens 404 and every estimate for a
    model-less request silently degrade to the char heuristic. The row
    must exist and must not be marked retired or deprecated."""
    assert _PRICING_YAML.is_file(), f"pricing.yaml not found at {_PRICING_YAML}"
    row = _pricing_row(DEFAULT_COUNT_TOKENS_MODEL)
    assert row is not None, f"{DEFAULT_COUNT_TOKENS_MODEL} is not priced in pricing.yaml"
    assert row.get("provider") == "anthropic"
    notes = row.get("notes", "").lower()
    for marker in ("retired", "deprecated", "retires", "shutdown"):
        assert marker not in notes, f"{DEFAULT_COUNT_TOKENS_MODEL} is marked {marker!r}: {notes}"


def test_default_count_tokens_model_is_in_the_installed_sdk_model_list() -> None:
    anthropic_types = pytest.importorskip("anthropic.types")
    literal_values: set[str] = set()
    for member in typing.get_args(anthropic_types.Model):
        literal_values.update(v for v in typing.get_args(member) if isinstance(v, str))
    assert DEFAULT_COUNT_TOKENS_MODEL in literal_values


def test_estimate_tokens_names_the_default_model_when_request_has_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = MagicMock()
    client.messages.count_tokens.return_value.input_tokens = 7
    monkeypatch.setattr(AnthropicProvider, "_client", client)
    estimate, source = AnthropicProvider().estimate_tokens(
        {"messages": [{"role": "user", "content": "hi"}]}
    )
    assert (estimate, source) == (7, "tiktoken")
    assert client.messages.count_tokens.call_args.kwargs["model"] == DEFAULT_COUNT_TOKENS_MODEL


def test_estimate_tokens_prefers_the_request_model_over_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = MagicMock()
    client.messages.count_tokens.return_value.input_tokens = 3
    monkeypatch.setattr(AnthropicProvider, "_client", client)
    AnthropicProvider().estimate_tokens({"model": "claude-haiku-4-5", "messages": []})
    assert client.messages.count_tokens.call_args.kwargs["model"] == "claude-haiku-4-5"


# ----------------------------------------------------------------------
# Stop-reason readers
# ----------------------------------------------------------------------


class _Plain:
    """Attribute bag; a bare MagicMock would answer every getattr."""

    def __init__(self, **attrs: object) -> None:
        self.__dict__.update(attrs)


def test_anthropic_response_stop_reason_reads_a_message() -> None:
    provider = AnthropicProvider()
    assert provider.response_stop_reason(_Plain(stop_reason="refusal")) == "refusal"
    assert provider.response_stop_reason(_Plain(stop_reason=None)) is None
    assert provider.response_stop_reason(_Plain()) is None
    assert provider.response_stop_reason(_Plain(stop_reason=42)) is None
    assert provider.response_stop_reason(None) is None


def test_anthropic_response_stop_reason_parses_raw_wrappers_and_helper_snapshots() -> None:
    provider = AnthropicProvider()
    wrapper = _Plain(parse=lambda: _Plain(stop_reason="model_context_window_exceeded"))
    assert provider.response_stop_reason(wrapper) == "model_context_window_exceeded"
    helper = _Plain(current_message_snapshot=_Plain(stop_reason="refusal"))
    assert provider.response_stop_reason(helper) == "refusal"


def test_anthropic_stop_reason_from_stream_chunk_reads_message_delta_only() -> None:
    provider = AnthropicProvider()
    delta = _Plain(type="message_delta", delta=_Plain(stop_reason="refusal"))
    assert provider.stop_reason_from_stream_chunk(delta) == "refusal"
    unset = _Plain(type="message_delta", delta=_Plain(stop_reason=None))
    assert provider.stop_reason_from_stream_chunk(unset) is None
    text = _Plain(type="content_block_delta", delta=_Plain(text="hi"))
    assert provider.stop_reason_from_stream_chunk(text) is None
    assert provider.stop_reason_from_stream_chunk(None) is None


def test_anthropic_response_stop_reason_fails_open_on_raising_accessors() -> None:
    provider = AnthropicProvider()

    class _RaisingParse:
        def parse(self) -> Any:
            raise RuntimeError("parse detonates")

    class _RaisingStopReason:
        @property
        def stop_reason(self) -> str:
            raise RuntimeError("stop_reason detonates")

    class _RaisingSnapshot:
        stop_reason = "refusal"

        @property
        def current_message_snapshot(self) -> Any:
            raise RuntimeError("snapshot detonates")

    assert provider.response_stop_reason(_RaisingParse()) is None
    assert provider.response_stop_reason(_RaisingStopReason()) is None
    # A snapshot that cannot be read leaves the object itself to answer.
    assert provider.response_stop_reason(_RaisingSnapshot()) == "refusal"


def test_adapters_carry_their_wire_names() -> None:
    assert AnthropicProvider.name == "anthropic"
    assert OpenAIProvider.name == "openai"
    assert LitellmProvider.name == "litellm"


def _chat_completion(finish_reason: str, refusal: str | None = None) -> Any:
    from openai.types.chat import ChatCompletion

    return ChatCompletion.model_validate(
        {
            "id": "c",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-5.5",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish_reason,
                    "message": {"role": "assistant", "content": None, "refusal": refusal},
                }
            ],
        }
    )


def _responses_dict(status: str, reason: str | None) -> dict[str, Any]:
    return {
        "id": "r",
        "object": "response",
        "created_at": 1.0,
        "model": "gpt-5.5",
        "status": status,
        "output": [],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "incomplete_details": {"reason": reason} if reason else None,
    }


def test_openai_response_stop_reason_reads_chat_finish_reason_and_refusal() -> None:
    provider = OpenAIProvider()
    assert provider.response_stop_reason(_chat_completion("content_filter")) == "content_filter"
    assert provider.response_stop_reason(_chat_completion("stop", refusal="No.")) == "refusal"
    assert provider.response_stop_reason(_chat_completion("stop")) == "stop"
    assert provider.response_stop_reason(_chat_completion("length")) == "length"
    # An Anthropic-shaped object, an embeddings response, nothing at all.
    assert provider.response_stop_reason(_Plain(stop_reason="refusal")) is None
    assert provider.response_stop_reason(_Plain(data=[], usage=_Plain(prompt_tokens=1))) is None
    assert provider.response_stop_reason(None) is None


def test_openai_response_stop_reason_reads_incomplete_responses() -> None:
    from openai.types.responses import Response

    provider = OpenAIProvider()
    filtered = Response.model_validate(_responses_dict("incomplete", "content_filter"))
    assert provider.response_stop_reason(filtered) == "content_filter"
    truncated = Response.model_validate(_responses_dict("incomplete", "max_output_tokens"))
    assert provider.response_stop_reason(truncated) == "max_output_tokens"
    done = Response.model_validate(_responses_dict("completed", None))
    assert provider.response_stop_reason(done) is None


def test_openai_response_stop_reason_parses_raw_wrappers() -> None:
    provider = OpenAIProvider()
    wrapper = _Plain(parse=lambda: _chat_completion("content_filter"))
    assert provider.response_stop_reason(wrapper) == "content_filter"


def test_openai_stop_reason_from_stream_chunk() -> None:
    from openai.types.chat import ChatCompletionChunk
    from openai.types.responses import ResponseIncompleteEvent

    provider = OpenAIProvider()

    def chunk(finish_reason: str | None, content: str | None = None) -> ChatCompletionChunk:
        return ChatCompletionChunk.model_validate(
            {
                "id": "c",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "gpt-5.5",
                "choices": [
                    {"index": 0, "delta": {"content": content}, "finish_reason": finish_reason}
                ],
            }
        )

    assert provider.stop_reason_from_stream_chunk(chunk("content_filter")) == "content_filter"
    assert provider.stop_reason_from_stream_chunk(chunk(None, "hi")) is None
    assert provider.stop_reason_from_stream_chunk(chunk("stop")) == "stop"
    incomplete = ResponseIncompleteEvent.model_validate(
        {
            "type": "response.incomplete",
            "sequence_number": 7,
            "response": _responses_dict("incomplete", "content_filter"),
        }
    )
    assert provider.stop_reason_from_stream_chunk(incomplete) == "content_filter"
    assert provider.stop_reason_from_stream_chunk(_Plain(type="response.completed")) is None
    assert provider.stop_reason_from_stream_chunk(None) is None


def test_litellm_stop_reason_reads_finish_reason_on_response_and_chunk() -> None:
    from litellm.types.utils import ModelResponse, ModelResponseStream

    provider = LitellmProvider()
    filtered = ModelResponse(
        choices=[
            {
                "index": 0,
                "finish_reason": "content_filter",
                "message": {"role": "assistant", "content": ""},
            }
        ]
    )
    assert provider.response_stop_reason(filtered) == "content_filter"
    done = ModelResponse(
        choices=[
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "hi"}}
        ]
    )
    assert provider.response_stop_reason(done) == "stop"
    chunk = ModelResponseStream(
        choices=[
            {
                "index": 0,
                "finish_reason": "content_filter",
                "delta": {"role": "assistant", "content": ""},
            }
        ]
    )
    assert provider.stop_reason_from_stream_chunk(chunk) == "content_filter"
    mid = ModelResponseStream(
        choices=[
            {"index": 0, "finish_reason": None, "delta": {"role": "assistant", "content": "hi"}}
        ]
    )
    assert provider.stop_reason_from_stream_chunk(mid) is None
    assert provider.response_stop_reason(_Plain(stop_reason="refusal")) is None
