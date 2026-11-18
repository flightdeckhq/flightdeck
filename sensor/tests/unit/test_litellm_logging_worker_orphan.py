"""A sync litellm call with ``fallbacks`` leaves litellm's global logging
worker bound to a closed event loop (see ``tests/litellm_logging_worker.py``);
the next test to use litellm then drops the coroutines it held and fails
when its module turns ``RuntimeWarning`` into an error. The unit suite's
autouse fixture retires the worker after the test that left it.

Under xdist which test comes next on a worker varies, so the suite failed
now and then. Here the order is fixed: an inner pytest session, in a
process of its own with no xdist, collects the test that leaves the worker
behind and then, next, a test with the strict modules' warning marks that
makes an async litellm call and forces a collection. It fails without the
fixture and passes with it. litellm answers from ``mock_response``: nothing
leaves the machine.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

pytest_plugins = ["pytester"]

# sensor/, so the inner session imports the suite's own retirement helper.
_SENSOR_DIR = Path(__file__).resolve().parents[2]

_CONFTEST = """
import os

import pytest

if os.environ.get("RETIRE_LITELLM_WORKER") == "1":
    from tests.litellm_logging_worker import retire_litellm_logging_worker

    @pytest.fixture(autouse=True)
    def _litellm_logging_worker_retired():
        yield
        retire_litellm_logging_worker()
"""

_LEAVES_THE_WORKER = """
import litellm
from litellm.litellm_core_utils import logging_worker


def test_a_sync_call_with_fallbacks():
    litellm.completion(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        mock_response="ok",
        fallbacks=["gpt-4o-mini"],
    )
    task = logging_worker.GLOBAL_LOGGING_WORKER._worker_task
    assert task is not None and not task.done() and task.get_loop().is_closed(), (
        "litellm no longer leaves its logging worker on a closed loop"
    )
"""

_STRICT = """
import asyncio
import gc

import litellm
import pytest

pytestmark = [
    pytest.mark.filterwarnings("error::RuntimeWarning"),
    pytest.mark.filterwarnings("error::pytest.PytestUnraisableExceptionWarning"),
]


def test_a_strict_test_that_uses_litellm_next():
    asyncio.run(
        litellm.acompletion(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "hi"}],
            mock_response="ok",
        )
    )
    gc.collect()
"""


# The inner session: one process, in collection order (no xdist), with the
# respx plugin off as in the suite's own configuration.
_INNER_ARGS = ("-p", "no:xdist", "-p", "no:cacheprovider", "-p", "no:respx")
_STRICT_TEST = "*test_2_strict.py::test_a_strict_test_that_uses_litellm_next*"
_ORPHAN = "*coroutine 'LoggingWorker._worker_loop' was never awaited*"


@pytest.mark.parametrize("retired", [False, True], ids=["without the fixture", "with the fixture"])
def test_a_worker_left_on_a_closed_loop_fails_the_next_strict_test_unless_retired(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, retired: bool
) -> None:
    pytest.importorskip("litellm")
    path = [str(_SENSOR_DIR), os.environ.get("PYTHONPATH", "")]
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join(filter(None, path)))
    monkeypatch.setenv("RETIRE_LITELLM_WORKER", "1" if retired else "0")
    pytester.makeconftest(_CONFTEST)
    pytester.makepyfile(test_1_leaves_the_worker=_LEAVES_THE_WORKER, test_2_strict=_STRICT)
    result = pytester.runpytest_subprocess(*_INNER_ARGS, "-W", "ignore::DeprecationWarning")
    if retired:
        result.assert_outcomes(passed=2)
    else:
        result.assert_outcomes(passed=1, failed=1)
        result.stdout.fnmatch_lines([_STRICT_TEST])
        result.stdout.fnmatch_lines([_ORPHAN])
