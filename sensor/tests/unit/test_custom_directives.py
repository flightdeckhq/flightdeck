"""Tests for custom directive registration, fingerprinting, sync, and execution."""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from flightdeck_sensor import (
    Parameter,
    _compute_fingerprint,
    _directive_registry,
    directive,
)
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import (
    Directive,
    DirectiveAction,
    DirectiveContext,
    DirectiveParameter,
    DirectiveRegistration,
    SensorConfig,
)
from flightdeck_sensor.transport.client import ControlPlaneClient


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _make_session(
    server: str = "http://localhost:9999",
    token: str = "tok",
    quiet: bool = True,
) -> tuple[Session, MagicMock]:
    """Create a Session with a mocked ControlPlaneClient."""
    config = SensorConfig(
        server=server,
        token=token,
        agent_flavor="test",
        agent_type="autonomous",
        quiet=quiet,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = None
    client.sync_directives.return_value = []
    client.register_directives.return_value = None
    session = Session(config=config, client=client)
    return session, client


# ------------------------------------------------------------------
# Parameter alias
# ------------------------------------------------------------------


def test_parameter_is_directive_parameter() -> None:
    """The public Parameter alias resolves to DirectiveParameter."""
    assert Parameter is DirectiveParameter


# ------------------------------------------------------------------
# Fingerprinting
# ------------------------------------------------------------------


def test_fingerprint_deterministic() -> None:
    """Same inputs produce the same fingerprint."""
    params = [DirectiveParameter(name="x", type="int")]
    fp1 = _compute_fingerprint("test", "desc", params)
    fp2 = _compute_fingerprint("test", "desc", params)
    assert fp1 == fp2


def test_fingerprint_changes_on_name() -> None:
    """Different names produce different fingerprints."""
    params = [DirectiveParameter(name="x", type="int")]
    fp1 = _compute_fingerprint("alpha", "desc", params)
    fp2 = _compute_fingerprint("beta", "desc", params)
    assert fp1 != fp2


def test_fingerprint_changes_on_parameters() -> None:
    """Different parameters produce different fingerprints."""
    fp1 = _compute_fingerprint("test", "desc", [DirectiveParameter(name="x", type="int")])
    fp2 = _compute_fingerprint("test", "desc", [DirectiveParameter(name="y", type="str")])
    assert fp1 != fp2


def test_fingerprint_is_base64() -> None:
    """Fingerprint is a valid base64 string."""
    import base64

    fp = _compute_fingerprint("test", "", [])
    decoded = base64.b64decode(fp)
    assert len(decoded) == 32  # SHA-256 produces 32 bytes


# ------------------------------------------------------------------
# Decorator registration
# ------------------------------------------------------------------


def test_directive_decorator_registers_handler() -> None:
    """@directive registers the handler in _directive_registry."""
    # Clean up after test
    name = "_test_decorator_reg"
    try:

        @directive(name, description="test handler")
        def handler(ctx: DirectiveContext) -> str:
            return "ok"

        assert name in _directive_registry
        reg = _directive_registry[name]
        assert reg.name == name
        assert reg.description == "test handler"
        assert reg.handler is handler
        assert reg.fingerprint != ""
    finally:
        _directive_registry.pop(name, None)


def test_directive_decorator_with_parameters() -> None:
    """@directive stores parameter definitions."""
    name = "_test_decorator_params"
    try:

        @directive(
            name,
            description="with params",
            parameters=[Parameter(name="dur", type="int", required=True)],
        )
        def handler(ctx: DirectiveContext, dur: int = 10) -> None:
            pass

        reg = _directive_registry[name]
        assert len(reg.parameters) == 1
        assert reg.parameters[0].name == "dur"
        assert reg.parameters[0].required is True
    finally:
        _directive_registry.pop(name, None)


def test_directive_decorator_returns_original_function() -> None:
    """@directive does not wrap the function."""
    name = "_test_decorator_passthrough"
    try:

        @directive(name)
        def handler(ctx: DirectiveContext) -> str:
            return "hello"

        # The decorated function is the original function
        assert handler(MagicMock()) == "hello"
    finally:
        _directive_registry.pop(name, None)


# ------------------------------------------------------------------
# Session._sync_directives
# ------------------------------------------------------------------


def test_sync_directives_sends_fingerprints() -> None:
    """_sync_directives POSTs fingerprints via client.sync_directives."""
    session, client = _make_session()
    reg = DirectiveRegistration(
        name="pause",
        description="pause",
        parameters=[],
        fingerprint="abc123",
        handler=lambda ctx: None,
    )
    registry = {"pause": reg}
    session._sync_directives(registry)

    client.sync_directives.assert_called_once_with(
        "test", [{"name": "pause", "fingerprint": "abc123"}]
    )


def test_sync_directives_registers_unknown() -> None:
    """When the server returns unknown fingerprints, _sync_directives registers them."""
    session, client = _make_session()
    reg = DirectiveRegistration(
        name="pause",
        description="pause the agent",
        parameters=[DirectiveParameter(name="dur", type="int")],
        fingerprint="abc123",
        handler=lambda ctx: None,
    )
    registry = {"pause": reg}
    client.sync_directives.return_value = ["abc123"]

    session._sync_directives(registry)

    client.register_directives.assert_called_once()
    args = client.register_directives.call_args[0]
    assert args[0] == "test"
    assert len(args[1]) == 1
    assert args[1][0]["name"] == "pause"
    assert args[1][0]["fingerprint"] == "abc123"


def test_sync_directives_skips_known() -> None:
    """When all fingerprints are known, no register call is made."""
    session, client = _make_session()
    reg = DirectiveRegistration(
        name="pause",
        description="pause",
        parameters=[],
        fingerprint="known",
        handler=lambda ctx: None,
    )
    registry = {"pause": reg}
    client.sync_directives.return_value = []

    session._sync_directives(registry)

    client.register_directives.assert_not_called()


def test_sync_directives_fails_open() -> None:
    """_sync_directives does not raise on client error."""
    session, client = _make_session()
    client.sync_directives.side_effect = RuntimeError("network failure")

    reg = DirectiveRegistration(
        name="pause",
        description="pause",
        parameters=[],
        fingerprint="fp",
        handler=lambda ctx: None,
    )
    # Should not raise
    session._sync_directives({"pause": reg})


# ------------------------------------------------------------------
# Session._build_directive_context
# ------------------------------------------------------------------


def test_build_directive_context() -> None:
    """_build_directive_context returns correct session state."""
    session, _ = _make_session()
    session._tokens_used = 500
    session._model = "claude-sonnet-4-20250514"

    ctx = session._build_directive_context()

    assert ctx.session_id == session.config.session_id
    assert ctx.flavor == "test"
    assert ctx.tokens_used == 500
    assert ctx.model == "claude-sonnet-4-20250514"


def test_build_directive_context_no_model() -> None:
    """_build_directive_context uses empty string when no model recorded."""
    session, _ = _make_session()
    ctx = session._build_directive_context()
    assert ctx.model == ""


# ------------------------------------------------------------------
# Session._build_directive_result_event
# ------------------------------------------------------------------


def test_build_directive_result_event_success() -> None:
    """directive_result event with success=True."""
    session, _ = _make_session()
    payload = session._build_directive_result_event("pause", success=True, result="done")

    assert payload["event_type"] == "directive_result"
    assert payload["directive_name"] == "pause"
    assert payload["directive_success"] is True
    assert payload["directive_result"] == "done"
    assert payload["directive_error"] is None


def test_build_directive_result_event_failure() -> None:
    """directive_result event with success=False."""
    session, _ = _make_session()
    payload = session._build_directive_result_event("pause", success=False, error="timeout")

    assert payload["event_type"] == "directive_result"
    assert payload["directive_success"] is False
    assert payload["directive_error"] == "timeout"


# ------------------------------------------------------------------
# Session._execute_custom_directive
# ------------------------------------------------------------------


def test_execute_custom_directive_success() -> None:
    """Successful custom directive execution enqueues a success result."""
    session, _ = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    name = "_test_exec_success"
    fp = _compute_fingerprint(name, "", [])
    try:
        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description="",
            parameters=[],
            fingerprint=fp,
            handler=lambda ctx: "executed",
        )

        d = Directive(
            action=DirectiveAction.CUSTOM,
            reason="test",
            payload={"name": name, "fingerprint": fp, "parameters": {}},
        )
        session._execute_custom_directive(d)

        eq.enqueue.assert_called_once()
        payload = eq.enqueue.call_args[0][0]
        assert payload["directive_success"] is True
        assert payload["directive_result"] == "executed"
    finally:
        _directive_registry.pop(name, None)


