"""Availability-guard behaviour of the MCP interceptor.

These tests run whether or not ``mcp`` is importable: they drive the
guard state directly so the "installed but unsupported" path has
coverage even in an environment where the import succeeded.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from flightdeck_sensor.interceptor import mcp as mcp_interceptor

if TYPE_CHECKING:
    import pytest

_LOGGER = "flightdeck_sensor.interceptor.mcp"


def test_patch_warns_when_mcp_installed_but_unimportable(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(mcp_interceptor, "_MCP_AVAILABLE", False)
    monkeypatch.setattr(mcp_interceptor, "_MCP_IMPORT_ERROR", "cannot import name 'McpError'")
    monkeypatch.setattr(mcp_interceptor, "_installed_mcp_version", lambda: "2.1.0")
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        mcp_interceptor.patch_mcp_classes(quiet=True)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "2.1.0" in message
    assert "cannot import name 'McpError'" in message
    assert mcp_interceptor._MCP_SUPPORTED_RANGE in message


def test_patch_stays_quiet_when_mcp_absent(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(mcp_interceptor, "_MCP_AVAILABLE", False)
    monkeypatch.setattr(mcp_interceptor, "_installed_mcp_version", lambda: None)
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        mcp_interceptor.patch_mcp_classes(quiet=False)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("not installed" in r.getMessage() for r in caplog.records)
