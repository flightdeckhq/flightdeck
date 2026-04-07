"""Tests for PolicyCache: thresholds, fire-once, update."""

from __future__ import annotations

from flightdeck_sensor.core.types import PolicyDecision
from flightdeck_sensor.core.policy import PolicyCache


def test_allow_below_all_thresholds() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    result = cache.check(tokens_used=100, estimated=100)
    assert result == PolicyDecision.ALLOW


def test_warn_fires_at_configured_pct() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    result = cache.check(tokens_used=750, estimated=100)
    assert result == PolicyDecision.WARN


def test_warn_fires_only_once_per_session() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    first = cache.check(tokens_used=750, estimated=100)
    second = cache.check(tokens_used=760, estimated=100)
    assert first == PolicyDecision.WARN
    assert second == PolicyDecision.ALLOW


def test_degrade_at_threshold() -> None:
    cache = PolicyCache(
        token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100, degrade_to="gpt-4o-mini"
    )
    result = cache.check(tokens_used=850, estimated=100)
    assert result == PolicyDecision.DEGRADE


def test_block_at_threshold() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    result = cache.check(tokens_used=950, estimated=100)
    assert result == PolicyDecision.BLOCK


def test_update_replaces_all_fields_atomically() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    cache.check(tokens_used=850, estimated=0)  # fire warn
    cache.update({"token_limit": 5000, "warn_at_pct": 70, "degrade_at_pct": 85, "block_at_pct": 95})
    assert cache.token_limit == 5000
    assert cache.warn_at_pct == 70
    assert cache.degrade_at_pct == 85
    assert cache.block_at_pct == 95
    # warn flag should be reset
    result = cache.check(tokens_used=3600, estimated=100)
    assert result == PolicyDecision.WARN


def test_no_limit_always_allows() -> None:
    cache = PolicyCache(token_limit=None)
    result = cache.check(tokens_used=999999, estimated=999999)
    assert result == PolicyDecision.ALLOW
