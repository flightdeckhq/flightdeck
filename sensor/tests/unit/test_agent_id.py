"""Unit tests for :mod:`flightdeck_sensor.core.agent_id`.

D115 locks the namespace UUID and the fixture vector -- the assertions
here guarantee the Python and Node implementations stay in lock-step
and that the namespace is never accidentally rotated.
"""
from __future__ import annotations

from uuid import UUID

import pytest

from flightdeck_sensor.core.agent_id import (
    NAMESPACE_FLIGHTDECK,
    derive_agent_id,
)


class TestNamespace:
    def test_value_is_frozen(self) -> None:
        # Freezing this value is the whole point of NAMESPACE_FLIGHTDECK
        # -- any change orphans every historical agent_id. The literal
        # comparison here is the tripwire: if a future refactor
        # "improves" the constant, this test fails loudly.
        assert str(NAMESPACE_FLIGHTDECK) == "ee22ab58-26fc-54ef-91b4-b5c0a97f9b61"

    def test_is_regenerable_from_seed(self) -> None:
        # Byte-for-byte equivalence with the documented seed derivation.
        # Doubles as migration-history documentation in code.
        from uuid import NAMESPACE_DNS, uuid5

        assert NAMESPACE_FLIGHTDECK == uuid5(NAMESPACE_DNS, "flightdeck.dev")


class TestDeriveAgentId:
    def test_fixture_vector(self) -> None:
        # Locked by the v0.4.0 Phase 1 brief. Node twin asserts the
        # same value in ``plugin/tests/agent_id.test.mjs``.
        aid = derive_agent_id(
            agent_type="coding",
            user="omria",
            hostname="Omri-PC",
            client_type="claude_code",
            agent_name="omria@Omri-PC",
        )
        assert str(aid) == "ee76931b-06fa-5da6-a019-5a8237efd496"

    def test_same_inputs_same_uuid(self) -> None:
        a = derive_agent_id(
            agent_type="production",
            user="alice",
            hostname="worker-1",
            client_type="flightdeck_sensor",
            agent_name="ci-runner",
        )
        b = derive_agent_id(
            agent_type="production",
            user="alice",
            hostname="worker-1",
            client_type="flightdeck_sensor",
            agent_name="ci-runner",
        )
        assert a == b

    @pytest.mark.parametrize(
        "override",
        [
            {"agent_type": "coding"},
            {"user": "bob"},
            {"hostname": "worker-2"},
            {"client_type": "claude_code"},
            {"agent_name": "batch-job"},
        ],
    )
    def test_different_inputs_different_uuids(
        self, override: dict[str, str]
    ) -> None:
        base = dict(
            agent_type="production",
            user="alice",
            hostname="worker-1",
            client_type="flightdeck_sensor",
            agent_name="ci-runner",
        )
        a = derive_agent_id(**base)
        b = derive_agent_id(**{**base, **override})
        assert a != b, f"override {override!r} produced a colliding uuid"

    def test_returns_uuid_instance(self) -> None:
        # Callers treat the return as a UUID; str(...) is the wire form.
        aid = derive_agent_id(
            agent_type="coding",
            user="u",
            hostname="h",
            client_type="claude_code",
            agent_name="n",
        )
        assert isinstance(aid, UUID)
