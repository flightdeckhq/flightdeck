"""Retiring litellm's global logging worker once the event loop it was
started on is closed, so the coroutines litellm leaves behind on that loop
die in the test that made them, not in whichever test next uses litellm.

litellm logs a call's success through one worker per process,
``litellm.litellm_core_utils.logging_worker.GLOBAL_LOGGING_WORKER``. The
call enqueues its ``Logging.async_success_handler`` coroutine, and the
worker's ``start()`` creates a task running ``_worker_loop()`` on the loop
that is running. Two kinds of call leave that state bound to a loop that
has closed, with or without the sensor:

- A sync call that litellm runs on a loop of its own (a call with
  ``fallbacks``, through ``asyncify.run_in_new_loop``) closes that loop
  when the call returns without cancelling the task, which never ran. The
  worker keeps the task and the queued handler.
- An async call run with ``asyncio.run`` closes its loop with the handler
  still queued; ``asyncio.run`` cancels the worker's task, which is done.

The next async litellm call, on another loop, resets the worker
(``_ensure_queue``). There litellm 1.83, the SDK floors and SDK majors
lanes' release, drops the never-run task and the queued handlers, and
litellm 1.104, the dev and Google ADK lanes' release, drops the task only:
it carries the handlers over to its new queue, where they run once a later
loop lives long enough. Python reports each coroutine dropped as never
awaited, inside whichever test made that next call, which may be in a
module that turns ``RuntimeWarning`` into an error. Retiring the worker
after the test that left it also drops, on 1.104, the handlers litellm
would otherwise run in a later test: on purpose, so that no test's logging
runs inside another test.
"""

from __future__ import annotations

import gc
import re
import sys
import warnings
from typing import Any

WORKER_MODULE = "litellm.litellm_core_utils.logging_worker"

# What a coroutine of a retired worker raises as it is dropped: it was
# never started, and its loop is closed, so it never will be.
ORPHAN_MESSAGES = (
    "coroutine 'LoggingWorker._worker_loop' was never awaited",
    "coroutine 'Logging.async_success_handler' was never awaited",
)

# The worker's state bound to its loop, set back to what a new worker
# holds. Both releases have ``_queue``, ``_worker_task``, ``_sem``,
# ``_bound_loop`` and the ``_running_tasks`` set; 1.104 also has
# ``_timeout_summary_task`` and the ``_dequeued_tasks`` dict. A name a
# release lacks is skipped.
_EMPTIED_ATTRIBUTES = ("_queue", "_worker_task", "_sem", "_bound_loop", "_timeout_summary_task")
_CLEARED_COLLECTIONS = ("_running_tasks", "_dequeued_tasks")


def _loops_of(worker: Any) -> list[Any]:
    """The loops the worker's state is bound to: its task's and its queue's."""
    loops = [getattr(worker, "_bound_loop", None)]
    task = getattr(worker, "_worker_task", None)
    get_loop = getattr(task, "get_loop", None)
    if callable(get_loop):
        loops.append(get_loop())
    return [loop for loop in loops if loop is not None]


def retire_litellm_logging_worker() -> bool:
    """Reset litellm's global logging worker when its state is bound to a
    closed loop, dropping that state with the warnings in
    :data:`ORPHAN_MESSAGES` ignored and collecting it at once. Whether
    anything was retired. Nothing is done before litellm's worker module
    is imported, nor for a worker whose loop is still open: whoever opened
    that loop cancels its tasks as they close it (``asyncio.run`` and
    ``asyncio.Runner`` do)."""
    module = sys.modules.get(WORKER_MODULE)
    worker = getattr(module, "GLOBAL_LOGGING_WORKER", None)
    if worker is None or not any(loop.is_closed() for loop in _loops_of(worker)):
        return False
    with warnings.catch_warnings():
        for message in ORPHAN_MESSAGES:
            warnings.filterwarnings("ignore", message=re.escape(message), category=RuntimeWarning)
        for name in _EMPTIED_ATTRIBUTES:
            if hasattr(worker, name):
                setattr(worker, name, None)
        for name in _CLEARED_COLLECTIONS:
            collection = getattr(worker, name, None)
            if isinstance(collection, (set, dict)):
                collection.clear()
        gc.collect()
    return True
