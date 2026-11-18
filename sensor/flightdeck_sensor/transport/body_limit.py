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
import math
import threading
from typing import Any

from flightdeck_sensor.providers._access import UnreadableResponse

_log = logging.getLogger("flightdeck_sensor.transport.body_limit")

#: Largest event body the sensor sends, as measured by
#: :func:`encoded_size`; the remaining quarter of the 1 MiB limit covers
#: what ingestion adds when it rewrites an event: the token id and name
#: of a ``session_start``, or the catch-all of a replaced value.
MAX_EVENT_BODY_BYTES = 768 * 1024

# Characters ingestion's Go encoder writes as six-byte unicode escapes
# when it rewrites a session_start or an event with a replaced value
# (one byte each here).
_GO_ESCAPED = (b"<", b">", b"&")


def encoded_size(body: bytes) -> int:
    """The size of a JSON body once ingestion has rewritten it.

    Ingestion rewrites a ``session_start`` (to add the token id and
    name) or an event with a replaced value, with Go's encoder. Every
    value it does not change keeps its bytes, numbers included, but the
    encoder escapes ``<``, ``>`` and ``&`` in every string; the sensor's
    ``json.dumps`` already escapes every non-ASCII character, which Go
    keeps as written, so text grows only by those three. Every event is
    measured this way; for the others it only over-counts.
    """
    return len(body) + 5 * sum(body.count(ch) for ch in _GO_ESCAPED)


def truncation_marker(kept_bytes: int, total_bytes: int) -> str:
    """The text that replaces the cut end of a string in oversized content."""
    return f"… [flightdeck: kept {kept_bytes} of {total_bytes} bytes to fit the event size limit]"


def _cap_strings(value: Any, cap_bytes: int) -> Any:
    """Every string in ``value`` longer than ``cap_bytes`` of UTF-8, cut and marked."""
    if isinstance(value, str):
        # ``surrogatepass`` keeps a lone surrogate (from a
        # ``surrogateescape`` decode) from raising; the cut drops it.
        raw = value.encode("utf-8", "surrogatepass")
        if len(raw) <= cap_bytes:
            return value
        # ``errors="ignore"`` drops a code point the cut split.
        kept = raw[:cap_bytes].decode("utf-8", errors="ignore")
        marked = kept + truncation_marker(len(kept.encode("utf-8", "surrogatepass")), len(raw))
        # A string barely over the cap would grow by the marker; keep it.
        return marked if len(marked.encode("utf-8", "surrogatepass")) < len(raw) else value
    if isinstance(value, list):
        return [_cap_strings(item, cap_bytes) for item in value]
    if isinstance(value, dict):
        return {key: _cap_strings(item, cap_bytes) for key, item in value.items()}
    return value


def _longest_string_bytes(value: Any) -> int:
    if isinstance(value, str):
        return len(value.encode("utf-8", "surrogatepass"))
    items = value if isinstance(value, list) else value.values() if isinstance(value, dict) else ()
    return max((_longest_string_bytes(item) for item in items), default=0)


def _serialize_cut(payload: dict[str, Any], content: Any, cap: int) -> bytes:
    return json.dumps({**payload, "content": _cap_strings(content, cap)}, allow_nan=False).encode()


# Payload fields holding a sub-agent message stub that points at the
# event's content (``{has_content: true, content_bytes, captured_at}``).
_MESSAGE_STUB_FIELDS = ("incoming_message", "outgoing_message")


def _without_content(payload: dict[str, Any]) -> dict[str, Any]:
    """``payload`` sent without its content: no stub still claims it."""
    out = {**payload, "has_content": False, "content": None}
    for field in _MESSAGE_STUB_FIELDS:
        stub = out.get(field)
        if isinstance(stub, dict) and stub.get("has_content"):
            out[field] = {**stub, "has_content": False}
    return out


# The (event type, object type) pairs whose content has been sent without
# its content once already: the warning is logged once per pair, and at
# debug level after that, so a framework that always hands over the same
# unencodable object does not fill the log. Events drain on one thread;
# the lock covers a direct post_event from another.
_warned_unencodable: set[tuple[Any, str]] = set()
_warned_unencodable_lock = threading.Lock()


def _first_time(event_type: Any, unencodable: str) -> bool:
    """Whether this pair of event type and object type is new."""
    key = (event_type, unencodable)
    with _warned_unencodable_lock:
        if key in _warned_unencodable:
            return False
        _warned_unencodable.add(key)
        return True


