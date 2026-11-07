"""patch() before the SDK imports, a framework imported after init(), and a
SIGTERM that lands inside a sensor lock.

1. ``import flightdeck_sensor``, ``init()`` and ``patch()`` load no SDK:
   the script checks ``sys.modules``, then imports openai, anthropic and
   litellm only afterwards and makes one tiny call through each; every
   call must land a metered ``post_call``.
2. A framework imported after ``init()``: LangChain is not loaded when
   the classifiers first run, and its first call labels the session
   (``framework=langchain``, also in ``context.frameworks``). Skipped
   without langchain-openai.
3. A child process starts a session, makes one tiny OpenAI call, then
   holds the session's lock on its main thread while the script sends it
   a real SIGTERM. The child must end by SIGTERM within a bound, with its
   ``session_end`` delivered to the stack.

Needs OPENAI_API_KEY and ANTHROPIC_API_KEY, the openai, anthropic and
litellm packages, and the dev stack. Exits 2 (SKIP) without them.
"""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
import uuid
from typing import Any

import flightdeck_sensor

from _helpers import (
    API_TOKEN,
    API_URL,
    assert_event_landed,
    fetch_events_for_session,
    init_sensor,
    print_result,
    require_env,
    wait_for_dev_stack,
)

FLAVOR = "playground-lazy-patch-signals"
OPENAI_MODEL = "gpt-4o-mini"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
HI = [{"role": "user", "content": "hi"}]
# Every SDK patch() covers, by the module whose import triggers its patch.
PATCHABLE = (
    "anthropic",
    "openai",
    "litellm",
    "mcp",
    "crewai",
    "langgraph.graph",
    "claude_agent_sdk",
)
# The child ends within the sensor's 8 s shutdown deadline, with room for
# a slow machine; before the fix it never ended at all.
CHILD_EXIT_BOUND_S = 20.0
# How long the child holds the session lock once it prints READY: the
# SIGTERM, sent as soon as READY is read, lands while it is held.
CHILD_LOCK_HOLD_S = 1.0
# Sleep between checks of the hold's deadline. A sleep loop, as in the
# unit tests' child: Python 3.13 can skip a busy loop's `with` exit when a
# signal handler raises at its back-edge.
CHILD_LOCK_POLL_S = 0.01
# Time for an event to land after the drain thread posts it.
EVENT_LANDED_S = 15.0


def child(session_id: str) -> None:
    """The process the parent sends SIGTERM to."""
    init_sensor(session_id, flavor=FLAVOR)
    flightdeck_sensor.patch(quiet=True)
    import openai

    openai.OpenAI().chat.completions.create(model=OPENAI_MODEL, max_tokens=5, messages=HI)
    session = flightdeck_sensor._session
    assert session is not None
    with session._lock:
        print("READY", flush=True)
        deadline = time.monotonic() + CHILD_LOCK_HOLD_S
        while time.monotonic() < deadline:
            time.sleep(CHILD_LOCK_POLL_S)
    time.sleep(60)
    print("ALIVE", flush=True)


def lazy_patch() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor=FLAVOR)
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:31_lazy_patch_signals] session_id={session_id}")

    loaded = [name for name in PATCHABLE if name in sys.modules]
    print_result("import + init() + patch() load no SDK", not loaded, 0, f"loaded={loaded}")
    if loaded:
        raise AssertionError(f"SDKs loaded before the application imported them: {loaded}")

    import openai

    t0 = time.monotonic()
    openai.OpenAI().chat.completions.create(model=OPENAI_MODEL, max_tokens=5, messages=HI)
    assert_event_landed(session_id, "post_call", EVENT_LANDED_S, model_contains=OPENAI_MODEL)
    print_result(
        "openai imported after patch() is metered", True, int((time.monotonic() - t0) * 1000)
    )

    import anthropic

    t0 = time.monotonic()
    anthropic.Anthropic().messages.create(model=ANTHROPIC_MODEL, max_tokens=5, messages=HI)
    assert_event_landed(session_id, "post_call", EVENT_LANDED_S, model_contains="claude-haiku-4-5")
    print_result(
        "anthropic imported after patch() is metered", True, int((time.monotonic() - t0) * 1000)
    )

    import litellm

    t0 = time.monotonic()
    litellm.completion(model=OPENAI_MODEL, max_tokens=5, messages=HI)
    events = fetch_events_for_session(session_id, expect_event_types=["post_call"])
    deadline = time.monotonic() + EVENT_LANDED_S
    post_calls = [e for e in events if e.get("event_type") == "post_call"]
    while len(post_calls) < 3 and time.monotonic() < deadline:
        time.sleep(0.5)
        events = fetch_events_for_session(session_id, expect_event_types=["post_call"])
        post_calls = [e for e in events if e.get("event_type") == "post_call"]
    # One post_call each for openai and anthropic, and one for the litellm
    # call (which litellm served through the openai SDK, reported once).
    passed = len(post_calls) == 3
    print_result(
        "litellm imported after patch() is metered once",
        passed,
        int((time.monotonic() - t0) * 1000),
        f"post_calls={len(post_calls)}",
    )
    if not passed:
        raise AssertionError(f"expected 3 post_calls, saw {len(post_calls)}")
    flightdeck_sensor.teardown()


