"""transport/body_limit.py: every event body stays within the server's
1 MiB limit, less headroom, by cutting the strings of captured content,
and an embeddings call's vectors before them."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import random
import re
import struct
from typing import Any

import pytest

from flightdeck_sensor.transport import body_limit
from flightdeck_sensor.transport.body_limit import (
    MAX_EVENT_BODY_BYTES,
    _cap_strings,
    encoded_size,
    serialize_event,
    truncation_marker,
)

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


def test_a_system_given_as_blocks_is_cut_inside_its_blocks() -> None:
    """An Anthropic ``system`` given as a list of content blocks stays a
    list when the event is cut: each block keeps its type and
    ``cache_control``, and only its long text is cut and marked."""
    big = "d" * (2 * 1024 * 1024)
    system = [
        {"type": "text", "text": big, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "Answer in one word."},
    ]
    payload = _post_call({"provider": "anthropic", "system": system, "messages": []})
    body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    sent = json.loads(body)["content"]["system"]
    assert isinstance(sent, list)
    assert len(sent) == 2
    assert sent[0]["type"] == "text"
    assert sent[0]["cache_control"] == {"type": "ephemeral"}
    match = _MARKER_RE.search(sent[0]["text"])
    assert match, sent[0]["text"][-120:]
    assert int(match.group(2)) == len(big)
    assert sent[1] == system[1]


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
    short = "s" * 70
    assert _cap_strings(short, 10) == short
    long = "l" * 200
    assert _cap_strings(long, 10) == "l" * 10 + truncation_marker(10, 200)
    assert _cap_strings({"a": [short, long], "n": 3, "b": None}, 10) == {
        "a": [short, "l" * 10 + truncation_marker(10, 200)],
        "n": 3,
        "b": None,
    }


def test_a_cut_never_splits_a_multibyte_character() -> None:
    # Each emoji is four bytes; a six-byte cap lands inside the second.
    cut = _cap_strings("\U0001f600" * 40, 6)
    assert "\ufffd" not in cut
    assert cut == "\U0001f600" + truncation_marker(4, 160)


def test_a_lone_surrogate_in_oversized_content_is_cut_not_raised() -> None:
    # A tool result decoded with errors="surrogateescape" carries \udcXX.
    payload = {
        "event_type": "session_start",
        "has_content": True,
        "content": {"response": {"body": "\udc80" * 300_000}},
    }
    body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    assert json.loads(body)["has_content"] is True


def test_dropping_the_content_clears_a_message_stub_that_points_at_it() -> None:
    payload = {
        "event_type": "session_start",
        "has_content": True,
        "incoming_message": {"has_content": True, "content_bytes": 3_000_000, "captured_at": "t"},
        "content": {"response": {"body": [{"k": i} for i in range(200_000)]}},
    }
    sent = json.loads(serialize_event(payload))
    assert sent["content"] is None
    assert sent["has_content"] is False
    assert sent["incoming_message"] == {
        "has_content": False,
        "content_bytes": 3_000_000,
        "captured_at": "t",
    }


def test_content_with_nothing_to_cut_skips_the_search(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    real = body_limit._serialize_cut

    def counting(payload: dict[str, Any], content: Any, cap: int, *rest: Any) -> bytes:
        calls.append(cap)
        return real(payload, content, cap, *rest)

    monkeypatch.setattr(body_limit, "_serialize_cut", counting)
    numbers = [[0.123456789] * 3072 for _ in range(50)]
    sent = json.loads(serialize_event(_post_call({"response": {"data": numbers}})))
    assert sent["content"] is None
    assert calls == [0]


def test_the_budget_leaves_room_under_the_one_mib_limit() -> None:
    assert MAX_EVENT_BODY_BYTES <= 0.8 * 1024 * 1024


class _NotData:
    """An object json cannot write, as an SDK object a capture missed."""


def test_content_json_cannot_write_is_dropped_and_the_tokens_kept(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(body_limit, "_warned_unencodable", set())
    payload = _post_call({"messages": [], "tools": _NotData()})
    payload["incoming_message"] = {"has_content": True, "content_bytes": 9, "captured_at": "t"}
    with caplog.at_level(logging.WARNING):
        sent = json.loads(serialize_event(payload))
    assert sent["tokens_input"] == 42
    assert sent["has_content"] is False and sent["content"] is None
    assert sent["incoming_message"]["has_content"] is False
    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert "post_call" in message and "_NotData" in message
    assert "<" not in json.dumps(sent), "no string form of the object is stored"


def test_content_with_a_cycle_is_dropped_and_the_tokens_kept(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(body_limit, "_warned_unencodable", set())
    cycle: list[Any] = []
    cycle.append(cycle)
    with caplog.at_level(logging.WARNING):
        sent = json.loads(serialize_event(_post_call({"messages": cycle})))
    assert sent["tokens_input"] == 42 and sent["content"] is None
    assert "post_call" in caplog.records[0].getMessage()


def test_a_field_outside_the_content_json_cannot_write_still_raises() -> None:
    import pytest

    payload = {**_post_call(None), "model": _NotData()}
    with pytest.raises(TypeError):
        serialize_event(payload)


def test_the_warning_for_content_json_cannot_write_is_logged_once_per_kind(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A framework that always hands over the same unencodable object gets
    one warning per event type and object type; the rest go to debug."""
    monkeypatch.setattr(body_limit, "_warned_unencodable", set())
    with caplog.at_level(logging.DEBUG, logger="flightdeck_sensor.transport.body_limit"):
        for _ in range(3):
            serialize_event(_post_call({"tools": _NotData()}))
        serialize_event({**_post_call({"tools": _NotData()}), "event_type": "embeddings"})
        serialize_event(_post_call({"tools": {1, 2}}))
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    debugs = [r for r in caplog.records if r.levelno == logging.DEBUG]
    assert len(warnings) == 3, warnings
    assert any("post_call" in w and "_NotData" in w for w in warnings)
    assert any("embeddings" in w and "_NotData" in w for w in warnings)
    assert any("post_call" in w and "set" in w for w in warnings)
    assert len(debugs) == 2


