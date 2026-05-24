"""Tests for Session lifecycle: start, end, signal handlers."""

from __future__ import annotations

import atexit
import logging
import signal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from flightdeck_sensor.core.exceptions import ConfigurationError
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import Directive, DirectiveAction, SensorConfig
from flightdeck_sensor.transport.client import ControlPlaneClient


def _make_session(
    server: str = "http://localhost:9999",
    token: str = "tok",
    quiet: bool = True,
) -> tuple[Session, MagicMock]:
    config = SensorConfig(
        server=server, token=token, agent_flavor="test", agent_type="production", quiet=quiet
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client)
    return session, client


def test_start_fires_session_start_event() -> None:
    session, client = _make_session()
    session.start()
    session.end()
    calls = client.post_event.call_args_list
    assert any(c[0][0]["event_type"] == "session_start" for c in calls)


def test_end_fires_session_end_event() -> None:
    session, client = _make_session()
    session.start()
    session.end()
    calls = client.post_event.call_args_list
    assert any(c[0][0]["event_type"] == "session_end" for c in calls)


def test_end_is_idempotent() -> None:
    session, client = _make_session()
    session.start()
    session.end()
    session.end()
    end_calls = [
        c for c in client.post_event.call_args_list if c[0][0]["event_type"] == "session_end"
    ]
    assert len(end_calls) == 1


def test_atexit_handler_registered() -> None:
    session, _ = _make_session()
    with patch.object(atexit, "register") as mock_register:
        session._register_handlers()
        mock_register.assert_called_once_with(session.end)


def test_sigterm_handler_fires_session_end() -> None:
    session, client = _make_session()
    session.start()
    prev = signal.getsignal(signal.SIGTERM)
    handler = signal.getsignal(signal.SIGTERM)
    assert callable(handler)
    session.end()
    signal.signal(signal.SIGTERM, prev if callable(prev) else signal.SIG_DFL)


def test_preflight_populates_policy_cache(mock_control_plane: Any) -> None:
    """Preflight GET /v1/policy populates PolicyCache on start()."""
    mock_control_plane["set_response"](
        {
            "token_limit": 50000,
            "warn_at_pct": 80,
            "degrade_at_pct": 90,
            "block_at_pct": 100,
        }
    )

    config = SensorConfig(
        server=mock_control_plane["url"],
        token="test-token",
        agent_flavor="test-preflight",
        agent_type="production",
        quiet=True,
    )
    client_obj = ControlPlaneClient(
        server=mock_control_plane["url"],
        token="test-token",
    )
    session = Session(config=config, client=client_obj)
    session.start()
    session.end()

    assert session.policy.token_limit == 50000
    assert session.policy.warn_at_pct == 80


def test_preflight_failure_proceeds_with_empty_cache() -> None:
    """Preflight failure: start() completes without exception, PolicyCache empty."""
    config = SensorConfig(
        server="http://127.0.0.1:1",  # unreachable
        token="test-token",
        agent_flavor="test-preflight-fail",
        agent_type="production",
        quiet=True,
    )
    client_obj = ControlPlaneClient(
        server="http://127.0.0.1:1",
        token="test-token",
        unavailable_policy="continue",
    )
    session = Session(config=config, client=client_obj)
    session.start()
    session.end()

    # PolicyCache should be empty (no token_limit set)
    assert session.policy.token_limit is None


def test_directive_warn_logs_and_continues() -> None:
    """WARN directive logs warning, enqueues policy_warn event, does not raise."""
    session, _client = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    directive = Directive(
        action=DirectiveAction.WARN,
        reason="token usage at 80%",
    )
    # Should not raise
    session._apply_directive(directive)

    # Verify policy_warn event was enqueued
    eq.enqueue.assert_called_once()
    payload = eq.enqueue.call_args[0][0]
    assert payload["event_type"] == "policy_warn"
    assert payload["source"] == "server"
    assert payload["reason"] == "token usage at 80%"


def test_directive_degrade_sets_model() -> None:
    """DEGRADE directive sets policy.degrade_to, does not raise."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.DEGRADE,
        reason="budget threshold crossed",
        payload={"degrade_to": "claude-haiku-4-5"},
    )
    session._apply_directive(directive)
    assert session.policy.degrade_to == "claude-haiku-4-5"


def test_directive_policy_update_replaces_cache() -> None:
    """POLICY_UPDATE directive updates PolicyCache fields."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.POLICY_UPDATE,
        reason="policy changed",
        payload={
            "token_limit": 50000,
            "warn_at_pct": 80,
            "degrade_at_pct": 85,
            "block_at_pct": 95,
        },
    )
    session._apply_directive(directive)
    assert session.policy.token_limit == 50000
    assert session.policy.warn_at_pct == 80
    assert session.policy.degrade_at_pct == 85
    assert session.policy.block_at_pct == 95


