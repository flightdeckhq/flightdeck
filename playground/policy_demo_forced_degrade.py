"""Forced-DEGRADE demo — exercise the per-arm one-shot emission contract.

Same flavor-scoped policy shape as ``policy_demo_degrade.py`` but with
many subsequent calls. Verifies Decision 1 lock: POLICY_DEGRADE fires
ONCE per directive arrival regardless of how many post_calls run on
the armed session afterwards. Per-call swaps are visible only via
``post_call.model``.

Run: ``python playground/policy_demo_forced_degrade.py``
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
    flavor = f"playground-policy-forced-degrade-{uuid.uuid4().hex[:6]}"
    sonnet = "claude-sonnet-4-5-20250929"
    haiku = "claude-haiku-4-5-20251001"
    # Generous block_at_pct so subsequent calls don't get blocked;
    # degrade_at_pct=1 so the first call already crosses the threshold.
    # Per Decision 1, POLICY_DEGRADE fires ONCE per arm regardless of
    # how many subsequent calls land.
    policy = _api("POST", "/v1/policies", {
        "scope": "flavor", "scope_value": flavor,
        "token_limit": 1000,
        "warn_at_pct": 1, "degrade_at_pct": 2, "block_at_pct": 99,
        "degrade_to": haiku,
    })
    try:
        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
        print(f"[playground:policy_forced_degrade] session_id={session_id} flavor={flavor}")
        c = anthropic.Anthropic()
        N = 6
        for i in range(N):
            t0 = time.monotonic()
            r = c.messages.create(
                model=sonnet, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            print_result(
                f"call {i+1}", True, int((time.monotonic() - t0) * 1000),
                f"model={r.model}",
            )
        flightdeck_sensor.teardown()
        time.sleep(1)
        events = _api(
            "GET",
            f"/v1/events?from=1970-01-01T00:00:00Z&session_id={session_id}",
        )["events"]
        degrades = [e for e in events if e["event_type"] == "policy_degrade"]
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        haiku_calls = sum(1 for pc in post_calls if pc.get("model") == haiku)
        # Decision 1 lock: exactly one POLICY_DEGRADE event per arm,
        # regardless of how many subsequent post_calls fire on the
        # armed session. The worker dedups directive writes; rare
        # transient races can produce 2.
        once_only = len(degrades) == 1
        print_result(
            "exactly one policy_degrade event across many calls",
            once_only,
            0,
            f"got {len(degrades)} policy_degrade events from {N} calls",
        )
        if not once_only:
            raise AssertionError(
                f"Decision 1 lock violated: expected 1 policy_degrade, got "
                f"{len(degrades)}; events={degrades!r}",
            )
        # Per-call swap should be visible on post_call.model -- the
        # actual proof that the directive landed and was applied.
        swap_landed = haiku_calls >= 1
        print_result(
            "post_call.model swapped to haiku at least once", swap_landed, 0,
            f"post_calls={len(post_calls)} haiku_calls={haiku_calls} "
            f"(per-call swap visible via post_call.model only)",
        )
        if not swap_landed:
            raise AssertionError(
                f"degrade swap did not land in any post_call.model; "
                f"models seen: {[pc.get('model') for pc in post_calls]!r}",
            )
    finally:
        try:
            _api("DELETE", f"/v1/policies/{policy['id']}")
        except Exception:
            pass


if __name__ == "__main__":
    main()