def test_execute_custom_directive_handler_not_found() -> None:
    """Missing handler enqueues a failure result."""
    session, _ = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    d = Directive(
        action=DirectiveAction.CUSTOM,
        reason="test",
        payload={"name": "nonexistent", "fingerprint": "x", "parameters": {}},
    )
    session._execute_custom_directive(d)

    eq.enqueue.assert_called_once()
    payload = eq.enqueue.call_args[0][0]
    assert payload["directive_success"] is False
    assert payload["directive_error"] == "handler not found"


def test_execute_custom_directive_fingerprint_mismatch() -> None:
    """Fingerprint mismatch enqueues a failure result."""
    session, _ = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    name = "_test_exec_fp_mismatch"
    try:
        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description="",
            parameters=[],
            fingerprint="correct_fp",
            handler=lambda ctx: None,
        )

        d = Directive(
            action=DirectiveAction.CUSTOM,
            reason="test",
            payload={"name": name, "fingerprint": "wrong_fp", "parameters": {}},
        )
        session._execute_custom_directive(d)

        eq.enqueue.assert_called_once()
        payload = eq.enqueue.call_args[0][0]
        assert payload["directive_success"] is False
        assert "fingerprint mismatch" in payload["directive_error"]
    finally:
        _directive_registry.pop(name, None)


