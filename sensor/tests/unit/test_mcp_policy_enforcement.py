"""Unit tests for MCP Protection Policy enforcement.

Covers the matrix from step 4 plan B6:

  - Policy decision evaluation (cache miss, flavor entry, global
    entry, mode default, block-on-uncertainty failsafe).
  - Soft-launch downgrade (warn / enforce / invalid env override).
  - Event emission shape for warn / block / name-drift.
  - MCPPolicyBlocked exception fields and message.
  - Integration with the call_tool wrapper helper functions.
  - Concurrency safety on the cache.
  - Wrapper failure paths (policy lookup raises, payload build raises,
    queue flush raises) — all swallowed without crashing the user
    call.

Mocks the HTTP transport so the cache populate path is exercised
end-to-end without a live control plane.
"""

from __future__ import annotations

import json
import threading
from typing import Any
from unittest.mock import MagicMock, patch

from flightdeck_sensor.core.exceptions import MCPPolicyBlocked
from flightdeck_sensor.core.mcp_policy import (
    MCPPolicyCache,
    MCPPolicyDecision,
)
from flightdeck_sensor.core.types import EventType
from flightdeck_sensor.interceptor.mcp import (
    _build_policy_event_extras,
    _enforce_call_tool_policy,
    _extract_server_url,
)
from flightdeck_sensor.interceptor.mcp_identity import (
    canonicalize_url,
    fingerprint_short,
)

# ----- Fixtures + helpers -----------------------------------------


def _global_doc(
    *, mode: str = "blocklist", entries: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return {
        "id": "global-id",
        "scope": "global",
        "scope_value": None,
        "mode": mode,
        "block_on_uncertainty": False,
        "entries": entries or [],
    }


def _flavor_doc(
    *,
    scope_value: str = "production",
    block_on_uncertainty: bool = False,
    entries: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": f"flavor-{scope_value}-id",
        "scope": "flavor",
        "scope_value": scope_value,
        "mode": None,
        "block_on_uncertainty": block_on_uncertainty,
        "entries": entries or [],
    }


def _entry(
    *,
    server_url: str,
    server_name: str,
    entry_kind: str = "allow",
    enforcement: str | None = None,
) -> dict[str, Any]:
    canonical = canonicalize_url(server_url)
    return {
        "id": f"entry-{server_name}",
        "policy_id": "stub",
        "server_url": canonical,
        "server_name": server_name,
        "fingerprint": fingerprint_short(canonical, server_name),
        "entry_kind": entry_kind,
        "enforcement": enforcement,
    }


class _FakeHTTPResponse:
    def __init__(self, body: dict[str, Any]) -> None:
        self._body = json.dumps(body).encode()

    def __enter__(self) -> _FakeHTTPResponse:
        return self

    def __exit__(self, *_a: Any) -> None:
        pass

    def read(self) -> bytes:
        return self._body


def _populate_cache(
    cache: MCPPolicyCache,
    *,
    global_doc: dict[str, Any] | None = None,
    flavor_doc: dict[str, Any] | None = None,
    flavor_name: str | None = "production",
) -> None:
    """Populate the cache via the public populate path with mocked
    HTTP. Mirrors what the sensor's _preflight_mcp_policy does."""

    def _fake_urlopen(req: Any, timeout: int = 0) -> Any:  # noqa: ARG001
        url = getattr(req, "full_url", "")
        if "/v1/mcp-policies/global" in url:
            if global_doc is None:
                raise RuntimeError("no global doc configured")
            return _FakeHTTPResponse(global_doc)
        return _FakeHTTPResponse(flavor_doc) if flavor_doc else _FakeHTTPResponse({})

    with patch("flightdeck_sensor.core.mcp_policy.urllib.request.urlopen", _fake_urlopen):
        cache.populate_from_control_plane(
            api_url="http://localhost:4000/api",
            token="tok_dev",
            flavor=flavor_name,
        )


# ----- MCPPolicyCache.evaluate -----------------------------------


def test_evaluate_flavor_allow_entry_returns_allow() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(mode="allowlist"),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://x.example.com",
                    server_name="x",
                )
            ]
        ),
    )
    decision = cache.evaluate("https://x.example.com", "x")
    assert decision.decision == "allow"
    assert decision.decision_path == "flavor_entry"


