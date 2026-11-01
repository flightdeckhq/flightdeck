"""The recorded OTLP fixtures stay scrubbed.

tests/otlp/record_claude_code.py replaces Claude Code's identity and
machine attributes with placeholders and drops the records that describe
the recording machine, and refuses to write a scenario that fails
tests/otlp/fixture_checks.py. This test runs the same checks over the
committed fixtures, protobuf files included, so a hand edit or a
recorder change cannot commit a real account's identifiers, the user's
connector names, an email address or a machine path.
"""

from __future__ import annotations

from pathlib import Path

from ..otlp.fixture_checks import directory_problems, problems

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "otlp"


def _scenarios() -> list[Path]:
    return sorted(p.parent for p in FIXTURES.glob("*/*/manifest.json"))


def test_the_fixtures_exist() -> None:
    assert _scenarios(), f"no OTLP fixtures under {FIXTURES}"


def test_every_fixture_passes_the_privacy_checks() -> None:
    found = [p for scenario in _scenarios() for p in directory_problems(scenario)]
    assert found == []


def test_the_checks_catch_a_planted_leak(tmp_path: Path) -> None:
    """The checks themselves: a real-looking identity value, a connector
    record and a machine path are each reported, in JSON and protobuf."""
    leaky = tmp_path / "001-logs.json"
    leaky.write_text(
        '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":['
        '{"key":"user.email","value":{"stringValue":"someone@corp.example.org"}},'
        '{"key":"server_scope","value":{"stringValue":"claudeai"}},'
        '{"key":"cwd","value":{"stringValue":"/home/alice/repo"}}]}]}]}]}'
    )
    found = problems(leaky)
    assert any("user.email" in p for p in found), found
    assert any("claude.ai connector" in p for p in found), found
    assert any("/home/alice" in p for p in found), found

    def field(number: int, payload: bytes) -> bytes:
        return bytes([number << 3 | 2, len(payload)]) + payload

    any_value = field(1, b"00000000-1111-2222-3333-444444444444")
    key_value = field(1, b"organization.id") + field(2, any_value)
    pb = tmp_path / "002-logs.pb"
    pb.write_bytes(field(1, field(2, field(2, field(6, key_value)))))
    assert any("organization.id" in p for p in problems(pb)), problems(pb)
