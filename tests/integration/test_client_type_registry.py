"""The client_type CHECK constraints hold exactly the client type
registry's values.

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

import pytest

from .conftest import exec_sql

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