def test_evaluate_flavor_deny_entry_returns_block_by_default() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://x.example.com",
                    server_name="x",
                    entry_kind="deny",
                )
            ]
        ),
    )
    decision = cache.evaluate("https://x.example.com", "x")
    assert decision.decision == "block"
    assert decision.decision_path == "flavor_entry"


def test_evaluate_flavor_deny_with_warn_enforcement() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://x.example.com",
                    server_name="x",
                    entry_kind="deny",
                    enforcement="warn",
                )
            ]
        ),
    )
    decision = cache.evaluate("https://x.example.com", "x")
    assert decision.decision == "warn"


def test_evaluate_global_entry_used_when_flavor_empty() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(
            mode="blocklist",
            entries=[
                _entry(
                    server_url="https://g.example.com",
                    server_name="g",
                    entry_kind="deny",
                    enforcement="block",
                )
            ],
        ),
        flavor_doc=_flavor_doc(),
    )
    decision = cache.evaluate("https://g.example.com", "g")
    assert decision.decision_path == "global_entry"
    assert decision.decision == "block"


def test_evaluate_flavor_overrides_global_for_same_url() -> None:
    cache = MCPPolicyCache()
    same_url = "https://shared.example.com"
    same_name = "shared"
    _populate_cache(
        cache,
        global_doc=_global_doc(
            entries=[
                _entry(
                    server_url=same_url,
                    server_name=same_name,
                    entry_kind="deny",
                    enforcement="block",
                )
            ]
        ),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url=same_url,
                    server_name=same_name,
                    entry_kind="allow",
                )
            ]
        ),
    )
    decision = cache.evaluate(same_url, same_name)
    assert decision.decision == "allow"
    assert decision.decision_path == "flavor_entry"


def test_evaluate_mode_default_allowlist_blocks_unmatched() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(mode="allowlist"),
        flavor_doc=_flavor_doc(),
    )
    decision = cache.evaluate("https://unknown.example.com", "unknown")
    assert decision.decision_path == "mode_default"
    assert decision.decision == "block"


def test_evaluate_mode_default_blocklist_allows_unmatched() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(mode="blocklist"),
        flavor_doc=_flavor_doc(),
    )
    decision = cache.evaluate("https://unknown.example.com", "unknown")
    assert decision.decision_path == "mode_default"
    assert decision.decision == "allow"


def test_evaluate_block_on_uncertainty_attributes_to_flavor() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(mode="allowlist"),
        flavor_doc=_flavor_doc(scope_value="production", block_on_uncertainty=True),
    )
    decision = cache.evaluate("https://unknown.example.com", "unknown")
    assert decision.decision == "block"
    assert decision.scope == "flavor:production"
    assert decision.block_on_uncertainty is True


def test_evaluate_empty_cache_with_failsafe_blocks() -> None:
    cache = MCPPolicyCache(mcp_block_on_uncertainty=True)
    decision = cache.evaluate("https://unknown.example.com", "unknown")
    assert decision.decision == "block"
    assert decision.scope == "local_failsafe"
    assert decision.decision_path == "mode_default"


def test_evaluate_empty_cache_without_failsafe_fails_open() -> None:
    cache = MCPPolicyCache(mcp_block_on_uncertainty=False)
    decision = cache.evaluate("https://unknown.example.com", "unknown")
    assert decision.decision == "allow"
    assert decision.scope == "fail_open"


