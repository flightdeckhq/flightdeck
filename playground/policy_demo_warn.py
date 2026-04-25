"""Policy WARN demo — server policy fires WARN at the configured threshold.

Creates a flavor-scoped policy with warn_at_pct=50 (token_limit=20, so warn
fires past 10 tokens). Runs two short Anthropic calls; the first burns
enough input+output tokens to cross the threshold, the second triggers
the worker policy evaluator → ``warn`` directive → sensor's
``_apply_directive(WARN)`` emits a ``policy_warn`` event with
``source="server"``.

Run: ``python playground/policy_demo_warn.py``
"""
from __future__ import annotations

import json, os, sys, time, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)
import flightdeck_sensor
from _helpers import init_sensor, print_result

API = os.environ.get("FLIGHTDECK_API_URL", "http://localhost:4000/api")
TOK = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
AUTH = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}


def _api(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=AUTH)
    raw = urllib.request.urlopen(req, timeout=5).read()
    return json.loads(raw) if raw else None


def main() -> None:
    session_id = str(uuid.uuid4())
    flavor = f"playground-policy-warn-{uuid.uuid4().hex[:6]}"
    # token_limit large enough that BLOCK never fires; WARN at 1%
    # so the first call's tokens already cross the threshold.
    policy = _api("POST", "/v1/policies", {
        "scope": "flavor", "scope_value": flavor,
        "token_limit": 1000,
        "warn_at_pct": 1, "degrade_at_pct": 90, "block_at_pct": 99,
    })
    try:
        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
        print(f"[playground:policy_warn] session_id={session_id} flavor={flavor}")
        c = anthropic.Anthropic()
        # Two calls. First crosses threshold; second receives the
        # WARN directive and emits the policy_warn event.
        for i in range(2):
            t0 = time.monotonic()
            r = c.messages.create(
                model="claude-haiku-4-5-20251001", max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            print_result(
                f"call {i+1}", True, int((time.monotonic() - t0) * 1000),
                f"{r.usage.input_tokens + r.usage.output_tokens} tokens burned",
            )
        # Force the directive-bearing event to flush.
        flightdeck_sensor.teardown()

        # Inspect the resulting events.
        time.sleep(1)
        events = _api(
            "GET",
            f"/v1/events?from=1970-01-01T00:00:00Z&session_id={session_id}",
        )["events"]
        warns = [e for e in events if e["event_type"] == "policy_warn"]
        print_result(
            "policy_warn event landed",
            len(warns) >= 1,
            0,
            f"got {len(warns)} policy_warn events",
        )
        if warns:
            payload = warns[0].get("payload") or {}
            print(f"  source={payload.get('source')} reason={payload.get('reason')}")
    finally:
        try:
            _api("DELETE", f"/v1/policies/{policy['id']}")
        except Exception:
            pass


if __name__ == "__main__":
    main()
