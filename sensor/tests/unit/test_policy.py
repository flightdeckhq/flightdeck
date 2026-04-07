"""Tests for PolicyCache: thresholds, fire-once, update, local limit (D035)."""

from __future__ import annotations

from flightdeck_sensor.core.types import PolicyDecision
from flightdeck_sensor.core.policy import PolicyCache


def test_allow_below_all_thresholds() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    result = cache.check(tokens_used=100, estimated=100)
    assert result.decision == PolicyDecision.ALLOW


def test_warn_fires_at_configured_pct() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    result = cache.check(tokens_used=750, estimated=100)
    assert result.decision == PolicyDecision.WARN
    assert result.source == "server"


def test_warn_fires_only_once_per_session() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    first = cache.check(tokens_used=750, estimated=100)
    second = cache.check(tokens_used=760, estimated=100)
    assert first.decision == PolicyDecision.WARN
    assert second.decision == PolicyDecision.ALLOW


def test_degrade_at_threshold() -> None:
    cache = PolicyCache(
        token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100, degrade_to="gpt-4o-mini"
    )
    result = cache.check(tokens_used=850, estimated=100)
    assert result.decision == PolicyDecision.DEGRADE
    assert result.source == "server"


def test_block_at_threshold() -> None:
    cache = PolicyCache(token_limit=1000, warn_at_pct=80, degrade_at_pct=90, block_at_pct=100)
    result = cache.check(tokens_used=950, estimated=100)
    assert result.decision == PolicyDecision.BLOCK
    assert result.source == "server"


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
    assert result.decision == PolicyDecision.WARN


def test_no_limit_always_allows() -> None:
    cache = PolicyCache(token_limit=None)
    result = cache.check(tokens_used=999999, estimated=999999)
    assert result.decision == PolicyDecision.ALLOW


# --- D035: Local limit tests ---


def test_local_limit_fires_warn_with_source_local() -> None:
    cache = PolicyCache(local_limit=50000, local_warn_at=0.8)
    result = cache.check(tokens_used=40000, estimated=1000)
    assert result.decision == PolicyDecision.WARN
    assert result.source == "local"


def test_local_warn_does_not_block_the_call() -> None:
    cache = PolicyCache(local_limit=1000, local_warn_at=0.8)
    # Even when tokens far exceed the local limit, it only WARNs
    result = cache.check(tokens_used=5000, estimated=100)
    assert result.decision == PolicyDecision.WARN
    assert result.source == "local"
    # Second check: fire-once means ALLOW, never BLOCK
    result2 = cache.check(tokens_used=9000, estimated=100)
    assert result2.decision == PolicyDecision.ALLOW


def test_most_restrictive_threshold_fires_first() -> None:
    # Server warns at 80% of 100k = 80k, local warns at 80% of 50k = 40k
    # Local fires first because 40k < 80k
    cache = PolicyCache(
        token_limit=100000, warn_at_pct=80,
        degrade_at_pct=90, block_at_pct=100,
        local_limit=50000, local_warn_at=0.8,
    )
    result = cache.check(tokens_used=40000, estimated=1000)
    assert result.decision == PolicyDecision.WARN
    assert result.source == "local"


def test_local_limit_does_not_upgrade_to_block() -> None:
    # Local limit = 1000, tokens used = 5000 -- far exceeds limit
    # But local can only WARN (D035), never BLOCK
    cache = PolicyCache(local_limit=1000, local_warn_at=0.8)
    result = cache.check(tokens_used=5000, estimated=100)
    assert result.decision != PolicyDecision.BLOCK
    assert result.decision == PolicyDecision.WARN
    assert result.source == "local"