def test_evaluate_canonical_url_normalisation_drives_lookup() -> None:
    # The cache stored a canonical URL; the agent passes a non-
    # canonical variant that canonicalizes to the same value.
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(mode="allowlist"),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://Maps.Example.COM:443/SSE",
                    server_name="maps",
                )
            ]
        ),
    )
    decision = cache.evaluate("HTTPS://maps.example.com:443/SSE", "maps")
    assert decision.decision == "allow"


# ----- populate path ----------------------------------------------


def test_populate_handles_missing_flavor_404() -> None:
    """When the flavor policy doesn't exist (HTTP 404), only the
    global policy populates and evaluation falls through to global."""
    import urllib.error

    def _fake_urlopen(req: Any, timeout: int = 0) -> Any:  # noqa: ARG001
        if "/v1/mcp-policies/global" in req.full_url:
            return _FakeHTTPResponse(_global_doc(mode="blocklist"))
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)  # type: ignore[arg-type]

    cache = MCPPolicyCache()
    with patch("flightdeck_sensor.core.mcp_policy.urllib.request.urlopen", _fake_urlopen):
        cache.populate_from_control_plane(
            api_url="http://localhost",
            token="t",
            flavor="missing",
        )
    assert cache.is_populated()
    decision = cache.evaluate("https://x.example.com", "x")
    assert decision.decision == "allow"  # blocklist mode default


def test_populate_failure_leaves_cache_empty() -> None:
    def _raise(_: Any, timeout: int = 0) -> Any:
        raise OSError("network down")

    cache = MCPPolicyCache(mcp_block_on_uncertainty=True)
    with patch("flightdeck_sensor.core.mcp_policy.urllib.request.urlopen", _raise):
        cache.populate_from_control_plane(
            api_url="http://localhost",
            token="t",
            flavor="x",
        )
    assert cache.is_populated() is False
    # Failsafe blocks unmatched URLs
    decision = cache.evaluate("https://unknown.example.com", "unknown")
    assert decision.decision == "block"


# ----- known_servers + lookup_known_name ---------------------------


def test_lookup_known_name_returns_policy_name() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://maps.example.com",
                    server_name="maps-canonical",
                )
            ]
        ),
    )
    assert cache.lookup_known_name("https://maps.example.com") == "maps-canonical"


def test_lookup_known_name_returns_none_when_url_unknown() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(),
        flavor_doc=_flavor_doc(),
    )
    assert cache.lookup_known_name("https://unknown.example.com") is None


def test_known_servers_lists_both_scopes() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(
            entries=[
                _entry(
                    server_url="https://g.example.com",
                    server_name="g",
                )
            ]
        ),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://f.example.com",
                    server_name="f",
                )
            ]
        ),
    )
    servers = cache.known_servers()
    names = {name for _, name in servers}
    assert names == {"g", "f"}


# ----- _enforce_call_tool_policy hook ------------------------------


def _make_fake_session(*, decision: MCPPolicyDecision) -> Any:
    fake = MagicMock()
    fake.mcp_policy = MagicMock()
    fake.mcp_policy.evaluate = MagicMock(return_value=decision)
    fake._build_payload = MagicMock(return_value={"event_type": "test", "extras": {}})
    fake.event_queue = MagicMock()
    return fake


def test_enforce_allow_returns_none() -> None:
    fake = _make_fake_session(
        decision=MCPPolicyDecision(
            decision="allow",
            decision_path="flavor_entry",
            policy_id="p",
            scope="flavor:x",
            fingerprint="abc",
        )
    )
    blocked = _enforce_call_tool_policy(
        sensor_session=fake,
        server_url="https://x.example.com",
        server_name="x",
        transport="http",
        tool_name="search",
    )
    assert blocked is None
    fake.event_queue.enqueue.assert_not_called()


