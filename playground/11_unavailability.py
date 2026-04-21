"""Unavailability policy -- continue (fail open) vs halt (fail closed).

`FLIGHTDECK_UNAVAILABLE_POLICY=continue` (default) is the safe posture
for production agents: if the control plane is down, the agent still
makes LLM calls and drops telemetry silently. `halt` is the opposite
-- `init()` raises `DirectiveError` when the server is unreachable so
the operator knows telemetry is broken.

This file tests both by pointing the sensor at a dead port.
"""
from __future__ import annotations

import os, sys, uuid

try:
    import anthropic
except ImportError:
    print("SKIP: pip install anthropic"); sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import DirectiveError
from _helpers import print_result

DEAD = "http://127.0.0.1:9999"
MODEL, HI = "claude-haiku-4-5-20251001", [{"role": "user", "content": "hi"}]

def main():
    print("[playground:11_unavailability]")

    # 1) continue: init + LLM call succeed against a dead control plane.
    os.environ.pop("FLIGHTDECK_SERVER", None)
    os.environ["FLIGHTDECK_UNAVAILABLE_POLICY"] = "continue"
    flightdeck_sensor.init(server=DEAD, token="tok_dev",
        session_id=str(uuid.uuid4()), quiet=True)
    flightdeck_sensor.patch(providers=["anthropic"], quiet=True)
    anthropic.Anthropic().messages.create(model=MODEL, max_tokens=5, messages=HI)
    print_result("continue + dead URL: LLM call succeeds", True, 0)
    flightdeck_sensor.teardown()

    # 2) halt: init() raises because the control plane is unreachable.
    os.environ["FLIGHTDECK_UNAVAILABLE_POLICY"] = "halt"
    try:
        flightdeck_sensor.init(server=DEAD, token="tok_dev",
            session_id=str(uuid.uuid4()), quiet=True)
        print_result("halt + dead URL: init() raises", False, 0, "no exception")
        flightdeck_sensor.teardown()
        sys.exit(1)
    except DirectiveError as e:
        print_result("halt + dead URL: init() raises", True, 0, f"DirectiveError: {e}")

if __name__ == "__main__":
    main()