#: What a warning names when the value JSON cannot write is a float that
#: is not finite. Python's json module would write it as ``NaN`` /
#: ``Infinity``, which is not JSON: ingestion rejects such a body whole.
NON_FINITE_FLOAT = "a non-finite float (NaN or Infinity)"


def _holds_non_finite(value: Any) -> bool:
    """Whether ``value``'s dicts and lists hold a NaN or an infinity. Each
    container is visited once, so a circular reference ends the walk."""
    pending = [value]
    seen: set[int] = set()
    while pending:
        item = pending.pop()
        if isinstance(item, float):
            if not math.isfinite(item):
                return True
            continue
        if not isinstance(item, (dict, list, tuple)) or id(item) in seen:
            continue
        seen.add(id(item))
        pending.extend(item.values() if isinstance(item, dict) else item)
    return False


def _encode(payload: dict[str, Any]) -> tuple[bytes | None, str]:
    """``payload`` as JSON, or (None, what could not be encoded): the type
    name of the first object json cannot write, :data:`NON_FINITE_FLOAT`
    for a NaN or an infinity, else the error's text (a circular
    reference). The body is always JSON: a non-finite float is refused
    rather than written as ``NaN`` / ``Infinity``, as the provider SDKs'
    own encoders refuse it."""
    unencodable: list[str] = []

    def refuse(value: Any) -> Any:
        unencodable.append(type(value).__name__)
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")

    try:
        return json.dumps(payload, default=refuse, allow_nan=False).encode(), ""
    except (TypeError, ValueError) as exc:
        if unencodable:
            return None, unencodable[0]
        return None, NON_FINITE_FLOAT if _holds_non_finite(payload) else str(exc)


def serialize_event(payload: dict[str, Any]) -> bytes:
    """The JSON body for one event, kept within :data:`MAX_EVENT_BODY_BYTES`.

    An event without content, or one over the limit even without it, is
    sent as it is. An event whose content json cannot write (an object, or
    a non-finite float) is sent without it, with a warning: its token
    counts and metadata still arrive, and the content is never replaced
    by a string form, or a ``null``, the provider never returned. A
    failure outside the content raises, as before; nothing that is not
    JSON is ever sent.
    """
    body, unencodable = _encode(payload)
    if body is None:
        content = payload.get("content")
        if content is None:
            raise TypeError(f"event is not JSON serializable: {unencodable}")
        payload = _without_content(payload)
        body, outside = _encode(payload)
        if body is None:
            raise TypeError(f"event is not JSON serializable outside its content: {outside}")
        event_type = payload.get("event_type")
        log = _log.warning if _first_time(event_type, unencodable) else _log.debug
        if unencodable == UnreadableResponse.__name__:
            # The response the call returned stands in for a provider body
            # the SDK could not parse (see providers/_access.py).
            provider = payload.get("provider") or (
                content.get("provider") if isinstance(content, dict) else None
            )
            log(
                "%s event (%s): the provider's response body did not parse, so the call "
                "is reported on the pre-call estimate and sent without its content",
                event_type,
                provider or "unknown provider",
            )
        else:
            log(
                "%s event's captured content holds %s, which cannot be written as JSON; "
                "sent without its content",
                event_type,
                unencodable,
            )
    size = encoded_size(body)
    content = payload.get("content")
    if size <= MAX_EVENT_BODY_BYTES or content is None:
        return body
    event_type = payload.get("event_type")
    bare = json.dumps(_without_content(payload), allow_nan=False).encode()
    if encoded_size(bare) > MAX_EVENT_BODY_BYTES:
        _log.warning(
            "%s event is %d bytes and over the event size limit without its content; sent as it is",
            event_type,
            size,
        )
        return body
    # The body only grows with the cap, so when even an empty cap does
    # not fit, no cap does; that skips the search (each step serialises
    # the whole event).
    if encoded_size(_serialize_cut(payload, content, 0)) > MAX_EVENT_BODY_BYTES:
        _log.warning(
            "%s event is %d bytes and its content cannot be cut to fit the event size limit; "
            "sent without it",
            event_type,
            size,
        )
        return bare
    lo, hi = 0, min(_longest_string_bytes(content), MAX_EVENT_BODY_BYTES)
    best: bytes | None = None
    best_cap = 0
    # Binary search for the largest per-string length that fits.
    while lo <= hi:
        cap = (lo + hi) // 2
        candidate = _serialize_cut(payload, content, cap)
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