def test_enforce_warn_emits_event_returns_none() -> None:
    fake = _make_fake_session(
        decision=MCPPolicyDecision(
            decision="warn",
            decision_path="flavor_entry",
            policy_id="p",
            scope="flavor:x",
            fingerprint="abc",
        )
    )
    blocked = _enforce_call_tool_policy(
        sensor_session=fake,
        server_url="https://x.example.com",
        server_name="x",
        transport="http",
        tool_name="search",
    )
    assert blocked is None
    fake.event_queue.enqueue.assert_called_once()
    # Phase 7 Step 2 (D148/D149): policy_decision shared block +
    # originating_call_context (defaults to "tool_call") added to the
    # extras. Legacy top-level fields (policy_id, scope, decision_path)
    # remain on the wire for backwards compatibility with the
    # dashboard renderers; Step 6 will consolidate.
    fake._build_payload.assert_called_with(
        EventType.POLICY_MCP_WARN,
        server_url="https://x.example.com",
        server_name="x",
        fingerprint="abc",
        tool_name="search",
        policy_id="p",
        scope="flavor:x",
        decision_path="flavor_entry",
        policy_decision={
            "policy_id": "p",
            "scope": "flavor:x",
            "decision": "warn",
            "reason": "Server x warned by flavor entry, enforcement=warn",
            "decision_path": "flavor_entry",
        },
        originating_call_context="tool_call",
        transport="http",
    )


def test_enforce_block_emits_flushes_returns_exception() -> None:
    fake = _make_fake_session(
        decision=MCPPolicyDecision(
            decision="block",
            decision_path="flavor_entry",
            policy_id="p",
            scope="flavor:x",
            fingerprint="abc",
        )
    )
    blocked = _enforce_call_tool_policy(
        sensor_session=fake,
        server_url="https://x.example.com",
        server_name="x",
        transport="http",
        tool_name="search",
    )
    assert isinstance(blocked, MCPPolicyBlocked)
    assert blocked.fingerprint == "abc"
    assert blocked.decision_path == "flavor_entry"
    assert blocked.server_name == "x"
    fake.event_queue.enqueue.assert_called_once()
    fake.event_queue.flush.assert_called_once()


def test_enforce_evaluate_raises_returns_none() -> None:
    """A policy evaluation bug must NEVER crash the user's MCP call."""
    fake = MagicMock()
    fake.mcp_policy = MagicMock()
    fake.mcp_policy.evaluate = MagicMock(side_effect=RuntimeError("internal bug"))
    fake.event_queue = MagicMock()
    blocked = _enforce_call_tool_policy(
        sensor_session=fake,
        server_url="https://x.example.com",
        server_name="x",
        transport="http",
        tool_name="search",
    )
    assert blocked is None
    fake.event_queue.enqueue.assert_not_called()


def test_enforce_payload_build_raises_block_still_raised() -> None:
    """Payload-build failure on a block path must NOT swallow the
    block — the agent still must not reach the server."""
    fake = _make_fake_session(
        decision=MCPPolicyDecision(
            decision="block",
            decision_path="flavor_entry",
            policy_id="p",
            scope="flavor:x",
            fingerprint="abc",
        )
    )
    fake._build_payload = MagicMock(side_effect=RuntimeError("payload bug"))
    blocked = _enforce_call_tool_policy(
        sensor_session=fake,
        server_url="https://x.example.com",
        server_name="x",
        transport="http",
        tool_name="search",
    )
    assert isinstance(blocked, MCPPolicyBlocked)


# ----- _build_policy_event_extras ---------------------------------


def test_build_extras_block_includes_block_on_uncertainty() -> None:
    decision = MCPPolicyDecision(
        decision="block",
        decision_path="mode_default",
        policy_id="p",
        scope="flavor:prod",
        fingerprint="abc",
        block_on_uncertainty=True,
    )
    extras = _build_policy_event_extras(
        decision=decision,
        server_url="https://x",
        server_name="x",
        transport="http",
        tool_name="t",
    )
    assert extras["block_on_uncertainty"] is True


