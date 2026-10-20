"""The e2e fixture seeder waits for the Fleet only on agents it actually
(re)seeded. Stack-free: every network and database touch of ``seed.py``
is stubbed, so this pins the control flow of ``seed()`` and not the
fixtures themselves."""

from __future__ import annotations

import importlib.util
import pathlib
import subprocess
import sys
from typing import Any

import pytest

SEED_PATH = pathlib.Path(__file__).resolve().parents[1] / "e2e-fixtures" / "seed.py"


@pytest.fixture
def seeder(monkeypatch: pytest.MonkeyPatch) -> Any:
    spec = importlib.util.spec_from_file_location("e2e_seed_under_test", SEED_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "wait_for_services", lambda timeout: None)
    monkeypatch.setattr(module, "_post_session_events", lambda **kw: 1)
    monkeypatch.setattr(module, "post_event", lambda *a, **kw: None)
    # The backdate step shells out to psql and reads returncode / stdout.
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *a, **kw: subprocess.CompletedProcess(args=a, returncode=0, stdout="", stderr=""),
    )
    waits: list[list[str]] = []
    monkeypatch.setattr(
        module,
        "_wait_for_fleet_visibility",
        lambda names, timeout: waits.append(sorted(names)),
    )
    module.recorded_waits = waits
    return module


def _agent_names(module: Any) -> list[str]:
    import json

    with module.CANONICAL_PATH.open() as fh:
        return sorted(a["agent_name"] for a in json.load(fh)["agents"])


def test_first_seed_waits_once_for_every_canonical_agent(
    seeder: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(seeder, "_session_is_complete", lambda session_id, role_cfg: False)
    seeder.seed(mode="full")
    assert seeder.recorded_waits == [_agent_names(seeder)]


def test_reseed_with_every_session_present_skips_the_fleet_wait(
    seeder: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(seeder, "_session_is_complete", lambda session_id, role_cfg: True)
    seeder.seed(mode="full")
    assert seeder.recorded_waits == []


def test_partial_reseed_waits_only_for_agents_with_new_sessions(
    seeder: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    names = _agent_names(seeder)
    target = names[-1]
    incomplete = {seeder._derive_session_id(target, role) for role in _roles_of(seeder, target)}
    monkeypatch.setattr(
        seeder,
        "_session_is_complete",
        lambda session_id, role_cfg: session_id not in incomplete,
    )
    seeder.seed(mode="full")
    assert seeder.recorded_waits == [[target]]


def _roles_of(module: Any, agent_name: str) -> list[str]:
    import json

    with module.CANONICAL_PATH.open() as fh:
        for agent in json.load(fh)["agents"]:
            if agent["agent_name"] == agent_name:
                return list(agent["session_roles"])
    raise AssertionError(agent_name)
