"""Policy enforcement smoke test — runs the live sensor against a real
provider and a real flavor-scoped policy, then verifies the three
policy event types land on the wire with the contract-shape payload.

Rule 40d compliance: real provider + real LLM call + real worker
policy evaluator + real ingestion pipeline, end-to-end. Manual; NOT
in CI. Run via ``make smoke-policies``.

Why a dedicated smoke file rather than per-framework additions:
policy event emission is sensor-side, NOT a framework integration
boundary. The decision logic lives in ``interceptor/base.py``
``_pre_call`` and ``core/session.py`` ``_apply_directive``; neither
depends on which provider SDK is installed. One Anthropic-driven
smoke covers the full contract.

Scenarios:

* **WARN** — server policy with ``warn_at_pct=1`` so the first call
  crosses; sensor receives a WARN directive on the response envelope
  and emits ``policy_warn`` (source=server).
* **DEGRADE** — ``degrade_at_pct=2`` triggers a DEGRADE directive;
  sensor emits ``policy_degrade`` once with from/to model, then
  applies the swap. Per Decision 1: subsequent calls run on the
  degraded model but do NOT re-emit ``policy_degrade``.
* **BLOCK** — ``block_at_pct=50`` + tight ``token_limit=20`` so the
  second call's pre-flight check raises. Sensor emits
  ``policy_block`` with intended_model + tokens_used + token_limit,
  flushes the queue synchronously, then raises ``BudgetExceededError``.

Estimated cost across all three scenarios: ~$0.01.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
import uuid
from typing import Any

import pytest

from tests.smoke.conftest import (
    fetch_events_for_session,
    make_sensor_session,
    require_env,
    wait_for_dev_stack,
)

API_URL = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
TOKEN = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
AUTH = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def _api(method: str, path: str, body: Any = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API_URL + path, data=data, method=method, headers=AUTH)
    raw = urllib.request.urlopen(req, timeout=10).read()
    return json.loads(raw) if raw else None


def _create_policy(flavor: str, **overrides: Any) -> dict[str, Any]:
    body = {
        "scope": "flavor",
        "scope_value": flavor,
        "token_limit": 1000,
        "warn_at_pct": 1,
        "degrade_at_pct": 50,
        "block_at_pct": 99,
    }
    body.update(overrides)
    return _api("POST", "/v1/policies", body)


def _delete_policy(policy_id: str) -> None:
    try:
        _api("DELETE", f"/v1/policies/{policy_id}")
    except Exception:
        pass


@pytest.fixture(scope="module", autouse=True)
def _stack_ready() -> None:
    require_env("ANTHROPIC_API_KEY")
    wait_for_dev_stack()


def test_policy_warn_event_fires_on_threshold_cross() -> None:
    import anthropic

    flavor = f"smoke-policy-warn-{uuid.uuid4().hex[:6]}"
    policy = _create_policy(
        flavor,
        token_limit=1000,
        warn_at_pct=1,
        degrade_at_pct=90,
        block_at_pct=99,
    )
    try:
        sess = make_sensor_session(flavor=flavor)
        client = anthropic.Anthropic()
        # Two calls so the WARN directive issued after the first
        # post_call is delivered on the second call's response and
        # _apply_directive emits the event.
        for _ in range(2):
            client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
        events = fetch_events_for_session(
            sess.config.session_id,
            expect_event_types=["policy_warn"],
        )
        warns = [e for e in events if e["event_type"] == "policy_warn"]
        assert warns, f"no policy_warn observed; events={events!r}"
        assert (warns[0].get("payload") or {}).get("source") == "server"
    finally:
        _delete_policy(policy["id"])


def test_policy_degrade_event_fires_with_from_to_model() -> None:
    import anthropic

    flavor = f"smoke-policy-degrade-{uuid.uuid4().hex[:6]}"
    sonnet = "claude-sonnet-4-5-20250929"
    haiku = "claude-haiku-4-5-20251001"
    policy = _create_policy(
        flavor,
        token_limit=1000,
        warn_at_pct=1,
        degrade_at_pct=2,
        block_at_pct=99,
        degrade_to=haiku,
    )
    try:
        sess = make_sensor_session(flavor=flavor)
        client = anthropic.Anthropic()
        # Three calls: first uses sonnet, sensor receives DEGRADE
        # directive on call-2 response, subsequent calls use haiku.
        models_seen: list[str] = []
        for _ in range(3):
            r = client.messages.create(
                model=sonnet,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            models_seen.append(r.model)
        events = fetch_events_for_session(
            sess.config.session_id,
            expect_event_types=["policy_degrade"],
        )
        degrades = [e for e in events if e["event_type"] == "policy_degrade"]
        assert degrades, f"no policy_degrade observed; events={events!r}"
        payload = degrades[0].get("payload") or {}
        # Sensor records the model the agent was on at directive
        # arrival; the actual swap happens on the next call. The
        # to_model is the directive's degrade_to.
        assert payload.get("to_model") == haiku, payload
        # Subsequent calls observed on the degraded model.
        assert haiku in models_seen, models_seen
    finally:
        _delete_policy(policy["id"])


def test_policy_block_event_fires_and_blocks_with_intended_model() -> None:
    import anthropic
    from flightdeck_sensor import BudgetExceededError

    flavor = f"smoke-policy-block-{uuid.uuid4().hex[:6]}"
    intended = "claude-haiku-4-5-20251001"
    # Tight limit so the second call's _pre_call hits BLOCK locally.
    policy = _create_policy(
        flavor,
        token_limit=20,
        warn_at_pct=1,
        degrade_at_pct=10,
        block_at_pct=50,
    )
    try:
        sess = make_sensor_session(flavor=flavor)
        client = anthropic.Anthropic()
        client.messages.create(
            model=intended,
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        with pytest.raises(BudgetExceededError):
            client.messages.create(
                model=intended,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
        # The sensor flushed the queue synchronously before raising,
        # so the policy_block event is on the wire before this fetch.
        events = fetch_events_for_session(
            sess.config.session_id,
            expect_event_types=["policy_block"],
        )
        blocks = [e for e in events if e["event_type"] == "policy_block"]
        assert blocks, f"no policy_block observed; events={events!r}"
        payload = blocks[0].get("payload") or {}
        assert payload.get("source") == "server"
        assert payload.get("intended_model") == intended, payload
        assert payload.get("token_limit") == 20, payload
    finally:
        _delete_policy(policy["id"])
