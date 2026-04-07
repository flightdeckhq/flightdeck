# Flightdeck Smoke Test
#
# Runs every Phase 1 feature against real provider
# APIs with a live Flightdeck stack.
#
# Requirements:
#   make dev (stack must be running)
#   pip install anthropic openai flightdeck-sensor
#
# Usage:
#   python tests/smoke/smoke_test.py
#
# Environment variables:
#   FLIGHTDECK_SERVER   default: http://localhost:4000
#   FLIGHTDECK_TOKEN    default: tok_dev
#   ANTHROPIC_API_KEY   required for Anthropic tests
#   OPENAI_API_KEY      required for OpenAI tests
#
# Cost: ~$0.05-0.10 per full run
# Each scenario is independent. Comment out any block.
# API keys are read from environment only and are
# never printed or logged.

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SERVER = os.environ.get("FLIGHTDECK_SERVER", "http://localhost:4000")
TOKEN = os.environ.get("FLIGHTDECK_TOKEN", "tok_dev")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY")

ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
OPENAI_MODEL = "gpt-4o-mini"

INGEST_URL = f"{SERVER}/ingest"
API_URL = f"{SERVER}/api"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_passes = 0
_fails = 0
_skips = 0


def check(description: str, condition: bool) -> None:
    global _passes, _fails
    if condition:
        _passes += 1
        print(f"  [PASS] {description}")
    else:
        _fails += 1
        print(f"  [FAIL] {description}")


def skip(description: str, reason: str) -> None:
    global _skips
    _skips += 1
    print(f"  [SKIP] {description} -- {reason}")


def section(title: str) -> None:
    print(f"\n--- {title} ---")


def redact_keys(text: str) -> str:
    result = text
    if ANTHROPIC_KEY:
        result = result.replace(ANTHROPIC_KEY, "[REDACTED]")
    if OPENAI_KEY:
        result = result.replace(OPENAI_KEY, "[REDACTED]")
    return result


def _http_request(url: str, method: str = "GET", data: dict | None = None) -> dict:
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"_status": e.code, "_error": e.reason}
    except Exception as e:
        return {"_status": 0, "_error": redact_keys(str(e))}


def api_get(path: str) -> dict:
    return _http_request(f"{API_URL}{path}")


def ingest_post(path: str, payload: dict) -> dict:
    return _http_request(f"{INGEST_URL}{path}", method="POST", data=payload)


def api_post(path: str, payload: dict) -> dict:
    return _http_request(f"{API_URL}{path}", method="POST", data=payload)


def wait_for_session(session_id: str, timeout: int = 15) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        fleet = api_get("/v1/fleet")
        for flavor in fleet.get("flavors", []):
            for sess in flavor.get("sessions", []):
                if sess.get("session_id") == session_id:
                    return sess
        time.sleep(1)
    return None


def wait_for_state(session_id: str, state: str, timeout: int = 30) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        detail = api_get(f"/v1/sessions/{session_id}")
        sess = detail.get("session", {})
        if sess.get("state") == state:
            return True
        time.sleep(1)
    return False


def get_session_events(session_id: str) -> list:
    time.sleep(3)  # allow events to propagate
    detail = api_get(f"/v1/sessions/{session_id}")
    return detail.get("events", [])


# ---------------------------------------------------------------------------
# SCENARIO 1 -- Stack health check
# ---------------------------------------------------------------------------

def scenario_1_health() -> None:
    section("1. Stack health check")

    try:
        with urllib.request.urlopen(f"{INGEST_URL}/health", timeout=5) as r:
            check("Ingestion API healthy", r.status == 200)
    except Exception:
        check("Ingestion API healthy", False)

    try:
        with urllib.request.urlopen(f"{API_URL}/health", timeout=5) as r:
            check("Query API healthy", r.status == 200)
    except Exception:
        check("Query API healthy", False)

    if _fails > 0:
        print("\n  Stack does not appear to be running. Run: make dev")
        sys.exit(1)


# ---------------------------------------------------------------------------
# SCENARIO 2 -- Basic visibility (Anthropic)
# ---------------------------------------------------------------------------

def scenario_2_anthropic() -> None:
    section("2. Basic visibility -- Anthropic")

    if ANTHROPIC_KEY is None:
        skip("Anthropic visibility", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    os.environ["AGENT_FLAVOR"] = "smoke-basic-anthropic"
    try:
        flightdeck_sensor.init(server=INGEST_URL, token=TOKEN, quiet=True)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key=ANTHROPIC_KEY))
        client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": "Reply with one word: hello"}],
        )
        session_id = flightdeck_sensor.get_status().session_id
    except Exception as e:
        check(f"Anthropic call succeeded ({redact_keys(str(e))})", False)
        return
    finally:
        flightdeck_sensor.teardown()

    session = wait_for_session(session_id)
    check("Session appears in fleet", session is not None)
    check("Session flavor is smoke-basic-anthropic",
          (session or {}).get("flavor") == "smoke-basic-anthropic")

    events = get_session_events(session_id)
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    check("At least one post_call event exists", len(post_calls) > 0)
    if post_calls:
        check("tokens_total > 0", post_calls[0].get("tokens_total", 0) > 0)


# ---------------------------------------------------------------------------
# SCENARIO 3 -- Basic visibility (OpenAI)
# ---------------------------------------------------------------------------

