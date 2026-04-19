"""Custom directives -- register, trigger via API, handler runs in-process.

`@flightdeck_sensor.directive` declares a handler; `init()` syncs it;
POST /v1/directives (action=custom) queues a call; the next LLM turn
pulls the envelope, runs the handler, emits `directive_result`.
"""
from __future__ import annotations

import json, os, sys, time, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)
import flightdeck_sensor
from flightdeck_sensor import Parameter
from _helpers import assert_event_landed, init_sensor, print_result

API = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
HDR = {"Authorization": f"Bearer {os.environ.get('FLIGHTDECK_TOKEN', 'tok_dev')}",
    "Content-Type": "application/json"}
called = {"msg": None}
@flightdeck_sensor.directive("playground_echo",
    description="Echo the msg parameter back",
    parameters=[Parameter(name="msg", type="string", required=True)])
def handler(ctx, msg=""):
    called["msg"] = msg; return {"echoed": msg}
def _get(path):
    return json.loads(urllib.request.urlopen(urllib.request.Request(
        API + path, headers=HDR), timeout=2).read())

def main() -> None:
    sid, flavor = str(uuid.uuid4()), f"playground-07-{uuid.uuid4().hex[:6]}"
    os.environ["AGENT_FLAVOR"] = flavor
    init_sensor(sid); flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
    print(f"[playground:07_directives] session_id={sid} flavor={flavor}")
    deadline, d = time.monotonic() + 10, None
    while time.monotonic() < deadline and not d:
        try: d = next((x for x in _get(f"/v1/directives/custom?flavor={flavor}").get(
            "directives", []) if x.get("name") == "playground_echo"), None)
        except Exception: pass
        if not d: time.sleep(0.3)
    assert d, f"playground_echo never registered for flavor {flavor!r}"
    body = json.dumps({"action": "custom", "session_id": sid, "reason": "playground",
        "directive_name": "playground_echo", "fingerprint": d["fingerprint"],
        "parameters": {"msg": "hello"}, "grace_period_ms": 5000}).encode()
    urllib.request.urlopen(urllib.request.Request(f"{API}/v1/directives",
        data=body, method="POST", headers=HDR), timeout=5).read()
    c = anthropic.Anthropic()
    for _ in range(5):
        c.messages.create(model="claude-haiku-4-5-20251001", max_tokens=5,
            messages=[{"role": "user", "content": "hi"}])
        if called["msg"] == "hello": break
        time.sleep(1)
    assert called["msg"] == "hello", f"handler never ran (msg={called['msg']!r})"
    print_result("@directive playground_echo executed", True, 0)
    assert_event_landed(sid, "directive_result", timeout=8); flightdeck_sensor.teardown()

if __name__ == "__main__":
    main()