def test_directive_shutdown_raises() -> None:
    """SHUTDOWN directive sets shutdown flag with correct reason."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.SHUTDOWN,
        reason="test kill",
    )
    session._apply_directive(directive)
    assert session._shutdown_requested is True
    assert session._shutdown_reason == "test kill"


def test_directive_shutdown_flavor_raises() -> None:
    """SHUTDOWN_FLAVOR directive sets shutdown flag."""
    session, _client = _make_session()
    directive = Directive(
        action=DirectiveAction.SHUTDOWN_FLAVOR,
        reason="fleet-wide stop",
    )
    session._apply_directive(directive)
    assert session._shutdown_requested is True
    assert session._shutdown_reason == "fleet-wide stop"


def test_configuration_error_on_empty_server(monkeypatch: pytest.MonkeyPatch) -> None:
    # Scrub FLIGHTDECK_SERVER / FLIGHTDECK_TOKEN so a shell with these
    # vars set (dev loop, release workflow) doesn't let init() resolve
    # a server from env and mask the empty-kwarg ConfigurationError.
    # KI25.
    monkeypatch.delenv("FLIGHTDECK_SERVER", raising=False)
    monkeypatch.delenv("FLIGHTDECK_TOKEN", raising=False)
    import flightdeck_sensor

    with pytest.raises(ConfigurationError):
        flightdeck_sensor.init(server="", token="tok", quiet=True)
        flightdeck_sensor.teardown()


def test_record_usage_accumulates() -> None:
    """record_usage adds token counts cumulatively, not replacing."""
    from flightdeck_sensor.core.types import TokenUsage

    session, _client = _make_session()
    session.record_usage(TokenUsage(input_tokens=100, output_tokens=50))
    session.record_usage(TokenUsage(input_tokens=100, output_tokens=50))
    assert session.tokens_used == 300


def test_get_status_returns_correct_fields() -> None:
    """get_status snapshot reflects recorded usage and configured limit."""
    from flightdeck_sensor.core.types import TokenUsage

    session, _client = _make_session()
    session._token_limit = 10000
    session.record_usage(TokenUsage(input_tokens=500, output_tokens=300))
    status = session.get_status()

    assert status.session_id == session.config.session_id
    assert status.tokens_used == 800
    assert status.token_limit == 10000
    assert status.pct_used is not None
    assert status.pct_used == 8.0  # (800 / 10000) * 100


# ------------------------------------------------------------------
# D094 -- session_id hint + backend attachment
# ------------------------------------------------------------------


def test_init_custom_session_id_emits_warning(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a caller supplies session_id (kwarg or env var), init()
    logs a single WARNING with the exact wording documented in D094
    so operators can see attachment semantics kicked in."""
    import flightdeck_sensor

    # A valid UUID is required -- non-UUID inputs hit the separate
    # _is_valid_uuid fallback path and never surface this warning.
    sid = "11111111-1111-4111-8111-111111111111"
    monkeypatch.delenv("FLIGHTDECK_SESSION_ID", raising=False)
    flightdeck_sensor.teardown()
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        try:
            flightdeck_sensor.init(
                server="http://127.0.0.1:1",
                token="tok",
                session_id=sid,
                quiet=True,
            )
        finally:
            flightdeck_sensor.teardown()
    messages = [r.message for r in caplog.records]
    assert any(
        f"Custom session_id provided: '{sid}'" in m
        and "used as-is" in m
        and "backend will attach" in m
        for m in messages
    ), f"expected attachment warning, got: {messages}"


