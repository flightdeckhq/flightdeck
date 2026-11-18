"""The network guard the unit tests run under (``tests/network_guard.py``).

In the test process (``_no_network`` in ``tests/conftest.py``) every name
lookup that would leave the machine is refused, and the refusal fails the
test that made it even when the code under test catches the error: in the
test's own thread, in another thread, through the asyncio resolver
(``loop.getaddrinfo`` / ``loop.getnameinfo`` run the socket functions in
an executor), through a socket method given a host name, and through a
resolver function reached by a reference taken before the guard.
Loopback lookups, address literals, a numeric ``getnameinfo`` and unix
sockets pass. Each refusal raises what the real call raises when it
fails. Checked in an inner pytest session in a subprocess, with the guard
imported from the suite's conftest, so the outcomes are pytest's own.

A child process the tests start is guarded the same way, and what its
guard refuses fails the test that started it.

Every name looked up is under ``.invalid``, every address in a
documentation range, and each is refused before the resolver is asked.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.unit._child_process import run_python

pytest_plugins = ["pytester"]

# The sensor checkout's root, where ``tests`` is importable from.
_SENSOR_ROOT = str(Path(__file__).resolve().parents[2])
# A child that has not finished by then has hung.
_CHILD_TIMEOUT_SECS = 60.0

_CONFTEST = """
from tests.conftest import _no_network  # noqa: F401  (the suite's guard, autouse)
"""

_TESTS = """
import asyncio
import contextlib
import errno
import os
import socket
import tempfile
import threading

import pytest

# Taken before the guard replaces it: only the audit hook sees a call.
_SAVED_GETADDRINFO = socket.getaddrinfo


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
    with pytest.raises(socket.gaierror):
        socket.gethostbyname("byname.invalid")


def test_a_reverse_lookup_raises_herror_and_fails_the_test():
    with pytest.raises(socket.herror):
        socket.gethostbyaddr("203.0.113.9")


def test_getnameinfo_raises_gaierror_and_fails_the_test():
    with pytest.raises(socket.gaierror):
        socket.getnameinfo(("192.0.2.1", 80), 0)


def test_getnameinfo_through_the_asyncio_resolver_fails_the_test():
    async def _look():
        with contextlib.suppress(OSError):
            await asyncio.get_running_loop().getnameinfo(("192.0.2.2", 80))

    asyncio.run(_look())


def test_getfqdn_fails_the_test():
    assert socket.getfqdn("fqdn.invalid") == "fqdn.invalid"


def test_a_name_under_localhost_fails_the_test():
    with pytest.raises(socket.gaierror):
        socket.getaddrinfo("dev.localhost", 80)


def test_connect_ex_to_a_name_fails_the_test():
    with socket.socket() as sock, pytest.raises(socket.gaierror):
        sock.connect_ex(("connect-ex.invalid", 80))


def test_sendto_a_name_fails_the_test():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock, pytest.raises(socket.gaierror):
        sock.sendto(b"x", ("sendto.invalid", 9))


def test_bind_to_a_name_fails_the_test():
    with socket.socket() as sock, pytest.raises(socket.gaierror):
        sock.bind(("bind.invalid", 0))


def test_a_saved_resolver_reference_fails_the_test():
    with pytest.raises(socket.gaierror):
        _SAVED_GETADDRINFO("saved.invalid", 443)


def test_loopback_lookups_and_unix_sockets_pass():
    # A loopback lookup is let through; whether the host's resolver
    # answers it (IPv6 off, no hosts entry) does not matter here.
    for host in ("localhost", "LOCALHOST", "127.0.0.1", "::1"):
        with contextlib.suppress(OSError):
            socket.getaddrinfo(host, 80)
    with contextlib.suppress(OSError):
        socket.gethostbyaddr("127.0.0.1")
    with contextlib.suppress(OSError):
        socket.getnameinfo(("127.0.0.1", 80), 0)
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "guard.sock")
        with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
            server.bind(path)
            server.listen(1)
            client.connect(path)


def test_address_literals_need_no_lookup():
    socket.getaddrinfo("203.0.113.9", 443)
    assert socket.getnameinfo(("192.0.2.3", 80), socket.NI_NUMERICHOST)[0] == "192.0.2.3"
    # A connection off the machine is refused, as an unreachable server
    # refuses it; it is not a lookup.
    with socket.socket() as sock:
        assert sock.connect_ex(("203.0.113.9", 9)) == errno.ECONNREFUSED
"""

# The inner tests that make a lookup the guard refuses, with the name.
_REFUSED = {
    "test_a_swallowed_lookup_fails_the_test": "swallowed.invalid",
    "test_a_lookup_in_another_thread_fails_the_test": "thread.invalid",
    "test_a_lookup_through_the_asyncio_resolver_fails_the_test": "asyncio.invalid",
    "test_gethostbyname_fails_the_test": "byname.invalid",
    "test_a_reverse_lookup_raises_herror_and_fails_the_test": "203.0.113.9",
    "test_getnameinfo_raises_gaierror_and_fails_the_test": "192.0.2.1",
    "test_getnameinfo_through_the_asyncio_resolver_fails_the_test": "192.0.2.2",
    "test_getfqdn_fails_the_test": "fqdn.invalid",
    "test_a_name_under_localhost_fails_the_test": "dev.localhost",
    "test_connect_ex_to_a_name_fails_the_test": "connect-ex.invalid",
    "test_sendto_a_name_fails_the_test": "sendto.invalid",
    "test_bind_to_a_name_fails_the_test": "bind.invalid",
    "test_a_saved_resolver_reference_fails_the_test": "saved.invalid",
}
# The inner tests that must pass without a refusal.
_CLEAN = ("test_loopback_lookups_and_unix_sockets_pass", "test_address_literals_need_no_lookup")


def test_the_guard_fails_every_lookup_that_leaves_the_machine_and_names_it(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PYTHONPATH", _SENSOR_ROOT)
    pytester.makeconftest(_CONFTEST)
    pytester.makepyfile(test_lookups=_TESTS)
    result = pytester.runpytest_subprocess("-p", "no:cacheprovider", "-p", "no:respx")

    # Every inner test's body passes (each asserts what the refused call
    # raises); a refused lookup errors its teardown.
    result.assert_outcomes(passed=len(_REFUSED) + len(_CLEAN), errors=len(_REFUSED))
    output = result.stdout.str()
    sections = re.split(r"_+ ERROR at teardown of ", output)
    named = {s.split(" ", 1)[0]: s for s in sections[1:]}
    assert set(named) == set(_REFUSED)
    for test_name, host in _REFUSED.items():
        assert f"the test resolved names that leave the machine: '{host}'" in named[test_name]


def test_a_lookup_in_a_child_process_fails_the_test_that_started_it() -> None:
    code = """
        import contextlib, socket
        with contextlib.suppress(OSError):
            socket.getaddrinfo("child.invalid", 80)
    """
    refused = "the child process tried to leave the machine: [\"lookup 'child.invalid'\"]"
    with pytest.raises(AssertionError, match=re.escape(refused)):
        run_python(code, timeout=_CHILD_TIMEOUT_SECS)


def test_a_child_that_stays_on_the_machine_passes() -> None:
    code = """
        import contextlib, socket
        with contextlib.suppress(OSError):  # whether the host answers does not matter
            socket.getaddrinfo("localhost", 80)
        print("done")
    """
    result = run_python(code, timeout=_CHILD_TIMEOUT_SECS)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "done"