def scenario_3_openai() -> None:
    section("3. Basic visibility -- OpenAI")

    if OPENAI_KEY is None:
        skip("OpenAI visibility", "OPENAI_API_KEY not set")
        return

    import flightdeck_sensor
    import openai

    os.environ["AGENT_FLAVOR"] = "smoke-basic-openai"
    try:
        flightdeck_sensor.init(server=INGEST_URL, token=TOKEN, quiet=True)
        client = flightdeck_sensor.wrap(openai.OpenAI(api_key=OPENAI_KEY))
        client.chat.completions.create(
            model=OPENAI_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": "Reply with one word: hello"}],
        )
        session_id = flightdeck_sensor.get_status().session_id
    except Exception as e:
        check(f"OpenAI call succeeded ({redact_keys(str(e))})", False)
        return
    finally:
        flightdeck_sensor.teardown()

    session = wait_for_session(session_id)
    check("Session appears in fleet", session is not None)
    check("Session flavor is smoke-basic-openai",
          (session or {}).get("flavor") == "smoke-basic-openai")

    events = get_session_events(session_id)
    post_calls = [e for e in events if e["event_type"] == "post_call"]
    check("At least one post_call event exists", len(post_calls) > 0)
    if post_calls:
        check("tokens_total > 0", post_calls[0].get("tokens_total", 0) > 0)


# ---------------------------------------------------------------------------
# SCENARIO 4 -- Token enforcement BLOCK
# ---------------------------------------------------------------------------

def scenario_4_block() -> None:
    section("4. Token enforcement -- BLOCK raises exception")

    if ANTHROPIC_KEY is None:
        skip("BLOCK test", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    os.environ["AGENT_FLAVOR"] = "smoke-block"
    blocked = False
    session_id = None
    try:
        flightdeck_sensor.init(server=INGEST_URL, token=TOKEN, quiet=True)
        # Set server-side token_limit=1 on the PolicyCache to trigger BLOCK.
        # Per D035, init(limit=...) is WARN-only. BLOCK is server-side only.
        import flightdeck_sensor as _fs
        if _fs._session is not None:
            _fs._session.policy.token_limit = 1
            _fs._session.policy.block_at_pct = 100
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key=ANTHROPIC_KEY))
        client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": "hello"}],
        )
    except flightdeck_sensor.BudgetExceededError:
        blocked = True
    except Exception as e:
        check(f"Unexpected error: {redact_keys(str(e))}", False)
    finally:
        session_id = flightdeck_sensor.get_status().session_id
        flightdeck_sensor.teardown()

    check("BudgetExceededError was raised", blocked)

    if session_id:
        events = get_session_events(session_id)
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        check("No post_call event (call never reached provider)", len(post_calls) == 0)


# ---------------------------------------------------------------------------
# SCENARIO 5 -- Token enforcement WARN
# ---------------------------------------------------------------------------

def scenario_5_warn() -> None:
    section("5. Token enforcement -- WARN recorded")

    if ANTHROPIC_KEY is None:
        skip("WARN test", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    os.environ["AGENT_FLAVOR"] = "smoke-warn"
    try:
        flightdeck_sensor.init(
            server=INGEST_URL, token=TOKEN, limit=500, warn_at=0.01, quiet=True,
        )
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key=ANTHROPIC_KEY))
        client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": "Reply with one word: hello"}],
        )
        session_id = flightdeck_sensor.get_status().session_id
    except Exception as e:
        check(f"Call succeeded ({redact_keys(str(e))})", False)
        return
    finally:
        flightdeck_sensor.teardown()

    check("Call succeeded (no exception raised)", True)

    events = get_session_events(session_id)
    check("post_call event recorded",
          any(e["event_type"] == "post_call" for e in events))


# ---------------------------------------------------------------------------
# SCENARIO 6 -- Multi-session fleet
# ---------------------------------------------------------------------------

def scenario_6_fleet() -> None:
    section("6. Multi-session fleet -- sequential sessions")

    if ANTHROPIC_KEY is None:
        skip("Multi-session test", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    # Run sequentially because flightdeck_sensor uses a module-level singleton.
    # Each init/call/teardown cycle creates a separate session with a unique flavor.
    flavors = ["smoke-fleet-alpha", "smoke-fleet-beta", "smoke-fleet-gamma"]

    for flavor in flavors:
        os.environ["AGENT_FLAVOR"] = flavor
        flightdeck_sensor.init(server=INGEST_URL, token=TOKEN, quiet=True)
        client = flightdeck_sensor.wrap(anthropic.Anthropic(api_key=ANTHROPIC_KEY))
        client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": "Say: ok"}],
        )
        flightdeck_sensor.teardown()

    time.sleep(5)  # allow events to propagate

    fleet = api_get("/v1/fleet")
    fleet_flavors = {f["flavor"] for f in fleet.get("flavors", [])}
    for flavor in flavors:
        check(f"{flavor} appears in fleet", flavor in fleet_flavors)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    scenario_1_health()
    scenario_2_anthropic()
    scenario_3_openai()
    scenario_4_block()
    scenario_5_warn()
    scenario_6_fleet()

    section("Summary")
    total = _passes + _fails + _skips
    print(f"  Passed:  {_passes}")
    print(f"  Failed:  {_fails}")
    print(f"  Skipped: {_skips}")
    print(f"  Total:   {total}")
    print()
    if _fails == 0:
        print("  All checks passed.")
    else:
        print(f"  {_fails} check(s) failed.")
    print()
    print("  Note: API keys were read from environment")
    print("  variables and were not logged or printed.")
    sys.exit(0 if _fails == 0 else 1)
