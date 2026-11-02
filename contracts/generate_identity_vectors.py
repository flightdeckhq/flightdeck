"""Regenerate contracts/identity_vectors.json from the Python sensor.

The sensor's derivation (flightdeck_sensor.core.agent_id) is canonical.
The plugin (plugin/tests/identity_vectors.test.mjs), the Go ingestion
port (ingestion/internal/identity/identity_test.go) and the sensor itself
(sensor/tests/unit/test_identity_vectors.py) each assert every vector, so
a change to one implementation that the others do not share fails a test.

Run from the repository root with the sensor's environment:

    sensor/.venv/bin/python contracts/generate_identity_vectors.py \\
        > contracts/identity_vectors.json
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sensor"))

from flightdeck_sensor.core.agent_id import (  # noqa: E402
    NAMESPACE_FLIGHTDECK,
    derive_agent_id,
)

NS = str(NAMESPACE_FLIGHTDECK)

UUID5_NAMES = [
    "flightdeck://otlp/claude-code/session/898e9d82-4172-4be8-88e7-1df336742e10",
    "flightdeck://otlp/claude-code/session/898e9d82-4172-4be8-88e7-1df336742e10/aad3b518eff5ab279",
    "flightdeck://otlp/claude-code/event/898e9d82-4172-4be8-88e7-1df336742e10/api_request/14/1793534465960000000",
    "flightdeck:subagent://11111111-2222-4333-8444-555555555555/toolu_01",
    "",
    "flightdeck://unicode/naïve-ü-日本",
]

_BASE = {
    "agent_type": "coding",
    "user": "alice",
    "hostname": "build-01",
    "client_type": "claude_code",
    "agent_name": "alice@build-01",
}

AGENTS = [
    # The locked vector ARCHITECTURE.md (Agent identity) quotes.
    {
        "agent_type": "coding",
        "user": "omria",
        "hostname": "Omri-PC",
        "client_type": "claude_code",
        "agent_name": "omria@Omri-PC",
        "agent_role": None,
    },
    {
        "agent_type": "coding",
        "user": "user@example.com",
        "hostname": "unknown",
        "client_type": "claude_code",
        "agent_name": "user@example.com@unknown",
        "agent_role": None,
    },
    {
        "agent_type": "coding",
        "user": "user@example.com",
        "hostname": "unknown",
        "client_type": "claude_code",
        "agent_name": "user@example.com@unknown",
        "agent_role": "general-purpose",
    },
    {**_BASE, "agent_role": "  Explore  "},
    {
        "agent_type": "production",
        "user": "svc",
        "hostname": "pod-7",
        "client_type": "flightdeck_sensor",
        "agent_name": "svc@pod-7",
        "agent_role": "   ",
    },
    {
        "agent_type": "coding",
        "user": "unknown",
        "hostname": "unknown",
        "client_type": "claude_code",
        "agent_name": "unknown@unknown",
        "agent_role": "",
    },
    # Roles whose ends Python's str.strip(), Go's strings.TrimSpace and
    # JavaScript's trim() treat differently: the ASCII separators
    # U+001C..U+001F (stripped by Python only), U+0085 (not by
    # JavaScript) and U+FEFF (by JavaScript only). str.strip() is the
    # definition.
    {**_BASE, "agent_role": "\x1cExplore\x1f"},
    {**_BASE, "agent_role": "\x85Explore　"},
    {**_BASE, "agent_role": "﻿Explore﻿"},
    {**_BASE, "agent_role": "\x1d\x1e"},
]


def main() -> None:
    out = {
        "about": (
            "Identity derivation vectors, generated from the Python sensor "
            "(flightdeck_sensor.core.agent_id) by "
            "contracts/generate_identity_vectors.py. "
            "The sensor, the Go ingestion port and the Claude Code plugin each assert "
            "every id, and that their role trim removes exactly role_trim_code_points "
            "(what Python's str.strip() removes)."
        ),
        "namespace_flightdeck": NS,
        "uuid5": [
            {"namespace": NS, "name": n, "uuid": str(uuid.uuid5(uuid.UUID(NS), n))}
            for n in UUID5_NAMES
        ]
        + [
            {"namespace": str(uuid.NAMESPACE_DNS), "name": "flightdeck.dev", "uuid": NS}
        ],
        "agent_id": [{**a, "agent_id": str(derive_agent_id(**a))} for a in AGENTS],
        "role_trim_code_points": [
            i for i in range(0x110000) if ("a" + chr(i)).strip() == "a"
        ],
    }
    print(json.dumps(out, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
