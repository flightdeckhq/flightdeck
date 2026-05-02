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


class TestSubAgentRoleDerivation:
    """D126 conditional 6th input.

    Verifies that adding ``agent_role`` to the call shape leaves the
    D115 5-tuple derivation byte-for-byte unchanged, that supplied
    roles produce distinct uuids, that semantically-empty role
    values collapse to the 5-tuple form, and that whitespace is
    trimmed before the role joins the derivation.
    """

    def _root_kwargs(self) -> dict[str, str]:
        # The locked v0.4.0 Phase 1 fixture vector — root call shape
        # with no role. Repeated here so each test is self-contained.
        return dict(
            agent_type="coding",
            user="omria",
            hostname="Omri-PC",
            client_type="claude_code",
            agent_name="omria@Omri-PC",
        )

    def test_omitting_role_kwarg_matches_d115_fixture(self) -> None:
        # Hardest regression we have to protect: the D115 fixture
        # vector. Callers that don't pass agent_role at all must
        # produce the legacy uuid byte-for-byte, otherwise every
        # historical agent_id in every deployment is orphaned.
        aid = derive_agent_id(**self._root_kwargs())
        assert str(aid) == "ee76931b-06fa-5da6-a019-5a8237efd496"

    def test_role_none_matches_d115_fixture(self) -> None:
        # Callers that pass agent_role=None explicitly must collapse
        # to the same path the kwarg-omitted form takes. This is the
        # common shape for direct-SDK callers under D126: pass the
        # kwarg uniformly, set it to None for non-sub-agent
        # sessions.
        aid = derive_agent_id(**self._root_kwargs(), agent_role=None)
        assert str(aid) == "ee76931b-06fa-5da6-a019-5a8237efd496"

    @pytest.mark.parametrize("role", ["", "   ", "\t\n", " \n  \t "])
    def test_empty_or_whitespace_role_collapses_to_5tuple(
        self, role: str
    ) -> None:
        # Empty, all-spaces, all-tabs, mixed-whitespace — none of
        # these carry semantic identity, so the derivation must
        # collapse to the 5-tuple form. A sensor or framework that
        # accidentally emits a blank role must NOT produce a
        # distinct agent_id (that would silently fork identity for
        # the same logical agent across well-typed-vs-blank
        # emissions).
        aid = derive_agent_id(**self._root_kwargs(), agent_role=role)
        assert str(aid) == "ee76931b-06fa-5da6-a019-5a8237efd496"

    def test_supplied_role_changes_uuid(self) -> None:
        # The point of the 6th input: a CrewAI Researcher and a
        # CrewAI Writer running on the same host land under
        # distinct agent_ids despite sharing the rest of the
        # 5-tuple.
        root = derive_agent_id(**self._root_kwargs())
        researcher = derive_agent_id(
            **self._root_kwargs(), agent_role="Researcher"
        )
        writer = derive_agent_id(
            **self._root_kwargs(), agent_role="Writer"
        )
        assert root != researcher
        assert root != writer
        assert researcher != writer

    def test_role_is_deterministic(self) -> None:
        # Same role string deterministically produces the same hash.
        a = derive_agent_id(
            **self._root_kwargs(), agent_role="Researcher"
        )
        b = derive_agent_id(
            **self._root_kwargs(), agent_role="Researcher"
        )
        assert a == b

    def test_role_whitespace_is_trimmed(self) -> None:
        # Leading / trailing whitespace must not produce a distinct
        # agent_id. Frameworks that pass role values verbatim
        # without normalising shouldn't fork identity over a
        # spurious trailing newline. Trimmed value is what hits the
        # path.
        bare = derive_agent_id(
            **self._root_kwargs(), agent_role="Researcher"
        )
        padded = derive_agent_id(
            **self._root_kwargs(), agent_role="  Researcher  "
        )
        newlined = derive_agent_id(
            **self._root_kwargs(), agent_role="\nResearcher\n"
        )
        assert bare == padded == newlined

    def test_role_internal_whitespace_is_preserved(self) -> None:
        # Trim is leading/trailing only; internal whitespace is
        # part of the role. ``"Senior Researcher"`` is a different
        # role from ``"Researcher"`` and from ``"SeniorResearcher"``
        # — the derivation must reflect that.
        single = derive_agent_id(
            **self._root_kwargs(), agent_role="Researcher"
        )
        compound = derive_agent_id(
            **self._root_kwargs(), agent_role="Senior Researcher"
        )
        nospace = derive_agent_id(
            **self._root_kwargs(), agent_role="SeniorResearcher"
        )
        assert single != compound
        assert compound != nospace
        assert single != nospace
