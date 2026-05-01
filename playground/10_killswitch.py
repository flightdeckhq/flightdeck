"""Kill switch -- POST shutdown directive, later call raises DirectiveError.

Operator flow: click "Stop Agent" in the dashboard (or POST
/v1/directives with action=shutdown). The directive rides back on the
next envelope; the sensor raises `DirectiveError` on a subsequent LLM
call and the worker transitions the session to state=closed.

Delivery is asynchronous -- the shutdown can land on the very next
call or a few calls later depending on drain-thread timing, so this
example loops a few times until the raise fires.
"""
from __future__ import annotations

import json, os, sys, time, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import DirectiveError, Provider
from _helpers import init_sensor, print_result

API = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
TOK = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
MODEL, HI = "claude-haiku-4-5-20251001", [{"role": "user", "content": "hi"}]

def main():
    sid = str(uuid.uuid4())
    init_sensor(sid, flavor="playground-killswitch")
    flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
    print(f"[playground:10_killswitch] session_id={sid}")
    c = anthropic.Anthropic()
    c.messages.create(model=MODEL, max_tokens=5, messages=HI)
    print_result("first call succeeds", True, 0)

    body = json.dumps({"action": "shutdown", "session_id": sid,
        "reason": "playground-10", "grace_period_ms": 5000}).encode()
    req = urllib.request.Request(f"{API}/v1/directives", data=body, method="POST",
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=5).read()

    for _ in range(5):
        try:
            c.messages.create(model=MODEL, max_tokens=5, messages=HI)
        except DirectiveError as e:
            print_result("subsequent call raises after shutdown", True, 0,
                f"DirectiveError: {e}")
            flightdeck_sensor.teardown(); return
        time.sleep(1)
    print_result("subsequent call raises after shutdown", False, 0,
        "never raised after 5 retries")
    flightdeck_sensor.teardown(); sys.exit(1)

if __name__ == "__main__":
    main()
