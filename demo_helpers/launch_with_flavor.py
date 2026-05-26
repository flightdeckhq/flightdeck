"""Launch a playground script with a flavor override.

playground/_helpers.py:init_sensor() sets os.environ["AGENT_FLAVOR"]
from its `flavor` kwarg, overwriting any value the caller exported in
the shell. This shim monkey-patches init_sensor BEFORE the target
module imports it, so the script's hardcoded flavor is replaced by
DEMO_FLAVOR_OVERRIDE without touching repo files.

Usage:
    DEMO_FLAVOR_OVERRIDE=<flavor> python /tmp/demo_helpers/launch_with_flavor.py <module>
        e.g. DEMO_FLAVOR_OVERRIDE=checkout-orchestrator \
             python /tmp/demo_helpers/launch_with_flavor.py 01_direct_anthropic

Lives in /tmp because the deliverable is the live demo, not committed code.
"""
from __future__ import annotations

import importlib
import os
import sys

PLAYGROUND_DIR = "/mnt/c/Users/omria/dev/flightdeck/playground"
sys.path.insert(0, PLAYGROUND_DIR)

# Patch BEFORE the target script's `from _helpers import init_sensor`
# binds a local reference.
import _helpers as _h  # noqa: E402
_orig_init_sensor = _h.init_sensor


def _init_sensor_override(session_id, *, flavor, **kwargs):
    override = os.environ.get("DEMO_FLAVOR_OVERRIDE")
    if override:
        flavor = override
    return _orig_init_sensor(session_id, flavor=flavor, **kwargs)


_h.init_sensor = _init_sensor_override

if len(sys.argv) < 2:
    print("usage: launch_with_flavor.py <module-name>", file=sys.stderr)
    sys.exit(1)

target = sys.argv[1]
mod = importlib.import_module(target)
mod.main()
