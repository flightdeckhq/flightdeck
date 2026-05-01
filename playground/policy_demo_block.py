"""Policy BLOCK demo — server policy refuses the call before dispatch.

Creates a flavor-scoped policy with ``block_at_pct=50`` (token_limit=20,
so block fires past 10 tokens). The first call burns enough tokens to
cross the threshold. The next call's pre-flight policy check returns
BLOCK; the sensor's ``_pre_call`` emits a ``policy_block`` event,
flushes the event queue synchronously, and raises
``BudgetExceededError`` before the provider is reached.

The blocked call's intended model is captured on the event so the
operator can answer "which call hit the limit?".

Run: ``python playground/policy_demo_block.py``
"""
from __future__ import annotations

import json, os, sys, time, urllib.request, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)
import flightdeck_sensor
from flightdeck_sensor import BudgetExceededError
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
    flavor = f"playground-policy-block-{uuid.uuid4().hex[:6]}"
    intended = "claude-haiku-4-5-20251001"
    policy = _api("POST", "/v1/policies", {
        "scope": "flavor", "scope_value": flavor,
        "token_limit": 20, "block_at_pct": 50,
    })
    try:
        init_sensor(session_id, flavor=flavor)
        flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
        print(f"[playground:policy_block] session_id={session_id} flavor={flavor}")
        c = anthropic.Anthropic()
        t0 = time.monotonic()
        r = c.messages.create(
            model=intended, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        print_result(
            "first call succeeds", True, int((time.monotonic() - t0) * 1000),
            f"{r.usage.input_tokens + r.usage.output_tokens} tokens burned",
        )
        try:
            c.messages.create(
                model=intended, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            print_result("second call blocked", False, 0, "no BudgetExceededError")
            sys.exit(1)
        except BudgetExceededError as e:
            print_result("second call blocked", True, 0, f"BudgetExceededError: {e}")
        flightdeck_sensor.teardown()
        time.sleep(1)
        events = _api(
            "GET",
            f"/v1/events?from=1970-01-01T00:00:00Z&session_id={session_id}",
        )["events"]
        blocks = [e for e in events if e["event_type"] == "policy_block"]
        block_count_ok = len(blocks) >= 1
        print_result(
            "policy_block event landed",
            block_count_ok, 0,
            f"got {len(blocks)} policy_block events",
        )
        if not block_count_ok:
            raise AssertionError(
                f"no policy_block observed; events={events!r}",
            )
        payload = blocks[0].get("payload") or {}
        source_ok = payload.get("source") == "server"
        intended_ok = payload.get("intended_model") == intended
        limit_ok = payload.get("token_limit") == 20
        print_result(
            "policy_block.source=server", source_ok, 0,
            f"source={payload.get('source')!r}",
        )
        print_result(
            "policy_block.intended_model", intended_ok, 0,
            f"intended_model={payload.get('intended_model')!r}",
        )
        print_result(
            "policy_block.token_limit=20", limit_ok, 0,
            f"token_limit={payload.get('token_limit')!r} tokens_used={payload.get('tokens_used')!r}",
        )
        if not (source_ok and intended_ok and limit_ok):
            raise AssertionError(f"policy_block payload mismatch: {payload!r}")
    finally:
        try:
            _api("DELETE", f"/v1/policies/{policy['id']}")
        except Exception:
            pass


if __name__ == "__main__":
    main()
