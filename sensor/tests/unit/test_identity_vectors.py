"""The sensor reproduces contracts/identity_vectors.json.

The vectors are generated from this package by
contracts/generate_identity_vectors.py; the Claude Code plugin and the
Go ingestion port assert the same file. This test pins the sensor to the
committed file, so a change to the derivation that is not regenerated
into the vectors (and so not checked against the other two) fails here.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest

from flightdeck_sensor.core.agent_id import NAMESPACE_FLIGHTDECK, derive_agent_id

VECTORS = Path(__file__).resolve().parents[3] / "contracts" / "identity_vectors.json"


def _vectors() -> dict[str, Any]:
    return json.loads(VECTORS.read_text())  # type: ignore[no-any-return]


def test_namespace_matches() -> None:
    assert _vectors()["namespace_flightdeck"] == str(NAMESPACE_FLIGHTDECK)


@pytest.mark.parametrize("vector", _vectors()["uuid5"], ids=lambda v: v["name"][:60] or "empty")
def test_uuid5_vectors(vector: dict[str, str]) -> None:
    assert str(uuid.uuid5(uuid.UUID(vector["namespace"]), vector["name"])) == vector["uuid"]


@pytest.mark.parametrize("vector", _vectors()["agent_id"], ids=lambda v: repr(v["agent_role"]))
def test_agent_id_vectors(vector: dict[str, Any]) -> None:
    inputs = {k: v for k, v in vector.items() if k != "agent_id"}
    assert str(derive_agent_id(**inputs)) == vector["agent_id"]


def test_role_trim_set_is_str_strip() -> None:
    """The role trim the vectors record is exactly what str.strip()
    removes, the definition the plugin and the Go port follow."""
    want = set(_vectors()["role_trim_code_points"])
    got = {i for i in range(0x110000) if ("a" + chr(i)).strip() == "a"}
    assert got == want
    # A role that differs between the languages' built-in trims derives
    # the id of its stripped form.
    base = {
        "agent_type": "coding",
        "user": "alice",
        "hostname": "build-01",
        "client_type": "claude_code",
        "agent_name": "alice@build-01",
    }
    assert derive_agent_id(**base, agent_role="\x1cExplore\x1f") == derive_agent_id(
        **base, agent_role="Explore"
    )
    assert derive_agent_id(**base, agent_role="﻿Explore") != derive_agent_id(
        **base, agent_role="Explore"
    )
