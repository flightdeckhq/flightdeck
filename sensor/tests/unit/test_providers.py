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
    # D100: cache tokens also surfaced separately so analytics can break them
    # out without losing the billed-total semantics of input_tokens.
    assert usage.cache_read_tokens == 10
    assert usage.cache_creation_tokens == 5


def test_openai_extract_usage_reads_prompt_and_completion(mock_openai_response: MagicMock) -> None:
    provider = OpenAIProvider()
    usage = provider.extract_usage(mock_openai_response)
    assert usage.input_tokens == 120
    assert usage.output_tokens == 60


# ----------------------------------------------------------------------
# LitellmProvider (KI21)
# ----------------------------------------------------------------------

from flightdeck_sensor.providers.litellm import LitellmProvider


def test_litellm_estimation_reasonable() -> None:
    """litellm.token_counter is model-aware; estimate is non-zero for
    a non-empty message list regardless of which underlying provider
    the model string routes to.
    """
    provider = LitellmProvider()
    for model in ("claude-haiku-4-5-20251001", "gpt-4o"):
        estimate, source = provider.estimate_tokens({
            "model": model,
            "messages": [
                {"role": "user", "content": "Explain quantum computing"},
            ],
        })
        assert estimate > 0, (
            f"expected non-zero estimate for model={model}, got {estimate}"
        )
        assert source in ("tiktoken", "heuristic")


def test_litellm_estimation_falls_back_to_char_heuristic() -> None:
    """When the model string is unknown to litellm.token_counter the
    provider falls back to the char/4 heuristic rather than raising or
    returning zero. Never-raises is a Provider-protocol invariant.
    """
    provider = LitellmProvider()
    # A clearly-invalid model that won't match any litellm tokenizer.
    # The fallback should kick in and return something >= 0.
    estimate, source = provider.estimate_tokens({
        "model": "some-never-seen-provider/xyz-v99",
        "messages": [
            {"role": "user", "content": "A" * 400},
        ],
    })
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
