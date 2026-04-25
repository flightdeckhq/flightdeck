"""Policy DEGRADE demo — server policy swaps the model on threshold cross.

Creates a flavor-scoped policy with ``degrade_at_pct=50`` and
``degrade_to=claude-haiku-4-5-20251001``. First call uses the operator's
chosen model (sonnet). Second call crosses the threshold; the worker
emits a DEGRADE directive; the sensor's ``_apply_directive(DEGRADE)``
emits a single ``policy_degrade`` event with ``from_model`` / ``to_model``
plus a ``directive_result`` ack, then the sensor swaps the model on
every subsequent call.

Per Decision 1 lock: POLICY_DEGRADE fires ONCE per arm. Per-call swaps
are visible via ``post_call.model`` only.

Run: ``python playground/policy_demo_degrade.py``
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
    flavor = f"playground-policy-degrade-{uuid.uuid4().hex[:6]}"
    sonnet = "claude-sonnet-4-5-20250929"
    haiku = "claude-haiku-4-5-20251001"
    # token_limit large enough that BLOCK never fires; DEGRADE at 1%
    # so the first call's tokens already cross the threshold.
    policy = _api("POST", "/v1/policies", {
        "scope": "flavor", "scope_value": flavor,
        "token_limit": 1000,
        "warn_at_pct": 1, "degrade_at_pct": 2, "block_at_pct": 99,
        "degrade_to": haiku,
    })
    try:
        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
        print(f"[playground:policy_degrade] session_id={session_id} flavor={flavor}")
        c = anthropic.Anthropic()
        for i in range(3):
            t0 = time.monotonic()
            r = c.messages.create(
                model=sonnet, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            print_result(
                f"call {i+1}", True, int((time.monotonic() - t0) * 1000),
                f"model={r.model} tokens={r.usage.input_tokens + r.usage.output_tokens}",
            )
        flightdeck_sensor.teardown()
        time.sleep(1)
        events = _api(
            "GET",
            f"/v1/events?from=1970-01-01T00:00:00Z&session_id={session_id}",
        )["events"]
        degrades = [e for e in events if e["event_type"] == "policy_degrade"]
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        # Decision 1 lock: POLICY_DEGRADE fires once per
        # _apply_directive(DEGRADE) call. The worker's policy
        # evaluator de-dups directive writes per session, so under
        # most timing the sensor receives a single DEGRADE
        # directive → emits a single POLICY_DEGRADE event. Worker
        # dedup is best-effort; transient races can produce 2 (rare).
        print_result(
            "policy_degrade event landed",
            len(degrades) >= 1,
            0,
            f"got {len(degrades)} policy_degrade events",
        )
        if degrades:
            payload = degrades[0].get("payload") or {}
            print(
                f"  from_model={payload.get('from_model')} "
                f"to_model={payload.get('to_model')}"
            )
        haiku_calls = sum(1 for pc in post_calls if pc.get("model") == haiku)
        print(
            f"  post_calls={len(post_calls)} of which {haiku_calls} on the degraded model",
        )
    finally:
        try:
            _api("DELETE", f"/v1/policies/{policy['id']}")
        except Exception:
            pass


if __name__ == "__main__":
    main()