def test_execute_custom_directive_handler_raises() -> None:
    """Handler exception enqueues a failure result, does not raise."""
    session, _ = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    name = "_test_exec_raises"
    fp = _compute_fingerprint(name, "", [])
    try:

        def bad_handler(ctx: Any) -> None:
            raise ValueError("handler exploded")

        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description="",
            parameters=[],
            fingerprint=fp,
            handler=bad_handler,
        )

        d = Directive(
            action=DirectiveAction.CUSTOM,
            reason="test",
            payload={"name": name, "fingerprint": fp, "parameters": {}},
        )
        # Should not raise
        session._execute_custom_directive(d)

        eq.enqueue.assert_called_once()
        payload = eq.enqueue.call_args[0][0]
        assert payload["directive_success"] is False
        assert "handler exploded" in payload["directive_error"]
    finally:
        _directive_registry.pop(name, None)


def test_execute_custom_directive_passes_parameters() -> None:
    """Handler receives parameters from the directive payload."""
    session, _ = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    name = "_test_exec_params"
    params = [DirectiveParameter(name="dur", type="int")]
    fp = _compute_fingerprint(name, "", params)
    captured: dict[str, Any] = {}

    try:

        def handler(ctx: DirectiveContext, dur: int = 0) -> str:
            captured["dur"] = dur
            return "ok"

        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description="",
            parameters=params,
            fingerprint=fp,
            handler=handler,
        )

        d = Directive(
            action=DirectiveAction.CUSTOM,
            reason="test",
            payload={"name": name, "fingerprint": fp, "parameters": {"dur": 42}},
        )
        session._execute_custom_directive(d)

        assert captured["dur"] == 42
    finally:
        _directive_registry.pop(name, None)


# ------------------------------------------------------------------
# _apply_directive dispatches CUSTOM
# ------------------------------------------------------------------


