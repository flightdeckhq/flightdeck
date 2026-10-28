"""The client type registry, end to end: the client_type CHECK
constraints hold exactly its values, every value passes ingestion and is
stored, and the API's client_type filter accepts exactly those values.

``contracts/client_types.json`` is the registry's one source. The
``agents_client_type_check`` and ``sessions_client_type_check``
constraints are a copy maintained by migrations; this test reads them
from ``pg_constraint`` so a registry change that misses its migration
(or a migration that drifts from the registry) fails here.
"""

from __future__ import annotations

import json
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid

import pytest

from .conftest import (
    API_URL,
    auth_headers,
    delete_flavor_data,
    exec_sql,
    make_event,
    post_event,
    wait_for_session_in_fleet,
)

REGISTRY_PATH = (
    pathlib.Path(__file__).resolve().parents[2] / "contracts" / "client_types.json"
)
CONSTRAINTS = (
    ("agents", "agents_client_type_check"),
    ("sessions", "sessions_client_type_check"),
)


def _registry_ids() -> list[str]:
    # Fails, not skips, when the source file is missing.
    data = json.loads(REGISTRY_PATH.read_text())
    return [entry["id"] for entry in data["client_types"]]


@pytest.mark.parametrize(("table", "constraint"), CONSTRAINTS)
def test_client_type_constraint_matches_registry(table: str, constraint: str) -> None:
    row = exec_sql(
        "SELECT convalidated, pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = :'name' AND conrelid = :'table'::regclass",
        name=constraint,
        table=table,
    )
    assert row, f"constraint {constraint} not found"
    validated, definition = row.split("|", 1)
    assert validated == "t", f"{constraint} is not validated"
    values = re.findall(r"'([^']*)'::text", definition)
    assert sorted(values) == sorted(_registry_ids()), (
        f"{constraint} allows {sorted(values)}, the registry lists {sorted(_registry_ids())}"
    )


def _registry_entries() -> list[dict[str, object]]:
    return list(json.loads(REGISTRY_PATH.read_text())["client_types"])


@pytest.mark.parametrize("entry", _registry_entries(), ids=lambda e: str(e["id"]))
def test_every_registry_client_type_is_ingested_and_stored(
    entry: dict[str, object],
) -> None:
    client_type = str(entry["id"])
    flavor = f"test-client-type-{client_type}-{uuid.uuid4().hex[:6]}"
    session_id = str(uuid.uuid4())
    try:
        post_event(
            make_event(
                session_id,
                flavor,
                "session_start",
                client_type=client_type,
                agent_type=str(entry["agent_type"]),
            )
        )
        session = wait_for_session_in_fleet(session_id, timeout=10.0)
        assert session is not None, f"{client_type}: session never stored"
        assert session.get("client_type") == client_type
    finally:
        delete_flavor_data(flavor)


def _filter_status(path: str, client_type: str) -> int:
    url = f"{API_URL}{path}?" + urllib.parse.urlencode({"client_type": client_type})
    req = urllib.request.Request(url, headers=auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


@pytest.mark.parametrize("path", ["/v1/agents", "/v1/sessions"])
def test_client_type_filter_accepts_registry_values_only(path: str) -> None:
    for entry in _registry_entries():
        assert _filter_status(path, str(entry["id"])) == 200, (path, entry["id"])
    assert _filter_status(path, "windsurf") == 400