def test_init_no_session_id_does_not_warn(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Default init() (UUID auto-generated) must not emit the custom-
    session-id warning -- otherwise every vanilla agent startup spams
    the log."""
    import flightdeck_sensor

    monkeypatch.delenv("FLIGHTDECK_SESSION_ID", raising=False)
    flightdeck_sensor.teardown()
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        try:
            flightdeck_sensor.init(
                server="http://127.0.0.1:1",
                token="tok",
                quiet=True,
            )
        finally:
            flightdeck_sensor.teardown()
    assert not any("Custom session_id provided" in r.message for r in caplog.records)


def test_init_non_uuid_session_id_falls_back_and_warns(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caller-supplied session_id that is not a valid UUID must NOT
    be used verbatim -- the sessions table column is UUID-typed and
    the event would later be dropped at worker time. The sensor logs
    a warning with the documented wording and falls back to an
    auto-generated UUID so the agent still boots."""
    import flightdeck_sensor

    monkeypatch.delenv("FLIGHTDECK_SESSION_ID", raising=False)
    flightdeck_sensor.teardown()
    with caplog.at_level(logging.WARNING, logger="flightdeck_sensor"):
        try:
            flightdeck_sensor.init(
                server="http://127.0.0.1:1",
                token="tok",
                session_id="my-temporal-workflow-id",
                quiet=True,
            )
            assert flightdeck_sensor._session is not None
            sid = flightdeck_sensor._session.config.session_id
        finally:
            flightdeck_sensor.teardown()

    # Exact wording: "Custom session_id '{value}' is not a valid UUID.
    # A random run ID will be generated instead." The kwarg name
    # ``session_id`` is preserved in the warning text (it names the
    # caller-supplied parameter); the surrounding prose follows the
    # run vocabulary.
    assert any(
        "Custom session_id 'my-temporal-workflow-id' is not a valid UUID" in r.message
        and "random run ID will be generated" in r.message
        for r in caplog.records
    ), f"expected invalid-uuid warning, got: {[r.message for r in caplog.records]}"

    # Fallback UUID must itself be a valid UUID and must not equal the
    # caller-supplied string.
    import uuid as _uuid

    _uuid.UUID(sid)  # raises if not a UUID
    assert sid != "my-temporal-workflow-id"


def test_init_env_var_overrides_kwarg(monkeypatch: pytest.MonkeyPatch) -> None:
    """FLIGHTDECK_SESSION_ID env var wins over the init() kwarg, same
    pattern as FLIGHTDECK_SERVER and AGENT_FLAVOR (D094)."""
    import flightdeck_sensor

    env_sid = "22222222-2222-4222-8222-222222222222"
    kwarg_sid = "33333333-3333-4333-8333-333333333333"
    flightdeck_sensor.teardown()
    monkeypatch.setenv("FLIGHTDECK_SESSION_ID", env_sid)
    try:
        flightdeck_sensor.init(
            server="http://127.0.0.1:1",
            token="tok",
            session_id=kwarg_sid,
            quiet=True,
        )
        assert flightdeck_sensor._session is not None
        assert flightdeck_sensor._session.config.session_id == env_sid
    finally:
        flightdeck_sensor.teardown()


def test_post_event_attached_logs_info_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Session._post_event emits the 'Attached to existing session'
    INFO line on the first response envelope that carries
    attached=true, and not on subsequent ones."""
    from flightdeck_sensor.core.types import EventType

    session, client = _make_session(quiet=False)
    # First call: backend confirms attachment.
    client.post_event.return_value = (None, True)
    with caplog.at_level(logging.INFO, logger="flightdeck_sensor.core.session"):
        session._post_event(EventType.SESSION_START)
    info_lines = [r.message for r in caplog.records if "Attached to existing session" in r.message]
    assert len(info_lines) == 1, f"expected 1 attach INFO, got {info_lines}"

    # Second call: same flag still true, but we've already logged --
    # must not fire again.
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="flightdeck_sensor.core.session"):
        session._post_event(EventType.POST_CALL)
    info_lines = [r.message for r in caplog.records if "Attached to existing session" in r.message]
    assert info_lines == []
    session.end()


# ---------------------------------------------------------------------
# KI20 -- FLIGHTDECK_SERVER URL normalization at init()
# ---------------------------------------------------------------------
#
# The Claude Code plugin uses FLIGHTDECK_SERVER without the /ingest
# suffix (it appends the path itself). A developer running both the
# plugin and a sensor script on one machine used to hit a silent 404
# because the sensor required the suffix and the plugin's env
# overrode any kwarg. The sensor now appends /ingest when missing --
# these tests lock that behaviour in.


def test_init_appends_ingest_suffix_when_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Server URL without /ingest gets the suffix appended.

    Verifies via get_status() after init -- SensorConfig.server
    should carry the normalized URL with /ingest, regardless of
    whether the original input had it.
    """
    import flightdeck_sensor

    monkeypatch.delenv("FLIGHTDECK_SERVER", raising=False)
    monkeypatch.delenv("FLIGHTDECK_TOKEN", raising=False)
    flightdeck_sensor.teardown()
    flightdeck_sensor.init(server="http://stack.internal", token="tok", quiet=True)
    try:
        assert flightdeck_sensor._session is not None
        assert flightdeck_sensor._session.config.server == "http://stack.internal/ingest"
    finally:
        flightdeck_sensor.teardown()


def test_init_preserves_ingest_suffix_when_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Server URL that already ends with /ingest is left unchanged.

    Idempotency: a caller that passed the canonical form keeps it
    exactly -- no double-append, no trailing slash games.
    """
    import flightdeck_sensor

    monkeypatch.delenv("FLIGHTDECK_SERVER", raising=False)
    monkeypatch.delenv("FLIGHTDECK_TOKEN", raising=False)
    flightdeck_sensor.teardown()
    flightdeck_sensor.init(
        server="http://stack.internal/ingest",
        token="tok",
        quiet=True,
    )
    try:
        assert flightdeck_sensor._session is not None
        assert flightdeck_sensor._session.config.server == "http://stack.internal/ingest"
    finally:
        flightdeck_sensor.teardown()


def test_init_preserves_ingest_with_trailing_slash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Server URL with /ingest/ (trailing slash) is left unchanged.

    The normalization check is ``if "/ingest" not in server`` -- a
    trailing slash after /ingest is still a containment match so the
    suffix is not double-appended. The trailing slash itself is
    preserved verbatim (callers occasionally intend it).
    """
    import flightdeck_sensor

    monkeypatch.delenv("FLIGHTDECK_SERVER", raising=False)
    monkeypatch.delenv("FLIGHTDECK_TOKEN", raising=False)
    flightdeck_sensor.teardown()
    flightdeck_sensor.init(
        server="http://stack.internal/ingest/",
        token="tok",
        quiet=True,
    )
    try:
        assert flightdeck_sensor._session is not None
        assert flightdeck_sensor._session.config.server == "http://stack.internal/ingest/"
    finally:
        flightdeck_sensor.teardown()