def test_apply_directive_dispatches_custom() -> None:
    """_apply_directive routes CUSTOM actions to _execute_custom_directive."""
    session, _ = _make_session()
    eq = MagicMock()
    session.event_queue = eq

    name = "_test_apply_custom"
    fp = _compute_fingerprint(name, "", [])
    try:
        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description="",
            parameters=[],
            fingerprint=fp,
            handler=lambda ctx: "via_apply",
        )

        d = Directive(
            action=DirectiveAction.CUSTOM,
            reason="test",
            payload={"name": name, "fingerprint": fp, "parameters": {}},
        )
        session._apply_directive(d)

        eq.enqueue.assert_called_once()
        payload = eq.enqueue.call_args[0][0]
        assert payload["event_type"] == "directive_result"
        assert payload["directive_success"] is True
    finally:
        _directive_registry.pop(name, None)


# ------------------------------------------------------------------
# start() calls _sync_directives when registry is non-empty
# ------------------------------------------------------------------


def test_start_calls_sync_directives() -> None:
    """start() calls _sync_directives when _directive_registry is populated."""
    session, client = _make_session()

    name = "_test_start_sync"
    fp = _compute_fingerprint(name, "", [])
    try:
        _directive_registry[name] = DirectiveRegistration(
            name=name,
            description="",
            parameters=[],
            fingerprint=fp,
            handler=lambda ctx: None,
        )

        session.start()
        session.end()

        client.sync_directives.assert_called_once()
    finally:
        _directive_registry.pop(name, None)


# ------------------------------------------------------------------
# Client methods (sync_directives, register_directives)
# ------------------------------------------------------------------


def test_client_sync_directives_returns_unknown(
    mock_control_plane: dict[str, Any],
) -> None:
    """sync_directives returns the unknown list from the server."""
    mock_control_plane["set_response"]({"unknown": ["fp_abc"]})
    client = ControlPlaneClient(
        server=mock_control_plane["url"],
        token="test-token",
    )
    result = client.sync_directives("test", [{"name": "x", "fingerprint": "fp_abc"}])
    assert result == ["fp_abc"]


def test_client_sync_directives_returns_empty_on_error() -> None:
    """sync_directives returns [] on network error (fail open)."""
    client = ControlPlaneClient(
        server="http://127.0.0.1:1",
        token="test-token",
    )
    result = client.sync_directives("test", [{"name": "x", "fingerprint": "fp"}])
    assert result == []


def test_client_register_directives_fire_and_forget(
    mock_control_plane: dict[str, Any],
) -> None:
    """register_directives sends data and does not raise."""
    mock_control_plane["set_response"]({"status": "ok"})
    client = ControlPlaneClient(
        server=mock_control_plane["url"],
        token="test-token",
    )
    # Should not raise
    client.register_directives(
        "test",
        [{"name": "x", "fingerprint": "fp", "description": "", "parameters": []}],
    )
    # Verify the request was received
    assert len(mock_control_plane["requests"]) == 1
    assert mock_control_plane["requests"][0]["path"] == "/v1/directives/register"


def test_client_register_directives_ignores_error() -> None:
    """register_directives does not raise on network error."""
    client = ControlPlaneClient(
        server="http://127.0.0.1:1",
        token="test-token",
    )
    # Should not raise
    client.register_directives("test", [{"name": "x", "fingerprint": "fp"}])


# ------------------------------------------------------------------
# DirectiveAction.CUSTOM enum value
# ------------------------------------------------------------------


def test_directive_action_custom_value() -> None:
    """DirectiveAction.CUSTOM has value 'custom'."""
    assert DirectiveAction.CUSTOM.value == "custom"


# ------------------------------------------------------------------
# EventType.DIRECTIVE_RESULT enum value
# ------------------------------------------------------------------


def test_event_type_directive_result_value() -> None:
    """EventType.DIRECTIVE_RESULT has value 'directive_result'."""
    from flightdeck_sensor.core.types import EventType

    assert EventType.DIRECTIVE_RESULT.value == "directive_result"