def _session_row(session_id: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions/{session_id}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return dict(json.loads(r.read()).get("session") or {})


def late_framework() -> None:
    """A framework imported after init() labels the session: the
    classifiers find nothing at init(), the next call carries the label,
    and the worker fills the session row's framework and
    context.frameworks."""
    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor=FLAVOR)
    flightdeck_sensor.patch(quiet=True)
    print(f"[playground:31_lazy_patch_signals] late-framework session_id={session_id}")
    session = flightdeck_sensor._session
    assert session is not None
    at_init = session._framework

    from langchain_openai import ChatOpenAI

    t0 = time.monotonic()
    ChatOpenAI(model=OPENAI_MODEL, max_tokens=5).invoke("hi")
    assert_event_landed(session_id, "post_call", EVENT_LANDED_S, model_contains=OPENAI_MODEL)
    deadline = time.monotonic() + EVENT_LANDED_S
    row = _session_row(session_id)
    while row.get("framework") is None and time.monotonic() < deadline:
        time.sleep(0.5)
        row = _session_row(session_id)
    frameworks = (row.get("context") or {}).get("frameworks") or []
    passed = at_init is None and row.get("framework") == "langchain" and "langchain" in frameworks
    print_result(
        "a framework imported after init() labels the session",
        passed,
        int((time.monotonic() - t0) * 1000),
        f"at_init={at_init} framework={row.get('framework')} frameworks={frameworks}",
    )
    flightdeck_sensor.teardown()
    if not passed:
        raise AssertionError(
            f"want framework=langchain after the late import, at init None: "
            f"at_init={at_init} row framework={row.get('framework')} frameworks={frameworks}"
        )


def sigterm_inside_a_lock() -> None:
    child_session_id = str(uuid.uuid4())
    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--child", child_session_id],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.strip() == "READY":
            break
    else:
        raise AssertionError(f"child exited before READY: {proc.wait()} {proc.stderr.read()}")
    print(f"[playground:31_lazy_patch_signals] child session_id={child_session_id}")
    t0 = time.monotonic()
    proc.send_signal(signal.SIGTERM)
    try:
        out, err = proc.communicate(timeout=CHILD_EXIT_BOUND_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise AssertionError("child did not exit on SIGTERM") from None
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    passed = proc.returncode == -signal.SIGTERM and "ALIVE" not in out
    print_result(
        "SIGTERM inside the session lock ends the child",
        passed,
        elapsed_ms,
        f"exit={proc.returncode}",
    )
    if not passed:
        raise AssertionError(f"child exit {proc.returncode}: {out} {err}")
    assert_event_landed(child_session_id, "post_call", EVENT_LANDED_S, model_contains=OPENAI_MODEL)
    assert_event_landed(child_session_id, "session_end", EVENT_LANDED_S)
    print_result("child's session_end landed", True, elapsed_ms)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        child(sys.argv[2])
        return
    require_env("OPENAI_API_KEY", "ANTHROPIC_API_KEY")
    missing = [m for m in ("openai", "anthropic", "litellm") if importlib.util.find_spec(m) is None]
    if missing:
        print(f"SKIP: pip install {' '.join(missing)} to run this example", file=sys.stderr)
        sys.exit(2)
    wait_for_dev_stack()
    lazy_patch()
    if importlib.util.find_spec("langchain_openai") is None:
        print("SKIP: late-framework section: pip install langchain-openai to run it")
    else:
        late_framework()
    sigterm_inside_a_lock()


if __name__ == "__main__":
    main()
