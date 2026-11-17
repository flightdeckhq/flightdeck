"""Prompt capture -- OFF (default) vs ON.

`capture_prompts=False` (the default) writes metadata only;
`/v1/events/{id}/content` returns 404. Opt in and the endpoint returns
provider / system / messages / response blocks. Sequential sessions in
one process with teardown between (init() is a process-wide singleton;
*overlapping* init()s are the thing to avoid).

The last session sends ``system`` as a list of content blocks, the form
prompt caching uses (``cache_control`` on a block), twice: each call's
stored content serves ``system_prompt`` as that same list, and each call
reports prompt-cache tokens, so the request was the real cached form.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic")
    sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import Provider
from _helpers import API_TOKEN, API_URL, assert_event_landed, init_sensor, print_result

API = API_URL
HDR = {"Authorization": f"Bearer {API_TOKEN}"}

MODEL = "claude-haiku-4-5-20251001"

# Claude Haiku 4.5 caches a prefix of at least 4096 tokens; a shorter
# block with cache_control is accepted and silently not cached. About
# 6,000 tokens of fixed text clears that with room to spare, and the
# same text on every run lets a second call (or a rerun within the
# cache's five minutes) read the entry the first one wrote.
CACHED_SYSTEM_REPEATS = 240
CACHED_SYSTEM_TEXT = (
    "You are the geography desk of a terse reference service. "
    "Answer with the single word that names the place asked for. "
) * CACHED_SYSTEM_REPEATS
SYSTEM_BLOCKS = [
    {"type": "text", "text": CACHED_SYSTEM_TEXT, "cache_control": {"type": "ephemeral"}},
    {"type": "text", "text": "Never add punctuation."},
]
# Two calls: the first writes the cache entry (or reads one a recent run
# wrote), the second reads it.
CACHED_QUESTIONS = ("Capital of France?", "Capital of Italy?")


def _content_status(eid):
    req = urllib.request.Request(f"{API}/v1/events/{eid}/content", headers=HDR)
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def _content(eid):
    req = urllib.request.Request(f"{API}/v1/events/{eid}/content", headers=HDR)
    with urllib.request.urlopen(req, timeout=3) as r:
        return json.loads(r.read())


def _session_events(sid):
    req = urllib.request.Request(f"{API}/v1/sessions/{sid}", headers=HDR)
    return json.loads(urllib.request.urlopen(req, timeout=3).read()).get("events", [])


def _last_post_call_id(sid):
    return next(e["id"] for e in _session_events(sid) if e["event_type"] == "post_call")


def _post_calls(sid, want, timeout):
    """The session's post_call events once *want* of them have landed."""
    deadline = time.monotonic() + timeout
    while True:
        calls = [e for e in _session_events(sid) if e["event_type"] == "post_call"]
        if len(calls) >= want or time.monotonic() > deadline:
            return calls
        time.sleep(0.25)


def _run(capture, label):
    sid = str(uuid.uuid4())
    # This script deliberately exercises the capture_prompts=False
    # path to verify the 404 contract on event_content. The default
    # True from _helpers.init_sensor is overridden per-run here on
    # purpose -- the script's whole point is the on/off matrix.
    init_sensor(sid, flavor="playground-capture", capture_prompts=capture)
    flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
    t0 = time.monotonic()
    anthropic.Anthropic().messages.create(
        model=MODEL,
        max_tokens=5,
        messages=[{"role": "user", "content": "hi"}],
    )
    assert_event_landed(sid, "post_call", timeout=8)
    eid = _last_post_call_id(sid)
    status = _content_status(eid)
    want = 200 if capture else 404
    print_result(
        label,
        status == want,
        int((time.monotonic() - t0) * 1000),
        f"GET /v1/events/{eid}/content -> {status} (want {want})",
    )
    flightdeck_sensor.teardown()
    assert status == want, f"{label}: got HTTP {status}, expected {want}"


def _run_cached_system_blocks():
    """``system`` as content blocks with a cache breakpoint, capture on:
    each call's content keeps the list as sent, and each call reports
    cache tokens (written by the first call, read by the next)."""
    label = "system as cached content blocks -> stored as the list"
    sid = str(uuid.uuid4())
    init_sensor(sid, flavor="playground-capture")
    flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
    t0 = time.monotonic()
    client = anthropic.Anthropic()
    usages = []
    for question in CACHED_QUESTIONS:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=8,
            system=SYSTEM_BLOCKS,
            messages=[{"role": "user", "content": question}],
        )
        usages.append(resp.usage)
    flightdeck_sensor.teardown()

    calls = _post_calls(sid, len(CACHED_QUESTIONS), timeout=10)
    problems = []
    if len(calls) != len(CACHED_QUESTIONS):
        problems.append(f"{len(calls)} post_calls landed, want {len(CACHED_QUESTIONS)}")
    for i, call in enumerate(calls):
        if not call.get("has_content"):
            problems.append(f"call {i}: stored without its content")
            continue
        stored = _content(call["id"]).get("system_prompt")
        if stored != SYSTEM_BLOCKS:
            problems.append(
                f"call {i}: system_prompt is {type(stored).__name__}, not the list sent"
            )
    for i, usage in enumerate(usages):
        cached = (usage.cache_creation_input_tokens or 0) + (usage.cache_read_input_tokens or 0)
        if cached == 0:
            problems.append(f"call {i}: the provider reported no prompt-cache tokens")
    detail = ", ".join(
        f"call {i}: cache write {u.cache_creation_input_tokens} read {u.cache_read_input_tokens}"
        for i, u in enumerate(usages)
    )
    print_result(label, not problems, int((time.monotonic() - t0) * 1000), detail)
    assert not problems, f"{label}: " + "; ".join(problems)


def main():
    print("[playground:09_capture]")
    _run(capture=False, label="capture_prompts=False -> 404")
    _run(capture=True, label="capture_prompts=True  -> 200")
    _run_cached_system_blocks()


if __name__ == "__main__":
    main()