# ----- an embeddings call's vectors ------------------------------------------

TEXTS = [f"text {i}: " + "lorem ipsum dolor sit amet " * 8 for i in range(30)]


def _float_vectors(count: int, dimension: int, seed: int = 7) -> list[list[float]]:
    rng = random.Random(seed)
    return [[rng.uniform(-0.1, 0.1) for _ in range(dimension)] for _ in range(count)]


def _base64_vectors(count: int, dimension: int) -> list[str]:
    """Each vector as the base64 string of its float32 values, as the API
    returns it for ``encoding_format="base64"``."""
    return [
        base64.b64encode(struct.pack(f"<{dimension}f", *vector)).decode()
        for vector in _float_vectors(count, dimension)
    ]


def _embeddings(input_: Any, vectors: Any) -> dict[str, Any]:
    """An embeddings event with capture on, as the sensor builds it."""
    return {
        "event_type": "embeddings",
        "session_id": "s1",
        "tokens_input": 42,
        "has_content": True,
        "output_dimensions": {"count": 30, "dimension": 1536},
        "content": {
            "system": None,
            "messages": [],
            "tools": None,
            "response": {},
            "provider": "openai",
            "model": "text-embedding-3-small",
            "session_id": "s1",
            "event_id": "",
            "captured_at": "2026-11-19T00:00:00Z",
            "input": input_,
            "embedding_output": vectors,
        },
    }


def _vectors_marker(vectors: Any) -> str:
    return truncation_marker(0, len(json.dumps(vectors).encode()))


def _apart_from_the_vectors(content: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in content.items() if key != "embedding_output"}


