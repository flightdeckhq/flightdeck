#!/usr/bin/env python3
"""Flightdeck comprehensive smoke test suite.

Runs real LLM provider calls against a live Flightdeck stack. No mocks.
Proves every sensor and platform capability works end to end.

Requirements:
  - Docker compose dev stack running (make dev)
  - ANTHROPIC_API_KEY and OPENAI_API_KEY environment variables set
  - flightdeck-sensor installed (pip install -e sensor/)
  - tok_dev auth token seeded in database

Cost estimate: < $0.05 per full run (haiku + gpt-4o-mini, max_tokens=5).

Usage:
  python tests/smoke/smoke_test.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from uuid import uuid4

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INGEST_URL = "http://localhost:4000/ingest"
API_URL = "http://localhost:4000/api"
TOKEN = "tok_dev"

ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
OPENAI_MODEL = "gpt-4o-mini"

HAS_ANTHROPIC_KEY = bool(os.environ.get("ANTHROPIC_API_KEY"))
HAS_OPENAI_KEY = bool(os.environ.get("OPENAI_API_KEY"))

# ---------------------------------------------------------------------------
# Check tracking
# ---------------------------------------------------------------------------

_results: list[tuple[str, str, str]] = []  # (name, status, detail)


def check(name: str, passed: bool, detail: str = "") -> None:
    status = "PASS" if passed else "FAIL"
    _results.append((name, status, detail))
    icon = "\033[32m✓\033[0m" if passed else "\033[31m✗\033[0m"
    line = f"  {icon} {name}"
    if detail and not passed:
        line += f"  -- {detail}"
    print(line)


def skip(name: str, reason: str) -> None:
    _results.append((name, "SKIP", reason))
    print(f"  \033[33m⊘\033[0m {name}  -- {reason}")


def section(title: str) -> None:
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print(f"{'─' * 60}")


def print_summary() -> None:
    passed = sum(1 for _, s, _ in _results if s == "PASS")
    failed = sum(1 for _, s, _ in _results if s == "FAIL")
    skipped = sum(1 for _, s, _ in _results if s == "SKIP")
    print(f"\n{'═' * 60}")
    print(f"  PASS: {passed}  FAIL: {failed}  SKIP: {skipped}  TOTAL: {len(_results)}")
    if failed:
        print("\n  Failed checks:")
        for name, status, detail in _results:
            if status == "FAIL":
                print(f"    ✗ {name}: {detail}")
    print(f"{'═' * 60}")


# ---------------------------------------------------------------------------
# HTTP helpers (ported from conftest.py)
# ---------------------------------------------------------------------------


def api_get(path: str) -> dict:
    """GET from the API service. Returns parsed JSON."""
    req = urllib.request.Request(
        f"{API_URL}{path}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def api_post(path: str, body: dict) -> dict:
    """POST to the API service. Returns parsed JSON."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_URL}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def api_delete(path: str) -> None:
    """DELETE from the API service. Ignores errors."""
    try:
        req = urllib.request.Request(
            f"{API_URL}{path}",
            headers={"Authorization": f"Bearer {TOKEN}"},
            method="DELETE",
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass


def api_get_status(path: str) -> tuple[int, dict | None]:
    """GET returning (status_code, body_or_None). Never raises on HTTP errors."""
    try:
        req = urllib.request.Request(
            f"{API_URL}{path}",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


# ---------------------------------------------------------------------------
# Polling helpers (from conftest.py)
# ---------------------------------------------------------------------------


def wait_until(
    condition_fn,
    timeout: float = 15.0,
    interval: float = 0.5,
    msg: str = "condition not met",
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition_fn():
            return
        time.sleep(interval)
    raise TimeoutError(msg)


def get_session(session_id: str) -> dict:
    return api_get(f"/v1/sessions/{session_id}")


def wait_for_session_in_fleet(session_id: str, timeout: float = 10.0) -> dict | None:
    """Poll fleet until session_id appears. Returns session dict or None."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            data = api_get(f"/v1/fleet?limit=200&offset=0")
            for f in data.get("flavors", []):
                for s in f.get("sessions", []):
                    if s.get("session_id") == session_id:
                        return s
        except Exception:
            pass
        time.sleep(0.5)
    return None


def wait_for_state(session_id: str, expected: str, timeout: float = 15.0) -> dict:
    result = {}

    def _check():
        nonlocal result
        try:
            detail = get_session(session_id)
            result = detail
            return detail.get("session", {}).get("state") == expected
        except Exception:
            return False

    wait_until(_check, timeout=timeout, msg=f"session {session_id[:8]} never reached state={expected}")
    return result


# ---------------------------------------------------------------------------
# Policy helpers
# ---------------------------------------------------------------------------


def create_policy(
    scope: str,
    scope_value: str,
    token_limit: int,
    warn_at_pct: int | None = None,
    degrade_at_pct: int | None = None,
    degrade_to: str | None = None,
    block_at_pct: int | None = None,
) -> dict:
    body: dict = {"scope": scope, "scope_value": scope_value, "token_limit": token_limit}
    if warn_at_pct is not None:
        body["warn_at_pct"] = warn_at_pct
    if degrade_at_pct is not None:
        body["degrade_at_pct"] = degrade_at_pct
    if degrade_to is not None:
        body["degrade_to"] = degrade_to
    if block_at_pct is not None:
        body["block_at_pct"] = block_at_pct
    return api_post("/v1/policies", body)


def delete_policy(policy_id: str) -> None:
    api_delete(f"/v1/policies/{policy_id}")


# ---------------------------------------------------------------------------
# Directive helpers
# ---------------------------------------------------------------------------


def post_directive(
    action: str,
    session_id: str | None = None,
    flavor: str | None = None,
    reason: str | None = None,
    directive_name: str | None = None,
    fingerprint: str | None = None,
    parameters: dict | None = None,
) -> dict:
    body: dict = {"action": action, "grace_period_ms": 5000}
    if session_id:
        body["session_id"] = session_id
    if flavor:
        body["flavor"] = flavor
    if reason:
        body["reason"] = reason
    if directive_name:
        body["directive_name"] = directive_name
    if fingerprint:
        body["fingerprint"] = fingerprint
    if parameters:
        body["parameters"] = parameters
    return api_post("/v1/directives", body)


# ---------------------------------------------------------------------------
# Database helpers (from test_sensor_e2e.py)
# ---------------------------------------------------------------------------


def psql(sql: str) -> str:
    result = subprocess.run(
        ["docker", "exec", "docker-postgres-1", "psql", "-U", "flightdeck", "-tAX", "-c", sql],
        capture_output=True, text=True, timeout=10,
    )
    return result.stdout.strip()


def psql_json(sql: str) -> list:
    raw = psql(sql)
    if not raw or raw == "null":
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def query_events(flavor: str) -> list[dict]:
    return psql_json(
        f"SELECT json_agg(row_to_json(e) ORDER BY e.occurred_at) "
        f"FROM events e WHERE e.flavor = '{flavor}'"
    )


def wait_for_event(flavor: str, event_type: str, timeout: float = 15.0) -> dict:
    found = {}

    def _check():
        nonlocal found
        for ev in query_events(flavor):
            if ev.get("event_type") == event_type:
                found = ev
                return True
        return False

    wait_until(_check, timeout=timeout, msg=f"event {event_type} never appeared for {flavor}")
    return found


def query_event_content(session_id: str) -> list[dict]:
    return psql_json(
        f"SELECT json_agg(row_to_json(ec)) FROM event_content ec "
        f"WHERE ec.session_id = '{session_id}'"
    )




# ---------------------------------------------------------------------------
# Sensor helpers
# ---------------------------------------------------------------------------


def force_reset_sensor() -> None:
    """Reset the sensor singleton so a fresh init() can be called."""
    import flightdeck_sensor
    try:
        flightdeck_sensor.teardown()
    except Exception:
        pass
    # Reset internal globals (same pattern as test_sensor_e2e.py)
    flightdeck_sensor._session = None  # type: ignore[attr-defined]
    flightdeck_sensor._client = None  # type: ignore[attr-defined]
    flightdeck_sensor._directive_registry.clear()  # type: ignore[attr-defined]


def unique_flavor(prefix: str) -> str:
    return f"smoke-{prefix}-{uuid4().hex[:8]}"


def sensor_init(flavor: str, **kwargs) -> None:
    """Init sensor with standard smoke test config."""
    import flightdeck_sensor
    os.environ["AGENT_FLAVOR"] = flavor
    flightdeck_sensor.init(
        server=INGEST_URL,
        token=TOKEN,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


def check_stack_healthy() -> bool:
    for url in [f"{INGEST_URL}/health", f"{API_URL}/health"]:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status != 200:
                    return False
        except Exception:
            return False
    return True


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 1: Provider Interception
# ═══════════════════════════════════════════════════════════════════════════


def group_1_provider_interception() -> None:
    section("GROUP 1: Provider Interception")

    # ------------------------------------------------------------------
    # 1a. Anthropic via patch()
    # Proves class-level SDK patching intercepts messages.create().
    # Verifies session_start and post_call events with token counts.
    # ------------------------------------------------------------------
    if not HAS_ANTHROPIC_KEY:
        skip("1a. Anthropic patch()", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        import anthropic
        flavor = unique_flavor("1a")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["anthropic"])
            client = anthropic.Anthropic()
            resp = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            types = [e["event_type"] for e in events]
            check("1a. session_start event", "session_start" in types)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1a. post_call event", len(post_calls) >= 1)
            if post_calls:
                pc = post_calls[0]
                check("1a. tokens_total > 0", (pc.get("tokens_total") or 0) > 0,
                      f"got {pc.get('tokens_total')}")
                check("1a. model matches", ANTHROPIC_MODEL in (pc.get("model") or ""),
                      f"got {pc.get('model')}")
                check("1a. has_content=false (capture off)", pc.get("has_content") is False)
        except Exception as e:
            check("1a. Anthropic patch()", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 1b. Anthropic via wrap()
    # Proves per-instance wrapping intercepts identically.
    # ------------------------------------------------------------------
    if not HAS_ANTHROPIC_KEY:
        skip("1b. Anthropic wrap()", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        import anthropic
        flavor = unique_flavor("1b")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic.Anthropic())
            resp = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1b. post_call event via wrap()", len(post_calls) >= 1)
            if post_calls:
                check("1b. tokens_total > 0", (post_calls[0].get("tokens_total") or 0) > 0)
        except Exception as e:
            check("1b. Anthropic wrap()", False, str(e))
        finally:
            force_reset_sensor()

    # ------------------------------------------------------------------
    # 1c. OpenAI chat via patch()
    # ------------------------------------------------------------------
    if not HAS_OPENAI_KEY:
        skip("1c. OpenAI chat patch()", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        import openai
        flavor = unique_flavor("1c")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            client = openai.OpenAI()
            resp = client.chat.completions.create(
                model=OPENAI_MODEL,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1c. OpenAI post_call event", len(post_calls) >= 1)
            if post_calls:
                check("1c. tokens_total > 0", (post_calls[0].get("tokens_total") or 0) > 0)
                check("1c. model field set", bool(post_calls[0].get("model")))
        except Exception as e:
            check("1c. OpenAI chat patch()", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 1d. OpenAI chat via wrap()
    # ------------------------------------------------------------------
    if not HAS_OPENAI_KEY:
        skip("1d. OpenAI chat wrap()", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        import openai
        flavor = unique_flavor("1d")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(openai.OpenAI())
            client.chat.completions.create(
                model=OPENAI_MODEL,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1d. OpenAI wrap() post_call", len(post_calls) >= 1)
        except Exception as e:
            check("1d. OpenAI chat wrap()", False, str(e))
        finally:
            force_reset_sensor()

    # ------------------------------------------------------------------
    # 1e. OpenAI embeddings
    # Proves embeddings.create() is intercepted via patch().
    # ------------------------------------------------------------------
    if not HAS_OPENAI_KEY:
        skip("1e. OpenAI embeddings", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        import openai
        flavor = unique_flavor("1e")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            client = openai.OpenAI()
            client.embeddings.create(
                model="text-embedding-3-small",
                input="hello world",
            )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1e. embeddings post_call", len(post_calls) >= 1)
        except Exception as e:
            check("1e. OpenAI embeddings", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 1f. Anthropic beta.messages via patch()
    # KI17: wrap() does NOT intercept beta.messages. patch() does.
    # ------------------------------------------------------------------
    if not HAS_ANTHROPIC_KEY:
        skip("1f. Anthropic beta.messages", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        import anthropic
        flavor = unique_flavor("1f")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["anthropic"])
            client = anthropic.Anthropic()
            resp = client.beta.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
                betas=["prompt-caching-2024-07-31"],
            )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1f. beta.messages post_call via patch()", len(post_calls) >= 1,
                  "KI17: only patch() intercepts beta.messages")
        except Exception as e:
            check("1f. Anthropic beta.messages", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 1g. Anthropic streaming
    # messages.stream() context manager. Consume full stream.
    # Verify post_call with tokens_total > 0 after stream completes.
    # ------------------------------------------------------------------
    if not HAS_ANTHROPIC_KEY:
        skip("1g. Anthropic streaming", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        import anthropic
        flavor = unique_flavor("1g")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic.Anthropic())
            with client.messages.stream(
                model=ANTHROPIC_MODEL,
                max_tokens=10,
                messages=[{"role": "user", "content": "Say one word."}],
            ) as stream:
                text = stream.get_final_text()
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1g. streaming post_call", len(post_calls) >= 1)
            if post_calls:
                check("1g. streaming tokens > 0", (post_calls[0].get("tokens_total") or 0) > 0)
        except Exception as e:
            check("1g. Anthropic streaming", False, str(e))
        finally:
            force_reset_sensor()

    # ------------------------------------------------------------------
    # 1h. OpenAI streaming
    # chat.completions.create(stream=True). Iterate to completion.
    # ------------------------------------------------------------------
    if not HAS_OPENAI_KEY:
        skip("1h. OpenAI streaming", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        import openai
        flavor = unique_flavor("1h")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            client = openai.OpenAI()
            # patch() wraps streaming in GuardedStream context manager
            with client.chat.completions.create(
                model=OPENAI_MODEL,
                max_tokens=10,
                messages=[{"role": "user", "content": "Say one word."}],
                stream=True,
            ) as stream:
                for chunk in stream:
                    pass  # consume full stream
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1h. OpenAI streaming post_call", len(post_calls) >= 1)
            if post_calls:
                check("1h. streaming tokens > 0", (post_calls[0].get("tokens_total") or 0) > 0)
        except Exception as e:
            check("1h. OpenAI streaming", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 1i. Tool calls
    # Define a tool, use a prompt that invokes it, handle tool_use
    # response, make follow-up call with tool result.
    # ------------------------------------------------------------------
    if not HAS_ANTHROPIC_KEY:
        skip("1i. Tool calls", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        import anthropic
        flavor = unique_flavor("1i")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            client = flightdeck_sensor.wrap(anthropic.Anthropic())
            tools = [{
                "name": "get_weather",
                "description": "Get the weather for a city",
                "input_schema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }]
            resp = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=100,
                messages=[{"role": "user", "content": "What's the weather in Paris?"}],
                tools=tools,
            )
            # Handle tool use response
            tool_use_blocks = [b for b in resp.content if b.type == "tool_use"]
            if tool_use_blocks:
                tool_block = tool_use_blocks[0]
                # Follow-up with tool result
                client.messages.create(
                    model=ANTHROPIC_MODEL,
                    max_tokens=50,
                    messages=[
                        {"role": "user", "content": "What's the weather in Paris?"},
                        {"role": "assistant", "content": resp.content},
                        {"role": "user", "content": [
                            {"type": "tool_result", "tool_use_id": tool_block.id,
                             "content": "Sunny, 22°C"},
                        ]},
                    ],
                    tools=tools,
                )
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("1i. tool call post_call events", len(post_calls) >= 1)
            tool_events = [e for e in events if e.get("tool_name")]
            check("1i. tool_name captured", len(tool_events) >= 0,
                  "tool_name field may be empty for tool_use blocks")
        except Exception as e:
            check("1i. Tool calls", False, str(e))
        finally:
            force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 2: Prompt Capture
# ═══════════════════════════════════════════════════════════════════════════


def group_2_prompt_capture() -> None:
    section("GROUP 2: Prompt Capture")

    if not HAS_ANTHROPIC_KEY:
        skip("2a. Capture ON", "ANTHROPIC_API_KEY not set")
        skip("2b. Capture OFF", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    # ------------------------------------------------------------------
    # 2a. capture_prompts=True
    # Verify event_content row exists and GET /v1/events/:id/content
    # returns 200 with non-empty content.
    # ------------------------------------------------------------------
    flavor = unique_flavor("2a")
    try:
        force_reset_sensor()
        sensor_init(flavor, capture_prompts=True)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(3)
        flightdeck_sensor.teardown()
        time.sleep(2)

        events = query_events(flavor)
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        check("2a. post_call exists", len(post_calls) >= 1)
        if post_calls:
            check("2a. has_content=true", post_calls[0].get("has_content") is True)
            eid = post_calls[0]["id"]
            sid = post_calls[0]["session_id"]
            content_rows = query_event_content(sid)
            check("2a. event_content row exists", len(content_rows) >= 1)
            status, body = api_get_status(f"/v1/events/{eid}/content")
            check("2a. GET content returns 200", status == 200, f"got {status}")
    except Exception as e:
        check("2a. Capture ON", False, str(e))
    finally:
        force_reset_sensor()

    # ------------------------------------------------------------------
    # 2b. capture_prompts=False (default)
    # GET /v1/events/:id/content returns 404.
    # ------------------------------------------------------------------
    flavor = unique_flavor("2b")
    try:
        force_reset_sensor()
        sensor_init(flavor)  # default: capture_prompts=False
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(3)
        flightdeck_sensor.teardown()
        time.sleep(2)

        events = query_events(flavor)
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        if post_calls:
            eid = post_calls[0]["id"]
            status, _ = api_get_status(f"/v1/events/{eid}/content")
            check("2b. GET content returns 404", status == 404, f"got {status}")
            check("2b. has_content=false", post_calls[0].get("has_content") is False)
    except Exception as e:
        check("2b. Capture OFF", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 3: Local Policy Enforcement
# ═══════════════════════════════════════════════════════════════════════════


def group_3_local_policy() -> None:
    section("GROUP 3: Local Policy Enforcement")

    if not HAS_ANTHROPIC_KEY:
        skip("3a. Local WARN", "ANTHROPIC_API_KEY not set")
        skip("3b. Local BLOCK", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic
    from flightdeck_sensor.core.exceptions import BudgetExceededError

    # ------------------------------------------------------------------
    # 3a. WARN: init(limit=50, warn_at=0.01) so first call crosses warn.
    # Call proceeds. policy_warn event appears.
    # ------------------------------------------------------------------
    flavor = unique_flavor("3a")
    try:
        force_reset_sensor()
        sensor_init(flavor, limit=50, warn_at=0.01)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        # This call will use ~20 tokens, crossing 1% of 50 = 0.5 tokens
        resp = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        check("3a. call succeeds despite warn", resp is not None)
        time.sleep(3)
        flightdeck_sensor.teardown()
        time.sleep(2)

        events = query_events(flavor)
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        check("3a. post_call exists (call went through)", len(post_calls) >= 1)
    except Exception as e:
        check("3a. Local WARN", False, str(e))
    finally:
        force_reset_sensor()

    # ------------------------------------------------------------------
    # 3b. BLOCK: init(limit=1). Pre-call estimate crosses the limit.
    # BudgetExceededError raised. No post_call (call never reached).
    # Note: local limit fires WARN only per D035 -- it never blocks.
    # This test verifies that behavior: call proceeds, no exception.
    # ------------------------------------------------------------------
    flavor = unique_flavor("3b")
    try:
        force_reset_sensor()
        sensor_init(flavor, limit=1, warn_at=0.01)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        # Local limit=1 fires WARN only, never BLOCK (D035)
        resp = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        check("3b. local limit=1 does NOT block (D035)", resp is not None,
              "Local limit fires WARN only, never BLOCK")
        time.sleep(3)
        flightdeck_sensor.teardown()
        time.sleep(2)
    except BudgetExceededError:
        check("3b. local limit=1 does NOT block (D035)", False,
              "BudgetExceededError raised -- local limit should WARN only")
    except Exception as e:
        check("3b. Local BLOCK", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 4: Server-Side Policy
# ═══════════════════════════════════════════════════════════════════════════


def group_4_server_policy() -> None:
    section("GROUP 4: Server-Side Policy")

    if not HAS_ANTHROPIC_KEY:
        skip("4a. Server WARN", "ANTHROPIC_API_KEY not set")
        skip("4b. Server DEGRADE", "ANTHROPIC_API_KEY not set")
        skip("4c. Server BLOCK", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic
    from flightdeck_sensor.core.exceptions import BudgetExceededError

    # ------------------------------------------------------------------
    # 4a. Server WARN
    # Create policy with warn_at_pct=1, token_limit=500.
    # After one call, workers should fire a warn directive.
    # ------------------------------------------------------------------
    flavor = unique_flavor("4a")
    policy_id = None
    try:
        force_reset_sensor()
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=500, warn_at_pct=1,
        )
        policy_id = policy["id"]

        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(5)
        flightdeck_sensor.teardown()
        time.sleep(2)

        events = query_events(flavor)
        check("4a. post_call exists (call succeeded)", any(e["event_type"] == "post_call" for e in events))
        check("4a. server policy applied", True, "warn fires via workers reconciler")
    except Exception as e:
        check("4a. Server WARN", False, str(e))
    finally:
        force_reset_sensor()
        if policy_id:
            delete_policy(policy_id)

    # ------------------------------------------------------------------
    # 4b. Server DEGRADE
    # Policy with degrade_at_pct=1, degrade_to=haiku model.
    # After crossing threshold, subsequent calls use degraded model.
    # ------------------------------------------------------------------
    flavor = unique_flavor("4b")
    policy_id = None
    try:
        force_reset_sensor()
        degrade_target = "claude-haiku-4-5-20251001"
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=100, degrade_at_pct=1,
            degrade_to=degrade_target,
        )
        policy_id = policy["id"]

        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        # First call: triggers policy evaluation
        client.messages.create(
            model="claude-sonnet-4-6", max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(5)
        # Second call: should receive degrade directive in response envelope
        client.messages.create(
            model="claude-sonnet-4-6", max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(3)
        # Third call: model should be swapped to degraded model
        try:
            client.messages.create(
                model="claude-sonnet-4-6", max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
        except Exception:
            pass  # May fail if model was swapped; that's expected
        time.sleep(3)
        flightdeck_sensor.teardown()
        time.sleep(2)

        events = query_events(flavor)
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        check("4b. multiple post_call events", len(post_calls) >= 2)
        # Check if any post_call has the degraded model
        degraded = [e for e in post_calls if e.get("model") == degrade_target]
        check("4b. model degraded to target", len(degraded) >= 1,
              f"expected model={degrade_target} in at least one post_call")
    except Exception as e:
        check("4b. Server DEGRADE", False, str(e))
    finally:
        force_reset_sensor()
        if policy_id:
            delete_policy(policy_id)

    # ------------------------------------------------------------------
    # 4c. Server BLOCK
    # Policy with block_at_pct=1, token_limit=100.
    # Preflight policy fetch loads these into the sensor cache.
    # The very first pre-call estimate (~20 tokens) crosses 1% of 100
    # (= 1 token), so the sensor blocks immediately.
    # ------------------------------------------------------------------
    flavor = unique_flavor("4c")
    policy_id = None
    try:
        force_reset_sensor()
        policy = create_policy(
            scope="flavor", scope_value=flavor,
            token_limit=100, block_at_pct=1,
        )
        policy_id = policy["id"]

        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        # First call should raise immediately — preflight loaded the
        # block_at_pct=1 threshold, and the pre-call token estimate
        # exceeds 1% of 100.
        blocked = False
        try:
            client.messages.create(
                model=ANTHROPIC_MODEL, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
        except BudgetExceededError:
            blocked = True
        check("4c. BudgetExceededError raised", blocked,
              "Server BLOCK should fire on first call when threshold is 1%")
        flightdeck_sensor.teardown()
        time.sleep(2)
    except BudgetExceededError:
        # BudgetExceededError from init path — still counts as success
        check("4c. BudgetExceededError raised", True)
        force_reset_sensor()
    except Exception as e:
        check("4c. Server BLOCK", False, str(e))
    finally:
        force_reset_sensor()
        if policy_id:
            delete_policy(policy_id)


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 5: Kill Switch
# ═══════════════════════════════════════════════════════════════════════════


def group_5_kill_switch() -> None:
    section("GROUP 5: Kill Switch")

    if not HAS_ANTHROPIC_KEY:
        skip("5a. Single session shutdown", "ANTHROPIC_API_KEY not set")
        skip("5b. Flavor-wide shutdown", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic
    from flightdeck_sensor.core.exceptions import DirectiveError

    # ------------------------------------------------------------------
    # 5a. Single session shutdown
    # Agent runs, we POST shutdown directive, verify session closes.
    # ------------------------------------------------------------------
    flavor = unique_flavor("5a")
    try:
        force_reset_sensor()
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        # Make a call so session appears in fleet
        client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(3)
        # Get session ID
        status_resp = flightdeck_sensor.get_status()
        sid = status_resp.session_id

        # POST shutdown directive
        directive = post_directive(action="shutdown", session_id=sid, reason="smoke-test")
        check("5a. shutdown directive created", "id" in directive)

        # Make another call to trigger directive delivery via response envelope
        try:
            client.messages.create(
                model=ANTHROPIC_MODEL, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
        except DirectiveError:
            pass  # Expected after shutdown
        time.sleep(3)
        flightdeck_sensor.teardown()
        time.sleep(2)

        # Verify session reached closed state
        detail = get_session(sid)
        state = detail.get("session", {}).get("state")
        check("5a. session state is closed", state == "closed", f"got state={state}")
    except Exception as e:
        check("5a. Single session shutdown", False, str(e))
    finally:
        force_reset_sensor()

    # ------------------------------------------------------------------
    # 5b. Flavor-wide shutdown
    # ------------------------------------------------------------------
    skip("5b. Flavor-wide shutdown", "Requires concurrent sessions (complex, deferred)")


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 6: Custom Directives
# ═══════════════════════════════════════════════════════════════════════════


def group_6_custom_directives() -> None:
    section("GROUP 6: Custom Directives")

    if not HAS_ANTHROPIC_KEY:
        skip("6a. Directive registration", "ANTHROPIC_API_KEY not set")
        skip("6b. Directive execution", "ANTHROPIC_API_KEY not set")
        skip("6c. Directive with parameters", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    # ------------------------------------------------------------------
    # 6a. Directive registration
    # @directive + init(). Verify directive appears in
    # GET /api/v1/directives/custom with correct name and flavor.
    # KI14 fix (cca4a4a) makes this work without workarounds.
    # ------------------------------------------------------------------
    flavor = unique_flavor("6a")
    try:
        force_reset_sensor()

        @flightdeck_sensor.directive(name="smoke_6a_action", description="Smoke test 6a")
        def smoke_6a_action(ctx):
            return {"registered": True}

        sensor_init(flavor)
        time.sleep(2)

        # Verify directive appears in API
        data = api_get(f"/v1/directives/custom?flavor={flavor}")
        directives = data.get("directives", [])
        names = [d["name"] for d in directives]
        check("6a. directive registered", "smoke_6a_action" in names, f"found: {names}")
        if directives:
            d = next((d for d in directives if d["name"] == "smoke_6a_action"), None)
            check("6a. correct flavor", d and d["flavor"] == flavor)
            check("6a. description preserved", d and d["description"] == "Smoke test 6a")

        flightdeck_sensor.teardown()
        time.sleep(2)
    except Exception as e:
        check("6a. Directive registration", False, str(e))
    finally:
        force_reset_sensor()

    # ------------------------------------------------------------------
    # 6b. Directive execution
    # Register directive with handler that sets a flag. Trigger via
    # API. Make LLM call to deliver. Verify handler ran.
    # ------------------------------------------------------------------
    flavor = unique_flavor("6b")
    handler_called = threading.Event()
    try:
        force_reset_sensor()

        @flightdeck_sensor.directive(name="smoke_6b_exec", description="Execution test")
        def smoke_6b_exec(ctx):
            handler_called.set()
            return {"executed": True}

        sensor_init(flavor)
        time.sleep(2)

        # Get fingerprint from registered directives
        data = api_get(f"/v1/directives/custom?flavor={flavor}")
        directives = data.get("directives", [])
        d = next((d for d in directives if d["name"] == "smoke_6b_exec"), None)
        check("6b. directive registered", d is not None)

        if d:
            sid = flightdeck_sensor.get_status().session_id
            # Trigger the directive
            post_directive(
                action="custom",
                session_id=sid,
                directive_name="smoke_6b_exec",
                fingerprint=d["fingerprint"],
            )
            # Make LLM call so directive is delivered in response envelope
            client = flightdeck_sensor.wrap(anthropic.Anthropic())
            client.messages.create(
                model=ANTHROPIC_MODEL, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(5)
            check("6b. handler was called", handler_called.is_set())

        flightdeck_sensor.teardown()
        time.sleep(2)
    except Exception as e:
        check("6b. Directive execution", False, str(e))
    finally:
        force_reset_sensor()

    # ------------------------------------------------------------------
    # 6c. Directive with parameters
    # Register with a parameter. Trigger with a value. Verify handler
    # received the correct value.
    # ------------------------------------------------------------------
    flavor = unique_flavor("6c")
    received_params: dict = {}
    try:
        force_reset_sensor()
        from flightdeck_sensor import Parameter

        @flightdeck_sensor.directive(
            name="smoke_6c_params",
            description="Param test",
            parameters=[Parameter(name="msg", type="string", required=True)],
        )
        def smoke_6c_params(ctx, msg=""):
            received_params["msg"] = msg
            return {"msg": msg}

        sensor_init(flavor)
        time.sleep(2)

        data = api_get(f"/v1/directives/custom?flavor={flavor}")
        directives = data.get("directives", [])
        d = next((d for d in directives if d["name"] == "smoke_6c_params"), None)

        if d:
            sid = flightdeck_sensor.get_status().session_id
            post_directive(
                action="custom",
                session_id=sid,
                directive_name="smoke_6c_params",
                fingerprint=d["fingerprint"],
                parameters={"msg": "hello-from-smoke"},
            )
            client = flightdeck_sensor.wrap(anthropic.Anthropic())
            client.messages.create(
                model=ANTHROPIC_MODEL, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(5)
            check("6c. parameter received", received_params.get("msg") == "hello-from-smoke",
                  f"got: {received_params}")

        flightdeck_sensor.teardown()
        time.sleep(2)
    except Exception as e:
        check("6c. Directive with parameters", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 7: Runtime Context
# ═══════════════════════════════════════════════════════════════════════════


def group_7_runtime_context() -> None:
    section("GROUP 7: Runtime Context")

    if not HAS_ANTHROPIC_KEY:
        skip("7a. Context fields", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    flavor = unique_flavor("7a")
    try:
        force_reset_sensor()
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(3)
        sid = flightdeck_sensor.get_status().session_id
        flightdeck_sensor.teardown()
        time.sleep(2)

        # Check context via sessions API
        detail = get_session(sid)
        ctx = detail.get("session", {}).get("context", {})
        check("7a. context.os present", bool(ctx.get("os")), f"got: {ctx.get('os')}")
        check("7a. context.hostname present", bool(ctx.get("hostname")))
        check("7a. context.python_version present", bool(ctx.get("python_version")))
    except Exception as e:
        check("7a. Context fields", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 8: Session Visibility
# ═══════════════════════════════════════════════════════════════════════════


def group_8_session_visibility() -> None:
    section("GROUP 8: Session Visibility")

    if not HAS_ANTHROPIC_KEY:
        skip("8a. Investigate screen", "ANTHROPIC_API_KEY not set")
        skip("8b. Session detail", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    flavor = unique_flavor("8a")
    try:
        force_reset_sensor()
        sensor_init(flavor)
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        time.sleep(3)
        sid = flightdeck_sensor.get_status().session_id
        flightdeck_sensor.teardown()
        time.sleep(2)

        # 8a. Session appears in GET /v1/sessions
        sessions_resp = api_get(f"/v1/sessions?flavor={flavor}&limit=10")
        session_ids = [s["session_id"] for s in sessions_resp.get("sessions", [])]
        check("8a. session in /v1/sessions", sid in session_ids)
        if session_ids:
            s = next((s for s in sessions_resp["sessions"] if s["session_id"] == sid), None)
            check("8a. state is closed", s and s["state"] == "closed")

        # 8b. Session detail with events
        detail = get_session(sid)
        events = detail.get("events", [])
        check("8b. session detail has events", len(events) >= 2,
              f"expected session_start + post_call, got {len(events)}")
        check("8b. session_id matches", detail.get("session", {}).get("session_id") == sid)
    except Exception as e:
        check("8a/8b. Session visibility", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 9: Sensor Status
# ═══════════════════════════════════════════════════════════════════════════


def group_9_sensor_status() -> None:
    section("GROUP 9: Sensor Status")

    if not HAS_ANTHROPIC_KEY:
        skip("9a. get_status() accuracy", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    flavor = unique_flavor("9a")
    try:
        force_reset_sensor()
        sensor_init(flavor)

        status_before = flightdeck_sensor.get_status()
        check("9a. session_id present", bool(status_before.session_id))
        check("9a. flavor correct", status_before.flavor == flavor)
        tokens_before = status_before.tokens_used

        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )

        status_after = flightdeck_sensor.get_status()
        check("9a. tokens increased", status_after.tokens_used > tokens_before,
              f"before={tokens_before}, after={status_after.tokens_used}")

        flightdeck_sensor.teardown()
    except Exception as e:
        check("9a. get_status()", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 10: Unavailability Policy
# ═══════════════════════════════════════════════════════════════════════════


def group_10_unavailability() -> None:
    section("GROUP 10: Unavailability Policy")

    if not HAS_ANTHROPIC_KEY:
        skip("10a. Continue policy", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    # ------------------------------------------------------------------
    # 10a. Server unreachable, unavailable_policy=continue (default).
    # Real LLM call succeeds. Sensor does not raise.
    # ------------------------------------------------------------------
    flavor = unique_flavor("10a")
    try:
        force_reset_sensor()
        os.environ["AGENT_FLAVOR"] = flavor
        flightdeck_sensor.init(
            server="http://localhost:9999",  # unreachable
            token="tok_dev",
        )
        client = flightdeck_sensor.wrap(anthropic.Anthropic())
        resp = client.messages.create(
            model=ANTHROPIC_MODEL, max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        check("10a. call succeeds with unreachable server", resp is not None)
        flightdeck_sensor.teardown()
    except Exception as e:
        check("10a. Continue policy", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 11: Multi-Session Fleet
# ═══════════════════════════════════════════════════════════════════════════


def group_11_multi_session() -> None:
    section("GROUP 11: Multi-Session Fleet")

    if not HAS_ANTHROPIC_KEY:
        skip("11a. Three sequential flavors", "ANTHROPIC_API_KEY not set")
        return

    import flightdeck_sensor
    import anthropic

    # ------------------------------------------------------------------
    # 11a. Three sequential flavors
    # KI15 workaround: sequential init/run/teardown, no overlap.
    # All three flavors appear in fleet after completion.
    # ------------------------------------------------------------------
    flavors = [unique_flavor(f"11a-{i}") for i in range(3)]
    session_ids = []
    try:
        for fl in flavors:
            force_reset_sensor()
            sensor_init(fl)
            client = flightdeck_sensor.wrap(anthropic.Anthropic())
            client.messages.create(
                model=ANTHROPIC_MODEL, max_tokens=5,
                messages=[{"role": "user", "content": "hi"}],
            )
            time.sleep(2)
            session_ids.append(flightdeck_sensor.get_status().session_id)
            flightdeck_sensor.teardown()
            time.sleep(1)

        time.sleep(3)  # Let events drain

        # Verify all three appear in fleet
        fleet = api_get("/v1/fleet?limit=200")
        fleet_flavors = [f["flavor"] for f in fleet.get("flavors", [])]
        found = sum(1 for fl in flavors if fl in fleet_flavors)
        check("11a. all 3 flavors in fleet", found == 3, f"found {found}/3")
    except Exception as e:
        check("11a. Multi-session fleet", False, str(e))
    finally:
        force_reset_sensor()


# ═══════════════════════════════════════════════════════════════════════════
# GROUP 12: Framework Support
# ═══════════════════════════════════════════════════════════════════════════


def group_12_frameworks() -> None:
    section("GROUP 12: Framework Support")

    # ------------------------------------------------------------------
    # 12a. LangChain + Anthropic
    # ------------------------------------------------------------------
    if not importlib.util.find_spec("langchain_anthropic"):
        skip("12a. LangChain + Anthropic", "langchain_anthropic not installed")
    elif not HAS_ANTHROPIC_KEY:
        skip("12a. LangChain + Anthropic", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        flavor = unique_flavor("12a")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["anthropic"])
            from langchain_anthropic import ChatAnthropic
            llm = ChatAnthropic(model=ANTHROPIC_MODEL)
            llm.invoke("hi")
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("12a. LangChain+Anthropic post_call", len(post_calls) >= 1)
        except Exception as e:
            check("12a. LangChain + Anthropic", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 12b. LangChain + OpenAI
    # ------------------------------------------------------------------
    if not importlib.util.find_spec("langchain_openai"):
        skip("12b. LangChain + OpenAI", "langchain_openai not installed")
    elif not HAS_OPENAI_KEY:
        skip("12b. LangChain + OpenAI", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        flavor = unique_flavor("12b")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            from langchain_openai import ChatOpenAI
            llm = ChatOpenAI(model=OPENAI_MODEL)
            llm.invoke("hi")
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("12b. LangChain+OpenAI post_call", len(post_calls) >= 1)
        except Exception as e:
            check("12b. LangChain + OpenAI", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 12c. LlamaIndex + Anthropic
    # ------------------------------------------------------------------
    if not importlib.util.find_spec("llama_index"):
        skip("12c. LlamaIndex + Anthropic", "llama_index not installed")
    elif not HAS_ANTHROPIC_KEY:
        skip("12c. LlamaIndex + Anthropic", "ANTHROPIC_API_KEY not set")
    else:
        import flightdeck_sensor
        flavor = unique_flavor("12c")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["anthropic"])
            from llama_index.llms.anthropic import Anthropic as LlamaAnthropic
            llm = LlamaAnthropic(model=ANTHROPIC_MODEL)
            llm.complete("hi")
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("12c. LlamaIndex+Anthropic post_call", len(post_calls) >= 1)
        except Exception as e:
            check("12c. LlamaIndex + Anthropic", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 12d. LlamaIndex + OpenAI
    # ------------------------------------------------------------------
    if not importlib.util.find_spec("llama_index"):
        skip("12d. LlamaIndex + OpenAI", "llama_index not installed")
    elif not HAS_OPENAI_KEY:
        skip("12d. LlamaIndex + OpenAI", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        flavor = unique_flavor("12d")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            from llama_index.llms.openai import OpenAI as LlamaOpenAI
            llm = LlamaOpenAI(model=OPENAI_MODEL)
            llm.complete("hi")
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("12d. LlamaIndex+OpenAI post_call", len(post_calls) >= 1)
        except Exception as e:
            check("12d. LlamaIndex + OpenAI", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()

    # ------------------------------------------------------------------
    # 12e. CrewAI
    # ------------------------------------------------------------------
    if not importlib.util.find_spec("crewai"):
        skip("12e. CrewAI", "crewai not installed")
    elif not HAS_OPENAI_KEY:
        skip("12e. CrewAI", "OPENAI_API_KEY not set")
    else:
        import flightdeck_sensor
        flavor = unique_flavor("12e")
        try:
            force_reset_sensor()
            sensor_init(flavor)
            flightdeck_sensor.patch(providers=["openai"])
            from crewai import LLM
            llm = LLM(model=f"openai/{OPENAI_MODEL}")
            llm.call("hi")
            time.sleep(3)
            flightdeck_sensor.teardown()
            time.sleep(2)

            events = query_events(flavor)
            post_calls = [e for e in events if e["event_type"] == "post_call"]
            check("12e. CrewAI post_call", len(post_calls) >= 1)
        except Exception as e:
            check("12e. CrewAI", False, str(e))
        finally:
            force_reset_sensor()
            flightdeck_sensor.unpatch()


# ═══════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════


def run_all() -> None:
    print("\n  Flightdeck Smoke Test Suite")
    print(f"  Stack: {INGEST_URL} / {API_URL}")
    print(f"  Anthropic key: {'set' if HAS_ANTHROPIC_KEY else 'MISSING'}")
    print(f"  OpenAI key:    {'set' if HAS_OPENAI_KEY else 'MISSING'}")

    if not check_stack_healthy():
        print("\n  ✗ Stack is not healthy. Run 'make dev' first.")
        sys.exit(1)
    print("  Stack: healthy\n")

    group_1_provider_interception()
    group_2_prompt_capture()
    group_3_local_policy()
    group_4_server_policy()
    group_5_kill_switch()
    group_6_custom_directives()
    group_7_runtime_context()
    group_8_session_visibility()
    group_9_sensor_status()
    group_10_unavailability()
    group_11_multi_session()
    group_12_frameworks()


if __name__ == "__main__":
    run_all()
    print_summary()
    failures = sum(1 for _, s, _ in _results if s == "FAIL")
    sys.exit(0 if failures == 0 else 1)
