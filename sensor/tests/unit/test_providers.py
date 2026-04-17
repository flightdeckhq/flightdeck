"""Tests for AnthropicProvider and OpenAIProvider."""

from __future__ import annotations

from unittest.mock import MagicMock

from flightdeck_sensor.core.types import TokenUsage
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.providers.openai import OpenAIProvider


def test_anthropic_estimation_reasonable() -> None:
    provider = AnthropicProvider()
    kwargs = {
        "model": "claude-sonnet-4-20250514",
        "messages": [{"role": "user", "content": "Explain quantum computing in detail"}],
        "system": "You are a helpful assistant",
    }
    estimate = provider.estimate_tokens(kwargs)
    assert estimate > 0


def test_openai_estimation_reasonable() -> None:
    provider = OpenAIProvider()
    kwargs = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": "Explain quantum computing in detail"},
        ],
    }
    estimate = provider.estimate_tokens(kwargs)
    assert estimate > 0


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
    # D098: cache tokens also surfaced separately so analytics can break them
    # out without losing the billed-total semantics of input_tokens.
    assert usage.cache_read_tokens == 10
    assert usage.cache_creation_tokens == 5


def test_openai_extract_usage_reads_prompt_and_completion(mock_openai_response: MagicMock) -> None:
    provider = OpenAIProvider()
    usage = provider.extract_usage(mock_openai_response)
    assert usage.input_tokens == 120
    assert usage.output_tokens == 60
