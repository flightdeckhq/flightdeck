"""Keep every event body the sensor POSTs within the server's size limit.

Ingestion reads at most 1 MiB of an event body, and NATS carries the
event on with the same 1 MiB ``max_payload``; a larger body is rejected
whole (413 from a proxy with nginx's default limit, 400 from ingestion
when the cut body fails to parse), and the call's token counts with it.
A captured prompt, a tool result or a sub-agent message can cross that.
An event over the limit has the strings of its captured ``content`` cut,
each to the same largest length that fits, ending in a marker; when no
cut fits, it is sent without content. The Claude Code plugin does the
same (``plugin/hooks/scripts/core/poster.mjs``).
"""

from __future__ import annotations

import json
import logging
from typing import Any

_log = logging.getLogger("flightdeck_sensor.transport.body_limit")

#: Largest event body the sensor sends, as measured by
#: :func:`encoded_size`; the remaining quarter of the 1 MiB limit covers
#: the token id and name ingestion adds to a ``session_start``.
MAX_EVENT_BODY_BYTES = 768 * 1024

# Characters ingestion's Go encoder writes as six-byte ``<``
# escapes when it re-encodes a session_start (one byte each here).
_GO_ESCAPED = (b"<", b">", b"&")


def encoded_size(body: bytes) -> int:
    """The size of a JSON body once ingestion has re-encoded it.

    The sensor's ``json.dumps`` already escapes every non-ASCII
    character, which Go writes as shorter UTF-8, so only ``<``, ``>``
    and ``&`` grow. Every event is measured this way; for the others it
    only over-counts.
    """
    return len(body) + 5 * sum(body.count(ch) for ch in _GO_ESCAPED)


def truncation_marker(kept_bytes: int, total_bytes: int) -> str:
    """The text that replaces the cut end of a string in oversized content."""
    return f"… [flightdeck: kept {kept_bytes} of {total_bytes} bytes to fit the event size limit]"


def _cap_strings(value: Any, cap_bytes: int) -> Any:
    """Every string in ``value`` longer than ``cap_bytes`` of UTF-8, cut and marked."""
    if isinstance(value, str):
        raw = value.encode("utf-8")
        if len(raw) <= cap_bytes:
            return value
        # ``errors="ignore"`` drops a code point the cut split.
        kept = raw[:cap_bytes].decode("utf-8", errors="ignore")
        marked = kept + truncation_marker(len(kept.encode("utf-8")), len(raw))
        # A string barely over the cap would grow by the marker; keep it.
        return marked if len(marked.encode("utf-8")) < len(raw) else value
    if isinstance(value, list):
        return [_cap_strings(item, cap_bytes) for item in value]
    if isinstance(value, dict):
        return {key: _cap_strings(item, cap_bytes) for key, item in value.items()}
    return value


def _longest_string_bytes(value: Any) -> int:
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    items = value if isinstance(value, list) else value.values() if isinstance(value, dict) else ()
    return max((_longest_string_bytes(item) for item in items), default=0)


def serialize_event(payload: dict[str, Any]) -> bytes:
    """The JSON body for one event, kept within :data:`MAX_EVENT_BODY_BYTES`.

    An event without content, or one over the limit even without it, is
    sent as it is.
    """
    body = json.dumps(payload).encode()
    size = encoded_size(body)
    content = payload.get("content")
    if size <= MAX_EVENT_BODY_BYTES or content is None:
        return body
    event_type = payload.get("event_type")
    bare = json.dumps({**payload, "has_content": False, "content": None}).encode()
    if encoded_size(bare) > MAX_EVENT_BODY_BYTES:
        _log.warning(
            "%s event is %d bytes and over the event size limit without its content; sent as it is",
            event_type,
            size,
        )
        return body
    lo, hi = 0, _longest_string_bytes(content)
    best: bytes | None = None
    best_cap = 0
    # Binary search for the largest per-string length that fits.
    while lo <= hi:
        cap = (lo + hi) // 2
        candidate = json.dumps({**payload, "content": _cap_strings(content, cap)}).encode()
        if encoded_size(candidate) <= MAX_EVENT_BODY_BYTES:
            best, best_cap, lo = candidate, cap, cap + 1
        else:
            hi = cap - 1
    if best is not None:
        _log.warning(
            "%s event is %d bytes; content strings over %d bytes were cut "
            "to fit the event size limit",
            event_type,
            size,
            best_cap,
        )
        return best
    _log.warning(
        "%s event is %d bytes and its content cannot be cut to fit the event size limit; "
        "sent without it",
        event_type,
        size,
    )
    return bare
