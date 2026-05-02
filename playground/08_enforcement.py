"""Server-side budget enforcement -- BudgetExceededError on second call.

D035: init(limit=...) is WARN-only. Real blocking is server-side via
`/v1/policies` with `block_at_pct`. The sensor's preflight loads the
thresholds locally; the PolicyCache evaluates projected tokens
(running total + estimated input) against block_at_pct on every call.

Policy here: token_limit=20, block_at_pct=50 -> block threshold=10.
First "hi" call (~3 estimated input, 5 output) sits below the
threshold. After the call, session.tokens_used is ~13, so the next
pre_call raises BudgetExceededError BEFORE the provider is reached.
"""
from __future__ import annotations

import json, os, sys, time, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)
import flightdeck_sensor
from flightdeck_sensor import BudgetExceededError, Provider
from _helpers import init_sensor, print_result

API = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
TOK = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
AUTH = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}
def _api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=AUTH)
    raw = urllib.request.urlopen(req, timeout=5).read()
    return json.loads(raw) if raw else None
def main() -> None:
    session_id = str(uuid.uuid4())
    # Hex suffix is load-bearing -- this script creates a flavor-scoped
    # policy and asserts the BLOCK threshold fires for THIS flavor's
    # first call. Two concurrent runs with the same flavor would share
    # one policy row and one budget, so each run gets its own.
    flavor = f"playground-enforcement-{uuid.uuid4().hex[:6]}"
    policy = _api("POST", "/v1/policies", {"scope": "flavor", "scope_value": flavor,
        "token_limit": 20, "block_at_pct": 50})
    try:
        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(providers=[Provider.ANTHROPIC], quiet=True)
        print(f"[playground:08_enforcement] session_id={session_id} flavor={flavor}")
        c = anthropic.Anthropic()
        t0 = time.monotonic()
        r = c.messages.create(model="claude-haiku-4-5-20251001", max_tokens=5,
            messages=[{"role": "user", "content": "hi"}])
        print_result("first call succeeds", True, int((time.monotonic() - t0) * 1000),
            f"{r.usage.input_tokens + r.usage.output_tokens} tokens burned")
        try:
            c.messages.create(model="claude-haiku-4-5-20251001", max_tokens=5,
                messages=[{"role": "user", "content": "hi"}])
            print_result("second call blocked", False, 0, "no BudgetExceededError"); sys.exit(1)
        except BudgetExceededError as e:
            print_result("second call blocked", True, 0, f"BudgetExceededError: {e}")
    finally:
        flightdeck_sensor.teardown()
        _api("DELETE", f"/v1/policies/{policy['id']}")

if __name__ == "__main__":
    main()