def test_vectors_that_take_the_event_over_the_limit_give_way_to_the_whole_input(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 30-text batch at 1536 dimensions is about 1 MB of vectors: they
    are replaced by the marker, and the input goes whole."""
    vectors = _float_vectors(30, 1536)
    payload = _embeddings(TEXTS, vectors)
    assert encoded_size(json.dumps(payload).encode()) > MAX_EVENT_BODY_BYTES
    with caplog.at_level(logging.WARNING):
        body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    sent = json.loads(body)
    assert sent["has_content"] is True
    content = sent["content"]
    assert content["input"] == TEXTS
    assert content["embedding_output"] == _vectors_marker(vectors)
    assert _apart_from_the_vectors(content) == _apart_from_the_vectors(payload["content"])
    assert sent["tokens_input"] == 42
    assert sent["output_dimensions"] == {"count": 30, "dimension": 1536}
    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert "embeddings" in message and "vectors" in message
    assert "lorem" not in message and str(vectors[0][0]) not in message


@pytest.mark.parametrize(
    "vectors",
    [_float_vectors(30, 1536), _float_vectors(12, 3072), _base64_vectors(100, 1536)],
    ids=["30 x 1536 floats", "12 x 3072 floats", "100 x 1536 base64"],
)
def test_the_marker_names_the_size_of_the_vectors_json(vectors: Any) -> None:
    sent = json.loads(serialize_event(_embeddings(TEXTS, vectors)))
    marker = sent["content"]["embedding_output"]
    # The whole value is the marker, which the dashboard's
    # SENSOR_CUT_MARKER (PromptViewer.tsx, the same pattern) reads.
    match = _MARKER_RE.fullmatch(marker)
    assert match, marker
    assert int(match.group(1)) == 0
    assert int(match.group(2)) == len(json.dumps(vectors).encode())
    assert sent["content"]["input"] == TEXTS


def test_an_input_over_the_limit_on_its_own_is_cut_once_the_vectors_have_gone(
    caplog: pytest.LogCaptureFixture,
) -> None:
    vectors = _float_vectors(30, 1536)
    big = "x" * 1_000_000
    payload = _embeddings([big, "short"], vectors)
    with caplog.at_level(logging.WARNING):
        body = serialize_event(payload)
    assert len(caplog.records) == 1
    assert "its vectors were left out and content strings over" in caplog.records[0].getMessage()
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    sent = json.loads(body)
    assert sent["has_content"] is True
    content = sent["content"]
    assert content["embedding_output"] == _vectors_marker(vectors)
    cut, short = content["input"]
    match = _MARKER_RE.search(cut)
    assert match, cut[-120:]
    kept, total = int(match.group(1)), int(match.group(2))
    assert total == len(big)
    assert cut == "x" * kept + truncation_marker(kept, total)
    assert kept > MAX_EVENT_BODY_BYTES * 0.9
    assert short == "short"


def test_the_vectors_marker_is_never_cut_with_the_input() -> None:
    """An input of many strings cut nearly to nothing: the string rule, at
    the length the input is cut to, would cut the vectors' marker too."""
    vectors = _float_vectors(30, 1536)
    texts = ["y" * 200] * 10_600
    sent = json.loads(serialize_event(_embeddings(texts, vectors)))
    marker = _vectors_marker(vectors)
    assert sent["content"]["embedding_output"] == marker
    match = _MARKER_RE.search(sent["content"]["input"][0])
    assert match
    kept = int(match.group(1))
    # At that length the string rule would cut the marker itself.
    assert _cap_strings(marker, kept) != marker


@pytest.mark.parametrize(
    ("input_", "vectors"),
    [
        ("q" * 500_000, _base64_vectors(30, 3072)),
        ("short input", _base64_vectors(10, 18_000)),
    ],
    ids=["beside a long input", "alone over the limit"],
)
def test_base64_vectors_give_way_whole_and_are_never_cut_with_the_input(
    input_: str, vectors: list[str]
) -> None:
    """Base64 vectors are strings, which the string rule would shorten
    alongside the input, keeping part of each; they are replaced whole."""
    payload = _embeddings(input_, vectors)
    assert encoded_size(json.dumps(payload).encode()) > MAX_EVENT_BODY_BYTES
    body = serialize_event(payload)
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    content = json.loads(body)["content"]
    assert content["embedding_output"] == _vectors_marker(vectors)
    assert content["input"] == input_


def test_vectors_no_larger_than_the_marker_stay_and_the_input_is_cut() -> None:
    payload = _embeddings("z" * 1_000_000, [[0.5]])
    sent = json.loads(serialize_event(payload))
    assert sent["content"]["embedding_output"] == [[0.5]]
    assert _MARKER_RE.search(sent["content"]["input"])


def test_an_input_no_cut_fits_sends_the_event_without_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    payload = _embeddings([""] * 300_000, _float_vectors(30, 1536))
    with caplog.at_level(logging.WARNING):
        sent = json.loads(serialize_event(payload))
    assert sent["content"] is None
    assert sent["has_content"] is False
    assert sent["tokens_input"] == 42
    assert sent["output_dimensions"] == {"count": 30, "dimension": 1536}
    assert "cannot be cut" in caplog.records[-1].getMessage()


def test_vectors_within_the_limit_are_sent_as_they_are(caplog: pytest.LogCaptureFixture) -> None:
    payload = _embeddings(TEXTS, _float_vectors(2, 1536))
    with caplog.at_level(logging.WARNING):
        assert serialize_event(payload) == json.dumps(payload).encode()
    assert caplog.records == []


def test_capture_off_sends_no_content_and_no_marker() -> None:
    payload = {
        "event_type": "embeddings",
        "session_id": "s1",
        "tokens_input": 42,
        "has_content": False,
        "content": None,
        "output_dimensions": {"count": 30, "dimension": 1536},
    }
    body = serialize_event(payload)
    assert body == json.dumps(payload).encode()
    assert b"flightdeck: kept" not in body
    assert b"embedding_output" not in body


# Events without vectors, each over the limit (or at an edge of the
# rule): their bodies are byte for byte what the sensor sent before an
# embeddings call's vectors were cut first. The hashes are of the bodies
# serialize_event built for them on main at cd387e21.
def _chat(content: dict[str, Any]) -> dict[str, Any]:
    """A post_call as the interceptor builds it: ``input`` and
    ``embedding_output`` are None on a chat call."""
    base = {
        "system": None,
        "messages": [],
        "tools": None,
        "response": {},
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "session_id": "s1",
        "event_id": "",
        "captured_at": "2026-11-19T00:00:00Z",
        "input": None,
        "embedding_output": None,
    }
    return _post_call({**base, **content})


_WITHOUT_VECTORS: dict[str, dict[str, Any]] = {
    "chat message cut": _chat(
        {
            "messages": [{"role": "user", "content": "a" * (3 * 1024 * 1024)}],
            "response": {"content": [{"type": "text", "text": "short"}]},
        }
    ),
    "two strings one cap": _chat(
        {"system": "b" * 600_000, "messages": [{"role": "user", "content": "c" * 600_000}]}
    ),
    "responses input list": _chat({"input": ["r" * 50_000] * 30}),
    "markup session_start": {
        "event_type": "session_start",
        "session_id": "s1",
        "has_content": True,
        "content": {"response": {"body": "<a>" * 240_000}},
    },
    "multibyte": _chat({"messages": [{"role": "user", "content": "\U0001f600" * 400_000}]}),
    "structure over the limit": _chat(
        {"response": {"content": [{"type": "text", "text": ""} for _ in range(60_000)]}}
    ),
    "numbers no cut shortens": _chat({"response": {"data": [[0.123456789] * 3072] * 50}}),
    "within the limit": _chat({"messages": [{"role": "user", "content": "hi"}]}),
}

_MAIN_SHA256 = {
    "chat message cut": "c68778e5f6b879a65d6c4d47c29cbec035feb2c1e3e9a2f14d410c50dadb5074",
    "two strings one cap": "62e0c8ba1b0543d0f0975d832d30a15d43a88433f6bac84f8ecd66a95feab4a9",
    "responses input list": "dec634481748384d7bba6b88d529e87fc8f694c6720b48553473203eddf938b4",
    "markup session_start": "e9851df889d92a78df7908b1580bc9d8973e9b8414a9ea84b06dd2d36769090d",
    "multibyte": "8f0589e39068e7f9f70a5d6e3afe92326aff2c3ed7047e56854ebfa0d733417d",
    # Both are sent without their content, which leaves the same body.
    "structure over the limit": "cf98c1a6d6800e80523462ceebc0d3c1794377184958226755378a8f3c39eaf3",
    "numbers no cut shortens": "cf98c1a6d6800e80523462ceebc0d3c1794377184958226755378a8f3c39eaf3",
    "within the limit": "3a8e6e02d7944c345d8fca93e6ef176e3e5e147204b94e2d91655ba2013470dc",
}


@pytest.mark.parametrize("name", sorted(_WITHOUT_VECTORS))
def test_an_event_without_vectors_is_sent_as_before(name: str) -> None:
    body = serialize_event(_WITHOUT_VECTORS[name])
    assert hashlib.sha256(body).hexdigest() == _MAIN_SHA256[name]