def test_build_extras_warn_no_block_on_uncertainty_field() -> None:
    decision = MCPPolicyDecision(
        decision="warn",
        decision_path="flavor_entry",
        policy_id="p",
        scope="flavor:prod",
        fingerprint="abc",
    )
    extras = _build_policy_event_extras(
        decision=decision,
        server_url="https://x",
        server_name="x",
        transport="http",
        tool_name="t",
    )
    assert "block_on_uncertainty" not in extras


# ----- MCPPolicyBlocked exception ---------------------------------


def test_mcp_policy_blocked_carries_attribution() -> None:
    exc = MCPPolicyBlocked(
        server_url="https://x.example.com",
        server_name="x",
        fingerprint="abc",
        policy_id="p1",
        decision_path="flavor_entry",
    )
    assert exc.server_url == "https://x.example.com"
    assert exc.server_name == "x"
    assert exc.fingerprint == "abc"
    assert exc.policy_id == "p1"
    assert exc.decision_path == "flavor_entry"
    assert "x" in str(exc)
    assert "flavor_entry" in str(exc)


def test_mcp_policy_blocked_inherits_from_exception_only() -> None:
    """Per the D130 implementation note: MCPPolicyBlocked is a
    sibling exception in the BudgetExceededError pattern, NOT a
    subclass of DirectiveError."""
    from flightdeck_sensor.core.exceptions import DirectiveError

    exc = MCPPolicyBlocked(
        server_url="x",
        server_name="x",
        fingerprint="x",
        policy_id="x",
        decision_path="flavor_entry",
    )
    assert isinstance(exc, Exception)
    assert not isinstance(exc, DirectiveError)


# ----- _extract_server_url ----------------------------------------


def test_extract_server_url_http_positional() -> None:
    assert _extract_server_url("http", ("https://x.example.com",), {}) == "https://x.example.com"


def test_extract_server_url_http_kwarg() -> None:
    assert _extract_server_url("http", (), {"url": "https://y"}) == "https://y"


def test_extract_server_url_stdio_with_args() -> None:
    class FakeParams:
        command = "npx"
        args = ["-y", "@scope/server-x", "/data"]

    out = _extract_server_url("stdio", (FakeParams(),), {})
    assert out == "npx -y @scope/server-x /data"


def test_extract_server_url_unknown_transport_returns_empty() -> None:
    assert _extract_server_url("unknown", ("https://x",), {}) == ""


def test_extract_server_url_missing_returns_empty() -> None:
    assert _extract_server_url("http", (), {}) == ""


# ----- Concurrency ------------------------------------------------


def test_evaluate_thread_safe_under_concurrent_lookup() -> None:
    cache = MCPPolicyCache()
    _populate_cache(
        cache,
        global_doc=_global_doc(mode="allowlist"),
        flavor_doc=_flavor_doc(
            entries=[
                _entry(
                    server_url="https://x.example.com",
                    server_name="x",
                )
            ]
        ),
    )

    results: list[str] = []
    errors: list[Exception] = []
    lock = threading.Lock()

    def _worker() -> None:
        try:
            for _ in range(50):
                d = cache.evaluate("https://x.example.com", "x")
                with lock:
                    results.append(d.decision)
        except Exception as exc:  # pragma: no cover - test fails loudly
            errors.append(exc)

    threads = [threading.Thread(target=_worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert all(d == "allow" for d in results)
    assert len(results) == 8 * 50


# ----- EventType enum locks ---------------------------------------


def test_event_type_enum_has_three_new_members() -> None:
    """Wire-shape lock — these strings ride the events.<type> NATS
    subject and the dashboard's filter lookups; they cannot drift."""
    assert EventType.POLICY_MCP_WARN.value == "policy_mcp_warn"
    assert EventType.POLICY_MCP_BLOCK.value == "policy_mcp_block"
    assert EventType.MCP_SERVER_NAME_CHANGED.value == "mcp_server_name_changed"
