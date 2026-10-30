"""transport/body_limit.py: every event body stays within the server's
1 MiB limit, less headroom, by cutting the strings of captured content."""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Any

from flightdeck_sensor.transport.body_limit import (
    MAX_EVENT_BODY_BYTES,
    encoded_size,
    serialize_event,
    truncation_marker,
)

if TYPE_CHECKING:
    import pytest

_MARKER_RE = re.compile(r"… \[flightdeck: kept (\d+) of (\d+) bytes to fit the event size limit\]$")


def _post_call(content: Any) -> dict[str, Any]:
    return {
        "event_type": "post_call",
        "session_id": "s1",
        "tokens_input": 42,
        "has_content": True,
        "content": content,
    }


def test_an_event_within_the_limit_is_sent_unchanged(caplog: pytest.LogCaptureFixture) -> None:
    payload = _post_call({"messages": [{"role": "user", "content": "hi"}]})
    with caplog.at_level(logging.WARNING):
        assert serialize_event(payload) == json.dumps(payload).encode()
    assert caplog.records == []


def test_oversized_content_is_cut_and_the_tokens_kept(caplog: pytest.LogCaptureFixture) -> None:
    big = "a" * (3 * 1024 * 1024)
    payload = _post_call(
        {
            "provider": "anthropic",
            "messages": [{"role": "user", "content": big}],
            "response": {"content": [{"type": "text", "text": "short"}]},
        }
    )
    with caplog.at_level(logging.WARNING):
        body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    sent = json.loads(body)
    assert sent["tokens_input"] == 42
    assert sent["has_content"] is True
    assert sent["content"]["provider"] == "anthropic"
    assert sent["content"]["response"] == payload["content"]["response"]
    cut = sent["content"]["messages"][0]["content"]
    match = _MARKER_RE.search(cut)
    assert match, cut[-120:]
    kept, total = int(match.group(1)), int(match.group(2))
    assert total == len(big)
    assert cut == "a" * kept + truncation_marker(kept, total)
    assert kept > MAX_EVENT_BODY_BYTES * 0.9
    assert len(caplog.records) == 1
    assert "content strings over" in caplog.records[0].getMessage()
    assert "aaaa" not in caplog.records[0].getMessage()


def test_every_long_string_gets_the_same_cap() -> None:
    payload = _post_call(
        {"system": "b" * 600_000, "messages": [{"role": "user", "content": "c" * 600_000}]}
    )
    sent = json.loads(serialize_event(payload))

    def kept(s: str) -> int:
        m = _MARKER_RE.search(s)
        assert m
        return int(m.group(1))

    assert kept(sent["content"]["system"]) == kept(sent["content"]["messages"][0]["content"])


def test_a_multibyte_character_is_never_split() -> None:
    payload = _post_call({"messages": [{"role": "user", "content": "\U0001f600" * 400_000}]})
    body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    text = json.loads(body)["content"]["messages"][0]["content"]
    assert "�" not in text
    assert re.match(r"^(\U0001f600)+… \[flightdeck: kept \d+ of 1600000 bytes", text)


def test_markup_heavy_content_fits_once_go_re_encodes_it() -> None:
    # Ingestion's Go encoder writes <, > and & as six-byte escapes when
    # it re-encodes a session_start.
    payload = {
        "event_type": "session_start",
        "session_id": "s1",
        "has_content": True,
        "content": {"response": {"body": "<a>" * 240_000}},
    }
    body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    assert len(body) + 5 * (body.count(b"<") + body.count(b">")) <= MAX_EVENT_BODY_BYTES


def test_encoded_size_counts_go_escapes() -> None:
    assert encoded_size(b'{"a":"x"}') == 9
    assert encoded_size(b'{"a":"<&>"}') == 11 + 3 * 5


def test_without_any_fitting_cut_the_event_goes_without_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    blocks = [{"type": "text", "text": ""} for _ in range(60_000)]
    payload = _post_call({"messages": [], "response": {"content": blocks}})
    with caplog.at_level(logging.WARNING):
        sent = json.loads(serialize_event(payload))
    assert sent["content"] is None
    assert sent["has_content"] is False
    assert sent["tokens_input"] == 42
    assert "cannot be cut" in caplog.records[0].getMessage()


def test_an_event_over_the_limit_without_content_keeps_it(caplog: pytest.LogCaptureFixture) -> None:
    payload = {
        **_post_call({"messages": [{"role": "user", "content": "hi"}]}),
        "note": "q" * MAX_EVENT_BODY_BYTES,
    }
    with caplog.at_level(logging.WARNING):
        assert serialize_event(payload) == json.dumps(payload).encode()
    assert "without its content" in caplog.records[0].getMessage()


def test_an_oversized_event_with_no_content_is_sent_as_it_is() -> None:
    payload = {"event_type": "tool_call", "content": None, "note": "q" * MAX_EVENT_BODY_BYTES}
    assert serialize_event(payload) == json.dumps(payload).encode()


def test_a_string_the_marker_would_lengthen_is_kept() -> None:
    blocks = [{"type": "text", "text": f"block {i} ".ljust(60, "y")} for i in range(4000)]
    payload = _post_call(
        {"messages": [{"role": "user", "content": "z" * 900_000}], "response": {"content": blocks}}
    )
    sent = json.loads(serialize_event(payload))
    assert sent["content"]["response"]["content"] == blocks


def test_the_budget_leaves_room_under_the_one_mib_limit() -> None:
    assert MAX_EVENT_BODY_BYTES <= 0.8 * 1024 * 1024
