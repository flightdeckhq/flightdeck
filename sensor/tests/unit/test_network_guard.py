"""The unit tests' network guard (``_no_network`` in ``tests/conftest.py``)
refuses every name lookup that would leave the machine, and a refused
lookup fails the test that made it even when the code under test catches
the error: in the test's own thread, in another thread, and through the
asyncio resolver (``loop.getaddrinfo`` runs ``socket.getaddrinfo`` in an
executor). Loopback names, address literals and unix sockets pass.

Run as an inner pytest session in a subprocess, with the guard imported
from the suite's conftest, so the outcomes are pytest's own. Every name
looked up is under ``.invalid`` and refused before the resolver is asked.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pytest

pytest_plugins = ["pytester"]

# The sensor checkout's root, where ``tests`` is importable from.
_SENSOR_ROOT = str(Path(__file__).resolve().parents[2])

_CONFTEST = """
from tests.conftest import _no_network  # noqa: F401  (the suite's guard, autouse)
"""

_TESTS = """
import asyncio
import contextlib
import os
import socket
import tempfile
import threading


def test_a_swallowed_lookup_fails_the_test():
    with contextlib.suppress(OSError):
        socket.getaddrinfo("swallowed.invalid", 443)


def test_a_lookup_in_another_thread_fails_the_test():
    def _look():
        with contextlib.suppress(OSError):
            socket.getaddrinfo("thread.invalid", 443)

    worker = threading.Thread(target=_look)
    worker.start()
    worker.join()


def test_a_lookup_through_the_asyncio_resolver_fails_the_test():
    async def _look():
        with contextlib.suppress(OSError):
            await asyncio.get_running_loop().getaddrinfo("asyncio.invalid", 443)

    asyncio.run(_look())


def test_gethostbyname_fails_the_test():
    with contextlib.suppress(OSError):
        socket.gethostbyname("byname.invalid")


def test_a_reverse_lookup_of_a_public_address_fails_the_test():
    with contextlib.suppress(OSError):
        socket.gethostbyaddr("203.0.113.9")


def test_loopback_lookups_and_unix_sockets_pass():
    # A loopback lookup is allowed through; whether the host's resolver
    # answers it (IPv6 off, no hosts entry) does not matter here.
    for host in ("localhost", "LOCALHOST", "dev.localhost", "127.0.0.1", "::1"):
        with contextlib.suppress(OSError):
            socket.getaddrinfo(host, 80)
    with contextlib.suppress(OSError):
        socket.gethostbyaddr("127.0.0.1")
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "guard.sock")
        server = socket.socket(socket.AF_UNIX)
        server.bind(path)
        server.listen(1)
        client = socket.socket(socket.AF_UNIX)
        client.connect(path)
        client.close()
        server.close()


def test_an_address_literal_resolves_without_dns():
    socket.getaddrinfo("203.0.113.9", 443)
"""

# The inner tests that make a lookup the guard refuses, with the name.
_REFUSED = {
    "test_a_swallowed_lookup_fails_the_test": "swallowed.invalid",
    "test_a_lookup_in_another_thread_fails_the_test": "thread.invalid",
    "test_a_lookup_through_the_asyncio_resolver_fails_the_test": "asyncio.invalid",
    "test_gethostbyname_fails_the_test": "byname.invalid",
    "test_a_reverse_lookup_of_a_public_address_fails_the_test": "203.0.113.9",
}


def test_the_guard_fails_every_lookup_that_leaves_the_machine_and_names_it(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PYTHONPATH", _SENSOR_ROOT)
    pytester.makeconftest(_CONFTEST)
    pytester.makepyfile(test_lookups=_TESTS)
    result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-p", "no:respx")

    # Every inner test's body passes; a refused lookup errors its teardown.
    result.assert_outcomes(passed=7, errors=len(_REFUSED))
    output = result.stdout.str()
    # Each refused lookup fails its own test, at teardown, naming the host.
    sections = re.split(r"_+ ERROR at teardown of ", output)
    named = {s.split(" ", 1)[0]: s for s in sections[1:]}
    assert set(named) == set(_REFUSED)
    for test_name, host in _REFUSED.items():
        assert f"the test resolved names that leave the machine: '{host}'" in named[test_name]
