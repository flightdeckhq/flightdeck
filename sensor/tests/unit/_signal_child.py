"""Child process for test_signal_shutdown.py.

Usage: ``_signal_child.py <capture server url> <mode> [<lock>]``

Starts a sensor session that reports to the capture server, prints
``SESSION <id>`` and ``READY``, then waits for the signal the test sends;
if none ends it, it prints ``ALIVE`` and exits normally. Modes:

- ``idle``: waits holding no sensor lock.
- ``hold``: prints READY while holding the sensor lock named by <lock>
  (``session``, ``queue`` or ``policy``) on the main thread, and keeps
  holding it for ``HOLD_SECS``, so the signal lands inside the critical
  section.
- ``hold-long``: as ``hold`` for ``LONG_HOLD_SECS``, longer than any wait
  of the sensor's, so only a forced exit ends the process early.
- ``leak``: another thread takes the session's lock and never releases
  it, as when code a signal interrupted leaves it held (see
  SHUTDOWN_LOCK_WAIT_SECS in the sensor).
- ``imports``: from READY on, records every module loaded and every
  ``exec`` run, on any thread, through an audit hook; when the SIGINT
  reaches it as KeyboardInterrupt it prints them as ``LOADED <json>`` and
  exits normally.
- ``inflight``: queues one ``INFLIGHT_EVENT_TYPE`` event before READY, so
  that against a capture server that holds its responses the drain
  thread's POST of it is under way when the signal lands.
- ``chain``: installs an application SIGTERM handler before ``init()``;
  it posts a marker to the capture server and exits with
  ``APP_EXIT_CODE``.
- ``ignore``: ignores SIGTERM before ``init()`` and exits normally after
  ``SHORT_WAIT_SECS``.

A lock is held in a ``time.sleep`` loop, not a busy loop: on Python 3.13
an exception a signal handler raises while the interrupted code is at a
loop's back-edge can skip that code's ``with`` exit, which would leave the
lock held for good. The ``leak`` mode covers that case on purpose.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import urllib.request
from typing import Any

# How long ``hold`` keeps the lock: the test sends its signal as soon as it
# reads READY, so a second is ample for the signal to land while it is held.
HOLD_SECS = 1.0
# Longer than every sensor wait put together, so a child in ``hold-long``
# exits within it only when a signal forces the exit.
LONG_HOLD_SECS = 30.0
# Sleep between checks of the hold's deadline.
HOLD_POLL_SECS = 0.01
# How long the child waits for a signal that should end it.
WAIT_SECS = 30.0
# How long ``ignore`` waits before exiting on its own.
SHORT_WAIT_SECS = 1.0
APP_EXIT_CODE = 7
# The event ``inflight`` queues (test_signal_shutdown.py looks for it).
INFLIGHT_EVENT_TYPE = "tool_call"


def _post_marker(server: str, name: str) -> None:
    request = urllib.request.Request(
        f"{server}/marker",
        data=json.dumps({"event_type": name}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        response.read()


def main() -> None:
    server, mode = sys.argv[1], sys.argv[2]
    lock_name = sys.argv[3] if len(sys.argv) > 3 else ""

    if mode == "chain":

        def app_handler(signum: int, frame: Any) -> None:
            _post_marker(server, "app_handler")
            os._exit(APP_EXIT_CODE)

        signal.signal(signal.SIGTERM, app_handler)
    elif mode == "ignore":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    import flightdeck_sensor

    flightdeck_sensor.init(server=server, token="tok", quiet=True, agent_type="coding")
    session = flightdeck_sensor._session
    assert session is not None
    print(f"SESSION {session.config.session_id}", flush=True)

    if mode in ("hold", "hold-long"):
        lock = {
            "session": session._lock,
            "queue": session.event_queue._queue.mutex,
            "policy": session.policy._lock,
        }[lock_name]
        with lock:
            print("READY", flush=True)
            deadline = time.monotonic() + (HOLD_SECS if mode == "hold" else LONG_HOLD_SECS)
            while time.monotonic() < deadline:
                time.sleep(HOLD_POLL_SECS)
    elif mode == "leak":
        held = threading.Event()

        def hold_for_good() -> None:
            session._lock.acquire()
            held.set()
            threading.Event().wait()

        threading.Thread(target=hold_for_good, daemon=True).start()
        held.wait()
        print("READY", flush=True)
    elif mode == "imports":
        loaded: list[str] = []

        def record(event: str, args: tuple[Any, ...]) -> None:
            if event == "import":
                loaded.append(f"import {args[0]}")
            elif event == "exec":
                code = args[0]
                where = f"{getattr(code, 'co_filename', '?')}:{getattr(code, 'co_name', '?')}"
                loaded.append(f"exec {where}")

        sys.addaudithook(record)
        print("READY", flush=True)
        try:
            time.sleep(WAIT_SECS)
        except KeyboardInterrupt:
            print(f"LOADED {json.dumps(loaded)}", flush=True)
            return
    elif mode == "inflight":
        session.event_queue.enqueue(
            {"event_type": INFLIGHT_EVENT_TYPE, "session_id": session.config.session_id}
        )
        print("READY", flush=True)
    else:
        print("READY", flush=True)
    time.sleep(SHORT_WAIT_SECS if mode == "ignore" else WAIT_SECS)
    print("ALIVE", flush=True)


if __name__ == "__main__":
    main()
