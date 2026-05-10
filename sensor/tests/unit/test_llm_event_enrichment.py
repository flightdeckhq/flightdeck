"""LLM family operator-actionable enrichment tests.

Covers pre_call / post_call / embeddings / llm_error payload
enrichment:

- pre_call: estimated_via, policy_decision_pre, model, tokens_input
- post_call + embeddings: estimated_via, provider_metadata,
  policy_decision_post (when crossed), output_dimensions (embeddings)
- embeddings + capture_prompts=True: embedding_output via event_content
- llm_error: retry_attempt, terminal
- Session.record_retry_attempt: bounded LRU at 256 entries
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import EventType, SensorConfig
from flightdeck_sensor.interceptor import base
from flightdeck_sensor.providers.anthropic import AnthropicProvider
from flightdeck_sensor.transport.client import ControlPlaneClient


def _make_session(
    *,
    token_limit: int | None = None,
    warn_at_pct: int = 80,
    block_at_pct: int = 100,
    capture_prompts: bool = False,
) -> tuple[Session, MagicMock, AnthropicProvider]:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
        capture_prompts=capture_prompts,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    session.policy = PolicyCache(
        token_limit=token_limit,
        warn_at_pct=warn_at_pct,
        block_at_pct=block_at_pct,
    )
    session.event_queue = MagicMock()
    return session, session.event_queue, AnthropicProvider()


def _events(eq: MagicMock, event_type: str) -> list[dict[str, Any]]:
    return [
        c[0][0]
        for c in eq.enqueue.call_args_list
        if c[0][0]["event_type"] == event_type
    ]


# --------------------------------------------------------------------------
# pre_call event emission
# --------------------------------------------------------------------------


def test_pre_call_event_carries_estimated_via_and_model() -> None:
    session, eq, provider = _make_session()
    base._pre_call(
        session, provider, {"model": "claude-sonnet-4-6"},
        estimated=42, estimated_via="tiktoken",
    )
    pre_calls = _events(eq, "pre_call")
    assert len(pre_calls) == 1
    e = pre_calls[0]
    assert e["estimated_via"] == "tiktoken"
    assert e["tokens_input"] == 42
    assert e["model"] == "claude-sonnet-4-6"
    assert "policy_decision_pre" not in e


def test_pre_call_event_omits_policy_decision_pre_on_allow() -> None:
    session, eq, provider = _make_session(token_limit=1000, warn_at_pct=80)
    session._tokens_used = 100
    base._pre_call(
        session, provider, {"model": "m"}, estimated=10, estimated_via="heuristic",
    )
    pre_calls = _events(eq, "pre_call")
    assert len(pre_calls) == 1
    assert "policy_decision_pre" not in pre_calls[0]


def test_pre_call_event_carries_policy_decision_pre_on_warn() -> None:
    session, eq, provider = _make_session(token_limit=100, warn_at_pct=50)
    session._tokens_used = 60
    base._pre_call(
        session, provider, {"model": "m"}, estimated=5, estimated_via="tiktoken",
    )
    pre_calls = _events(eq, "pre_call")
    assert len(pre_calls) == 1
    pdp = pre_calls[0].get("policy_decision_pre")
    assert pdp is not None
    assert pdp["decision"] == "warn"
    assert "warn threshold" in pdp["reason"]


def test_pre_call_event_carries_policy_decision_pre_on_block() -> None:
    session, eq, provider = _make_session(token_limit=100, block_at_pct=80)
    session._tokens_used = 80
    try:
        base._pre_call(
            session, provider, {"model": "m"},
            estimated=5, estimated_via="tiktoken",
        )
    except Exception:
        pass
    pre_calls = _events(eq, "pre_call")
    assert len(pre_calls) == 1
    pdp = pre_calls[0].get("policy_decision_pre")
    assert pdp is not None
    assert pdp["decision"] == "block"
    assert "block threshold" in pdp["reason"]


def test_pre_call_event_estimated_via_none_lands_when_estimator_failed() -> None:
    session, eq, provider = _make_session()
    base._pre_call(
        session, provider, {"model": "m"}, estimated=0, estimated_via="none",
    )
    pre_calls = _events(eq, "pre_call")
    assert len(pre_calls) == 1
    assert pre_calls[0]["estimated_via"] == "none"
    assert pre_calls[0]["tokens_input"] == 0


# --------------------------------------------------------------------------
# post_call enrichment
# --------------------------------------------------------------------------


def _mock_anthropic_response(
    input_tokens: int = 100, output_tokens: int = 50,
    headers: dict[str, str] | None = None,
) -> Any:
    """Plain object whose attributes match what AnthropicProvider reads.
    A bare MagicMock auto-generates child mocks for missing attrs,
    which then break arithmetic with int."""
    class _Usage:
        pass

    class _Resp:
        pass

    usage = _Usage()
    usage.input_tokens = input_tokens
    usage.output_tokens = output_tokens
    usage.cache_read_input_tokens = 0
    usage.cache_creation_input_tokens = 0
    resp = _Resp()
    resp.usage = usage
    resp.model = "claude-sonnet-4-6"
    resp.content = []
    resp.headers = headers
    return resp


def test_post_call_payload_carries_estimated_via_passthrough() -> None:
    session, eq, provider = _make_session()
    response = _mock_anthropic_response()
    base._post_call(
        session, provider, response,
        estimated=42, latency_ms=120, call_kwargs={"model": "m"},
        estimated_via="tiktoken",
    )
    posts = _events(eq, "post_call")
    assert len(posts) == 1
    assert posts[0]["estimated_via"] == "tiktoken"


def test_post_call_payload_carries_provider_metadata_when_headers_present() -> None:
    session, eq, provider = _make_session()
    headers = {
        "anthropic-ratelimit-tokens-remaining": "8000",
        "anthropic-ratelimit-requests-remaining": "42",
        "request-id": "req_abc123",
    }
    response = _mock_anthropic_response(headers=headers)
    base._post_call(
        session, provider, response,
        estimated=10, latency_ms=50, call_kwargs={"model": "m"},
        estimated_via="tiktoken",
    )
    posts = _events(eq, "post_call")
    pm = posts[0].get("provider_metadata")
    assert pm is not None
    assert pm["ratelimit_remaining_tokens"] == 8000
    assert pm["ratelimit_remaining_requests"] == 42
    assert pm["request_id"] == "req_abc123"


def test_post_call_payload_omits_provider_metadata_when_no_headers() -> None:
    session, eq, provider = _make_session()
    response = _mock_anthropic_response(headers=None)
    base._post_call(
        session, provider, response,
        estimated=10, latency_ms=50, call_kwargs={"model": "m"},
        estimated_via="tiktoken",
    )
    posts = _events(eq, "post_call")
    assert "provider_metadata" not in posts[0]


def test_post_call_payload_carries_policy_decision_post_when_crossed() -> None:
    # Pre-call usage 60/100; this call adds 25 → cumulative 85, above
    # the 80% warn threshold but below the 100% block threshold.
    session, eq, provider = _make_session(token_limit=100, warn_at_pct=80)
    session._tokens_used = 60
    response = _mock_anthropic_response(input_tokens=25, output_tokens=0)
    base._post_call(
        session, provider, response,
        estimated=10, latency_ms=50, call_kwargs={"model": "m"},
        estimated_via="tiktoken",
    )
    posts = _events(eq, "post_call")
    pdp = posts[0].get("policy_decision_post")
    assert pdp is not None
    assert pdp["decision"] == "warn"


def test_post_call_payload_omits_policy_decision_post_when_no_crossing() -> None:
    session, eq, provider = _make_session(token_limit=10000, warn_at_pct=80)
    session._tokens_used = 100
    response = _mock_anthropic_response(input_tokens=10, output_tokens=5)
    base._post_call(
        session, provider, response,
        estimated=10, latency_ms=50, call_kwargs={"model": "m"},
        estimated_via="tiktoken",
    )
    posts = _events(eq, "post_call")
    assert "policy_decision_post" not in posts[0]


# --------------------------------------------------------------------------
# embeddings enrichment (output_dimensions, embedding_output)
# --------------------------------------------------------------------------


def _mock_embeddings_response(vectors: list[list[float]]) -> Any:
    class _Usage:
        pass

    class _Entry:
        pass

    class _Resp:
        pass

    usage = _Usage()
    usage.prompt_tokens = 8
    usage.completion_tokens = 0
    resp = _Resp()
    resp.usage = usage
    resp.model = "text-embedding-3-small"
    resp.headers = None
    resp.data = []
    for v in vectors:
        e = _Entry()
        e.embedding = v
        resp.data.append(e)
    return resp


def test_embeddings_payload_carries_output_dimensions() -> None:
    from flightdeck_sensor.providers.openai import OpenAIProvider

    session, eq, _ = _make_session()
    provider = OpenAIProvider()
    response = _mock_embeddings_response([[0.0] * 1536, [0.0] * 1536])
    base._post_call(
        session, provider, response,
        estimated=8, latency_ms=22,
        call_kwargs={"model": "text-embedding-3-small", "input": ["a", "b"]},
        event_type=EventType.EMBEDDINGS, estimated_via="tiktoken",
    )
    embs = _events(eq, "embeddings")
    assert len(embs) == 1
    dims = embs[0].get("output_dimensions")
    assert dims == {"count": 2, "dimension": 1536}


def test_embeddings_payload_with_capture_carries_embedding_output_in_content() -> None:
    from flightdeck_sensor.providers.openai import OpenAIProvider

    session, eq, _ = _make_session(capture_prompts=True)
    provider = OpenAIProvider(capture_prompts=True)
    response = _mock_embeddings_response([[0.1, 0.2, 0.3]])
    base._post_call(
        session, provider, response,
        estimated=4, latency_ms=11,
        call_kwargs={"model": "text-embedding-3-small", "input": "hello"},
        event_type=EventType.EMBEDDINGS, estimated_via="tiktoken",
    )
    embs = _events(eq, "embeddings")
    e = embs[0]
    assert e["has_content"] is True
    content = e["content"]
    assert content["embedding_output"] == [[0.1, 0.2, 0.3]]
    assert content["input"] == "hello"


def test_embeddings_payload_without_capture_omits_embedding_output() -> None:
    from flightdeck_sensor.providers.openai import OpenAIProvider

    session, eq, _ = _make_session(capture_prompts=False)
    provider = OpenAIProvider(capture_prompts=False)
    response = _mock_embeddings_response([[0.1, 0.2, 0.3]])
    base._post_call(
        session, provider, response,
        estimated=4, latency_ms=11,
        call_kwargs={"model": "text-embedding-3-small", "input": "hello"},
        event_type=EventType.EMBEDDINGS, estimated_via="tiktoken",
    )
    e = _events(eq, "embeddings")[0]
    assert e.get("has_content", False) is False


# --------------------------------------------------------------------------
# llm_error enrichment (retry_attempt + terminal)
# --------------------------------------------------------------------------


def test_llm_error_carries_retry_attempt_and_terminal_for_non_retryable() -> None:
    session, eq, provider = _make_session()

    class _AuthError(Exception):
        pass

    exc = _AuthError("invalid api key")
    base._emit_error(
        session, provider, exc, latency_ms=50,
        call_kwargs={"model": "m"},
    )
    errs = _events(eq, "llm_error")
    assert len(errs) == 1
    e = errs[0]
    assert "retry_attempt" in e
    assert e["retry_attempt"] == 1
    assert e["terminal"] is True


def test_llm_error_increments_retry_attempt_within_request_id() -> None:
    session, eq, provider = _make_session()

    class _Timeout(Exception):
        pass

    base._emit_error(
        session, provider, _Timeout("attempt 1"), latency_ms=50,
        call_kwargs={"model": "m"},
    )
    base._emit_error(
        session, provider, _Timeout("attempt 2"), latency_ms=50,
        call_kwargs={"model": "m"},
    )
    errs = _events(eq, "llm_error")
    # request_id is None so both share the (provider, "") key.
    assert errs[0]["retry_attempt"] == 1
    assert errs[1]["retry_attempt"] == 2


def test_session_record_retry_attempt_is_bounded_lru() -> None:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    session = Session(config=config, client=client)
    for i in range(300):
        session.record_retry_attempt("anthropic", f"req_{i:04d}")
    assert len(session._retry_counters) <= 256
    assert ("anthropic", "req_0299") in session._retry_counters
    assert ("anthropic", "req_0000") not in session._retry_counters


def test_session_record_retry_attempt_increments_per_key() -> None:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="test",
        agent_type="production",
        quiet=True,
    )
    client = MagicMock(spec=ControlPlaneClient)
    session = Session(config=config, client=client)
    assert session.record_retry_attempt("openai", "req_a") == 1
    assert session.record_retry_attempt("openai", "req_a") == 2
    assert session.record_retry_attempt("openai", "req_b") == 1
    assert session.record_retry_attempt("openai", "req_a") == 3
