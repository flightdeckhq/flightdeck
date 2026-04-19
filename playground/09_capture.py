"""Prompt capture -- OFF (default) vs ON.

`capture_prompts=False` (D019 default) writes metadata only;
`/v1/events/{id}/content` returns 404. Opt in and the endpoint returns
provider / system / messages / response blocks. Two sequential sessions
in one process with teardown between (singleton is D091; *overlapping*
init()s are the thing to avoid).
"""
from __future__ import annotations

import json, os, sys, time, urllib.error, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result

API = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
TOK = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
HDR = {"Authorization": f"Bearer {TOK}"}

def _content_status(eid):
    req = urllib.request.Request(f"{API}/v1/events/{eid}/content", headers=HDR)
    try:
        with urllib.request.urlopen(req, timeout=3) as r: return r.status
    except urllib.error.HTTPError as e: return e.code

def _last_post_call_id(sid):
    req = urllib.request.Request(f"{API}/v1/sessions/{sid}", headers=HDR)
    data = json.loads(urllib.request.urlopen(req, timeout=3).read())
    return next(e["id"] for e in data.get("events", []) if e["event_type"] == "post_call")

def _run(capture, label):
    sid = str(uuid.uuid4())
    init_sensor(sid, capture_prompts=capture)
    flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
    t0 = time.monotonic()
    anthropic.Anthropic().messages.create(model="claude-haiku-4-5-20251001",
        max_tokens=5, messages=[{"role": "user", "content": "hi"}])
    assert_event_landed(sid, "post_call", timeout=8)
    eid = _last_post_call_id(sid)
    status = _content_status(eid)
    want = 200 if capture else 404
    print_result(label, status == want, int((time.monotonic() - t0) * 1000),
        f"GET /v1/events/{eid}/content -> {status} (want {want})")
    flightdeck_sensor.teardown()
    assert status == want, f"{label}: got HTTP {status}, expected {want}"

def main():
    print("[playground:09_capture]")
    _run(capture=False, label="capture_prompts=False -> 404")
    _run(capture=True, label="capture_prompts=True  -> 200")

if __name__ == "__main__":
    main()
