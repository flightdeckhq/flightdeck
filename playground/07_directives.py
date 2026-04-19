"""Custom directives -- register, trigger via API, handler runs in-process.

`@flightdeck_sensor.directive` declares a handler; `init()` syncs the
schema; POST /v1/directives (action=custom) queues a call; the next LLM
turn pulls the envelope, runs the handler, emits `directive_result`.
"""
from __future__ import annotations

import json, os, sys, time, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic")
    sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import Parameter
from _helpers import assert_event_landed, init_sensor, print_result

API = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
HEADERS = {
    "Authorization": f"Bearer {os.environ.get('FLIGHTDECK_TOKEN', 'tok_dev')}",
    "Content-Type": "application/json"}
called = {"msg": None}

@flightdeck_sensor.directive(
    "playground_echo", description="Echo the msg parameter back",
    parameters=[Parameter(name="msg", type="string", required=True)])
def handler(ctx, msg=""):
    called["msg"] = msg
    return {"echoed": msg}

def _api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read() or b"null")

def main() -> None:
    session_id = str(uuid.uuid4())
    flavor = f"playground-07-{uuid.uuid4().hex[:6]}"
    os.environ["AGENT_FLAVOR"] = flavor
    init_sensor(session_id)
    flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
    print(f"[playground:07_directives] session={session_id} flavor={flavor}")
    # init_sensor fires sync + register but the server row is not
    # readable until the writes settle -- poll briefly.
    registered = None
    for _ in range(33):
        try:
            rows = _api("GET", f"/v1/directives/custom?flavor={flavor}")["directives"]
            registered = next((d for d in rows if d["name"] == "playground_echo"), None)
        except Exception:
            pass
        if registered:
            break
        time.sleep(0.3)
    assert registered, f"playground_echo never registered for flavor {flavor!r}"
    _api("POST", "/v1/directives", {
        "action": "custom", "session_id": session_id, "reason": "playground",
        "directive_name": "playground_echo", "fingerprint": registered["fingerprint"],
        "parameters": {"msg": "hello"}, "grace_period_ms": 5000})
    # Directives ride back on the next POST /v1/events envelope -- not
    # instantaneous. Loop until the handler fires.
    client = anthropic.Anthropic()
    for _ in range(5):
        client.messages.create(model="claude-haiku-4-5-20251001", max_tokens=5,
            messages=[{"role": "user", "content": "hi"}])
        if called["msg"] == "hello":
            break
        time.sleep(1)
    assert called["msg"] == "hello", f"handler never ran (msg={called['msg']!r})"
    print_result("@directive playground_echo executed", True, 0)
    assert_event_landed(session_id, "directive_result", timeout=8)
    flightdeck_sensor.teardown()

if __name__ == "__main__":
    main()
